#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createClient } from "@sanity/client";
import dotenv from "dotenv";

const args = new Set(process.argv.slice(2));
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
};

const apply = args.has("--apply");
const inspectProviders = args.has("--inspect-providers");
const snapshotPath = valueAfter("--snapshot");
const confirmedSnapshotPath = valueAfter("--confirmed-snapshot");
const reconcileUrl = valueAfter("--reconcile-url");
const explicitEnvPath = valueAfter("--env");

for (const candidate of [
  explicitEnvPath,
  ".env.local",
  ".vercel/.env.production.local",
]) {
  if (candidate && fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false, quiet: true });
  }
}

const readEnv = (...keys) =>
  keys.map((key) => String(process.env[key] || "").trim()).find(Boolean) || "";

const projectId = readEnv("SANITY_PRIVATE_PROJECT_ID", "SANITY_PROJECT_ID");
const dataset = readEnv("SANITY_PRIVATE_DATASET", "SANITY_DATASET") || "production";
const apiVersion =
  readEnv("SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION") || "2023-10-01";
const token = readEnv(
  "SANITY_PRIVATE_WRITE_TOKEN",
  "SANITY_WRITE_TOKEN",
  "SANITY_PRIVATE_READ_TOKEN",
  "SANITY_READ_TOKEN"
);

if (!projectId || !token) {
  throw new Error("Sanity project and token environment variables are required.");
}
if (apply && !readEnv("SANITY_PRIVATE_WRITE_TOKEN", "SANITY_WRITE_TOKEN")) {
  throw new Error("A Sanity write token is required with --apply.");
}
if (apply && !explicitEnvPath) {
  throw new Error("--apply requires an explicit --env file.");
}
if (apply && !inspectProviders) {
  throw new Error("--apply requires --inspect-providers.");
}
if (apply && !reconcileUrl) {
  throw new Error("--apply requires --reconcile-url.");
}
if (apply && !confirmedSnapshotPath) {
  throw new Error("--apply requires --confirmed-snapshot from the production dry run.");
}

const client = createClient({
  projectId,
  dataset,
  apiVersion,
  token,
  useCdn: false,
  perspective: "published",
});

const now = new Date();
const nowIso = now.toISOString();
const hash = (value, length) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
const digestDocuments = (documents) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(Array.isArray(documents) ? documents : []))
    .digest("hex");
const normalize = (value) => String(value || "").trim();
const normalizeLower = (value) => normalize(value).toLowerCase();
const normalizeIso = (value) => {
  const parsed = new Date(value || "");
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
};
const canonicalBookingStatus = (value) => {
  const status = normalizeLower(value);
  if (status === "canceled") return "cancelled";
  if (["pending", "captured", "completed", "failed", "refunded", "cancelled"].includes(status)) {
    return status;
  }
  return "pending";
};
const blocksSlot = (status) =>
  ["pending", "captured", "completed"].includes(canonicalBookingStatus(status));
const bookingSlotId = (value) => {
  const startTimeUTC = normalizeIso(value);
  return startTimeUTC ? `bookingSlot.${hash(startTimeUTC, 24)}` : "";
};
const paymentProofClaimId = (record) => {
  const provider = normalizeLower(record?.provider) || "unknown";
  const proof =
    provider === "razorpay"
      ? normalize(record?.providerPaymentId)
      : normalize(record?.providerOrderId || record?.providerPaymentId);
  return proof ? `paymentProofClaim.${provider}.${hash(proof, 40)}` : "";
};

const TYPES = [
  "booking",
  "slotHold",
  "coupon",
  "referral",
  "paymentRecord",
  "paymentProofClaim",
  "bookingSlot",
  "couponRedemption",
  "paymentStartClaim",
  "paymentUpgradeLock",
  "paymentWebhookReceipt",
  "paymentRecoveryCase",
  "bookingRecoveryCase",
];

