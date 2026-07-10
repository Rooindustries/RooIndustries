#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { createClient } from "@sanity/client";
import dotenv from "dotenv";

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
};
const explicitEnv = valueAfter("--env");
const prePrivate = process.argv.includes("--pre-private");
for (const candidate of [explicitEnv, ".env.local", ".vercel/.env.production.local"]) {
  if (candidate && fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false, quiet: true });
  }
}

const env = (...keys) =>
  keys.map((key) => String(process.env[key] || "").trim()).find(Boolean) || "";
const projectId = env("SANITY_PRIVATE_PROJECT_ID", "SANITY_PROJECT_ID");
const dataset = env("SANITY_PRIVATE_DATASET", "SANITY_DATASET") || "production";
const indiaDataset = env("SANITY_INDIA_DATASET") || "production-in";
const token = env(
  "SANITY_PRIVATE_READ_TOKEN",
  "SANITY_READ_TOKEN",
  "SANITY_PRIVATE_WRITE_TOKEN",
  "SANITY_WRITE_TOKEN"
);
if (!projectId || !token) throw new Error("Authenticated Sanity read access is required.");

const apiVersion = env("SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION") || "2023-10-01";
const anonymousQueryUrl = new URL(
  `https://${projectId}.api.sanity.io/v${apiVersion}/data/query/${dataset}`
);
anonymousQueryUrl.searchParams.set("query", "count(*)");
const anonymousResponse = await fetch(anonymousQueryUrl, {
  headers: { accept: "application/json" },
  cache: "no-store",
});
let anonymousCount = null;
try {
  const payload = await anonymousResponse.json();
  if (Number.isFinite(Number(payload?.result))) anonymousCount = Number(payload.result);
} catch {}

const anonymousReadable = anonymousResponse.ok && Number(anonymousCount || 0) > 0;
if (!prePrivate && anonymousReadable) {
  throw new Error("The production Sanity dataset is still anonymously readable.");
}

const indiaClient = createClient({
  projectId,
  dataset: indiaDataset,
  apiVersion,
  token,
  useCdn: false,
  perspective: "published",
});
const sensitiveTypes = [
  "booking",
  "referral",
  "paymentRecord",
  "slotHold",
  "bookingSlot",
  "paymentProofClaim",
  "paymentWebhookReceipt",
  "couponRedemption",
];
const indiaCounts = await indiaClient.fetch(
  `{ "sensitive": count(*[_type in $types]), "coupons": count(*[_type == "coupon"]) }`,
  { types: sensitiveTypes }
);
if (Number(indiaCounts?.sensitive || 0) !== 0) {
  throw new Error("The India dataset contains commerce or customer records.");
}

console.log(
  JSON.stringify(
    {
      productionAnonymousAccess: anonymousReadable ? "readable" : "blocked",
      productionAnonymousStatus: anonymousResponse.status,
      indiaSensitiveDocuments: Number(indiaCounts?.sensitive || 0),
      indiaCouponBaseline: Number(indiaCounts?.coupons || 0),
    },
    null,
    2
  )
);
