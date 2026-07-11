#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { createClient as createSanityClient } from "@sanity/client";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import {
  accountRpcPayload,
  assetStorageDescriptor,
  buildDocumentManifest,
  buildMigrationAccounts,
  CMS_DOCUMENT_TYPES,
  collectAssetLinks,
  compareDocumentManifests,
  mapConcurrent,
  sha256,
  summarizeDocuments,
} from "./lib/supabase-shadow-migration.mjs";

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
const skipAssets = hasFlag("--skip-assets");
const reuseVerifiedAssets = hasFlag("--reuse-verified-assets");
const concurrencyArgument = process.argv.find((entry) =>
  entry.startsWith("--concurrency=")
);
const concurrency = Math.min(
  8,
  Math.max(1, Number(concurrencyArgument?.split("=")[1] || 4))
);

const readEnv = (...keys) =>
  keys.map((key) => String(process.env[key] || "").trim()).find(Boolean) || "";

if (
  apply &&
  String(process.env.DATA_PRIMARY_BACKEND || "sanity").trim().toLowerCase() ===
    "supabase"
) {
  throw new Error(
    "Sanity-to-Supabase apply is disabled after Supabase becomes primary."
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
  db: { schema: "public" },
  global: {
    headers: { "X-Client-Info": "roo-industries-shadow-migration" },
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

const importDocuments = async (documents, batchSize = 25) => {
  const normalized = documents.map((document) => ({
    legacy_sanity_id: document._id,
    document_type: document._type,
    source_revision: document._rev || null,
    source_hash: sha256(document),
    source_created_at: document._createdAt || null,
    source_updated_at: document._updatedAt || null,
    payload: document,
  }));
  let imported = 0;
  for (let index = 0; index < normalized.length; index += batchSize) {
    const batch = normalized.slice(index, index + batchSize);
    const result = await requireRpc("roo_import_shadow_batch", {
      p_documents: batch,
    });
    imported += Number(result?.imported || batch.length);
  }
  return { imported };
};

const listAllAuthUsers = async () => {
  const users = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw new Error("Supabase Auth user inventory failed.");
    const batch = data?.users || [];
    users.push(...batch);
    if (batch.length < 1000) return users;
  }
};

const ensureAuthAccounts = async (accounts) => {
  const existingUsers = await listAllAuthUsers();
  const byId = new Map(existingUsers.map((user) => [user.id, user]));
  const byEmail = new Map(
    existingUsers
      .filter((user) => user.email)
      .map((user) => [String(user.email).trim().toLowerCase(), user])
  );
  let created = 0;
  let updated = 0;
  let pending = 0;

  for (const account of accounts) {
    const existingById = byId.get(account.userId);
    const existingByEmail = byEmail.get(account.primaryEmail);
    if (
      existingById &&
      existingByEmail &&
      existingById.id !== existingByEmail.id
    ) {
      throw new Error("Supabase Auth contains a conflicting imported identity.");
    }

    const existing = existingById || existingByEmail || null;
    if (existing && existing.id !== account.userId) {
      account.userId = existing.id;
    }

    const authAttributes = {
      email: account.primaryEmail,
      email_confirm: true,
      user_metadata: {
        display_name: account.displayName,
      },
      app_metadata: {
        imported_from: "sanity",
        legacy_sanity_id: account.legacySanityId,
        roles: account.roles,
        credential_migration_pending: !account.passwordHash,
      },
      ...(account.passwordHash
        ? { password_hash: account.passwordHash }
        : {}),
    };

    let createdThisAccount = false;
    if (!existing) {
      const { data, error } = await supabase.auth.admin.createUser({
        id: account.userId,
        ...authAttributes,
      });
      if (error || !data?.user?.id) {
        throw new Error("A Supabase Auth account could not be imported.");
      }
      createdThisAccount = true;
      created += 1;
      byId.set(data.user.id, data.user);
      byEmail.set(account.primaryEmail, data.user);
    } else {
      const { error } = await supabase.auth.admin.updateUserById(
        account.userId,
        authAttributes
      );
      if (error) {
        throw new Error("A Supabase Auth account could not be synchronized.");
      }
      updated += 1;
    }

    if (!account.passwordHash) pending += 1;

    try {
      await requireRpc("roo_import_account", {
        p_account: accountRpcPayload(account),
      });
      await requireRpc("roo_finalize_imported_account_metadata", {
        p_user_id: account.userId,
        p_source_revision: account.sourceRevision || null,
        p_source_hash: account.sourceHash,
        p_email_verified: account.emailVerified,
      });
    } catch (error) {
      if (createdThisAccount) {
        await supabase.auth.admin.deleteUser(account.userId).catch(() => {});
      }
      throw error;
    }
  }

  return { total: accounts.length, created, updated, pending };
};

const contentType = (response) =>
  String(response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();

const verifySourceAsset = ({ buffer, descriptor, response }) => {
  const remoteLength = Number(response.headers.get("content-length") || 0);
  const expectedLength = remoteLength || descriptor.expectedBytes;
  if (buffer.length !== expectedLength) {
    throw new Error(
      `Sanity asset ${descriptor.legacySanityAssetId} has byte-size ${buffer.length}, expected ${expectedLength}.`
    );
  }
  const actualSha1 = crypto.createHash("sha1").update(buffer).digest("hex");
  const actualMd5 = crypto.createHash("md5").update(buffer).digest("hex");
  const remoteSha1 = String(response.headers.get("x-sanity-sha1") || "")
    .trim()
    .toLowerCase();
  const remoteMd5 = String(response.headers.get("x-sanity-md5") || "")
    .trim()
    .toLowerCase();
  const remoteHashMatches =
    (remoteSha1 && remoteSha1 === actualSha1) ||
    (remoteMd5 && remoteMd5 === actualMd5);
  const documentHashMatches =
    descriptor.expectedSha1 && descriptor.expectedSha1 === actualSha1;
  if (
    (remoteSha1 || remoteMd5) ? !remoteHashMatches : !documentHashMatches
  ) {
    throw new Error(
      `Sanity asset ${descriptor.legacySanityAssetId} failed its source checksum check.`
    );
  }
  const responseMime = contentType(response);
  if (responseMime && responseMime !== descriptor.mimeType) {
    throw new Error(
      `Sanity asset ${descriptor.legacySanityAssetId} has MIME type ${responseMime}, expected ${descriptor.mimeType}.`
    );
  }
};

const fetchRawSanityAsset = async (descriptor) => {
  const sourceUrl = new URL(descriptor.sourceUrl);
  const headers = { "accept-encoding": "identity" };
  if (descriptor.storageBucket === "site-content-public") {
    sourceUrl.searchParams.set("dlRaw", "true");
    headers.authorization = `Bearer ${sanityToken}`;
  }
  const response = await fetch(sourceUrl, {
    redirect: "follow",
    headers,
  });
  if (!response.ok) {
    throw new Error("A Sanity asset could not be downloaded.");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  verifySourceAsset({ buffer, descriptor, response });
  return { buffer, response };
};

const downloadStorageObject = async (descriptor) => {
  const { data, error } = await supabase.storage
    .from(descriptor.storageBucket)
    .download(descriptor.storagePath);
  if (error || !data) {
    throw new Error("A Supabase Storage object could not be downloaded.");
  }
  return Buffer.from(await data.arrayBuffer());
};

const copyAsset = async (asset) => {
  const descriptor = assetStorageDescriptor(asset);
  const { buffer } = await fetchRawSanityAsset(descriptor);
  const sourceSha256 = sha256(buffer);

  const { error: uploadError } = await supabase.storage
    .from(descriptor.storageBucket)
    .upload(descriptor.storagePath, buffer, {
      cacheControl: "31536000",
      contentType: descriptor.mimeType,
      upsert: true,
    });
  if (uploadError) {
    throw new Error("A Supabase Storage object could not be uploaded.");
  }

  const copied = await downloadStorageObject(descriptor);
  if (copied.length !== buffer.length || sha256(copied) !== sourceSha256) {
    throw new Error("A Supabase Storage object failed verification.");
  }

  await requireRpc("roo_upsert_asset", {
    p_asset: {
      legacy_sanity_asset_id: descriptor.legacySanityAssetId,
      source_url: descriptor.sourceUrl,
      storage_bucket: descriptor.storageBucket,
      storage_path: descriptor.storagePath,
      mime_type: descriptor.mimeType,
      byte_size: copied.length,
      sha256: sourceSha256,
      width: descriptor.width,
      height: descriptor.height,
      metadata: descriptor.metadata,
    },
  });

  return { bytes: copied.length };
};

const copyAssets = async (assets) => {
  const copied = await mapConcurrent(assets, concurrency, copyAsset);
  return {
    total: copied.length,
    bytes: copied.reduce((sum, entry) => sum + entry.bytes, 0),
  };
};

const verifyStoredAssets = async (sourceAssets, targetManifest) => {
  const targetById = new Map(
    targetManifest.map((entry) => [entry.legacy_sanity_asset_id, entry])
  );
  const failures = [];

  await mapConcurrent(sourceAssets, concurrency, async (asset) => {
    const descriptor = assetStorageDescriptor(asset);
    const target = targetById.get(descriptor.legacySanityAssetId);
    const { buffer: sourceBuffer } = await fetchRawSanityAsset(descriptor);
    const sourceSha256 = sha256(sourceBuffer);
    if (
      !target ||
      target.storage_bucket !== descriptor.storageBucket ||
      target.storage_path !== descriptor.storagePath ||
      target.mime_type !== descriptor.mimeType ||
      Number(target.byte_size) !== sourceBuffer.length ||
      target.sha256 !== sourceSha256 ||
      target.migration_status !== "verified"
    ) {
      failures.push(descriptor.legacySanityAssetId);
      return;
    }

    const copied = await downloadStorageObject(descriptor);
    if (
      copied.length !== sourceBuffer.length ||
      sha256(copied) !== sourceSha256
    ) {
      failures.push(descriptor.legacySanityAssetId);
    }
  });

  return {
    ok:
      failures.length === 0 &&
      targetManifest.length === sourceAssets.length,
    failures,
    expected: sourceAssets.length,
    actual: targetManifest.length,
  };
};

const verifyAccountAliases = async (accounts) => {
  const failures = [];
  for (const account of accounts) {
    for (const alias of account.aliases) {
      const resolved = await requireRpc("roo_resolve_account_alias", {
        p_identifier: alias.value,
      });
      if (
        resolved?.user_id !== account.userId ||
        !account.roles.every((role) => resolved?.roles?.includes(role))
      ) {
        failures.push(account.legacySanityId);
        break;
      }
    }
  }
  return failures;
};

const expectedCmsCount = (documents) =>
  documents.filter((document) => CMS_DOCUMENT_TYPES.has(document._type)).length;

const expectedOperationalCount = (documents) => {
  const types = new Set([
    "bookingSettings",
    "booking",
    "slotHold",
    "bookingSlot",
    "paymentRecord",
    "paymentStartClaim",
    "paymentProofClaim",
    "paymentUpgradeLock",
    "paymentWebhookReceipt",
    "paymentRecoveryCase",
    "bookingRecoveryCase",
    "coupon",
    "couponRedemption",
    "refRateLimitBucket",
  ]);
  return documents.filter((document) => types.has(document._type)).length;
};

const verificationFindings = ({
  manifestComparison,
  assetVerification,
  aliasFailures,
  countFailures,
}) => {
  const findings = [];
  for (const id of manifestComparison.missingTarget) {
    findings.push({
      category: "missing_target",
      severity: "error",
      legacy_sanity_id: id,
      details: { surface: "document" },
    });
  }
  for (const id of manifestComparison.missingSource) {
    findings.push({
      category: "missing_source",
      severity: "error",
      legacy_sanity_id: id,
      details: { surface: "document" },
    });
  }
  for (const id of manifestComparison.mismatched) {
    findings.push({
      category: "field_mismatch",
      severity: "error",
      legacy_sanity_id: id,
      details: { surface: "document_hash" },
    });
  }
  for (const id of assetVerification.failures) {
    findings.push({
      category: "asset_mismatch",
      severity: "error",
      legacy_sanity_id: id,
      details: { surface: "storage" },
    });
  }
  for (const id of aliasFailures) {
    findings.push({
      category: "relationship_mismatch",
      severity: "error",
      legacy_sanity_id: id,
      details: { surface: "account_alias" },
    });
  }
  for (const [name, details] of Object.entries(countFailures)) {
    findings.push({
      category: "count_mismatch",
      severity: "error",
      details: { surface: name, ...details },
    });
  }
  return findings;
};

const verifyParity = async ({ documents, accounts, links, runId }) => {
  const sourceManifest = buildDocumentManifest(documents);
  const targetManifest = await requireRpc("roo_shadow_manifest");
  const manifestComparison = compareDocumentManifests(
    sourceManifest,
    Array.isArray(targetManifest) ? targetManifest : []
  );
  const sourceAssets = documents.filter((document) =>
    ["sanity.imageAsset", "sanity.fileAsset"].includes(document._type)
  );
  const targetAssets = await requireRpc("roo_asset_manifest");
  const assetVerification = skipAssets
    ? { ok: true, failures: [], expected: 0, actual: 0 }
    : await verifyStoredAssets(
        sourceAssets,
        Array.isArray(targetAssets) ? targetAssets : []
      );
  const aliasFailures = await verifyAccountAliases(accounts);
  const [shadowSummary, accountSummary, operationalSummary, assetSummary] =
    await Promise.all([
      requireRpc("roo_shadow_summary"),
      requireRpc("roo_account_shadow_summary"),
      requireRpc("roo_operational_shadow_summary"),
      requireRpc("roo_shadow_asset_summary"),
    ]);

  const countFailures = {};
  const compareCount = (name, actual, expected) => {
    if (Number(actual) !== Number(expected)) {
      countFailures[name] = { actual: Number(actual), expected: Number(expected) };
    }
  };
  compareCount("source_documents", shadowSummary?.source_documents, documents.length);
  compareCount("cms_documents", shadowSummary?.cms_documents, expectedCmsCount(documents));
  compareCount("auth_users", accountSummary?.auth_users, accounts.length);
  compareCount("profiles", accountSummary?.profiles, accounts.length);
  compareCount(
    "creator_profiles",
    accountSummary?.creator_profiles,
    documents.filter((document) => document._type === "referral").length
  );
  compareCount(
    "tourney_accounts",
    accountSummary?.tourney_accounts,
    accounts.filter((account) => account.tourneyAccount).length
  );
  compareCount(
    "source_operational_documents",
    operationalSummary?.source_operational_documents,
    expectedOperationalCount(documents)
  );
  compareCount(
    "operational_imported",
    operationalSummary?.operational_imported,
    expectedOperationalCount(documents)
  );
  compareCount(
    "bookings",
    operationalSummary?.bookings,
    documents.filter((document) => document._type === "booking").length
  );
  compareCount(
    "payment_records",
    operationalSummary?.payment_records,
    documents.filter((document) => document._type === "paymentRecord").length
  );
  compareCount(
    "payment_proof_claims",
    operationalSummary?.payment_proof_claims,
    documents.filter((document) => document._type === "paymentProofClaim").length
  );
  compareCount(
    "coupons",
    operationalSummary?.coupons,
    documents.filter((document) => document._type === "coupon").length
  );
  if (!skipAssets) {
    compareCount("assets", assetSummary?.assets, sourceAssets.length);
    compareCount("document_asset_links", assetSummary?.document_asset_links, links.length);
  }

  const findings = verificationFindings({
    manifestComparison,
    assetVerification,
    aliasFailures,
    countFailures,
  });
  if (runId && findings.length > 0) {
    await requireRpc("roo_record_drift_findings", {
      p_run_id: runId,
      p_findings: findings,
    });
  }

  return {
    ok: findings.length === 0,
    documentDrift:
      manifestComparison.missingTarget.length +
      manifestComparison.missingSource.length +
      manifestComparison.mismatched.length,
    assetDrift: assetVerification.failures.length,
    accountDrift: aliasFailures.length,
    countDrift: Object.keys(countFailures).length,
    counts: {
      documents: documents.length,
      cmsDocuments: expectedCmsCount(documents),
      accounts: accounts.length,
      assets: sourceAssets.length,
      assetLinks: links.length,
    },
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
  const documents = await sanity.fetch("*[]");
  const inventory = summarizeDocuments(documents);
  const accounts = buildMigrationAccounts(documents, process.env);
  const assets = documents.filter((document) =>
    ["sanity.imageAsset", "sanity.fileAsset"].includes(document._type)
  );
  const links = collectAssetLinks(documents);
  const assetIds = new Set(assets.map((asset) => asset._id));
  const missingAssetReferences = links.filter(
    (link) => !assetIds.has(link.asset_legacy_id)
  );
  if (missingAssetReferences.length > 0) {
    throw new Error("CMS content references a missing Sanity asset.");
  }

  const dryRunSummary = {
    mode,
    dataset: sanityDataset,
    documents: inventory.total,
    documentTypes: Object.keys(inventory.byType).length,
    cmsDocuments: expectedCmsCount(documents),
    operationalDocuments: expectedOperationalCount(documents),
    accounts: accounts.length,
    pendingPlaintextCredentials: accounts.filter(
      (account) => !account.passwordHash
    ).length,
    assets: assets.length,
    assetBytes: assets.reduce((sum, asset) => sum + Number(asset.size || 0), 0),
    assetLinks: links.length,
  };

  if (mode === "dry-run") {
    console.log(JSON.stringify({ ok: true, ...dryRunSummary }, null, 2));
    return;
  }

  const runId = await requireRpc("roo_start_sync_run", {
    p_direction: verifyOnly ? "compare" : "sanity_to_supabase",
    p_mode: verifyOnly ? "shadow" : "apply",
    p_source_cursor: documents
      .map((document) => document._updatedAt || "")
      .sort()
      .at(-1) || null,
  });

  try {
    let importSummary = null;
    let authSummary = null;
    let assetSummary = null;
    let operationalSummary = null;
    if (apply) {
      importSummary = await importDocuments(documents, 25);
      importSummary.reconciliation = await requireRpc(
        "roo_reconcile_shadow_sources",
        { p_source_ids: documents.map((document) => document._id) }
      );
      authSummary = await ensureAuthAccounts(accounts);
      operationalSummary = await requireRpc("roo_refresh_operational_shadow");
      if (!skipAssets && !reuseVerifiedAssets) {
        assetSummary = await copyAssets(assets);
      }
      if (!skipAssets) {
        await requireRpc("roo_replace_document_asset_links", {
          p_links: links,
        });
        assetSummary = {
          ...(assetSummary || {}),
          pruning: await requireRpc("roo_prune_tombstoned_shadow_assets"),
        };
      }
    }

    const parity = await verifyParity({
      documents,
      accounts,
      links,
      runId,
    });
    const counters = {
      ...dryRunSummary,
      importSummary,
      authSummary,
      assetSummary,
      operationalSummary,
      parity,
    };
    if (!parity.ok) {
      await finishRun(runId, "failed", counters, "Shadow parity failed.");
      throw new Error("Supabase shadow parity failed.");
    }
    counters.resolvedDrift = await requireRpc(
      "roo_resolve_verified_drift_findings",
      { p_successful_run_id: runId }
    );
    await finishRun(runId, "completed", counters);
    console.log(JSON.stringify({ ok: true, ...counters }, null, 2));
  } catch (error) {
    await finishRun(
      runId,
      "failed",
      { ...dryRunSummary },
      "Migration execution failed."
    ).catch(() => {});
    throw error;
  }
};

main().catch((error) => {
  console.error(`[supabase-shadow-migration] ${error.message}`);
  process.exit(1);
});