const writeSnapshot = (documents) => {
  if (!snapshotPath) return false;
  const destination = path.resolve(snapshotPath);
  const root = path.resolve(process.cwd());
  if (destination === root || destination.startsWith(`${root}${path.sep}`)) {
    throw new Error("The migration snapshot must be stored outside the repository.");
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const payload = {
    generatedAt: nowIso,
    projectId,
    dataset,
    documentCount: documents.length,
    documentDigest: digestDocuments(documents),
    documents,
  };
  fs.writeFileSync(destination, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return true;
};

const verifyConfirmedSnapshot = () => {
  if (!confirmedSnapshotPath) return false;
  const source = path.resolve(confirmedSnapshotPath);
  if (!fs.existsSync(source)) {
    throw new Error("The confirmed migration snapshot does not exist.");
  }
  const snapshot = JSON.parse(fs.readFileSync(source, "utf8"));
  if (snapshot.projectId !== projectId || snapshot.dataset !== dataset) {
    throw new Error("The confirmed snapshot targets a different Sanity dataset.");
  }
  if (!Array.isArray(snapshot.documents) || !snapshot.generatedAt) {
    throw new Error("The confirmed migration snapshot is invalid.");
  }
  if (
    snapshot.documentCount !== snapshot.documents.length ||
    snapshot.documentDigest !== digestDocuments(snapshot.documents)
  ) {
    throw new Error("The confirmed migration snapshot failed its integrity check.");
  }
  const generatedAt = new Date(snapshot.generatedAt).getTime();
  const ageMs = Date.now() - generatedAt;
  if (
    !Number.isFinite(generatedAt) ||
    ageMs < -5 * 60 * 1000 ||
    ageMs > 6 * 60 * 60 * 1000
  ) {
    throw new Error("The confirmed migration snapshot is stale; run a new dry run.");
  }
  return true;
};

const indexBookings = (bookings) => {
  const byId = new Map();
  const byPayPalOrder = new Map();
  const byRazorpayOrder = new Map();
  const byRazorpayPayment = new Map();
  for (const booking of bookings) {
    byId.set(booking._id, booking);
    if (booking.paypalOrderId) byPayPalOrder.set(normalize(booking.paypalOrderId), booking);
    if (booking.razorpayOrderId) {
      byRazorpayOrder.set(normalize(booking.razorpayOrderId), booking);
    }
    if (booking.razorpayPaymentId) {
      byRazorpayPayment.set(normalize(booking.razorpayPaymentId), booking);
    }
  }
  return { byId, byPayPalOrder, byRazorpayOrder, byRazorpayPayment };
};

const findBookingForPayment = (record, indexes) => {
  const explicitId = normalize(record.bookingId);
  if (explicitId && indexes.byId.has(explicitId)) return indexes.byId.get(explicitId);
  if (normalizeLower(record.provider) === "paypal") {
    return indexes.byPayPalOrder.get(normalize(record.providerOrderId)) || null;
  }
  return (
    indexes.byRazorpayPayment.get(normalize(record.providerPaymentId)) ||
    indexes.byRazorpayOrder.get(normalize(record.providerOrderId)) ||
    null
  );
};

const paymentScore = ({ record, booking }) => {
  let score = 0;
  if (booking?._id) score += 100;
  if (normalize(record.bookingId) === booking?._id) score += 30;
  if (record.bookingPayload?.startTimeUTC) score += 10;
  if (record.bookingPayload?.email) score += 5;
  if (["booked", "email_partial", "refunded"].includes(normalizeLower(record.status))) {
    score += 20;
  }
  if (record._id.includes(".order.")) score += 2;
  return score;
};

const buildPlan = ({ bookings, payments, holds, coupons, existingLocks, existingClaims }) => {
  const bookingIndexes = indexBookings(bookings);
  const locksById = new Map(existingLocks.map((doc) => [doc._id, doc]));
  const claimsById = new Map(existingClaims.map((doc) => [doc._id, doc]));
  const paymentMatches = new Map();
  const proofGroups = new Map();

  for (const record of payments) {
    const booking = findBookingForPayment(record, bookingIndexes);
    paymentMatches.set(record._id, booking);
    const claimId = paymentProofClaimId(record);
    const status = normalizeLower(record.status);
    const capturedEvidence =
      !!booking?._id ||
      !!normalize(record.providerPaymentId) ||
      [
        "captured_client",
        "captured_webhook",
        "finalizing",
        "booked",
        "email_partial",
        "refunded",
      ].includes(status);
    if (!claimId || !capturedEvidence) continue;
    const group = proofGroups.get(claimId) || [];
    group.push({ record, booking });
    proofGroups.set(claimId, group);
  }

  const canonicalByRecordId = new Map();
  const claimsToCreate = [];
  for (const [claimId, group] of proofGroups) {
    const ranked = [...group].sort(
      (a, b) => paymentScore(b) - paymentScore(a) || a.record._id.localeCompare(b.record._id)
    );
    const canonical = ranked[0];
    for (const entry of group) canonicalByRecordId.set(entry.record._id, canonical);
    if (!claimsById.has(claimId)) {
      claimsToCreate.push({
        _id: claimId,
        _type: "paymentProofClaim",
        paymentRecordId: canonical.record._id,
        provider: normalizeLower(canonical.record.provider),
        providerOrderId: normalize(canonical.record.providerOrderId),
        providerPaymentId: normalize(canonical.record.providerPaymentId),
        bookingId: normalize(canonical.booking?._id),
        status: canonical.booking?._id ? "claimed" : "reserved",
        claimedAt: nowIso,
        migratedAt: nowIso,
      });
    }
  }

  const bookingPatches = [];
  const locksToCreate = [];
  const lockPatches = [];
  const slotConflicts = [];
  for (const booking of bookings) {
    const values = {};
    const status = canonicalBookingStatus(booking.status);
    if (status !== booking.status) values.status = status;
    const startTimeUTC = normalizeIso(booking.startTimeUTC);
    if (startTimeUTC && startTimeUTC !== booking.startTimeUTC) values.startTimeUTC = startTimeUTC;
    const isFuture = !!startTimeUTC && new Date(startTimeUTC).getTime() > now.getTime();
    const isUpgrade = !!normalize(booking.originalOrderId);
    if (isUpgrade) {
      if (booking.slotLockId) values.slotLockId = "";
      const legacyLockId = normalize(booking.slotLockId) || bookingSlotId(startTimeUTC);
      const legacyLock = locksById.get(legacyLockId);
      if (
        legacyLock?._id &&
        legacyLock.bookingId === booking._id &&
        legacyLock.status !== "released"
      ) {
        lockPatches.push({
          document: legacyLock,
          values: {
            status: "released",
            releasedAt: nowIso,
            releaseReason: "upgrade_booking_has_no_slot_lock",
          },
        });
      }
    } else if (isFuture && blocksSlot(status)) {
      const lockId = bookingSlotId(startTimeUTC);
      if (booking.slotLockId !== lockId) values.slotLockId = lockId;
      const existing = locksById.get(lockId);
      if (!existing) {
        const plannedLock = {
          _id: lockId,
          _type: "bookingSlot",
          bookingId: booking._id,
          startTimeUTC,
          status: "active",
          lockedAt: nowIso,
          migrationVersion: 1,
        };
        locksToCreate.push(plannedLock);
        locksById.set(lockId, plannedLock);
      } else if (existing.status === "released") {
        const reactivated = {
          ...existing,
          bookingId: booking._id,
          startTimeUTC,
          status: "active",
          releasedAt: "",
          releaseReason: "",
          lockedAt: nowIso,
        };
        lockPatches.push({
          document: existing,
          values: {
            bookingId: booking._id,
            startTimeUTC,
            status: "active",
            releasedAt: "",
            releaseReason: "",
            lockedAt: nowIso,
          },
        });
        locksById.set(lockId, reactivated);
      } else if (existing.bookingId !== booking._id && existing.status !== "released") {
        slotConflicts.push(lockId);
      }
    }
    if (Object.keys(values).length) bookingPatches.push({ document: booking, values });
  }

  const paymentPatches = [];
  for (const record of payments) {
    const booking = paymentMatches.get(record._id);
    const canonical = canonicalByRecordId.get(record._id);
    const values = {};
    if (booking?._id && normalize(record.bookingId) !== booking._id) {
      values.bookingId = booking._id;
    }
    if (booking?._id && canonical?.record?._id && canonical.record._id !== record._id) {
      values.canonicalPaymentRecordId = canonical.record._id;
      values.duplicatePaymentRecord = true;
    }
    const proofClaimId = canonical ? paymentProofClaimId(canonical.record) : "";
    if (proofClaimId && record.paymentProofClaimId !== proofClaimId) {
      values.paymentProofClaimId = proofClaimId;
    }
    const emailsSent =
      !!booking?.emailDispatchClientSentAt && !!booking?.emailDispatchOwnerSentAt;
    const status = normalizeLower(record.status);
    if (booking?._id && emailsSent && ["email_partial", "needs_recovery"].includes(status)) {
      values.status = "booked";
      values.recoveryReason = "";
      values.nextRecoveryAt = "";
      values.emailDispatchRequired = false;
    } else if (
      !record.nextRecoveryAt &&
      ["started", "captured_client", "captured_webhook", "finalizing", "needs_recovery"].includes(status)
    ) {
      values.nextRecoveryAt = nowIso;
    } else if (status === "email_partial" && !emailsSent && !record.nextRecoveryAt) {
      values.nextRecoveryAt = nowIso;
      values.recoveryReason = "email_dispatch_pending";
      values.emailDispatchRequired = true;
    }
    if (Object.keys(values).length) {
      values.migrationVersion = 1;
      values.migratedAt = nowIso;
      paymentPatches.push({ document: record, values });
    }
  }

  const bookingPaymentOwner = new Map();
  for (const record of payments) {
    const canonical = canonicalByRecordId.get(record._id)?.record || record;
    const booking = paymentMatches.get(record._id);
    if (booking?._id && !bookingPaymentOwner.has(booking._id)) {
      bookingPaymentOwner.set(booking._id, canonical._id);
    }
  }
  for (const booking of bookings) {
    const ownerId = bookingPaymentOwner.get(booking._id);
    if (ownerId && booking.paymentRecordId !== ownerId) {
      const existing = bookingPatches.find((entry) => entry.document._id === booking._id);
      if (existing) existing.values.paymentRecordId = ownerId;
      else bookingPatches.push({ document: booking, values: { paymentRecordId: ownerId } });
    }
  }

  const couponPatches = coupons
    .filter((coupon) => !Number.isFinite(Number(coupon.activeReservations)))
    .map((coupon) => ({ document: coupon, values: { activeReservations: 0 } }));

  const paymentById = new Map(payments.map((record) => [record._id, record]));
  const terminalPaymentStatuses = new Set([
    "booked",
    "email_partial",
    "refunded",
    "abandoned",
    "failed",
  ]);
  const holdPatches = [];
  const holdsToDelete = [];
  for (const hold of holds) {
    const linked = paymentById.get(normalize(hold.paymentRecordId));
    const linkedStatus = normalizeLower(linked?.status);
    const expiryMs = new Date(hold.expiresAt || "").getTime();
    const expired = !Number.isFinite(expiryMs) || expiryMs <= now.getTime();
    const phase = normalizeLower(hold.phase);
    const values = {};
    if (linked && ["booked", "email_partial", "refunded"].includes(linkedStatus)) {
      if (phase !== "consumed") values.phase = "consumed";
      if (!hold.consumedAt) values.consumedAt = linked.updatedAt || nowIso;
    } else if (linked && ["abandoned", "failed"].includes(linkedStatus)) {
      if (phase !== "released") values.phase = "released";
      if (!hold.releasedAt) values.releasedAt = linked.updatedAt || nowIso;
    }
    const resultingPhase = normalizeLower(values.phase || phase);
    const linkedPending = linked && !terminalPaymentStatuses.has(linkedStatus);
    const terminal = ["released", "consumed"].includes(resultingPhase) || !linked;
    if (expired && terminal && !linkedPending) {
      holdsToDelete.push(hold);
    } else if (Object.keys(values).length) {
      holdPatches.push({ document: hold, values });
    }
  }

  return {
    bookingPatches,
    locksToCreate,
    lockPatches,
    slotConflicts,
    claimsToCreate,
    paymentPatches,
    couponPatches,
    holdPatches,
    holdsToDelete,
  };
};

const patchAtRevision = async ({ document, values }) => {
  let patch = client.patch(document._id);
  if (document._rev) patch = patch.ifRevisionId(document._rev);
  return patch.set(values).commit({ visibility: "sync" });
};

const applyPlan = async (plan) => {
  for (const document of [...plan.claimsToCreate, ...plan.locksToCreate]) {
    await client.createIfNotExists(document);
  }
  for (const entry of [
    ...plan.bookingPatches,
    ...plan.lockPatches,
    ...plan.paymentPatches,
    ...plan.couponPatches,
    ...plan.holdPatches,
  ]) {
    await patchAtRevision(entry);
  }
  for (const hold of plan.holdsToDelete) {
    await client.delete({
      query: `*[_type == "slotHold" && _id == $id && _rev == $rev]`,
      params: { id: hold._id, rev: hold._rev },
    });
  }
};

let payPalAccessToken = "";
const getPayPalAccessToken = async () => {
  if (payPalAccessToken) return payPalAccessToken;
  const id = readEnv("PAYPAL_CLIENT_ID", "NEXT_PUBLIC_PAYPAL_CLIENT_ID");
  const secret = readEnv("PAYPAL_CLIENT_SECRET");
  if (!id || !secret) throw new Error("PayPal credentials are unavailable.");
  const base = normalizeLower(process.env.PAYPAL_ENV) === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";
  const response = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(`PayPal auth failed (${response.status}).`);
  payPalAccessToken = body.access_token;
  return payPalAccessToken;
};

const inspectProviderOrder = async (record) => {
  const provider = normalizeLower(record.provider);
  const orderId = normalize(record.providerOrderId);
  if (!orderId) return "unavailable";
  try {
    if (provider === "razorpay") {
      const id = readEnv("RAZORPAY_KEY_ID");
      const secret = readEnv("RAZORPAY_KEY_SECRET");
      if (!id || !secret) return "unavailable";
      const response = await fetch(
        `https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}/payments`,
        { headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` } }
      );
      if (!response.ok) return "unavailable";
      const body = await response.json().catch(() => ({}));
      const payments = Array.isArray(body.items) ? body.items : [];
      if (payments.some((payment) => normalizeLower(payment.status) === "captured")) return "captured";
      if (payments.some((payment) => ["created", "authorized"].includes(normalizeLower(payment.status)))) {
        return "pending";
      }
      return "unpaid";
    }
    if (provider === "paypal") {
      const base = normalizeLower(process.env.PAYPAL_ENV) === "sandbox"
        ? "https://api-m.sandbox.paypal.com"
        : "https://api-m.paypal.com";
      const response = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
        headers: { Authorization: `Bearer ${await getPayPalAccessToken()}` },
      });
      if (!response.ok) return "unavailable";
      const body = await response.json().catch(() => ({}));
      const status = normalize(body.status).toUpperCase();
      if (status === "COMPLETED") return "captured";
      if (["APPROVED", "PAYER_ACTION_REQUIRED", "SAVED"].includes(status)) return "pending";
      if (["CREATED", "VOIDED"].includes(status)) return "unpaid";
    }
  } catch {
    return "unavailable";
  }
  return "unavailable";
};

const inspectStalePayments = async (payments) => {
  const statuses = new Set([
    "started",
    "captured_client",
    "captured_webhook",
    "finalizing",
    "needs_recovery",
    "email_partial",
  ]);
  const stale = payments.filter(
    (record) =>
      ["paypal", "razorpay"].includes(normalizeLower(record.provider)) &&
      statuses.has(normalizeLower(record.status))
  );
  const summary = { scanned: 0, captured: 0, pending: 0, unpaid: 0, unavailable: 0 };
  for (const record of stale) {
    const state = await inspectProviderOrder(record);
    summary.scanned += 1;
    summary[state] = (summary[state] || 0) + 1;
  }
  return summary;
};

const runReconcile = async () => {
  if (!reconcileUrl) return null;
  const secret = readEnv("CRON_SECRET");
  if (!secret) throw new Error("CRON_SECRET is required with --reconcile-url.");
  const totals = {
    scanned: 0,
    finalized: 0,
    abandoned: 0,
    recovery: 0,
    pending: 0,
    providerUnavailable: 0,
    refundsSynced: 0,
  };
  const runs = [];
  let drained = false;

  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const response = await fetch(reconcileUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) {
      throw new Error(`Payment reconciliation failed (${response.status}).`);
    }
    const summary = body.summary || {};
    runs.push(summary);
    for (const key of Object.keys(totals)) {
      totals[key] += Number(summary[key] || 0);
    }
    if (Number(summary.scanned || 0) === 0) {
      drained = true;
      break;
    }
    const handled =
      Number(summary.finalized || 0) +
      Number(summary.abandoned || 0) +
      Number(summary.recovery || 0) +
      Number(summary.pending || 0) +
      Number(summary.providerUnavailable || 0) +
      Number(summary.refundsSynced || 0);
    if (handled === 0) break;
  }

  return { drained, runCount: runs.length, totals, runs };
};

const summarizePlan = (plan) => ({
  bookingPatches: plan.bookingPatches.length,
  slotLocksToCreate: plan.locksToCreate.length,
  slotLockPatches: plan.lockPatches.length,
  slotConflicts: plan.slotConflicts.length,
  proofClaimsToCreate: plan.claimsToCreate.length,
  paymentPatches: plan.paymentPatches.length,
  couponBaselinePatches: plan.couponPatches.length,
  holdPatches: plan.holdPatches.length,
  expiredTerminalHoldsToDelete: plan.holdsToDelete.length,
});

const main = async () => {
  const documents = await client.fetch(`*[_type in $types]`, { types: TYPES });
  const snapshotCreated = writeSnapshot(documents);
  const snapshotConfirmed = verifyConfirmedSnapshot();
  const byType = (type) => documents.filter((document) => document._type === type);
  const input = {
    bookings: byType("booking"),
    payments: byType("paymentRecord"),
    holds: byType("slotHold"),
    coupons: byType("coupon"),
    existingLocks: byType("bookingSlot"),
    existingClaims: byType("paymentProofClaim"),
  };
  const plan = buildPlan(input);
  const before = summarizePlan(plan);
  const providerInspection = inspectProviders
    ? await inspectStalePayments(input.payments)
    : null;

  if (apply && plan.slotConflicts.length) {
    throw new Error("Migration found conflicting future booking slots.");
  }
  if (apply) await applyPlan(plan);
  const reconciliation = apply ? await runReconcile() : null;
  if (reconciliation && reconciliation.drained !== true) {
    throw new Error("Payment reconciliation did not drain completely.");
  }

  let after = null;
  if (apply) {
    const refreshed = await client.fetch(`*[_type in $types]`, { types: TYPES });
    const followUpPlan = buildPlan({
      bookings: refreshed.filter((doc) => doc._type === "booking"),
      payments: refreshed.filter((doc) => doc._type === "paymentRecord"),
      holds: refreshed.filter((doc) => doc._type === "slotHold"),
      coupons: refreshed.filter((doc) => doc._type === "coupon"),
      existingLocks: refreshed.filter((doc) => doc._type === "bookingSlot"),
      existingClaims: refreshed.filter((doc) => doc._type === "paymentProofClaim"),
    });
    if (followUpPlan.slotConflicts.length) {
      throw new Error("Migration produced conflicting future booking slots.");
    }
    await applyPlan(followUpPlan);
    const finalDocuments = await client.fetch(`*[_type in $types]`, { types: TYPES });
    after = summarizePlan(buildPlan({
      bookings: finalDocuments.filter((doc) => doc._type === "booking"),
      payments: finalDocuments.filter((doc) => doc._type === "paymentRecord"),
      holds: finalDocuments.filter((doc) => doc._type === "slotHold"),
      coupons: finalDocuments.filter((doc) => doc._type === "coupon"),
      existingLocks: finalDocuments.filter((doc) => doc._type === "bookingSlot"),
      existingClaims: finalDocuments.filter((doc) => doc._type === "paymentProofClaim"),
    }));
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: apply ? "apply" : "dry-run",
        dataset,
        snapshotCreated,
        snapshotConfirmed,
        documentsScanned: documents.length,
        before,
        after,
        providerInspection,
        reconciliation,
      },
      null,
      2
    )
  );
  if (after && Object.values(after).some((count) => Number(count) !== 0)) {
    process.exitCode = 3;
  }
  if (plan.slotConflicts.length) process.exitCode = 2;
};

main().catch((error) => {
  console.error(`[migrate-payment-booking-repair] ${error.message}`);
  process.exit(1);
});
