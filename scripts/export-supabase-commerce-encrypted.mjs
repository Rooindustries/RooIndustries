#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import migrationTargetSafety from "../src/server/supabase/migrationTargetSafety.cjs";
import {
  defaultExportRoot,
  decryptJsonExport,
  deleteExportPassphrase,
  encryptJsonExport,
  loadPrivateExportEnvironment,
  parseExportArguments,
  reserveExportOutput,
  stableExportJson,
  storeExportPassphrase,
} from "./lib/encrypted-export.mjs";

const { assertTourneyCutoverSupabaseApiTarget, computeTourneyCutoverSupabaseApiTargetFingerprint } =
  migrationTargetSafety;
export const SNAPSHOT_ARRAYS = Object.freeze([
  "source_documents",
  "booking_settings",
  "bookings",
  "slot_holds",
  "slot_claims",
  "booking_slots",
  "payment_records",
  "payment_start_claims",
  "payment_upgrade_locks",
  "payment_proof_claims",
  "payment_events",
  "webhook_receipts",
  "refunds",
  "coupons",
  "coupon_redemptions",
  "referral_ledger",
  "recovery_cases",
  "email_dispatches",
  "rate_limit_buckets",
  "commands",
  "mirror_outbox",
  "mirror_checkpoints",
  "sync_runs",
  "sync_cursors",
  "drift_findings",
  "dead_letters",
]);
const account = process.env.USER || "serviroo";

const readEnv = (env, ...keys) =>
  keys.map((key) => String(env[key] || "").trim()).find(Boolean) || "";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export const validateCommerceExportSnapshot = (snapshot) => {
  if (
    !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
    snapshot.format !== "roo-supabase-commerce-export-v1" ||
    !Number.isFinite(Date.parse(String(snapshot.exported_at || ""))) ||
    SNAPSHOT_ARRAYS.some((key) => !Array.isArray(snapshot[key]))
  ) {
    throw new Error("The Supabase commerce snapshot is incomplete.");
  }
  const expectedKeys = new Set(["format", "exported_at", ...SNAPSHOT_ARRAYS]);
  if (Object.keys(snapshot).some((key) => !expectedKeys.has(key))) {
    throw new Error("The Supabase commerce snapshot contract changed.");
  }
  const documentIds = new Set();
  for (const document of snapshot.source_documents) {
    const id = String(document?.legacy_sanity_id || "").trim();
    if (
      !id || documentIds.has(id) || !String(document?.document_type || "").trim() ||
      !document.payload || typeof document.payload !== "object" ||
      !/^[0-9a-f]{64}$/.test(String(document.source_hash || ""))
    ) {
      throw new Error("The Supabase commerce source document snapshot is invalid.");
    }
    documentIds.add(id);
  }
  return {
    canonicalSha256: sha256(stableExportJson(snapshot)),
    counts: Object.fromEntries(SNAPSHOT_ARRAYS.map((key) => [key, snapshot[key].length])),
  };
};

export const runCommerceEncryptedExport = async ({
  argv = process.argv.slice(2),
  env = process.env,
  outputRoot = defaultExportRoot,
  clientFactory = createClient,
} = {}) => {
  const args = parseExportArguments(argv);
  loadPrivateExportEnvironment({
    envPath: args.envPath,
    prefixes: ["SUPABASE_", "NEXT_PUBLIC_SUPABASE_", "TOURNEY_CUTOVER_"],
    env,
  });
  const supabaseUrl = readEnv(env, "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
  const expectedFingerprint = readEnv(
    env,
    "SUPABASE_COMMERCE_EXPORT_EXPECTED_FINGERPRINT",
    "TOURNEY_CUTOVER_EXPECTED_SUPABASE_API_FINGERPRINT"
  );
  const target = assertTourneyCutoverSupabaseApiTarget({
    supabaseUrl,
    expectedFingerprint: args.printTargetFingerprint
      ? computeTourneyCutoverSupabaseApiTargetFingerprint(supabaseUrl)
      : expectedFingerprint,
  });
  if (args.printTargetFingerprint) {
    return { SUPABASE_COMMERCE_EXPORT_EXPECTED_FINGERPRINT: target.fingerprint };
  }
  const secret = readEnv(env, "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) throw new Error("Supabase server credentials are required.");
  const client = clientFactory(supabaseUrl, secret, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { "X-Client-Info": "roo-commerce-encrypted-export" } },
  });
  const { data: snapshot, error } = await client.rpc(
    "roo_export_commerce_trial_snapshot"
  );
  if (error) throw new Error("The Supabase commerce snapshot could not be created.");
  const validated = validateCommerceExportSnapshot(snapshot);
  const exportedAt = new Date().toISOString();
  const payload = {
    format: "roo-supabase-commerce-encrypted-export-v2",
    exportedByClientAt: exportedAt,
    targetFingerprint: target.fingerprint,
    snapshotCanonicalSha256: validated.canonicalSha256,
    tableCounts: validated.counts,
    snapshot,
  };
  const passphrase = crypto.randomBytes(48).toString("base64url");
  const stamp = exportedAt.replace(/[^0-9A-Za-z]/g, "");
  const service = `RooIndustries-Supabase-Commerce-Snapshot-${stamp}-${crypto.randomBytes(6).toString("hex")}`;
  const reservation = reserveExportOutput({
    prefix: "Supabase commerce complete pre-cutover export",
    extension: "json.enc",
    root: outputRoot,
    now: new Date(exportedAt),
  });
  let completed = false;
  try {
    const encrypted = encryptJsonExport({ payload, passphrase });
    fs.writeFileSync(reservation.descriptor, encrypted);
    fs.fsyncSync(reservation.descriptor);
    const decrypted = decryptJsonExport({ encrypted, passphrase });
    const decryptedValidation = validateCommerceExportSnapshot(decrypted.snapshot);
    if (
      stableExportJson(decrypted) !== stableExportJson(payload) ||
      decrypted.targetFingerprint !== target.fingerprint ||
      decrypted.snapshotCanonicalSha256 !== validated.canonicalSha256 ||
      decryptedValidation.canonicalSha256 !== validated.canonicalSha256 ||
      stableExportJson(decrypted.tableCounts) !== stableExportJson(validated.counts)
    ) {
      throw new Error("The encrypted Supabase commerce export failed exact verification.");
    }
    await storeExportPassphrase({ service, passphrase, account });
    completed = true;
    return {
      ok: true,
      outputPath: reservation.outputPath,
      keychainService: service,
      targetFingerprint: target.fingerprint,
      tableCounts: validated.counts,
      snapshotCanonicalSha256: validated.canonicalSha256,
      encryptedBytes: encrypted.byteLength,
      encryptedSha256: sha256(encrypted),
      localDecryptVerified: true,
    };
  } finally {
    fs.closeSync(reservation.descriptor);
    if (!completed) {
      await fsPromises.unlink(reservation.outputPath).catch(() => {});
      await deleteExportPassphrase({ service, account });
    }
  }
};

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  runCommerceEncryptedExport()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(() => {
      process.stderr.write("[supabase-commerce-encrypted-export] Export failed.\n");
      process.exitCode = 1;
    });
}
