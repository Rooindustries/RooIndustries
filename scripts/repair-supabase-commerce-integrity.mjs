#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { createClient as createSanityClient } from "@sanity/client";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { drainCommerceMirrorOutbox } from "../src/server/supabase/commerceMirrorOutbox.js";
import { SupabaseDocumentClient } from "../src/server/supabase/documentClient.js";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
};
const apply = process.argv.includes("--apply");
const envPath = argument("--env");
const expectedGenerationText = argument("--expected-generation");
const expectedGeneration = Number(expectedGenerationText);
const confirmedDigest = argument("--confirm-digest");

for (const candidate of [envPath, ".env.local", ".vercel/.env.production.local"]) {
  if (candidate && fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false, quiet: true });
  }
}

const readEnv = (...keys) =>
  keys.map((key) => String(process.env[key] || "").trim()).find(Boolean) || "";

if (
  !expectedGenerationText ||
  !Number.isSafeInteger(expectedGeneration) ||
  expectedGeneration < 0
) {
  throw new Error("--expected-generation must be a non-negative integer.");
}
if (apply && (!envPath || !confirmedDigest)) {
  throw new Error(
    "--apply requires --env and the --confirm-digest printed by a fresh dry run."
  );
}

const supabaseUrl = readEnv("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
const supabaseSecret = readEnv(
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY"
);
const sanityProjectId = readEnv("SANITY_PRIVATE_PROJECT_ID", "SANITY_PROJECT_ID");
const sanityDataset =
  readEnv("SANITY_PRIVATE_DATASET", "SANITY_DATASET") || "production";
const sanityWriteToken = readEnv(
  "SANITY_PRIVATE_WRITE_TOKEN",
  "SANITY_WRITE_TOKEN"
);

if (!supabaseUrl || !supabaseSecret) {
  throw new Error("Supabase server credentials are required.");
}
if (apply && (!sanityProjectId || !sanityWriteToken)) {
  throw new Error("Sanity write credentials are required to verify fallback mirroring.");
}

const supabase = createSupabaseClient(supabaseUrl, supabaseSecret, {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  },
  global: { headers: { "X-Client-Info": "roo-commerce-integrity-repair" } },
});
const documents = new SupabaseDocumentClient({
  shadowClient: supabase,
  commerceOnly: true,
  cutoverGeneration: expectedGeneration,
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

const control = await requireRpc("roo_commerce_control");
if (
  String(control?.primary_backend || "") !== "supabase" ||
  Number(control?.generation) !== expectedGeneration ||
  control?.starts_paused !== true
) {
  throw new Error(
    "Commerce must be Supabase-primary, on the expected generation, and paused before repair."
  );
}

const claimedFreeProofs = await documents.fetch(
  `*[_type == "paymentProofClaim" && provider == "free" && status == "claimed"]{...}`
);
const holds = await documents.fetch(`*[_type == "slotHold"]{...}`);
const paymentCache = new Map();
const getPayment = async (id) => {
  const key = String(id || "").trim();
  if (!key) return null;
  if (!paymentCache.has(key)) paymentCache.set(key, await documents.getDocument(key));
  return paymentCache.get(key);
};

const proofRepairs = [];
for (const proof of claimedFreeProofs || []) {
  if (String(proof?.bookingId || "").trim()) continue;
  const payment = await getPayment(proof?.paymentRecordId);
  if (
    payment?.provider === "free" &&
    !String(payment?.bookingId || "").trim() &&
    ["failed", "abandoned"].includes(String(payment?.status || "").toLowerCase())
  ) {
    proofRepairs.push(proof);
  }
}

const now = Date.now();
const terminalPaymentStatuses = new Set([
  "booked",
  "email_partial",
  "refunded",
  "failed",
  "abandoned",
]);
const expiredHolds = [];
for (const hold of holds || []) {
  const expiresAt = new Date(hold?.expiresAt || "").getTime();
  if (Number.isFinite(expiresAt) && expiresAt > now) continue;
  const payment = await getPayment(hold?.paymentRecordId);
  const phase = String(hold?.phase || "").trim().toLowerCase();
  const terminal =
    ["released", "consumed"].includes(phase) ||
    !payment?._id ||
    terminalPaymentStatuses.has(String(payment?.status || "").toLowerCase());
  if (terminal) expiredHolds.push(hold);
}

const repairShape = {
  generation: expectedGeneration,
  proofRepairs: proofRepairs
    .map((document) => ({ id: document._id, revision: document._rev || "" }))
    .sort((left, right) => left.id.localeCompare(right.id)),
  expiredHolds: expiredHolds
    .map((document) => ({ id: document._id, revision: document._rev || "" }))
    .sort((left, right) => left.id.localeCompare(right.id)),
};
const digest = crypto
  .createHash("sha256")
  .update(JSON.stringify(repairShape))
  .digest("hex");

console.log(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      expectedGeneration,
      orphanFreeProofsToRelease: proofRepairs.length,
      expiredTerminalHoldsToRemove: expiredHolds.length,
      confirmationDigest: digest,
    },
    null,
    2
  )
);

if (!apply) process.exit(0);
if (confirmedDigest !== digest) {
  throw new Error("The repair candidates changed after the dry run.");
}
if (proofRepairs.length < 1 && expiredHolds.length < 1) process.exit(0);

const releasedAt = new Date().toISOString();
let transaction = documents.transaction();
for (const proof of proofRepairs) {
  transaction = transaction.patch(proof._id, (patch) =>
    patch
      .ifRevisionId(proof._rev)
      .set({
        status: "released",
        releasedAt,
        releaseReason: "orphan_free_proof_from_failed_checkout",
      })
  );
}
for (const hold of expiredHolds) {
  transaction = transaction.delete(hold._id, { ifRevisionId: hold._rev });
}
await transaction.commit({ commandId: `integrity-repair:${digest.slice(0, 48)}` });

const sanity = createSanityClient({
  projectId: sanityProjectId,
  dataset: sanityDataset,
  apiVersion:
    readEnv("SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION") || "2023-10-01",
  token: sanityWriteToken,
  useCdn: false,
  perspective: "raw",
});
await drainCommerceMirrorOutbox({
  supabaseClient: supabase,
  sanityClient: sanity,
  failClosed: true,
  requiredDocumentIds: [
    ...proofRepairs.map((document) => document._id),
    ...expiredHolds.map((document) => document._id),
  ],
  limit: 100,
  maxBatches: 10,
});

console.log(JSON.stringify({ ok: true, applied: true, confirmationDigest: digest }));
