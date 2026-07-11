#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { createClient as createSanityClient } from "@sanity/client";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import {
  COMMERCE_EPHEMERAL_DOCUMENT_TYPES,
  COMMERCE_MIXED_IDENTITY_DOCUMENT_TYPES,
  COMMERCE_RECONCILABLE_DOCUMENT_TYPES,
  COMMERCE_SHADOW_DOCUMENT_TYPES,
} from "../src/server/commerce/documentTypes.js";
import { sha256 } from "./lib/supabase-shadow-migration.mjs";

const explicitEnvIndex = process.argv.indexOf("--env");
const explicitEnv =
  explicitEnvIndex >= 0
    ? String(process.argv[explicitEnvIndex + 1] || "").trim()
    : "";
for (const candidate of [
  explicitEnv,
  ".env.local",
  ".vercel/.env.preview.local",
]) {
  if (candidate && fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false, quiet: true });
  }
}

const hasFlag = (flag) => process.argv.includes(flag);
const apply = hasFlag("--apply");
const verifyOnly = hasFlag("--verify-only");
if (apply && verifyOnly) {
  throw new Error("--apply and --verify-only cannot be used together.");
}
const mode = apply ? "apply" : verifyOnly ? "verify" : "dry-run";

const readEnv = (...keys) =>
  keys.map((key) => String(process.env[key] || "").trim()).find(Boolean) || "";

const globalBackend = readEnv("DATA_PRIMARY_BACKEND") || "sanity";
const commerceBackend =
  readEnv("COMMERCE_PRIMARY_BACKEND") || globalBackend || "sanity";
if (
  apply &&
  [globalBackend, commerceBackend].some(
    (backend) => backend.toLowerCase() === "supabase"
  )
) {
  throw new Error(
    "Commerce shadow apply is disabled while Supabase is primary. Switch commerce to Sanity before importing a failover delta."
  );
}

const sanityProjectId = readEnv("SANITY_PRIVATE_PROJECT_ID", "SANITY_PROJECT_ID");
const sanityDataset =
  readEnv("SANITY_PRIVATE_DATASET", "SANITY_DATASET") || "production";
const sanityToken = readEnv(
  "SANITY_PRIVATE_READ_TOKEN",
  "SANITY_READ_TOKEN",
  "SANITY_PRIVATE_WRITE_TOKEN",
  "SANITY_WRITE_TOKEN"
);
const supabaseUrl = readEnv("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
const supabaseSecret = readEnv(
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY"
);

if (!sanityProjectId || !sanityToken) {
  throw new Error("Sanity read credentials are required.");
}
if (!supabaseUrl || !supabaseSecret) {
  throw new Error("Supabase server credentials are required.");
}

const sanity = createSanityClient({
  projectId: sanityProjectId,
  dataset: sanityDataset,
  apiVersion:
    readEnv("SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION") ||
    "2023-10-01",
  token: sanityToken,
  useCdn: false,
  perspective: "raw",
});

const supabase = createSupabaseClient(supabaseUrl, supabaseSecret, {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  },
  global: {
    headers: { "X-Client-Info": "roo-commerce-shadow-sync" },
  },
});

const requireRpc = async (name, parameters = {}) => {
  const { data, error } = await supabase.rpc(name, parameters);
  if (error) {
    const failure = new Error(`${name} failed.`);
    failure.code = error.code || "SUPABASE_RPC_FAILED";
    throw failure;
  }
  return data;
};

const sourcePayload = (document) => ({
  legacy_sanity_id: document._id,
  document_type: document._type,
  source_revision: document._rev || null,
  source_hash: sha256(document),
  source_created_at: document._createdAt || null,
  source_updated_at: document._updatedAt || null,
  payload: document,
});

const importDocuments = async (documents, batchSize = 25) => {
  const normalized = documents
    .map(sourcePayload)
    .sort((left, right) =>
      left.legacy_sanity_id.localeCompare(right.legacy_sanity_id)
    );
  let imported = 0;
  let skippedStale = 0;
  for (let index = 0; index < normalized.length; index += batchSize) {
    const batch = normalized.slice(index, index + batchSize);
    const result = await requireRpc(
      "roo_import_and_project_commerce_shadow_batch",
      { p_documents: batch }
    );
    imported += Number(result?.import?.imported ?? batch.length);
    skippedStale += Number(result?.import?.skipped_stale ?? 0);
  }
  return { imported, skippedStale };
};

