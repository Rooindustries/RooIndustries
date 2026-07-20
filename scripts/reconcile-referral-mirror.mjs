#!/usr/bin/env node

import process from "node:process";
import {
  pickReferralCommerceFields,
  pickReferralGeneralFields,
} from "../src/server/commerce/documentTypes.js";
import { drainCommerceMirrorOutbox } from "../src/server/supabase/commerceMirrorOutbox.js";
import { drainDocumentMutationOutbox } from "../src/server/supabase/documentMutationOutbox.js";
import { fetchShadowDocuments } from "../src/server/supabase/shadowStore.js";
import {
  buildMirrorMetadata,
  MIRROR_METADATA_KEYS,
  readMirrorSequence,
} from "../src/server/supabase/mirrorMetadata.js";
import { sha256, stableJson } from "./lib/supabase-shadow-migration.mjs";
import {
  argument,
  argumentsFor,
  assertPausedCommerceControl,
  buildConfirmationDigest,
  createRepairSanityClient,
  createRepairSupabaseClient,
  isValidSanityDocumentId,
  loadRepairEnvironment,
  parseExpectedGeneration,
  requireRpc,
} from "./lib/referral-repair-runtime.mjs";

const apply = process.argv.includes("--apply");
const allReferrals = process.argv.includes("--all");
const envPath = argument("--env");
const expectedGeneration = parseExpectedGeneration(
  argument("--expected-generation")
);
const confirmedDigest = argument("--confirm-digest");
const requestedIds = [
  ...new Set(argumentsFor("--referral-id")),
].sort();

loadRepairEnvironment(envPath);

if (apply && (!envPath || !confirmedDigest)) {
  throw new Error(
    "--apply requires --env and the --confirm-digest printed by a fresh dry run."
  );
}
if (allReferrals === (requestedIds.length > 0)) {
  throw new Error("Select either --all or one or more --referral-id values.");
}
if (
  requestedIds.length > 500 ||
  requestedIds.some((id) => !isValidSanityDocumentId(id))
) {
  throw new Error("Referral mirror targets are invalid or exceed the 500-document limit.");
}

const supabase = createRepairSupabaseClient("roo-referral-mirror-reconciliation");
await assertPausedCommerceControl({ supabase, expectedGeneration });
const sanity = createRepairSanityClient({ requireWrite: apply });

const immutableSanityKeys = new Set([
  "_id",
  "_type",
  "_rev",
  "_createdAt",
  "_updatedAt",
  "_originalId",
  "_system",
]);
const transportKeys = new Set([
  ...MIRROR_METADATA_KEYS,
  "_commerceCutoverGeneration",
]);
const cleanBusinessDocument = (document) =>
  Object.fromEntries(
    Object.entries(document || {}).filter(
      ([key]) => !immutableSanityKeys.has(key) && !transportKeys.has(key)
    )
  );
const projection = (document) => {
  const business = cleanBusinessDocument(document);
  return {
    global: pickReferralGeneralFields(business),
    commerce: pickReferralCommerceFields(business),
  };
};
const projectionDigest = (value) => sha256(stableJson(value));
const normalizeSequence = (value) => {
  const normalized = String(value ?? "0");
  if (!/^\d+$/.test(normalized)) throw new Error("Mirror sequence evidence is invalid.");
  return normalized;
};
const fetchSanityDocuments = async (ids) => {
  if (ids.length < 1) return [];
  return sanity.fetch(
    `*[_id in $ids]`,
    { ids },
    { perspective: "raw" }
  );
};
const readDomainStates = () =>
  requireRpc(supabase, "roo_referral_mirror_domain_state", {
    p_referral_ids: allReferrals ? null : requestedIds,
  });

const inspect = async () => {
  const states = await readDomainStates();
  if (!Array.isArray(states)) {
    throw new Error("Referral mirror state evidence is invalid.");
  }
  if (states.length > 500) {
    throw new Error("Referral mirror state exceeds the 500-document limit.");
  }
  const ids = states.map((state) => String(state?.referral_id || "")).sort();
  if (
    ids.some((id) => !isValidSanityDocumentId(id)) ||
    (!allReferrals && stableJson(ids) !== stableJson(requestedIds))
  ) {
    throw new Error("Referral mirror state did not match the requested targets.");
  }
  const [sourceDocuments, sanityDocuments] = await Promise.all([
    fetchShadowDocuments({
      client: supabase,
      documentTypes: ["referral"],
      ids,
      limit: 500,
      allowLegacyFallback: false,
    }),
    fetchSanityDocuments(ids),
  ]);
  const sourceById = new Map(
    sourceDocuments.map((document) => [String(document?._id || ""), document])
  );
  const sanityById = new Map(
    sanityDocuments.map((document) => [String(document?._id || ""), document])
  );
  return states
    .map((state) => {
      const referralId = String(state.referral_id);
      const source = sourceById.get(referralId);
      const current = sanityById.get(referralId) || null;
      if (
        !source?._id ||
        source._type !== "referral" ||
        String(source._rev || "") !== String(state.source_revision || "")
      ) {
        throw new Error(`Authoritative referral evidence changed for ${referralId}.`);
      }
      const expected = projection(source);
      const actual = projection(current);
      const globalSequence = normalizeSequence(state.global_sequence);
      const commerceSequence = normalizeSequence(state.commerce_sequence);
      const drift = {
        missingBackup: !current,
        globalProjection:
          stableJson(actual.global) !== stableJson(expected.global),
        commerceProjection:
          stableJson(actual.commerce) !== stableJson(expected.commerce),
        globalSequence:
          readMirrorSequence(current, "global").toString() !== globalSequence,
        commerceSequence:
          readMirrorSequence(current, "commerce").toString() !== commerceSequence,
        sourceRevision:
          String(current?._supabaseRevision || "") !==
          String(state.source_revision || ""),
        sourceHash:
          String(current?._supabaseCanonicalHash || "") !==
          String(state.source_hash || ""),
        generation:
          Number(current?._commerceCutoverGeneration) !== expectedGeneration,
      };
      return {
        referralId,
        sourceRevision: String(state.source_revision || ""),
        sourceHash: String(state.source_hash || ""),
        globalSequence,
        commerceSequence,
        sanityRevision: String(current?._rev || ""),
        source,
        current,
        expected,
        actual,
        drift,
        repairable: Object.values(drift).some(Boolean),
      };
    })
    .sort((left, right) => left.referralId.localeCompare(right.referralId));
};

