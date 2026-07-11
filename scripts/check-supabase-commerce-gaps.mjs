#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { createClient as createSanityClient } from "@sanity/client";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { SupabaseDocumentClient } from "../src/server/supabase/documentClient.js";

for (const candidate of [".env.local", ".vercel/.env.preview.local"]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false, quiet: true });
  }
}

const readEnv = (...keys) =>
  keys.map((key) => String(process.env[key] || "").trim()).find(Boolean) || "";

const sanityProjectId = readEnv("SANITY_PRIVATE_PROJECT_ID", "SANITY_PROJECT_ID");
const sanityDataset = readEnv("SANITY_PRIVATE_DATASET", "SANITY_DATASET") || "production";
const sanityToken = readEnv(
  "SANITY_PRIVATE_READ_TOKEN",
  "SANITY_READ_TOKEN",
  "SANITY_PRIVATE_WRITE_TOKEN",
  "SANITY_WRITE_TOKEN"
);
const supabaseUrl = readEnv("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
const supabaseSecret = readEnv("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY");
const baseline = JSON.parse(
  fs.readFileSync(new URL("../supabase/commerce-gap-baseline.json", import.meta.url), "utf8")
);

if (!sanityProjectId || !sanityToken || !supabaseUrl || !supabaseSecret) {
  throw new Error("Sanity read and Supabase service credentials are required.");
}

const sanity = createSanityClient({
  projectId: sanityProjectId,
  dataset: sanityDataset,
  apiVersion: readEnv("SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION") || "2023-10-01",
  token: sanityToken,
  useCdn: false,
  perspective: "raw",
});

const supabase = createSupabaseClient(supabaseUrl, supabaseSecret, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { headers: { "X-Client-Info": "roo-commerce-gap-check" } },
});

const excludedDocumentKeys = new Set([
  "_rev",
  "_createdAt",
  "_updatedAt",
  "_system",
  "_supabaseRevision",
  "_supabaseCanonicalHash",
  "_commerceCutoverGeneration",
  "_supabaseMirroredAt",
]);

const referralCredentialKeys = new Set([
  "creatorPassword",
  "resetToken",
  "resetTokenHash",
  "resetTokenExpiresAt",
  "passwordResetRequired",
  "credentialVersion",
]);

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

const canonicalResult = (value) => {
  if (Array.isArray(value)) return value.map(canonicalResult);
  if (!value || typeof value !== "object") return value;
  const ignoredKeys =
    value._type === "referral"
      ? new Set([...excludedDocumentKeys, ...referralCredentialKeys])
      : excludedDocumentKeys;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !ignoredKeys.has(key))
      .map(([key, child]) => [key, canonicalResult(child)])
  );
};

const stableJson = (value) => JSON.stringify(sortValue(value));
const hash = (value) =>
  crypto.createHash("sha256").update(stableJson(value)).digest("hex");

const diffPaths = (left, right, path = "") => {
  if (stableJson(left) === stableJson(right)) return [];
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) ||
    Array.isArray(right)
  ) {
    return [path || "$root"];
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].flatMap((key) =>
    diffPaths(left[key], right[key], path ? `${path}.${key}` : key)
  );
};

const requireRpc = async (name, parameters = {}) => {
  const { data, error } = await supabase.rpc(name, parameters);
  if (error) {
    const failure = new Error(`${name} failed.`);
    failure.code = error.code || "SUPABASE_RPC_FAILED";
    throw failure;
  }
  return data;
};

const walkJavaScript = (directory) => {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return walkJavaScript(path);
    return /\.[cm]?jsx?$/.test(entry.name) ? [path] : [];
  });
};

