import envValue from "./envValue.cjs";
const { resolveStoreBackend } = envValue;
import bcrypt from "bcryptjs";
import { createSupabaseAdminClient } from "./adminClient.js";
import {
  assertSupabaseCredentialOperationRetry,
  completeSupabaseCredentialOperation,
  getSupabaseCredentialOperation,
  checkpointPreparedCredentialOperation,
} from "./accounts.js";

const mark = (client, operationKey, status, errorCode = null) =>
  client.rpc("roo_mark_credential_operation_v2", {
    p_operation_key: operationKey,
    p_status: status,
    p_error_code: errorCode,
  });

const DETERMINISTIC_ERROR_CODES = new Set([
  "40001",
  "55000",
  "P0002",
  "SOURCE_REVISION_CONFLICT",
  "CREDENTIAL_AUTH_PLAINTEXT_REQUIRED",
  "CREDENTIAL_AUTH_OUTCOME_UNKNOWN",
  "CREDENTIAL_MIRROR_DEAD_LETTER",
  "CREDENTIAL_SOURCE_PRECONDITION_CHANGED",
  "CREDENTIAL_SOURCE_REPAIR_REQUIRED",
]);

const MISSING_RECOVERY_RECORDER_CODES = new Set([
  "PGRST202",
  "42883",
  "UNDEFINED_FUNCTION",
]);

const RECOVERY_ERROR_MESSAGES = {
  CREDENTIAL_AUTH_OUTCOME_UNKNOWN: "Credential Auth outcome requires verified recovery.",
  "40001": "Credential source precondition changed.",
  "55000": "Credential source operation is not ready.",
  P0002: "Credential source document is unavailable.",
  SOURCE_REVISION_CONFLICT: "Credential source revision changed.",
  CREDENTIAL_AUTH_PLAINTEXT_REQUIRED:
    "Credential recovery requires the original password request.",
  CREDENTIAL_MIRROR_DEAD_LETTER:
    "Credential fallback mirror requires manual repair.",
  CREDENTIAL_SOURCE_DOCUMENT_UNAVAILABLE:
    "Credential source document is unavailable.",
  CREDENTIAL_SOURCE_PRECONDITION_CHANGED:
    "Credential source precondition changed.",
  CREDENTIAL_SOURCE_REPAIR_REQUIRED:
    "Credential source operation requires audited repair.",
  CREDENTIAL_SOURCE_WRITE_CONFLICT:
    "Credential source write conflicted with another transaction.",
};

const errorCode = (error) =>
  String(error?.code || "CREDENTIAL_RECOVERY_PENDING")
    .trim()
    .toUpperCase()
    .slice(0, 128);

const errorClassification = (error) => {
  const code = errorCode(error);
  return {
    code,
    errorClass: DETERMINISTIC_ERROR_CODES.has(code)
      ? "deterministic"
      : "transient",
    message: String(
      RECOVERY_ERROR_MESSAGES[code] || "Credential recovery remains pending."
    ).slice(0, 512),
  };
};

const rpcFailure = (error, operation) => {
  const failure = new Error(`Supabase ${operation} failed.`);
  failure.code = error?.code || "CREDENTIAL_RECOVERY_FAILED";
  failure.status = error?.status || 500;
  return failure;
};

const isMissingRecoveryRecorder = (error) =>
  MISSING_RECOVERY_RECORDER_CODES.has(
    String(error?.code || "").trim().toUpperCase()
  );

const recordError = async (client, operationKey, expectedStatus, error) => {
  const failure = errorClassification(error);
  const response = await client.rpc("roo_record_credential_recovery_failure", {
    p_operation_key: operationKey,
    p_expected_status: expectedStatus,
    p_error_code: failure.code,
    p_error_message: failure.message,
    p_error_class: failure.errorClass,
  });
  if (!response?.error) return response;
  if (!isMissingRecoveryRecorder(response.error)) {
    throw rpcFailure(response.error, "credential recovery failure recording");
  }

  const fallback = await client.rpc("roo_record_credential_recovery_error", {
    p_operation_key: operationKey,
    p_expected_status: expectedStatus,
    p_error_code: failure.code,
  });
  if (fallback?.error) {
    throw rpcFailure(
      fallback.error,
      "legacy credential recovery failure recording"
    );
  }
  return fallback;
};

