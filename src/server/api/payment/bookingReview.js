import { issueHoldToken, verifyHoldToken } from "../../booking/holdToken.js";
import { buildBookingSlotId } from "../../booking/slotIdentity.js";
import { isBookingBlockingStatus } from "../../booking/bookingStatus.js";
import envValue from "../../supabase/envValue.cjs";

const { resolveStoreBackend } = envValue;
export const REVIEW_HOLD_EXPIRY = "9999-12-31T23:59:59.999Z";

export const isAutomaticBookingReview = (record = {}) =>
  ["started", "needs_recovery", "finalizing", "captured_client", "captured_webhook"].includes(record.status) &&
  !!record.holdSnapshot?.slotHoldId && !!record.holdSnapshot?.slotHoldToken &&
  !!record.bookingPayload?.startTimeUTC && !!record.bookingPayload?.packageTitle &&
  !record.bookingId && !record.bookingPayload?.originalOrderId &&
  !record.resourceReleasePending && !record.dodoDisputeActive &&
  record.refundState !== "full" && !record.providerRefundDetailsMissing &&
  !record.providerRecoveryTerminal &&
  (record.reviewPending === true || record.reconciliationRecoveryTerminal === true);

export const prepareBookingReviewHold = async ({ client, record }) => {
  const snapshot = record.holdSnapshot || {};
  const hold = await client.fetch('*[_type == "slotHold" && _id == $id][0]', {
    id: snapshot.slotHoldId || "",
  });
  const expiredByCleanup = hold?.phase === "expired" &&
    hold.releaseReason === "expired_by_operational_cleanup" && hold.paymentRecordId === record._id;
  const validToken = hold && verifyHoldToken({
    token: snapshot.slotHoldToken,
    holdId: hold._id,
    startTimeUTC: record.bookingPayload.startTimeUTC,
    holdNonce: expiredByCleanup ? "" : hold.holdNonce,
    backend: record.backendOwner,
    cutoverGeneration: record.cutoverGeneration,
    ignoreExpiry: true,
  });
  const releasedByRecovery = expiredByCleanup || (hold?.phase === "released" &&
    hold.releaseReason === "payment_recovery_hold_expired" && !hold.paymentRecordId);
  const ownsHold = hold?.phase === "payment_pending" && hold.paymentRecordId === record._id;
  if (!hold?._rev || !validToken || (!ownsHold && !releasedByRecovery) ||
      hold.startTimeUTC !== record.bookingPayload.startTimeUTC ||
      hold.packageTitle !== record.bookingPayload.packageTitle ||
      resolveStoreBackend(hold.backendOwner) !== resolveStoreBackend(record.backendOwner) ||
      Number(hold.cutoverGeneration || 0) !== Number(record.cutoverGeneration || 0)) {
    throw Object.assign(new Error("The reviewed payment no longer owns its slot."), {
      status: 409, code: "payment_review_hold_changed",
    });
  }
  if (releasedByRecovery) {
    const [lock, bookings] = await Promise.all([
      client.fetch('*[_type == "bookingSlot" && _id == $id][0]', {
        id: buildBookingSlotId(hold.startTimeUTC),
      }),
      client.fetch('*[_type == "booking" && startTimeUTC == $startTimeUTC]{_id,status,originalOrderId}', {
        startTimeUTC: hold.startTimeUTC,
      }),
    ]);
    if ((lock && lock.status !== "released") ||
        bookings.some(booking => !booking.originalOrderId && isBookingBlockingStatus(booking.status))) {
      throw Object.assign(new Error("The reviewed payment's slot is already booked."), {
        status: 409, code: "payment_review_slot_taken",
      });
    }
  }
  const token = issueHoldToken({
    holdId: hold._id,
    startTimeUTC: hold.startTimeUTC,
    holdNonce: hold.holdNonce,
    expiresAt: REVIEW_HOLD_EXPIRY,
    backend: record.backendOwner,
    cutoverGeneration: record.cutoverGeneration,
  });
  return {
    hold,
    changed: hold.expiresAt !== REVIEW_HOLD_EXPIRY || releasedByRecovery,
    set: { expiresAt: REVIEW_HOLD_EXPIRY,
      ...(releasedByRecovery ? { phase: "payment_pending", paymentRecordId: record._id,
        paymentProvider: record.provider, releaseReason: "", releasedAt: "" } : {}) },
    snapshot: { ...snapshot, phase: "payment_pending", slotHoldToken: token, slotHoldExpiresAt: REVIEW_HOLD_EXPIRY },
    bookingPayload: { ...record.bookingPayload, slotHoldToken: token, slotHoldExpiresAt: REVIEW_HOLD_EXPIRY },
  };
};
