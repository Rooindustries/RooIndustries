import {
  buildBookingSlotId,
  buildSlotHoldId,
} from "../../booking/slotIdentity.js";
import {
  isBookingBlockingStatus,
  normalizeBookingStatus,
} from "../../booking/bookingStatus.js";
import { appendCouponRefund } from "./couponReservations.js";

const isFullRefund = (refund = {}) => {
  const kind = String(refund.kind || refund.type || "").trim().toLowerCase();
  return refund.full === true || kind === "full" || kind === "reversal";
};

const patchRevision = (transaction, document, mutate) =>
  transaction.patch(document._id, (patch) => {
    const guarded = document._rev ? patch.ifRevisionId(document._rev) : patch;
    return mutate(guarded);
  });

const releaseRefundedUpgradeLock = async ({ client, paymentRecord }) => {
  const lockId = String(paymentRecord?.startClaimId || "").trim();
  if (!lockId.startsWith("paymentUpgradeLock.")) return false;
  const lock = await client.fetch(
    `*[_type == "paymentUpgradeLock" && _id == $id][0]{_id,_rev,paymentRecordId}`,
    { id: lockId }
  );
  if (!lock?._id) return true;
  if (String(lock.paymentRecordId || "").trim() !== String(paymentRecord._id || "").trim()) {
    return false;
  }
  await client.delete({
    query: `*[_type == "paymentUpgradeLock" && _id == $id && _rev == $rev && paymentRecordId == $paymentRecordId]`,
    params: {
      id: lock._id,
      rev: lock._rev,
      paymentRecordId: paymentRecord._id,
    },
  });
  return true;
};

const markPaymentRecordRefunded = async ({ client, paymentRecord, now }) => {
  if (!paymentRecord?._id) return false;
  const current = await client.fetch(
    `*[_type == "paymentRecord" && _id == $id][0]{...}`,
    { id: paymentRecord._id }
  );
  if (!current?._id) return false;
  let patch = client.patch(current._id);
  if (current._rev && typeof patch.ifRevisionId === "function") {
    patch = patch.ifRevisionId(current._rev);
  }
  await patch
    .set({
      status: "refunded",
      refundState: "full",
      refundRequiresBookingSync: false,
      recoveryReason: "",
      updatedAt: now,
    })
    .commit();
  return true;
};

const markPaymentRecordRefundPending = async ({ client, paymentRecord, now }) => {
  if (!paymentRecord?._id) return false;
  const current = await client.fetch(
    `*[_type == "paymentRecord" && _id == $id][0]{...}`,
    { id: paymentRecord._id }
  );
  if (!current?._id) return false;
  let patch = client.patch(current._id);
  if (current._rev && typeof patch.ifRevisionId === "function") {
    patch = patch.ifRevisionId(current._rev);
  }
  await patch
    .set({
      status: "refunded",
      refundState: "full",
      refundRequiresBookingSync: true,
      recoveryReason: "refund_requires_booking_sync",
      updatedAt: now,
    })
    .commit();
  return true;
};

