#!/usr/bin/env node

import process from "node:process";
import { drainCommerceMirrorOutbox } from "../src/server/supabase/commerceMirrorOutbox.js";
import { SupabaseDocumentClient } from "../src/server/supabase/documentClient.js";
import { stableJson } from "./lib/supabase-shadow-migration.mjs";
import {
  argument,
  assertPausedCommerceControl,
  buildConfirmationDigest,
  createRepairSanityClient,
  createRepairSupabaseClient,
  loadRepairEnvironment,
  parseExpectedGeneration,
  requireRpc,
} from "./lib/referral-repair-runtime.mjs";

const apply = process.argv.includes("--apply");
const auditAll = process.argv.includes("--audit-all");
const envPath = argument("--env");
const expectedGeneration = parseExpectedGeneration(
  argument("--expected-generation")
);
const confirmedDigest = argument("--confirm-digest");
const requestedReferralId = argument("--referral-id");
const requestedDomain = argument("--domain").toLowerCase();
const requestedSequence = argument("--sequence-no");

loadRepairEnvironment(envPath);

if (apply && (!envPath || !confirmedDigest)) {
  throw new Error(
    "--apply requires --env and the --confirm-digest printed by a fresh dry run."
  );
}
if (auditAll && (requestedReferralId || requestedDomain || requestedSequence)) {
  throw new Error("--audit-all cannot be combined with targeted snapshot flags.");
}
if (!auditAll) {
  if (!/^referral[.][A-Za-z0-9_-]{1,120}$/.test(requestedReferralId)) {
    throw new Error("--referral-id must identify one referral document.");
  }
  if (!["global", "commerce"].includes(requestedDomain)) {
    throw new Error("--domain must be global or commerce.");
  }
  if (!/^\d+$/.test(requestedSequence) || BigInt(requestedSequence) < 1n) {
    throw new Error("--sequence-no must be a positive integer.");
  }
}

const supabase = createRepairSupabaseClient("roo-referral-accounting-repair");
await assertPausedCommerceControl({ supabase, expectedGeneration });
const documents = new SupabaseDocumentClient({
  shadowClient: supabase,
  commerceOnly: true,
  cutoverGeneration: expectedGeneration,
});

const sortedStrings = (value) =>
  [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort();

const readSnapshot = (referralId, domain, sequenceNo) =>
  requireRpc(supabase, "roo_referral_recovery_snapshot", {
    p_referral_id: referralId,
    p_domain: domain,
    p_sequence_no: sequenceNo,
  });

const buildRepair = async ({
  referralId,
  domain,
  sequenceNo,
  expectedRevision = "",
  expectedAccountingDigest = "",
  requestedMissingKeys = null,
  unambiguous = true,
  blockedReason = "",
}) => {
  const [current, snapshot] = await Promise.all([
    documents.getDocument(referralId),
    readSnapshot(referralId, domain, sequenceNo),
  ]);
  if (!current?._id || !current._rev) {
    throw new Error(`Current referral source is unavailable for ${referralId}.`);
  }
  const snapshotMatches =
    String(snapshot?.referral_id || "") === referralId &&
    String(snapshot?.domain || "") === domain &&
    String(snapshot?.sequence_no || "") === String(sequenceNo);
  if (!snapshotMatches) {
    throw new Error(`Recovery evidence did not match ${referralId}.`);
  }
  const accounting = snapshot?.accounting || {};
  const snapshotKeys = sortedStrings(snapshot?.accounting_keys);
  const requestedKeys = requestedMissingKeys
    ? sortedStrings(requestedMissingKeys)
    : snapshotKeys;
  const missingKeys = requestedKeys.filter(
    (key) =>
      Object.prototype.hasOwnProperty.call(accounting, key) &&
      !Object.prototype.hasOwnProperty.call(current, key)
  );
  const eventStatus = String(snapshot?.event_status || "");
  const settled =
    domain === "global"
      ? eventStatus === "applied"
      : ["mirrored", "superseded"].includes(eventStatus);
  const sourceMatches =
    (!expectedRevision || current._rev === expectedRevision) &&
    (!expectedAccountingDigest ||
      snapshot?.accounting_digest === expectedAccountingDigest) &&
    settled;
  const repairable =
    unambiguous && sourceMatches && !blockedReason && missingKeys.length > 0;
  return {
    referralId,
    domain,
    sequenceNo: String(sequenceNo),
    currentRevision: current._rev,
    eventKey: String(snapshot?.event_key || ""),
    eventStatus: String(snapshot?.event_status || ""),
    eventCreatedAt: String(snapshot?.event_created_at || ""),
    accountingDigest: String(snapshot?.accounting_digest || ""),
    missingKeys,
    repairable,
    blockedReason:
      blockedReason ||
      (!unambiguous
        ? "later_accounting_change"
        : !sourceMatches
          ? "evidence_changed"
          : missingKeys.length < 1
            ? "no_missing_keys"
            : ""),
    accounting,
  };
};

const loadRepairs = async () => {
  if (!auditAll) {
    return [
      await buildRepair({
        referralId: requestedReferralId,
        domain: requestedDomain,
        sequenceNo: requestedSequence,
      }),
    ];
  }
  const candidates = await requireRpc(
    supabase,
    "roo_referral_accounting_loss_candidates"
  );
  const repairs = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const unambiguous = candidate?.unambiguous === true;
    repairs.push(
      await buildRepair({
        referralId: String(candidate?.referral_id || ""),
        domain: String(candidate?.suggested_domain || ""),
        sequenceNo: String(candidate?.suggested_sequence_no || ""),
        expectedRevision: String(candidate?.current_revision || ""),
        expectedAccountingDigest: String(
          candidate?.suggested_accounting_digest || ""
        ),
        requestedMissingKeys: candidate?.missing_accounting_keys,
        unambiguous,
        blockedReason:
          Number(candidate?.later_accounting_change_count || 0) > 0
            ? "later_accounting_change"
            : "",
      })
    );
  }
  return repairs;
};

