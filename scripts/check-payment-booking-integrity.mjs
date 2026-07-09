#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { createClient } from "@sanity/client";
import dotenv from "dotenv";

const explicitEnv = (() => {
  const index = process.argv.indexOf("--env");
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
})();
for (const candidate of [explicitEnv, ".env.local", ".vercel/.env.production.local"]) {
  if (candidate && fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false, quiet: true });
  }
}

const env = (...keys) =>
  keys.map((key) => String(process.env[key] || "").trim()).find(Boolean) || "";
const projectId = env("SANITY_PRIVATE_PROJECT_ID", "SANITY_PROJECT_ID");
const dataset = env("SANITY_PRIVATE_DATASET", "SANITY_DATASET") || "production";
const token = env(
  "SANITY_PRIVATE_READ_TOKEN",
  "SANITY_READ_TOKEN",
  "SANITY_PRIVATE_WRITE_TOKEN",
  "SANITY_WRITE_TOKEN"
);
if (!projectId || !token) throw new Error("Sanity read credentials are required.");

const client = createClient({
  projectId,
  dataset,
  apiVersion:
    env("SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION") || "2023-10-01",
  token,
  useCdn: false,
  perspective: "published",
});

const normalize = (value) => String(value || "").trim();
const lower = (value) => normalize(value).toLowerCase();
const groupDuplicates = (items, keyFor) => {
  const counts = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).length;
};

const main = async () => {
  const documents = await client.fetch(
    `*[_type in ["booking", "bookingSlot", "slotHold", "paymentRecord", "paymentProofClaim", "coupon", "couponRedemption", "bookingRecoveryCase", "paymentRecoveryCase"]]`
  );
  const byType = (type) => documents.filter((document) => document._type === type);
  const bookings = byType("booking");
  const locks = byType("bookingSlot");
  const holds = byType("slotHold");
  const payments = byType("paymentRecord");
  const claims = byType("paymentProofClaim");
  const coupons = byType("coupon");
  const redemptions = byType("couponRedemption");
  const recoveryCases = [
    ...byType("bookingRecoveryCase"),
    ...byType("paymentRecoveryCase"),
  ];
  const bookingIds = new Set(bookings.map((booking) => booking._id));
  const recoveryPaymentIds = new Set(
    recoveryCases.map((entry) => normalize(entry.paymentRecordId)).filter(Boolean)
  );
  const now = Date.now();
  const cleanupThreshold = now - 5 * 60 * 1000;
  const activeLocks = locks.filter((lock) => lower(lock.status) !== "released");
  const allowedStatuses = new Set([
    "pending",
    "captured",
    "completed",
    "failed",
    "refunded",
    "cancelled",
  ]);

  const staleCapturedWithoutOutcome = payments.filter((record) => {
    const reference = new Date(record.updatedAt || record.createdAt || "").getTime();
    if (!Number.isFinite(reference) || now - reference < 60 * 60 * 1000) return false;
    const status = lower(record.status);
    const captureEvidence =
      ["captured_client", "captured_webhook", "finalizing"].includes(status) ||
      lower(record.verificationState) === "server_verified" ||
      (status === "needs_recovery" && !!normalize(record.providerPaymentId));
    if (!captureEvidence) return false;
    return !(
      (normalize(record.bookingId) && bookingIds.has(normalize(record.bookingId))) ||
      record.requiresReschedule === true ||
      recoveryPaymentIds.has(record._id)
    );
  });

  const reservedByCoupon = new Map();
  for (const redemption of redemptions) {
    if (lower(redemption.status) !== "reserved") continue;
    const couponId = normalize(redemption.coupon?._ref);
    if (couponId) reservedByCoupon.set(couponId, (reservedByCoupon.get(couponId) || 0) + 1);
  }
  const couponReservationMismatches = coupons.filter(
    (coupon) =>
      Number(coupon.activeReservations || 0) !==
      Number(reservedByCoupon.get(coupon._id) || 0)
  ).length;

  const failures = {
    duplicateProofClaims: groupDuplicates(claims, (claim) => {
      const provider = lower(claim.provider);
      const proof =
        provider === "razorpay"
          ? normalize(claim.providerPaymentId)
          : normalize(claim.providerOrderId || claim.providerPaymentId);
      return proof ? `${provider}:${proof}` : "";
    }),
    duplicateActiveSlotLocks: groupDuplicates(
      activeLocks,
      (lock) => normalize(lock.startTimeUTC)
    ),
    orphanActiveSlotLocks: activeLocks.filter(
      (lock) => !bookingIds.has(normalize(lock.bookingId))
    ).length,
    expiredHoldsPastCleanupThreshold: holds.filter((hold) => {
      const expiry = new Date(hold.expiresAt || "").getTime();
      return !Number.isFinite(expiry) || expiry < cleanupThreshold;
    }).length,
    staleCapturedWithoutBookingOrReschedule: staleCapturedWithoutOutcome.length,
    invalidBookingStatuses: bookings.filter(
      (booking) => !allowedStatuses.has(lower(booking.status) === "canceled" ? "cancelled" : lower(booking.status))
    ).length,
    couponReservationMismatches,
  };
  const ok = Object.values(failures).every((count) => count === 0);
  console.log(
    JSON.stringify(
      {
        ok,
        dataset,
        counts: {
          bookings: bookings.length,
          paymentRecords: payments.length,
          proofClaims: claims.length,
          activeSlotLocks: activeLocks.length,
          holds: holds.length,
          openRecoveryCases: recoveryCases.filter(
            (entry) => !["resolved", "closed"].includes(lower(entry.status))
          ).length,
        },
        failures,
      },
      null,
      2
    )
  );
  if (!ok) process.exit(1);
};

main().catch((error) => {
  console.error(`[check-payment-booking-integrity] ${error.message}`);
  process.exit(1);
});