export const applyBookingRefund = async ({ client, paymentRecord, refund = {} }) => {
  if (!client || !paymentRecord?.bookingId) {
    return {
      bookingId: "",
      reopenedSlot: false,
      couponRestored: false,
      referralReversed: false,
      idempotent: true,
    };
  }
  const booking = await client.fetch(
    `*[_type == "booking" && _id == $id][0]{...}`,
    { id: paymentRecord.bookingId }
  );
  if (!booking?._id) {
    throw Object.assign(new Error("Refunded payment booking was not found."), {
      status: 404,
      code: "refund_booking_missing",
    });
  }

  const full = isFullRefund(refund);
  const now = new Date().toISOString();
  const refundId = String(refund.id || refund.refundId || refund.eventId || "").trim();
  if (!full) {
    const processedRefundIds = Array.isArray(booking.processedRefundIds)
      ? booking.processedRefundIds.filter(Boolean)
      : [];
    if (
      booking.refundAccountingAppliedAt ||
      booking.refundStatus === "full" ||
      (refundId && processedRefundIds.includes(refundId))
    ) {
      return {
        bookingId: booking._id,
        reopenedSlot: false,
        couponRestored: false,
        referralReversed: false,
        idempotent: true,
      };
    }
    let partialPatch = client.patch(booking._id);
    if (booking._rev && typeof partialPatch.ifRevisionId === "function") {
      partialPatch = partialPatch.ifRevisionId(booking._rev);
    }
    await partialPatch
      .set({
        lastRefundId: refundId,
        lastRefundAt: refund.refundedAt || now,
        refundedAmount: Number(booking.refundedAmount || 0) + Number(refund.amount || 0),
        refundStatus: "partial",
        processedRefundIds: refundId
          ? [...processedRefundIds, refundId]
          : processedRefundIds,
      })
      .commit();
    return {
      bookingId: booking._id,
      reopenedSlot: false,
      couponRestored: false,
      referralReversed: false,
      idempotent: false,
    };
  }

  if (booking.refundAccountingAppliedAt) {
    await markPaymentRecordRefundPending({ client, paymentRecord, now });
    const upgradeLockReleased = await releaseRefundedUpgradeLock({
      client,
      paymentRecord,
    });
    await markPaymentRecordRefunded({ client, paymentRecord, now });
    return {
      bookingId: booking._id,
      reopenedSlot: booking.slotReleasedAfterRefund === true,
      couponRestored: booking.couponRestoredAfterRefund === true,
      referralReversed: booking.referralReversedAfterRefund === true,
      upgradeLockReleased,
      idempotent: true,
    };
  }

  const slotLockId =
    booking.slotLockId ||
    (!booking.originalOrderId && booking.startTimeUTC
      ? buildBookingSlotId(booking.startTimeUTC)
      : "");
  const [slotLock, redemption] = await Promise.all([
    slotLockId
      ? client.fetch(`*[_type == "bookingSlot" && _id == $id][0]{...}`, {
          id: slotLockId,
        })
      : null,
    booking.couponRedemptionId
      ? client.fetch(`*[_type == "couponRedemption" && _id == $id][0]{...}`, {
          id: booking.couponRedemptionId,
        })
      : null,
  ]);
  const coupon = redemption?.coupon?._ref
    ? await client.fetch(`*[_type == "coupon" && _id == $id][0]{...}`, {
        id: redemption.coupon._ref,
      })
    : null;
  const ownsSlot = slotLock?.bookingId === booking._id && slotLock.status !== "released";
  const canRestoreCoupon = redemption?.status === "consumed";
  const referralId = booking.referral?._ref || "";
  const canReverseReferral = !!referralId && booking.referralAccountingApplied !== false;
  const referral = canReverseReferral
    ? await client.fetch(
        `*[_type == "referral" && _id == $id][0]{_id,_rev,successfulReferrals}`,
        { id: referralId }
      )
    : null;
  const willReverseReferral =
    !!referral?._id && Number(referral.successfulReferrals || 0) > 0;

  const transaction = client.transaction();
  patchRevision(transaction, booking, (patch) =>
    patch.set({
      status: "refunded",
      refundStatus: "full",
      lastRefundId: refundId,
      lastRefundAt: refund.refundedAt || now,
      refundedAmount: Number(refund.amount || booking.netAmount || 0),
      refundAccountingAppliedAt: now,
      slotReleasedAfterRefund: ownsSlot,
      couponRestoredAfterRefund: canRestoreCoupon,
      referralReversedAfterRefund: willReverseReferral,
      updatedAt: now,
    })
  );
  if (ownsSlot) {
    patchRevision(transaction, slotLock, (patch) =>
      patch.set({
        status: "released",
        releasedAt: now,
        releaseReason: "full_refund",
      })
    );
  }
  if (canRestoreCoupon) {
    appendCouponRefund({ transaction, coupon, redemption, refundedAt: now });
  }
  if (willReverseReferral) {
    patchRevision(transaction, referral, (patch) =>
      patch.dec({ successfulReferrals: 1 })
    );
  }
  if (paymentRecord?._id) {
    patchRevision(transaction, paymentRecord, (patch) =>
      patch.set({
        status: "refunded",
        refundState: "full",
        refundRequiresBookingSync: true,
        recoveryReason: "refund_requires_booking_sync",
        updatedAt: now,
      })
    );
  }
  await transaction.commit();
  const upgradeLockReleased = await releaseRefundedUpgradeLock({
    client,
    paymentRecord,
  });
  await markPaymentRecordRefunded({ client, paymentRecord, now });
  return {
    bookingId: booking._id,
    reopenedSlot: ownsSlot,
    couponRestored: canRestoreCoupon,
    referralReversed: willReverseReferral,
    upgradeLockReleased,
    idempotent: false,
  };
};

export const applyFullPaymentRefund = applyBookingRefund;

