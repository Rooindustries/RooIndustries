import { createRefWriteClient } from "../api/ref/sanity.js";
import { createSupabaseAdminClient } from "./adminClient.js";
import {
  buildCredentialSourceMutation,
  completeSupabaseCredentialMirror,
  getSupabaseCredentialOperation,
  markSupabaseCredentialSourceApplied,
} from "./accounts.js";
import { drainDocumentMutationOutbox } from "./documentMutationOutbox.js";

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

const requireCompletedMirror = (result) => {
  const pending = Number(result?.required?.pending ?? 1);
  const deadLetters = Number(result?.required?.dead_letters ?? 0);
  if (
    result?.supported !== true ||
    result?.pending === true ||
    pending !== 0 ||
    deadLetters !== 0
  ) {
    const error = new Error("Credential fallback mirror is still pending.");
    error.code = deadLetters > 0
      ? "CREDENTIAL_MIRROR_DEAD_LETTER"
      : "CREDENTIAL_MIRROR_PENDING";
    throw error;
  }
};

const credentialSourceUnavailable = () => {
  const error = new Error("Creator credential target was not found.");
  error.code = "CREDENTIAL_SOURCE_DOCUMENT_UNAVAILABLE";
  return error;
};

export const reconcileSupabaseCredentialSource = async ({
  operationKey,
  sourceDocumentId = "",
  adminClient = createSupabaseAdminClient(),
  sanityClient = createRefWriteClient({ backendOverride: "sanity" }),
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

  const mirrored = await drainDocumentMutationOutbox({
    supabaseClient: adminClient,
    sanityClient,
    requiredDocumentIds: [documentId],
    limit: 10,
    maxBatches: 2,
    budgetMs: 5_000,
  });
  requireCompletedMirror(mirrored);
  const completed = await completeSupabaseCredentialMirror({
    operationKey,
    adminClient,
  });
  return { applied, mirrored, ...completed };
};

const comparable = (value) => JSON.stringify(value);

const preconditionsMatch = (document, preconditions) =>
  Object.entries(preconditions || {}).every(
    ([field, value]) => comparable(document?.[field]) === comparable(value)
  );

const mutationWasApplied = (document, mutation) => {
  const set = mutation?.set || {};
  const unset = Array.isArray(mutation?.unset) ? mutation.unset : [];
  return Object.entries(set).every(
    ([field, value]) => comparable(document?.[field]) === comparable(value)
  ) && unset.every((field) => document?.[field] === undefined);
};

const rowMutation = (row) => {
  if (row?.source_mutation && typeof row.source_mutation === "object") {
    return row.source_mutation;
  }
  return buildCredentialSourceMutation({
    passwordHash: row?.password_hash,
    passwordChangedAt: new Date().toISOString(),
    consumeResetToken: true,
  });
};

const applySanityCredentialSource = async ({ row, sanityClient, adminClient }) => {
  const documentId = String(
    row.source_document_id || row.creator_legacy_sanity_id || ""
  ).trim();
  if (!documentId) throw credentialSourceUnavailable();
  const referral = await sanityClient.fetch(`*[_id == $id][0]`, { id: documentId });
  if (!referral?._id) throw credentialSourceUnavailable();

  const mutation = rowMutation(row);
  let appliedRevision = String(referral._rev || "").trim();
  if (!mutationWasApplied(referral, mutation)) {
    const preconditions = row.source_preconditions || {};
    const hasPreconditions = Object.keys(preconditions).length > 0;
    const expectedRevision = String(
      row.source_expected_revision || row.source_revision || ""
    ).trim();
    if (
      (hasPreconditions && !preconditionsMatch(referral, preconditions)) ||
      (!hasPreconditions && expectedRevision && referral._rev !== expectedRevision)
    ) {
      const conflict = new Error("Creator credential precondition changed.");
      conflict.code = "SOURCE_REVISION_CONFLICT";
      throw conflict;
    }
    let patch = sanityClient.patch(referral._id);
    if (referral._rev && typeof patch.ifRevisionId === "function") {
      patch = patch.ifRevisionId(referral._rev);
    }
    patch = patch.set(mutation.set || {});
    if (Array.isArray(mutation.unset) && mutation.unset.length > 0) {
      patch = patch.unset(mutation.unset);
    }
    const committed = await patch.commit({ visibility: "sync" });
    appliedRevision = String(committed?._rev || "").trim();
    if (!appliedRevision) {
      const current = await sanityClient.fetch(`*[_id == $id][0]{_id,_rev}`, {
        id: documentId,
      });
      appliedRevision = String(current?._rev || "").trim();
    }
  }

  if (row.source_backend === "sanity") {
    await markSupabaseCredentialSourceApplied({
      operationKey: row.operation_key,
      sourceRevision: appliedRevision,
      adminClient,
    });
  }
};

const recoverCredentialOperation = async ({ row, adminClient, sanityClient }) => {
  if (row.source_recovery_blocked) {
    const error = new Error("Credential source operation requires audited repair.");
    error.code = "CREDENTIAL_SOURCE_REPAIR_REQUIRED";
    error.credentialRecoveryRecorded = true;
    error.retryState = "parked";
    throw error;
  }
  const nextRetryAt = Date.parse(String(row.next_retry_at || ""));
  if (Number.isFinite(nextRetryAt) && nextRetryAt > Date.now()) {
    const error = new Error("Credential recovery is waiting for its retry window.");
    error.code = String(row.last_error_code || "CREDENTIAL_RECOVERY_BACKOFF");
    error.credentialRecoveryRecorded = true;
    error.retryState = "backoff";
    error.nextRetryAt = row.next_retry_at;
    throw error;
  }
  if (!["sanity", "supabase"].includes(row.source_backend)) {
    const error = new Error("Credential source operation requires audited repair.");
    error.code = "CREDENTIAL_SOURCE_REPAIR_REQUIRED";
    throw error;
  }
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

  if (row.source_backend === "supabase") {
    await reconcileSupabaseCredentialSource({
      operationKey: row.operation_key,
      sourceDocumentId: row.source_document_id,
      adminClient,
      sanityClient,
    });
    return;
  }

  await applySanityCredentialSource({ row, sanityClient, adminClient });
  await completeSupabaseCredentialMirror({
    operationKey: row.operation_key,
    adminClient,
  });
};

export const resumeSupabaseCredentialOperation = async ({
  operationKey,
  adminClient = createSupabaseAdminClient(),
  sanityClient = createRefWriteClient({ backendOverride: "sanity" }),
} = {}) => {
  const row = await getSupabaseCredentialOperation({ operationKey, adminClient });
  if (!row) return { resumed: false };
  if (
    row.status === "prepared" &&
    !row.source_recovery_blocked &&
    ["sanity", "supabase"].includes(row.source_backend)
  ) {
    return { resumed: false, status: "prepared" };
  }
  await recoverCredentialOperation({ row, adminClient, sanityClient });
  return { resumed: true, status: row.status };
};

export const reconcileCredentialOperations = async ({
  limit = 10,
  adminClient = createSupabaseAdminClient(),
  sanityClient = createRefWriteClient({ backendOverride: "sanity" }),
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
      await recoverCredentialOperation({ row, adminClient, sanityClient });
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
