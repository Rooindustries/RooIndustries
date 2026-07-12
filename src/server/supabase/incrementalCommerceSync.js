import crypto from "node:crypto";
import {
  COMMERCE_RECONCILABLE_DOCUMENT_TYPES,
  COMMERCE_SHADOW_DOCUMENT_TYPES,
} from "../commerce/documentTypes.js";
import { createCommerceReadClient } from "../api/ref/sanity.js";
import { createSupabaseAdminClient, isSupabaseAdminConfigured } from "./adminClient.js";
import { resolveSupabaseRuntimePolicy } from "./runtime.js";
import {
  importCommerceShadowDocuments,
  reconcileCommerceShadowDocuments,
} from "./shadowStore.js";

const STREAM_NAME = "commerce.sanity-to-supabase.v1";
const BATCH_SIZE = 50;
const MAX_BATCHES = 50;
const EMPTY_CURSOR = Object.freeze({ updatedAt: "", id: "" });

const requireRpcData = async (client, name, parameters = {}) => {
  const { data, error } = await client.rpc(name, parameters);
  if (!error) return data;
  const failure = new Error(`Supabase ${name} failed.`);
  failure.code = error.code || "SUPABASE_RPC_FAILED";
  throw failure;
};

const parseCursor = (value) => {
  try {
    const parsed = JSON.parse(String(value || ""));
    const updatedAt = String(parsed?.updatedAt || "");
    const id = String(parsed?.id || "");
    return updatedAt && id ? { updatedAt, id } : EMPTY_CURSOR;
  } catch {
    return EMPTY_CURSOR;
  }
};

const encodeCursor = (cursor) =>
  JSON.stringify({ updatedAt: cursor.updatedAt, id: cursor.id });

const cursorFromDocument = (document) => ({
  updatedAt: String(document?._updatedAt || ""),
  id: String(document?._id || ""),
});

const fetchChangedBatch = ({ client, cursor }) =>
  client.fetch(
    `*[
      _type in $types &&
      (_updatedAt > $updatedAt || (_updatedAt == $updatedAt && _id > $id))
    ] | order(_updatedAt asc, _id asc)[0...${BATCH_SIZE}]{...}`,
    {
      types: COMMERCE_SHADOW_DOCUMENT_TYPES,
      updatedAt: cursor.updatedAt,
      id: cursor.id,
    }
  );

const verifyChangedDocuments = async ({ documents, client }) => {
  if (documents.length < 1) return 0;
  const ids = documents.map((document) => document._id);
  const [sourceRows, targetRows] = await Promise.all([
    requireRpcData(client, "roo_hash_canonical_documents", {
      p_documents: documents,
    }),
    requireRpcData(client, "roo_commerce_canonical_manifest_for_ids", {
      p_ids: ids,
    }),
  ]);
  const source = new Map((sourceRows || []).map((row) => [row.id, row.hash]));
  const target = new Map(
    (targetRows || [])
      .filter((row) => !row.tombstoned)
      .map((row) => [row.id, row.hash])
  );
  const mismatched = ids.filter((id) => source.get(id) !== target.get(id));
  if (mismatched.length > 0) {
    const error = new Error("Incremental commerce parity failed.");
    error.code = "COMMERCE_INCREMENTAL_DRIFT";
    throw error;
  }
  return ids.length;
};