const inventoryCommerceQueries = () => {
  const roots = [
    "src/server/api/payment",
    "src/server/api/ref",
    "src/server/booking",
  ];
  const queries = [];
  const unsafe = [];
  for (const file of roots.flatMap(walkJavaScript)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/`([^`]*(?:\*\[|count\(\*\[)[^`]*)`/g)) {
      const query = match[1].replace(/\s+/g, " ").trim();
      queries.push(`${file}:${query}`);
      if (!query.includes("_type") && !query.includes("_id")) {
        unsafe.push({ category: "static_query_scope", file });
      }
    }
  }
  return { count: new Set(queries).size, unsafe };
};

const numericLeafFailures = (value, path = "") => {
  if (typeof value === "number") return value === 0 ? [] : [[path, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    numericLeafFailures(child, path ? `${path}.${key}` : key)
  );
};

const buildReplayCases = (documents) => {
  const first = (type) => documents.find((document) => document?._type === type);
  const booking = first("booking");
  const payment = first("paymentRecord");
  const coupon = first("coupon");
  const referral = first("referral");
  const exactDocumentTypes = [
    "booking",
    "bookingSettings",
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
    "referral",
    "owedReferral",
    "creatorPayout",
    "package",
    "upgradeLink",
  ];
  const exactCases = exactDocumentTypes.flatMap((type) => {
    const document = first(type);
    return document?._id
      ? [{
          name: `exact-${type}`,
          query: `*[_type == $type && _id == $id][0]{...}`,
          params: { type, id: document._id },
        }]
      : [];
  });
  return [
    {
      name: "booking-settings",
      query: `*[_type == "bookingSettings"] | order(_id asc)[0]{...}`,
      params: {},
    },
    {
      name: "availability-bookings",
      query: `*[_type == "booking"] | order(_id asc){_id,startTimeUTC,packageTitle,originalOrderId,status}`,
      params: {},
    },
    {
      name: "availability-holds",
      query: `*[_type == "slotHold"] | order(_id asc){_id,startTimeUTC,phase,expiresAt}`,
      params: {},
    },
    {
      name: "availability-locks",
      query: `*[_type == "bookingSlot" && status != "released"] | order(_id asc){_id,bookingId,startTimeUTC,status}`,
      params: {},
    },
    ...(booking?._id
      ? [{ name: "booking-by-id", query: `*[_type == "booking" && _id == $id][0]{...}`, params: { id: booking._id } }]
      : []),
    ...(payment?._id
      ? [{ name: "payment-by-id", query: `*[_type == "paymentRecord" && _id == $id][0]{...}`, params: { id: payment._id } }]
      : []),
    ...(payment?.providerOrderId
      ? [{
          name: "payment-by-provider-order",
          query: `*[_type == "paymentRecord" && provider == $provider && providerOrderId == $providerOrderId][0]{...}`,
          params: {
            provider: payment.provider,
            providerOrderId: payment.providerOrderId,
          },
        }]
      : []),
    ...(payment?.providerPaymentId
      ? [{
          name: "payment-by-provider-payment",
          query: `*[_type == "paymentRecord" && provider == $provider && providerPaymentId == $providerPaymentId][0]{...}`,
          params: {
            provider: payment.provider,
            providerPaymentId: payment.providerPaymentId,
          },
        }]
      : []),
    ...(booking?.startTimeUTC
      ? [{
          name: "bookings-by-slot",
          query: `*[_type == "booking" && startTimeUTC == $startTimeUTC] | order(_id asc){_id,status,originalOrderId}`,
          params: { startTimeUTC: booking.startTimeUTC },
        }]
      : []),
    ...(coupon?.code
      ? [{
          name: "coupon-by-code",
          query: `*[_type == "coupon" && lower(code) == $code][0]{_id,code,isActive,timesUsed,maxUses,validFrom,validTo,discountType,discountPercent,discountAmount}`,
          params: { code: String(coupon.code).toLowerCase() },
        }]
      : []),
    ...(referral?.slug?.current
      ? [{
          name: "referral-by-code",
          query: `*[_type == "referral" && slug.current == $code][0]{_id,slug,currentCommissionPercent,currentDiscountPercent}`,
          params: { code: referral.slug.current },
        }]
      : []),
    {
      name: "referral-accounting",
      query: `*[_type in ["owedReferral", "creatorPayout"]] | order(_id asc){...}`,
      params: {},
    },
    ...exactCases,
  ];
};

const compareDocuments = async () => {
  const [sourceDocuments, targetManifest] = await Promise.all([
    sanity.fetch(`*[]`),
    requireRpc("roo_commerce_canonical_manifest"),
  ]);
  const sourceHashes = new Map();
  for (let index = 0; index < sourceDocuments.length; index += 100) {
    const batch = sourceDocuments.slice(index, index + 100);
    const hashed = await requireRpc("roo_hash_canonical_documents", {
      p_documents: batch,
    });
    for (const entry of hashed || []) sourceHashes.set(entry.id, entry.hash);
  }
  const source = new Map(
    sourceDocuments.map((document) => [
      document._id,
      { type: document._type, hash: sourceHashes.get(document._id) },
    ])
  );
  const target = new Map((targetManifest || []).map((entry) => [entry.id, entry]));
  const gaps = [];
  for (const [id, entry] of source) {
    const mirrored = target.get(id);
    if (!mirrored || mirrored.tombstoned) {
      gaps.push({ category: "missing_target", id, type: entry.type });
      continue;
    }
    if (mirrored.hash !== entry.hash) {
      gaps.push({ category: "document_hash", id, type: entry.type });
    }
  }
  for (const [id, entry] of target) {
    if (!entry.tombstoned && !source.has(id)) {
      gaps.push({ category: "missing_source", id, type: entry.type });
    }
  }
  return { sourceDocuments, compared: source.size, gaps };
};

const replayQueries = async (documents) => {
  const client = new SupabaseDocumentClient({
    shadowClient: supabase,
    commerceOnly: true,
  });
  const failures = [];
  for (const replay of buildReplayCases(documents)) {
    const [sanityValue, supabaseValue] = await Promise.all([
      sanity.fetch(replay.query, replay.params),
      client.fetch(replay.query, replay.params),
    ]);
    if (hash(canonicalResult(sanityValue)) !== hash(canonicalResult(supabaseValue))) {
      failures.push({ name: replay.name, category: "query_result_mismatch" });
    }
  }
  return failures;
};

const runPass = async (pass) => {
  const comparison = await compareDocuments();
  const queryInventory = inventoryCommerceQueries();
  const [queryFailures, typedSummary, readiness] = await Promise.all([
    replayQueries(comparison.sourceDocuments),
    requireRpc("roo_commerce_typed_gap_summary"),
    requireRpc("roo_commerce_readiness"),
  ]);
  const typedFailures = numericLeafFailures(typedSummary).filter(([path]) =>
    /mismatch|duplicate|unsafe|missing_creator|ambiguous/i.test(path)
  );
  for (const section of ["bookings", "payments", "coupons", "holds", "email_dispatches", "referral_ledger", "refunds"]) {
    const values = typedSummary?.[section] || {};
    const expected = Number(values.source ?? values.expected ?? 0);
    const typed = Number(values.typed ?? 0);
    if (expected !== typed) typedFailures.push([`${section}.count`, typed - expected]);
  }
  const failures = [
    ...comparison.gaps,
    ...queryFailures,
    ...typedFailures.map(([path]) => ({ category: "typed_gap", path })),
    ...queryInventory.unsafe,
  ];
  const evidence = {
    pass,
    comparedDocuments: comparison.compared,
    replayedQueries: buildReplayCases(comparison.sourceDocuments).length,
    inventoriedProductionQueries: queryInventory.count,
    failures: failures.length,
    mirrorPending: Number(readiness?.mirror?.pending || 0),
    capturedWithoutBooking: Number(readiness?.captured_without_booking || 0),
    emailRetries: Number(readiness?.email_retries || 0),
    knownRegressionGates: baseline.excludedFromNewDiscoveryCount.length,
  };
  console.log(JSON.stringify(evidence));
  if (process.argv.includes("--details") && failures.length > 0) {
    const diagnosticClient = new SupabaseDocumentClient({
      shadowClient: supabase,
      commerceOnly: true,
    });
    const sources = new Map(
      comparison.sourceDocuments.map((document) => [document._id, document])
    );
    const failureDetails = [];
    for (const failure of failures) {
      if (failure.category !== "document_hash" || !failure.id) {
        failureDetails.push(failure);
        continue;
      }
      const mirrored = await diagnosticClient.fetch(
        `*[_id == $id][0]{...}`,
        { id: failure.id }
      );
      failureDetails.push({
        ...failure,
        changedPaths: diffPaths(
          canonicalResult(sources.get(failure.id)),
          canonicalResult(mirrored)
        ).sort(),
      });
    }
    console.error(JSON.stringify({ pass, failureDetails }, null, 2));
  }
  return { failures, evidence };
};

const passArgument = process.argv.find((argument) => argument.startsWith("--passes="));
const intervalArgument = process.argv.find((argument) => argument.startsWith("--interval-ms="));
const passes = Math.max(1, Math.min(10, Number(passArgument?.split("=")[1] || 2)));
const intervalMs = Math.max(0, Number(intervalArgument?.split("=")[1] || 0));
let consecutiveZero = 0;
let lastFailures = [];

for (let pass = 1; pass <= passes; pass += 1) {
  const result = await runPass(pass);
  lastFailures = result.failures;
  consecutiveZero = result.failures.length === 0 ? consecutiveZero + 1 : 0;
  if (pass < passes && intervalMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (consecutiveZero < passes) {
  console.error(
    JSON.stringify({
      ok: false,
      consecutiveZero,
      required: passes,
      categories: [...new Set(lastFailures.map((failure) => failure.category))].sort(),
    })
  );
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, consecutiveZero, required: passes }));
}