const deferredCredentialError = (result, fallbackCode) => {
  const status = String(result?.retry_status || result?.status || "").trim();
  if (!["backoff", "not_ready", "parked"].includes(status)) return null;
  const error = new Error(
    String(result?.last_error || "Credential recovery is not ready.")
  );
  error.code = String(result?.error_code || fallbackCode || "55000");
  error.credentialRecoveryRecorded = status !== "not_ready";
  error.retryState = status;
  error.nextRetryAt = result?.next_retry_at || null;
  return error;
};

const requireRpcData = ({ data, error }, operation) => {
  if (!error) return data || null;
  throw rpcFailure(error, operation);
};

export const reconcileSupabaseCredentialSource = async ({
  operationKey,
  sourceDocumentId = "",
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  const applied = requireRpcData(
    await adminClient.rpc("roo_apply_credential_source_operation_v2", {
      p_operation_key: operationKey,
    }),
    "credential source mutation"
  );
  const deferred = deferredCredentialError(
    applied,
    "CREDENTIAL_SOURCE_REPAIR_REQUIRED"
  );
  if (deferred) throw deferred;
  const documentId = String(
    sourceDocumentId || applied?.source_document_id || ""
  ).trim();
  if (!documentId) throw new Error("Credential source document was not found.");

  const completed = await completeSupabaseCredentialOperation({operationKey,adminClient});
  return {applied,...completed};
};

const recoverCredentialOperation = async ({ row, adminClient }) => {
  resolveStoreBackend(row.source_backend);
  assertSupabaseCredentialOperationRetry(row);
  if (row.status === "mirrored") return;
  if (row.status === "prepared") {
    const error = new Error(
      "Credential recovery requires the original password request."
    );
    error.code = "CREDENTIAL_AUTH_PLAINTEXT_REQUIRED";
    throw error;
  } else if (row.status === "auth_applied" && !row.sessions_revoked_at) {
    const checkpoint = await mark(adminClient, row.operation_key, "auth_applied");
    if (checkpoint.error) throw new Error("Credential session revocation failed.");
    row.sessions_revoked_at = new Date().toISOString();
  }

  await reconcileSupabaseCredentialSource({operationKey:row.operation_key,sourceDocumentId:row.source_document_id,adminClient});
};

export const resumeSupabaseCredentialOperation = async ({
  operationKey,
  password,
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  const row = await getSupabaseCredentialOperation({ operationKey, adminClient });
  if (!row) return { resumed: false };
  if (
    password !== undefined &&
    (!/^\$2[aby]\$(0[4-9]|1[0-5])\$/.test(String(row.password_hash || "")) || !await bcrypt.compare(String(password), String(row.password_hash || "")))
  ) {
    const error = new Error("Credential operation conflicts with the submitted password.");
    error.code = "23505";
    throw error;
  }
  if (row.status === "prepared" && password !== undefined) {
    if (await checkpointPreparedCredentialOperation({ operationKey, password, adminClient })) {
      row.status = "auth_applied";
      row.sessions_revoked_at = new Date().toISOString();
      row.source_recovery_blocked = false;
      row.last_error_code = null;
      row.attempt_count = 0;
    } else {
      return { resumed: false, status: "prepared" };
    }
  }
  if (row.status === "prepared" && !row.source_recovery_blocked) {
    assertSupabaseCredentialOperationRetry(row);
    return { resumed: false, status: "prepared" };
  }
  await recoverCredentialOperation({ row, adminClient });
  return { resumed: true, status: row.status };
};

export const reconcileCredentialOperations = async ({
  limit = 10,
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  const pending = await adminClient.rpc("roo_list_credential_recovery_v2", {
    p_limit: Math.max(1, Math.min(Number(limit) || 10, 25)),
  });
  if (pending.error) throw new Error("Credential recovery queue is unavailable.");
  const rows = Array.isArray(pending.data) ? pending.data : [];
  const summary = {
    checked: rows.length,
    recovered: 0,
    pending: 0,
    backoff: 0,
    parked: 0,
  };

  for (const row of rows) {
    try {
      await recoverCredentialOperation({ row, adminClient });
      summary.recovered += 1;
    } catch (error) {
      summary.pending += 1;
      let retryState = error?.retryState || "";
      if (!error?.credentialRecoveryRecorded) {
        const recorded = await recordError(
          adminClient,
          row.operation_key,
          row.status === "prepared" ? "prepared" : "auth_applied",
          error
        );
        retryState = String(
          recorded?.data?.retry_status || recorded?.data?.status || retryState
        );
      }
      if (retryState === "parked") summary.parked += 1;
      else if (retryState === "backoff") summary.backoff += 1;
    }
  }
  return summary;
};