const importChangedDocuments = async ({ sanityClient, supabaseClient, cursor }) => {
  const summary = { batches: 0, changed: 0, imported: 0, skippedStale: 0 };
  let nextCursor = cursor;
  let exhausted = false;
  const changedDocuments = [];

  while (summary.batches < MAX_BATCHES) {
    const documents = await fetchChangedBatch({
      client: sanityClient,
      cursor: nextCursor,
    });
    if (!Array.isArray(documents) || documents.length < 1) {
      exhausted = true;
      break;
    }
    const imported = await importCommerceShadowDocuments({
      documents,
      client: supabaseClient,
      batchSize: BATCH_SIZE,
    });
    summary.batches += 1;
    summary.changed += documents.length;
    summary.imported += imported.imported;
    summary.skippedStale += imported.skippedStale;
    changedDocuments.push(...documents);
    nextCursor = cursorFromDocument(documents.at(-1));
    if (documents.length < BATCH_SIZE) {
      exhausted = true;
      break;
    }
  }

  if (summary.batches === MAX_BATCHES && !exhausted) {
    const remaining = await fetchChangedBatch({
      client: sanityClient,
      cursor: nextCursor,
    });
    if (Array.isArray(remaining) && remaining.length > 0) {
      const error = new Error("Incremental commerce sync exceeded its batch limit.");
      error.code = "COMMERCE_SYNC_BATCH_LIMIT";
      throw error;
    }
    exhausted = true;
  }
  summary.verified = await verifyChangedDocuments({
    documents: changedDocuments,
    client: supabaseClient,
  });
  return { summary, cursor: nextCursor };
};

const finishFailedRun = async ({ client, runId, leaseId, error }) => {
  if (runId) {
    await requireRpcData(client, "roo_finish_sync_run", {
      p_run_id: runId,
      p_status: "failed",
      p_counters: {},
      p_error_summary: "Incremental commerce sync failed.",
    }).catch(() => {});
  }
  await requireRpcData(client, "roo_release_commerce_sync_cursor", {
    p_stream_name: STREAM_NAME,
    p_lease_id: leaseId,
    p_error_code: String(error?.code || "COMMERCE_SYNC_FAILED").slice(0, 128),
  }).catch(() => {});
};

export const syncSanityCommerceChanges = async ({
  env = process.env,
  sanityClient,
  supabaseClient,
} = {}) => {
  const policy = resolveSupabaseRuntimePolicy(env);
  if (!isSupabaseAdminConfigured(env) || !policy.shadowWritesEnabled) {
    return { supported: false, reason: "shadow_sync_disabled" };
  }
  if (policy.commercePrimaryBackend !== "sanity") {
    return { supported: false, reason: "supabase_primary" };
  }

  const target = supabaseClient || createSupabaseAdminClient({ env });
  const source = sanityClient || createCommerceReadClient({
    perspective: "raw",
    backendOverride: "sanity",
  });
  const leaseId = `commerce-sync:${crypto.randomUUID()}`;
  const claim = await requireRpcData(target, "roo_claim_commerce_sync_cursor", {
    p_stream_name: STREAM_NAME,
    p_lease_id: leaseId,
    p_lease_seconds: 240,
  });
  if (!claim?.claimed) return { supported: true, busy: true };

  const snapshotStartedAt = new Date().toISOString();
  const initialCursor = parseCursor(claim.cursor_value);
  let runId = null;
  try {
    runId = await requireRpcData(target, "roo_start_sync_run", {
      p_direction: "sanity_to_supabase",
      p_mode: "shadow",
      p_source_cursor: encodeCursor(initialCursor),
    });
    const imported = await importChangedDocuments({
      sanityClient: source,
      supabaseClient: target,
      cursor: initialCursor,
    });
    const sourceIds = await source.fetch(`*[_type in $types]._id`, {
      types: COMMERCE_RECONCILABLE_DOCUMENT_TYPES,
    });
    const reconciliation = await reconcileCommerceShadowDocuments({
      sourceIds: (sourceIds || []).filter(Boolean),
      documentTypes: COMMERCE_RECONCILABLE_DOCUMENT_TYPES,
      snapshotStartedAt,
      client: target,
    });
    const counters = {
      ...imported.summary,
      reconciliation: reconciliation?.reconciliation || {},
      sourceIds: Number(sourceIds?.length || 0),
    };
    await requireRpcData(target, "roo_complete_incremental_commerce_sync", {
      p_stream_name: STREAM_NAME,
      p_lease_id: leaseId,
      p_run_id: runId,
      p_cursor_value: encodeCursor(imported.cursor),
      p_source_updated_at: imported.cursor.updatedAt || null,
      p_counters: counters,
    });
    return { supported: true, busy: false, ...counters };
  } catch (error) {
    await finishFailedRun({ client: target, runId, leaseId, error });
    throw error;
  }
};
