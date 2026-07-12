import crypto from "node:crypto";
import { createSupabaseAdminClient } from "./adminClient.js";

const sortValue = (value) => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = sortValue(value[key]);
      return result;
    }, {});
};

export const stableJson = (value) => JSON.stringify(sortValue(value));

export const buildCommerceCommandId = ({ mutations, cutoverGeneration = 0 } = {}) =>
  `commerce:${crypto
    .createHash("sha256")
    .update(
      stableJson({
        mutations: Array.isArray(mutations) ? mutations : [],
        cutoverGeneration: Math.max(0, Number(cutoverGeneration) || 0),
      })
    )
    .digest("hex")}`;

export const hashShadowDocument = (document) =>
  crypto.createHash("sha256").update(stableJson(document)).digest("hex");

export const normalizeShadowDocument = (document) => {
  const id = String(document?._id || "").trim();
  const type = String(document?._type || "").trim();
  if (!id || !type) {
    throw new Error("Shadow documents require _id and _type.");
  }

  return {
    legacy_sanity_id: id,
    document_type: type,
    source_revision: String(document?._rev || "").trim() || null,
    source_hash: hashShadowDocument(document),
    source_created_at: String(document?._createdAt || "").trim() || null,
    source_updated_at: String(document?._updatedAt || "").trim() || null,
    payload: document,
  };
};

const requireRpcData = ({ data, error }, operation) => {
  if (error) {
    const failure = new Error(`Supabase ${operation} failed.`);
    failure.code = error.code || "SUPABASE_RPC_FAILED";
    const statusByCode = {
      "22023": 400,
      "23505": 409,
      "40001": 409,
      "55000": 503,
      "55006": 503,
      P0002: 404,
      PGRST000: 503,
      PGRST001: 503,
      PGRST002: 503,
    };
    failure.status =
      statusByCode[failure.code] || Number(error.status || 0) || 500;
    failure.statusCode = failure.status;
    throw failure;
  }
  return data;
};

export const importShadowDocuments = async ({
  documents,
  client = createSupabaseAdminClient(),
  batchSize = 100,
} = {}) => {
  const normalized = (documents || [])
    .map(normalizeShadowDocument)
    .sort((left, right) =>
      left.legacy_sanity_id.localeCompare(right.legacy_sanity_id)
    );
  let imported = 0;
  let skippedStale = 0;

  for (let index = 0; index < normalized.length; index += batchSize) {
    const batch = normalized.slice(index, index + batchSize);
    const result = requireRpcData(
      await client.rpc("roo_import_shadow_batch", { p_documents: batch }),
      "shadow import"
    );
    imported += Number(result?.imported ?? batch.length);
    skippedStale += Number(result?.skipped_stale ?? 0);
  }

  return { imported, skippedStale };
};

export const importCommerceShadowDocuments = async ({
  documents,
  client = createSupabaseAdminClient(),
  batchSize = 50,
} = {}) => {
  const normalized = (documents || [])
    .map(normalizeShadowDocument)
    .sort((left, right) =>
      left.legacy_sanity_id.localeCompare(right.legacy_sanity_id)
    );
  let imported = 0;
  let skippedStale = 0;

  for (let index = 0; index < normalized.length; index += batchSize) {
    const batch = normalized.slice(index, index + batchSize);
    const result = requireRpcData(
      await client.rpc("roo_import_and_project_commerce_shadow_batch", {
        p_documents: batch,
      }),
      "atomic commerce shadow import"
    );
    imported += Number(result?.import?.imported ?? batch.length);
    skippedStale += Number(result?.import?.skipped_stale ?? 0);
  }

  return { imported, skippedStale };
};

export const reconcileCommerceShadowDocuments = async ({
  sourceIds,
  documentTypes,
  snapshotStartedAt,
  client = createSupabaseAdminClient(),
} = {}) =>
  requireRpcData(
    await client.rpc(
      "roo_reconcile_and_project_commerce_shadow_sources_since",
      {
        p_source_ids: [...new Set((sourceIds || []).map(String))],
        p_document_types: [...new Set((documentTypes || []).map(String))],
        p_snapshot_started_at: snapshotStartedAt,
      }
    ),
    "atomic commerce shadow reconciliation"
  );

export const tombstoneShadowDocuments = async ({
  ids,
  deletedAt = new Date().toISOString(),
  client = createSupabaseAdminClient(),
} = {}) =>
  requireRpcData(
    await client.rpc("roo_tombstone_shadow_ids", {
      p_ids: [
        ...new Set(
          (ids || []).map((id) => String(id || "").trim()).filter(Boolean)
        ),
      ],
      p_deleted_at: deletedAt,
    }),
    "shadow tombstone"
  );

export const tombstoneCommerceShadowDocuments = async ({
  ids,
  deletedAt = new Date().toISOString(),
  client = createSupabaseAdminClient(),
} = {}) =>
  requireRpcData(
    await client.rpc("roo_tombstone_and_project_commerce_shadow_ids", {
      p_ids: [
        ...new Set(
          (ids || []).map((id) => String(id || "").trim()).filter(Boolean)
        ),
      ],
      p_deleted_at: deletedAt,
    }),
    "atomic commerce shadow tombstone"
  );