const canonicalSourceManifest = async (documents) => {
  const manifest = new Map();
  for (let index = 0; index < documents.length; index += 100) {
    const batch = documents.slice(index, index + 100);
    const hashed = await requireRpc("roo_hash_canonical_documents", {
      p_documents: batch,
    });
    for (const entry of hashed || []) {
      manifest.set(entry.id, {
        id: entry.id,
        type: batch.find((document) => document._id === entry.id)?._type,
        hash: entry.hash,
      });
    }
  }
  return manifest;
};

const verifyParity = async (documents) => {
  const [source, targetRows, typedSummary, readiness] = await Promise.all([
    canonicalSourceManifest(documents),
    requireRpc("roo_commerce_canonical_manifest_for_types", {
      p_document_types: COMMERCE_SHADOW_DOCUMENT_TYPES,
    }),
    requireRpc("roo_commerce_typed_gap_summary"),
    requireRpc("roo_commerce_readiness"),
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

  const inspectNumeric = (value, path = "") => {
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
      inspectNumeric(child, path ? `${path}.${key}` : key);
    }
  };
  inspectNumeric(typedSummary);

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
    const expected = Number(values.source ?? values.expected ?? 0);
    const typed = Number(values.typed ?? 0);
    if (expected !== typed) {
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

const finishRun = async (runId, status, counters, errorSummary = null) => {
  if (!runId) return;
  await requireRpc("roo_finish_sync_run", {
    p_run_id: runId,
    p_status: status,
    p_counters: counters,
    p_error_summary: errorSummary,
  });
};

const main = async () => {
  const snapshotStartedAt = new Date().toISOString();
  const documents = await sanity.fetch(`*[_type in $types]`, {
    types: COMMERCE_SHADOW_DOCUMENT_TYPES,
  });
  const byType = Object.fromEntries(
    COMMERCE_SHADOW_DOCUMENT_TYPES.map((type) => [
      type,
      documents.filter((document) => document._type === type).length,
    ])
  );
  const summary = {
    mode,
    dataset: sanityDataset,
    documents: documents.length,
    byType,
    mixedIdentityDocuments: documents.filter((document) =>
      COMMERCE_MIXED_IDENTITY_DOCUMENT_TYPES.includes(document._type)
    ).length,
    excludedEphemeralTypes: COMMERCE_EPHEMERAL_DOCUMENT_TYPES,
    touchesAuthUsers: false,
    touchesTourney: false,
    touchesAssets: false,
  };

  if (mode === "dry-run") {
    console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
    return;
  }

  const runId = await requireRpc("roo_start_sync_run", {
    p_direction: verifyOnly ? "compare" : "sanity_to_supabase",
    p_mode: verifyOnly ? "shadow" : "apply",
    p_source_cursor:
      documents
        .map((document) => document._updatedAt || "")
        .sort()
        .at(-1) || null,
  });

  try {
    let importSummary = null;
    let reconciliation = null;
    let projection = null;
    if (apply) {
      importSummary = await importDocuments(documents);
      const reconciled = await requireRpc(
        "roo_reconcile_and_project_commerce_shadow_sources_since",
        {
          p_source_ids: documents.map((document) => document._id),
          p_document_types: COMMERCE_RECONCILABLE_DOCUMENT_TYPES,
          p_snapshot_started_at: snapshotStartedAt,
        }
      );
      reconciliation = reconciled?.reconciliation || {};
      projection = reconciled?.projection || {};
    }

    const parity = await verifyParity(documents);
    const counters = {
      ...summary,
      importSummary,
      reconciliation,
      projection,
      parity: {
        ...parity,
        failures: parity.failures.length,
        categories: [
          ...new Set(parity.failures.map((failure) => failure.category)),
        ].sort(),
      },
    };
    if (!parity.ok) {
      await finishRun(runId, "failed", counters, "Commerce parity failed.");
      throw new Error("Supabase commerce parity failed.");
    }
    await finishRun(runId, "completed", counters);
    console.log(JSON.stringify({ ok: true, ...counters }, null, 2));
  } catch (error) {
    await finishRun(runId, "failed", summary, "Commerce sync failed.").catch(
      () => {}
    );
    throw error;
  }
};

main().catch((error) => {
  console.error(`[supabase-commerce-sync] ${error.message}`);
  process.exit(1);
});