export const applyBookingStatusTransition = async ({
  client,
  bookingId,
  status,
  payerEmail,
  source = "admin",
}) => {
  const canonicalStatus = normalizeBookingStatus(status);
  if (!canonicalStatus) {
    throw Object.assign(new Error("Invalid status value"), { status: 400 });
  }
  const booking = await client.fetch(
    `*[_type == "booking" && _id == $id][0]{...}`,
    { id: bookingId }
  );
  if (!booking?._id) {
    throw Object.assign(new Error("Booking not found"), { status: 404 });
  }
  if (canonicalStatus === "refunded") {
    const paymentRecord = booking.paymentRecordId
      ? await client.fetch(
          `*[_type == "paymentRecord" && _id == $id][0]{_id,_rev,status,bookingId,startClaimId}`,
          { id: booking.paymentRecordId }
        )
      : null;
    return applyBookingRefund({
      client,
      paymentRecord: {
        ...(paymentRecord || {}),
        bookingId: booking._id,
      },
      refund: { full: true, type: "full", id: `${source}:${booking._id}` },
    });
  }
  if (normalizeBookingStatus(booking.status) === "refunded") {
    throw Object.assign(
      new Error("A refunded booking cannot be reactivated or changed."),
      { status: 409, code: "refunded_booking_terminal" }
    );
  }

  const now = new Date().toISOString();
  const slotLockId =
    booking.slotLockId ||
    (!booking.originalOrderId && booking.startTimeUTC
      ? buildBookingSlotId(booking.startTimeUTC)
      : "");
  const becomesBlocking = isBookingBlockingStatus(canonicalStatus);
  const holdId = !booking.originalOrderId && booking.startTimeUTC
    ? buildSlotHoldId(booking.startTimeUTC)
    : "";
  const [slotLock, activeHold] = await Promise.all([
    slotLockId
      ? client.fetch(`*[_type == "bookingSlot" && _id == $id][0]{...}`, {
          id: slotLockId,
        })
      : null,
    becomesBlocking && holdId
      ? client.fetch(`*[_type == "slotHold" && _id == $id][0]{...}`, {
          id: holdId,
        })
      : null,
  ]);
  const holdExpiry = new Date(activeHold?.expiresAt || "").getTime();
  const holdBlocks =
    activeHold?._id &&
    !["released", "consumed"].includes(
      String(activeHold.phase || "active").trim().toLowerCase()
    ) &&
    Number.isFinite(holdExpiry) &&
    holdExpiry > Date.now();
  if (becomesBlocking && holdBlocks) {
    throw Object.assign(new Error("This booking slot has an active checkout hold."), {
      status: 409,
    });
  }
  if (
    becomesBlocking &&
    slotLock?._id &&
    slotLock.status !== "released" &&
    slotLock.bookingId !== booking._id
  ) {
    throw Object.assign(new Error("This booking slot is already occupied."), {
      status: 409,
    });
  }

  const transaction = client.transaction();
  patchRevision(transaction, booking, (patch) =>
    patch.set({
      status: canonicalStatus,
      ...(payerEmail !== undefined ? { payerEmail: String(payerEmail || "").trim() } : {}),
      statusUpdatedAt: now,
      statusUpdatedBy: source,
      updatedAt: now,
    })
  );
  if (slotLock?._id && slotLock.bookingId === booking._id) {
    patchRevision(transaction, slotLock, (patch) =>
      patch.set(
        becomesBlocking
          ? { status: "active", releasedAt: "", releaseReason: "" }
          : {
              status: "released",
              releasedAt: now,
              releaseReason: `booking_${canonicalStatus}`,
            }
      )
    );
  } else if (becomesBlocking && slotLockId) {
    transaction.create({
      _id: slotLockId,
      _type: "bookingSlot",
      bookingId: booking._id,
      startTimeUTC: booking.startTimeUTC,
      status: "active",
      lockedAt: now,
    });
  }
  if (becomesBlocking && holdId) {
    const holdBarrier = {
      phase: "consumed",
      expiresAt: now,
      consumedAt: now,
      bookingId: booking._id,
      paymentRecordId: "",
      startTimeUTC: booking.startTimeUTC,
    };
    if (activeHold?._id) {
      patchRevision(transaction, activeHold, (patch) => patch.set(holdBarrier));
    } else {
      transaction.create({
        _id: holdId,
        _type: "slotHold",
        ...holdBarrier,
      });
    }
  }
  await transaction.commit();
  return {
    bookingId: booking._id,
    status: canonicalStatus,
    reopenedSlot: !becomesBlocking && !!slotLock?._id,
  };
};