export const projectReferralAccountShadow = async ({
  ids,
  client = createSupabaseAdminClient(),
} = {}) =>
  requireRpcData(
    await client.rpc("roo_project_referral_account_shadow", {
      p_legacy_sanity_ids:
        Array.isArray(ids) && ids.length > 0 ? [...new Set(ids)] : null,
    }),
    "referral account shadow projection"
  );

export const fetchShadowDocuments = async ({
  documentTypes = null,
  ids = null,
  filters = [],
  limit = 500,
  allowLegacyFallback = true,
  client = createSupabaseAdminClient(),
} = {}) => {
  const targeted = await client.rpc("roo_fetch_shadow_documents_targeted", {
    p_document_types:
      Array.isArray(documentTypes) && documentTypes.length > 0
        ? documentTypes
        : null,
    p_ids: Array.isArray(ids) && ids.length > 0 ? ids : null,
    p_filters: Array.isArray(filters) ? filters : [],
    p_limit: Math.max(1, Math.min(1000, Number(limit) || 500)),
  });
  let data;
  if (
    targeted?.error &&
    ["42883", "PGRST202"].includes(String(targeted.error.code || ""))
  ) {
    if (!allowLegacyFallback) {
      const failure = new Error("Targeted commerce reads are unavailable.");
      failure.code = "COMMERCE_TARGETED_READ_UNAVAILABLE";
      failure.status = 503;
      failure.statusCode = 503;
      throw failure;
    }
    data = requireRpcData(
      await client.rpc("roo_fetch_shadow_documents", {
        p_document_types:
          Array.isArray(documentTypes) && documentTypes.length > 0
            ? documentTypes
            : null,
      }),
      "shadow fetch"
    );
  } else {
    data = requireRpcData(targeted, "targeted shadow fetch");
  }
  return Array.isArray(data) ? data : [];
};

export const fetchRecoveryPaymentDocuments = async ({
  backend,
  statuses,
  refundedStatus,
  bookedStatus,
  abandonedStatus,
  now,
  limit = 50,
  client = createSupabaseAdminClient(),
} = {}) => {
  const data = requireRpcData(
    await client.rpc("roo_fetch_recovery_payment_documents", {
      p_backend: backend === "supabase" ? "supabase" : "sanity",
      p_statuses: Array.isArray(statuses) ? statuses : [],
      p_refunded_status: String(refundedStatus || "refunded"),
      p_booked_status: String(bookedStatus || "booked"),
      p_abandoned_status: String(abandonedStatus || "abandoned"),
      p_now: String(now || new Date().toISOString()),
      p_limit: Math.max(1, Math.min(100, Number(limit) || 50)),
    }),
    "recovery payment fetch"
  );
  return Array.isArray(data) ? data : [];
};

export const fetchCommerceAvailability = async ({
  client = createSupabaseAdminClient(),
} = {}) => {
  const data = requireRpcData(
    await client.rpc("roo_fetch_commerce_availability"),
    "commerce availability fetch"
  );
  const result = {
    bookings: Array.isArray(data?.bookings) ? data.bookings : [],
    holds: Array.isArray(data?.holds) ? data.holds : [],
    slotLocks: Array.isArray(data?.slotLocks) ? data.slotLocks : [],
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 250 * 1024) {
    const error = new Error("Supabase commerce availability exceeded its payload budget.");
    error.code = "COMMERCE_PAYLOAD_BUDGET_EXCEEDED";
    error.status = 503;
    error.statusCode = 503;
    throw error;
  }
  return result;
};

export const applyShadowMutations = async ({
  mutations,
  commandId = "",
  cutoverGeneration = 0,
  commerceMode = false,
  client = createSupabaseAdminClient(),
} = {}) => {
  if (!Array.isArray(mutations) || mutations.length < 1) return [];
  if (commerceMode) {
    const resolvedCommandId =
      String(commandId || "").trim() ||
      buildCommerceCommandId({ mutations, cutoverGeneration });
    const data = requireRpcData(
      await client.rpc("roo_apply_commerce_document_mutations", {
        p_command_id: resolvedCommandId,
        p_mutations: mutations,
        p_cutover_generation: Math.max(0, Number(cutoverGeneration) || 0),
      }),
      "commerce document mutation"
    );
    return Array.isArray(data?.results) ? data.results : [];
  }
  const data = requireRpcData(
    await client.rpc("roo_apply_document_mutations", {
      p_mutations: mutations,
    }),
    "document mutation"
  );
  await projectOperationalShadow({ client });
  return Array.isArray(data) ? data : [];
};

export const projectOperationalShadow = async ({
  client = createSupabaseAdminClient(),
} = {}) =>
  requireRpcData(
    await client.rpc("roo_refresh_operational_shadow"),
    "operational shadow refresh"
  );

export const fetchShadowSummary = async ({
  client = createSupabaseAdminClient(),
} = {}) =>
  requireRpcData(await client.rpc("roo_shadow_summary"), "shadow summary");