const repairs = (await loadRepairs()).sort((left, right) =>
  left.referralId.localeCompare(right.referralId)
);
const repairShape = {
  expectedGeneration,
  auditAll,
  repairs: repairs.map((repair) => ({
    referralId: repair.referralId,
    domain: repair.domain,
    sequenceNo: repair.sequenceNo,
    currentRevision: repair.currentRevision,
    eventKey: repair.eventKey,
    eventStatus: repair.eventStatus,
    eventCreatedAt: repair.eventCreatedAt,
    accountingDigest: repair.accountingDigest,
    missingKeys: repair.missingKeys,
    repairable: repair.repairable,
    blockedReason: repair.blockedReason,
  })),
};
const digest = buildConfirmationDigest(repairShape);
const applicable = repairs.filter((repair) => repair.repairable);

console.log(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      auditAll,
      expectedGeneration,
      candidates: repairs.length,
      repairable: applicable.length,
      blocked: repairs.length - applicable.length,
      referrals: repairs.map((repair) => ({
        referralId: repair.referralId,
        domain: repair.domain,
        sequenceNo: repair.sequenceNo,
        missingKeys: repair.missingKeys,
        repairable: repair.repairable,
        blockedReason: repair.blockedReason || null,
      })),
      confirmationDigest: digest,
    },
    null,
    2
  )
);

if (!apply) process.exit(0);
if (confirmedDigest !== digest) {
  throw new Error("The referral recovery evidence changed after the dry run.");
}
if (applicable.length < 1) process.exit(0);

const sanity = createRepairSanityClient({ requireWrite: true });
let transaction = documents.transaction();
for (const repair of applicable) {
  const patch = Object.fromEntries(
    repair.missingKeys.map((key) => [key, repair.accounting[key]])
  );
  transaction = transaction.patch(repair.referralId, (builder) =>
    builder.ifRevisionId(repair.currentRevision).set(patch)
  );
}
await transaction.commit({
  commandId: `referral-accounting-repair:${digest.slice(0, 48)}`,
});

await drainCommerceMirrorOutbox({
  supabaseClient: supabase,
  sanityClient: sanity,
  failClosed: true,
  requiredDocumentIds: applicable.map((repair) => repair.referralId),
  limit: 100,
  maxBatches: 10,
});

for (const repair of applicable) {
  const current = await documents.getDocument(repair.referralId);
  const restored = repair.missingKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(current || {}, key) &&
      stableJson(current[key]) === stableJson(repair.accounting[key])
  );
  if (!restored) {
    throw new Error(`Referral accounting verification failed for ${repair.referralId}.`);
  }
}

console.log(
  JSON.stringify({
    ok: true,
    applied: true,
    repaired: applicable.length,
    confirmationDigest: digest,
  })
);
