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
    failure.status = error.status || 500;
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
  client = createSupabaseAdminClient(),
} = {}) => {
  const data = requireRpcData(
    await client.rpc("roo_fetch_shadow_documents", {
      p_document_types:
        Array.isArray(documentTypes) && documentTypes.length > 0
          ? documentTypes
          : null,
    }),
    "shadow fetch"
  );
  return Array.isArray(data) ? data : [];
};

export const applyShadowMutations = async ({
  mutations,
  client = createSupabaseAdminClient(),
} = {}) => {
  if (!Array.isArray(mutations) || mutations.length < 1) return [];
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
