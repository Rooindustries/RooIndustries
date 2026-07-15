import {
  COMMERCE_SHADOW_DOCUMENT_TYPES,
} from "../commerce/documentTypes.js";
import { createCommerceReadClient } from "../api/ref/sanity.js";
import {
  createSupabaseAdminClient,
  isSupabaseAdminConfigured,
} from "./adminClient.js";
import { resolveSupabaseRuntimePolicy } from "./runtime.js";

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

const requireRpcData = async (client, name, parameters = {}) => {
  const { data, error } = await client.rpc(name, parameters);
  if (!error) return data;
  const failure = new Error(`Supabase ${name} failed.`);
  failure.code = error.code || "SUPABASE_RPC_FAILED";
  throw failure;
};

const completedParityIsFresh = ({ readiness, maxAgeMs }) => {
  const parity = readiness?.last_parity;
  const completedAt = Date.parse(String(parity?.completed_at || ""));
  return (
    parity?.status === "completed" &&
    parity?.direction === "compare" &&
    parity?.counters?.mode === "verify" &&
    Number.isFinite(completedAt) &&
    completedAt <= Date.now() + 60_000 &&
    Date.now() - completedAt <= maxAgeMs
  );
};

const canonicalSourceManifest = async ({ client, documents }) => {
  const manifest = new Map();
  for (let index = 0; index < documents.length; index += 100) {
    const batch = documents.slice(index, index + 100);
    const rows = await requireRpcData(client, "roo_hash_canonical_documents", {
      p_documents: batch,
    });
    const typeById = new Map(batch.map((document) => [document._id, document._type]));
    for (const row of rows || []) {
      manifest.set(row.id, { id: row.id, type: typeById.get(row.id), hash: row.hash });
    }
  }
  return manifest;
};

const collectTypedGapFailures = (value, failures, path = "") => {
  if (typeof value === "number") {
    if (
      value !== 0 &&
      /mismatch|duplicate|unsafe|missing_creator|ambiguous/i.test(path)
    ) {
      failures.push({ category: "typed_gap", path });
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    collectTypedGapFailures(child, failures, path ? `${path}.${key}` : key);
  }
};

const compareCommerceParity = async ({ documents, client }) => {
  const [source, targetRows, typedSummary, readiness] = await Promise.all([
    canonicalSourceManifest({ client, documents }),
    requireRpcData(client, "roo_commerce_canonical_manifest_for_types", {
      p_document_types: COMMERCE_SHADOW_DOCUMENT_TYPES,
    }),
    requireRpcData(client, "roo_commerce_typed_gap_summary"),
    requireRpcData(client, "roo_commerce_readiness"),
  ]);
  const target = new Map((targetRows || []).map((entry) => [entry.id, entry]));
  const failures = [];

  for (const [id, entry] of source) {
    const mirrored = target.get(id);
    if (!mirrored || mirrored.tombstoned) {
      failures.push({ category: "missing_target", type: entry.type });
    } else if (mirrored.hash !== entry.hash) {
      failures.push({ category: "document_hash", type: entry.type });
    }
  }
  for (const [id, entry] of target) {
    if (!entry.tombstoned && !source.has(id)) {
      failures.push({ category: "missing_source", type: entry.type });
    }
  }

  collectTypedGapFailures(typedSummary, failures);
  for (const section of [
    "bookings",
    "payments",
    "coupons",
    "holds",
    "email_dispatches",
    "referral_ledger",
    "refunds",
  ]) {
    const values = typedSummary?.[section] || {};
    if (Number(values.source ?? values.expected ?? 0) !== Number(values.typed ?? 0)) {
      failures.push({ category: "typed_count", path: section });
    }
  }
  if (Number(readiness?.captured_without_booking || 0) > 0) {
    failures.push({ category: "captured_without_booking" });
  }

  return {
    ok: failures.length === 0,
    compared: source.size,
    failures,
    mirrorPending: Number(readiness?.mirror?.pending || 0),
    capturedWithoutBooking: Number(readiness?.captured_without_booking || 0),
    emailRetries: Number(readiness?.email_retries || 0),
  };
};

const finishRun = (client, runId, status, counters, errorSummary = null) =>
  requireRpcData(client, "roo_finish_sync_run", {
    p_run_id: runId,
    p_status: status,
    p_counters: counters,
    p_error_summary: errorSummary,
  });

export const refreshCommerceParityIfStale = async ({
  env = process.env,
  force = false,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  sanityClient,
  supabaseClient,
} = {}) => {
  const policy = resolveSupabaseRuntimePolicy(env);
  if (policy.commercePrimaryBackend !== "supabase") {
    return { supported: false, skipped: true, reason: "supabase_not_primary" };
  }
  if (!isSupabaseAdminConfigured(env)) {
    return { supported: false, skipped: true, reason: "supabase_unavailable" };
  }

  const target = supabaseClient || createSupabaseAdminClient({ env });
  const readiness = await requireRpcData(target, "roo_commerce_readiness");
  const safeMaxAgeMs = Math.max(60_000, Number(maxAgeMs) || DEFAULT_MAX_AGE_MS);
  if (!force && completedParityIsFresh({ readiness, maxAgeMs: safeMaxAgeMs })) {
    return { supported: true, skipped: true, reason: "parity_fresh" };
  }

  const source = sanityClient || createCommerceReadClient({
    perspective: "raw",
    backendOverride: "sanity",
  });
  const documents = await source.fetch(`*[_type in $types]`, {
    types: COMMERCE_SHADOW_DOCUMENT_TYPES,
  });
  const normalized = Array.isArray(documents) ? documents : [];
  const runId = await requireRpcData(target, "roo_start_sync_run", {
    p_direction: "compare",
    p_mode: "shadow",
    p_source_cursor: normalized
      .map((document) => document._updatedAt || "")
      .sort()
      .at(-1) || null,
  });

  const summary = {
    mode: "verify",
    documents: normalized.length,
    byType: Object.fromEntries(
      COMMERCE_SHADOW_DOCUMENT_TYPES.map((type) => [
        type,
        normalized.filter((document) => document._type === type).length,
      ])
    ),
  };
  let runFinished = false;
  try {
    const parity = await compareCommerceParity({ documents: normalized, client: target });
    const counters = {
      ...summary,
      parity: {
        ...parity,
        failures: parity.failures.length,
        categories: [...new Set(parity.failures.map((failure) => failure.category))].sort(),
      },
    };
    if (!parity.ok) {
      await finishRun(target, runId, "failed", counters, "Commerce parity failed.");
      runFinished = true;
      const error = new Error("Supabase commerce parity failed.");
      error.code = "COMMERCE_PARITY_FAILED";
      throw error;
    }
    await finishRun(target, runId, "completed", counters);
    runFinished = true;
    return { supported: true, skipped: false, ...counters };
  } catch (error) {
    if (!runFinished) {
      await finishRun(
        target,
        runId,
        "failed",
        summary,
        "Commerce parity verification failed."
      ).catch(() => {});
    }
    throw error;
  }
};
