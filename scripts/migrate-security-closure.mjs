#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import crypto from "node:crypto";
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
const projectId = env("SANITY_PRIVATE_PROJECT_ID", "SANITY_PROJECT_ID");
const dataset = env("SANITY_PRIVATE_DATASET", "SANITY_DATASET") || "production";
const indiaDataset = env("SANITY_INDIA_DATASET") || "production-in";
const token = env(
  "SANITY_PRIVATE_WRITE_TOKEN",
  "SANITY_WRITE_TOKEN",
  "SANITY_PRIVATE_READ_TOKEN",
  "SANITY_READ_TOKEN"
);

if (!projectId || !token) {
  throw new Error("Sanity project and authenticated token are required.");
}
if (apply && !env("SANITY_PRIVATE_WRITE_TOKEN", "SANITY_WRITE_TOKEN")) {
  throw new Error("A Sanity write token is required with --apply.");
}
if (apply && !explicitEnv) {
  throw new Error("--apply requires an explicit --env file.");
}

const client = createClient({
  projectId,
  dataset,
  apiVersion: env("SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION") || "2023-10-01",
  token,
  useCdn: false,
  perspective: "published",
});
const indiaClient = client.withConfig({ dataset: indiaDataset });

const INDIA_SENSITIVE_TYPES = [
  "booking",
  "referral",
  "paymentRecord",
  "slotHold",
  "bookingSlot",
  "paymentProofClaim",
  "paymentWebhookReceipt",
  "couponRedemption",
];

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
};

const documentDigest = (document) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(document)))
    .digest("hex");

const assertPrivateDestination = async () => {
  const apiVersion = env("SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION") || "2023-10-01";
  const url = new URL(
    `https://${projectId}.api.sanity.io/v${apiVersion}/data/query/${dataset}`
  );
  url.searchParams.set("query", "count(*)");
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (response.ok && Number(body?.result || 0) > 0) {
    throw new Error("India privacy migration requires the destination dataset to be private.");
  }
};

const indiaSensitiveDocuments = await indiaClient.fetch(
  `*[_type in $types]{_id,_type,_rev}`,
  { types: INDIA_SENSITIVE_TYPES }
);
const indiaCountsByType = Object.fromEntries(
  INDIA_SENSITIVE_TYPES.map((type) => [
    type,
    indiaSensitiveDocuments.filter((document) => document._type === type).length,
  ])
);

const candidates = await client.fetch(
  `*[_type == "referral" && !defined(securityClosureCredentialInvalidatedAt)]{
    _id,
    "hasPassword": defined(creatorPassword),
    "hasResetToken": defined(resetToken) || defined(resetTokenHash)
  }`
);
const referralsForIdentityClaims = await client.fetch(
  `*[_type == "referral"]{_id,creatorEmail,"slug":slug.current}`
);
const identityClaims = referralsForIdentityClaims.flatMap((referral) =>
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
const identityOwners = new Map();
const identityConflicts = [];
for (const claim of identityClaims) {
  const owner = identityOwners.get(claim._id);
  if (owner && owner !== claim.referral._ref) {
    identityConflicts.push(claim._id);
  } else {
    identityOwners.set(claim._id, claim.referral._ref);
  }
}
const identityClaimIds = [...identityOwners.keys()];
const existingIdentityClaims = identityClaimIds.length
  ? await client.fetch(
      `*[_type == "referralIdentityClaim" && _id in $ids]{_id,"owner":referral._ref}`,
      { ids: identityClaimIds }
    )
  : [];
const existingIdentityById = new Map(
  existingIdentityClaims.map((claim) => [claim._id, claim.owner])
);
for (const [claimId, owner] of identityOwners) {
  const existingOwner = existingIdentityById.get(claimId);
  if (existingOwner && existingOwner !== owner) identityConflicts.push(claimId);
}

const summary = {
  mode: apply ? "apply" : "dry-run",
  dataset,
  referralsToInvalidate: candidates.length,
  passwordHashesToInvalidate: candidates.filter((entry) => entry.hasPassword).length,
  activeResetTokensToInvalidate: candidates.filter((entry) => entry.hasResetToken).length,
  referralIdentityClaimsToCreate: identityClaimIds.filter(
    (id) => !existingIdentityById.has(id)
  ).length,
  referralIdentityConflicts: new Set(identityConflicts).size,
  indiaSensitiveDocumentsToMove: indiaSensitiveDocuments.length,
  indiaCountsByType,
};

if (identityConflicts.length > 0) {
  throw new Error("Duplicate referral email or slug identities require manual resolution.");
}

if (apply && candidates.length > 0) {
  const invalidatedAt = new Date().toISOString();
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const transaction = client.transaction();
    candidates.slice(offset, offset + 100).forEach(({ _id }) => {
      transaction.patch(_id, (patch) =>
        patch
          .set({
            passwordResetRequired: true,
            credentialVersion: 2,
            securityClosureCredentialInvalidatedAt: invalidatedAt,
          })
          .unset([
            "creatorPassword",
            "resetToken",
            "resetTokenHash",
            "resetTokenExpiresAt",
          ])
      );
    });
    await transaction.commit();
  }
}