const inspections = await inspect();
const repairShape = {
  expectedGeneration,
  targets: inspections.map((entry) => ({
    referralId: entry.referralId,
    sourceRevision: entry.sourceRevision,
    sourceHash: entry.sourceHash,
    globalSequence: entry.globalSequence,
    commerceSequence: entry.commerceSequence,
    sanityRevision: entry.sanityRevision,
    globalSourceDigest: projectionDigest(entry.expected.global),
    commerceSourceDigest: projectionDigest(entry.expected.commerce),
    globalBackupDigest: projectionDigest(entry.actual.global),
    commerceBackupDigest: projectionDigest(entry.actual.commerce),
    drift: entry.drift,
  })),
};
const digest = buildConfirmationDigest(repairShape);
const repairs = inspections.filter((entry) => entry.repairable);

console.log(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      expectedGeneration,
      inspected: inspections.length,
      drifted: repairs.length,
      referrals: inspections.map((entry) => ({
        referralId: entry.referralId,
        repairable: entry.repairable,
        drift: entry.drift,
      })),
      confirmationDigest: digest,
    },
    null,
    2
  )
);

if (!apply) process.exit(0);
if (confirmedDigest !== digest) {
  throw new Error("The referral mirror evidence changed after the dry run.");
}
if (repairs.length < 1) process.exit(0);

const mirroredAt = new Date().toISOString();
let transaction = sanity.transaction();
for (const repair of repairs) {
  const globalMetadata = buildMirrorMetadata({
    current: repair.current,
    document: repair.source,
    domain: "global",
    sequence: repair.globalSequence,
    revision: repair.sourceRevision,
    canonicalHash: repair.sourceHash,
    mirroredAt,
  });
  const metadata = buildMirrorMetadata({
    current: { ...(repair.current || {}), ...globalMetadata },
    document: repair.source,
    domain: "commerce",
    sequence: repair.commerceSequence,
    revision: repair.sourceRevision,
    canonicalHash: repair.sourceHash,
    mirroredAt,
  });
  const sourceBusiness = cleanBusinessDocument(repair.source);
  const value = {
    ...sourceBusiness,
    ...metadata,
    _commerceCutoverGeneration: expectedGeneration,
  };
  if (!repair.current) {
    transaction = transaction.createIfNotExists({
      _id: repair.referralId,
      _type: "referral",
      ...value,
    });
    continue;
  }
  const unset = Object.keys(repair.current).filter(
    (key) =>
      !immutableSanityKeys.has(key) &&
      !transportKeys.has(key) &&
      !Object.prototype.hasOwnProperty.call(sourceBusiness, key)
  );
  transaction = transaction.patch(repair.referralId, (patch) => {
    const setPatch = patch.ifRevisionId(repair.sanityRevision).set(value);
    return unset.length > 0 ? setPatch.unset(unset) : setPatch;
  });
}
await transaction.commit({ visibility: "sync" });

const repairedIds = repairs.map((entry) => entry.referralId);
const globalDrain = await drainDocumentMutationOutbox({
  supabaseClient: supabase,
  sanityClient: sanity,
  requiredDocumentIds: repairedIds,
  limit: 100,
  maxBatches: 10,
  budgetMs: 60_000,
});
if (
  globalDrain.supported !== true ||
  globalDrain.pending === true ||
  Number(globalDrain.required?.pending || 0) > 0 ||
  Number(globalDrain.required?.dead_letters || 0) > 0
) {
  throw new Error("The global referral mirror queue did not reconcile cleanly.");
}
await drainCommerceMirrorOutbox({
  supabaseClient: supabase,
  sanityClient: sanity,
  failClosed: true,
  requiredDocumentIds: repairedIds,
  limit: 100,
  maxBatches: 10,
});

const verified = await inspect();
const originalById = new Map(
  repairs.map((entry) => [entry.referralId, entry])
);
for (const entry of verified.filter((item) => originalById.has(item.referralId))) {
  const original = originalById.get(entry.referralId);
  const sourceChanged =
    entry.sourceRevision !== original.sourceRevision ||
    entry.sourceHash !== original.sourceHash;
  if (sourceChanged || entry.repairable) {
    throw new Error(`Referral mirror verification failed for ${entry.referralId}.`);
  }
}

console.log(
  JSON.stringify({
    ok: true,
    applied: true,
    reconciled: repairs.length,
    confirmationDigest: digest,
  })
);
