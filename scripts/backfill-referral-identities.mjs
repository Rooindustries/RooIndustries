#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { createClient } from "@sanity/client";
import dotenv from "dotenv";
import { buildReferralIdentityClaim } from "../src/server/api/ref/referralIdentity.js";

const args = new Set(process.argv.slice(2));
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
};
const apply = args.has("--apply");
const explicitEnv = valueAfter("--env");

for (const candidate of [explicitEnv, ".env.local", ".vercel/.env.production.local"]) {
  if (candidate && fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false, quiet: true });
  }
}

const env = (...keys) =>
  keys.map((key) => String(process.env[key] || "").trim()).find(Boolean) || "";
const projectId = env("SANITY_PROJECT_ID");
const dataset = env("SANITY_DATASET") || "production";
const token = env("SANITY_WRITE_TOKEN", "SANITY_READ_TOKEN");

if (!projectId || !token) {
  throw new Error("Sanity project and authenticated token are required.");
}
if (apply && !env("SANITY_WRITE_TOKEN")) {
  throw new Error("A Sanity write token is required with --apply.");
}
if (apply && !explicitEnv) {
  throw new Error("--apply requires an explicit --env file.");
}

const client = createClient({
  projectId,
  dataset,
  apiVersion: env("SANITY_API_VERSION") || "2023-10-01",
  token,
  useCdn: false,
  perspective: "published",
});

const referrals = await client.fetch(
  `*[_type == "referral"]{_id,creatorEmail,"slug":slug.current}`
);
const claims = referrals.flatMap((referral) =>
  [
    buildReferralIdentityClaim({
      kind: "email",
      value: referral.creatorEmail,
      referralId: referral._id,
    }),
    buildReferralIdentityClaim({
      kind: "slug",
      value: referral.slug,
      referralId: referral._id,
    }),
  ].filter((claim) => claim._id && claim.referral?._ref)
);

const ownersByClaimId = new Map();
const conflicts = new Set();
for (const claim of claims) {
  const owner = ownersByClaimId.get(claim._id);
  if (owner && owner !== claim.referral._ref) conflicts.add(claim._id);
  else ownersByClaimId.set(claim._id, claim.referral._ref);
}

const claimIds = [...ownersByClaimId.keys()];
const existingClaims = claimIds.length
  ? await client.fetch(
      `*[_type == "referralIdentityClaim" && _id in $ids]{_id,"owner":referral._ref}`,
      { ids: claimIds }
    )
  : [];
const existingOwnersById = new Map(
  existingClaims.map((claim) => [claim._id, claim.owner])
);
for (const [claimId, owner] of ownersByClaimId) {
  const existingOwner = existingOwnersById.get(claimId);
  if (existingOwner && existingOwner !== owner) conflicts.add(claimId);
}

if (conflicts.size > 0) {
  throw new Error("Duplicate referral email or slug identities require manual resolution.");
}

const claimsById = new Map(claims.map((claim) => [claim._id, claim]));
const missingClaimIds = claimIds.filter((id) => !existingOwnersById.has(id));
if (apply) {
  for (let offset = 0; offset < missingClaimIds.length; offset += 100) {
    const transaction = client.transaction();
    missingClaimIds.slice(offset, offset + 100).forEach((id) => {
      transaction.createIfNotExists(claimsById.get(id));
    });
    await transaction.commit({ visibility: "sync" });
  }
}

const claimsPresent = claimIds.length
  ? await client.fetch(
      `count(*[_type == "referralIdentityClaim" && _id in $ids])`,
      { ids: claimIds }
    )
  : 0;
if (apply && claimsPresent !== claimIds.length) {
  throw new Error("Referral identity claim backfill is incomplete.");
}

console.log(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      dataset,
      referralsScanned: referrals.length,
      referralIdentityClaimsToCreate: missingClaimIds.length,
      referralIdentityConflicts: conflicts.size,
      referralIdentityClaimsPresent: claimsPresent,
      passwordRecordsChanged: 0,
      externalDatasetsAccessed: 0,
    },
    null,
    2
  )
);