if (apply && identityClaimIds.length > 0) {
  const claimsById = new Map(identityClaims.map((claim) => [claim._id, claim]));
  for (let offset = 0; offset < identityClaimIds.length; offset += 100) {
    const transaction = client.transaction();
    identityClaimIds.slice(offset, offset + 100).forEach((id) => {
      transaction.createIfNotExists(claimsById.get(id));
    });
    await transaction.commit();
  }
}

if (apply && indiaSensitiveDocuments.length > 0) {
  await assertPrivateDestination();
  const privacyMigratedAt = new Date().toISOString();

  for (const candidate of indiaSensitiveDocuments) {
    const source = await indiaClient.getDocument(candidate._id);
    if (!source || source._rev !== candidate._rev) {
      throw new Error("An India source document changed during privacy migration.");
    }
    const inboundReferences = await indiaClient.fetch(
      `count(*[_id != $id && references($id)])`,
      { id: source._id }
    );
    if (Number(inboundReferences || 0) > 0) {
      throw new Error("An India sensitive document still has inbound references.");
    }

    const sourceDigest = documentDigest(source);
    const existing = await client.getDocument(source._id);
    if (
      existing &&
      (existing.privacySourceDataset !== indiaDataset ||
        existing.privacySourceDigest !== sourceDigest)
    ) {
      throw new Error("A destination document collision blocked India privacy migration.");
    }

    if (!existing) {
      const {
        _rev,
        _createdAt,
        _updatedAt,
        ...portableDocument
      } = source;
      await client.create({
        ...portableDocument,
        privacySourceDataset: indiaDataset,
        privacySourceRevision: _rev,
        privacySourceCreatedAt: _createdAt,
        privacySourceUpdatedAt: _updatedAt,
        privacySourceDigest: sourceDigest,
        privacyMigratedAt,
      });
    }

    const verified = await client.getDocument(source._id);
    if (
      verified?.privacySourceDataset !== indiaDataset ||
      verified?.privacySourceDigest !== sourceDigest
    ) {
      throw new Error("India privacy migration could not verify the private copy.");
    }
    await indiaClient.delete({
      query: "*[_id == $id && _rev == $revision]",
      params: { id: source._id, revision: source._rev },
    });
    if (await indiaClient.getDocument(source._id)) {
      throw new Error("An India source document changed before it could be removed.");
    }
  }
}

const remaining = await client.fetch(
  `count(*[_type == "referral" && !defined(securityClosureCredentialInvalidatedAt)])`
);
if (apply && remaining !== 0) {
  throw new Error(`Credential invalidation incomplete: ${remaining} referrals remain.`);
}

const indiaSensitiveRemaining = await indiaClient.fetch(
  `count(*[_type in $types])`,
  { types: INDIA_SENSITIVE_TYPES }
);
const referralIdentityClaimsRemaining = identityClaimIds.length
  ? await client.fetch(
      `count(*[_type == "referralIdentityClaim" && _id in $ids])`,
      { ids: identityClaimIds }
    )
  : 0;
if (apply && referralIdentityClaimsRemaining !== identityClaimIds.length) {
  throw new Error("Referral identity claim backfill is incomplete.");
}
if (apply && indiaSensitiveRemaining !== 0) {
  throw new Error(
    `India privacy migration incomplete: ${indiaSensitiveRemaining} documents remain.`
  );
}

console.log(
  JSON.stringify(
    {
      ...summary,
      remainingUnprocessed: remaining,
      referralIdentityClaimsPresent: referralIdentityClaimsRemaining,
      indiaSensitiveDocumentsRemaining: indiaSensitiveRemaining,
    },
    null,
    2
  )
);
