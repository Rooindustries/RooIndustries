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
  client.rpc("roo_mark_credential_operation", {
    p_operation_key: operationKey,
    p_status: status,
    p_error_code: errorCode,
  });

const recordError = (client, operationKey, expectedStatus, errorCode) =>
  client.rpc("roo_record_credential_recovery_error", {
    p_operation_key: operationKey,
    p_expected_status: expectedStatus,
    p_error_code: errorCode,
  });

const requireRpcData = ({ data, error }, operation) => {
  if (!error) return data || null;
  const failure = new Error(`Supabase ${operation} failed.`);
  failure.code = error.code || "CREDENTIAL_RECOVERY_FAILED";
  throw failure;
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

export const reconcileSupabaseCredentialSource = async ({
  operationKey,
  sourceDocumentId = "",
  adminClient = createSupabaseAdminClient(),
  sanityClient = createRefWriteClient({ backendOverride: "sanity" }),
} = {}) => {
  const applied = requireRpcData(
    await adminClient.rpc("roo_apply_credential_source_operation", {
      p_operation_key: operationKey,
    }),
    "credential source mutation"
  );
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
  if (!documentId) throw new Error("Creator credential target was not found.");
  const referral = await sanityClient.fetch(`*[_id == $id][0]`, { id: documentId });
  if (!referral?._id) throw new Error("Creator credential target was not found.");

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
  if (
    row.source_recovery_blocked ||
    !["sanity", "supabase"].includes(row.source_backend)
  ) {
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
  const pending = await adminClient.rpc("roo_list_credential_recovery", {
    p_limit: Math.max(1, Math.min(Number(limit) || 10, 25)),
  });
  if (pending.error) throw new Error("Credential recovery queue is unavailable.");
  const rows = Array.isArray(pending.data) ? pending.data : [];
  const summary = { checked: rows.length, recovered: 0, pending: 0 };

  for (const row of rows) {
    try {
      await recoverCredentialOperation({ row, adminClient, sanityClient });
      summary.recovered += 1;
    } catch (error) {
      summary.pending += 1;
      await recordError(
        adminClient,
        row.operation_key,
        row.status === "prepared" ? "prepared" : "auth_applied",
        String(error?.code || "CREDENTIAL_RECOVERY_PENDING").slice(0, 128)
      ).catch(() => {});
    }
  }
  return summary;
};
