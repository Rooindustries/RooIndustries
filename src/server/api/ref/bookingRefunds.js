import { buildBookingSlotId } from "../../booking/slotIdentity.js";
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
    return {
      bookingId: booking._id,
      reopenedSlot: booking.slotReleasedAfterRefund === true,
      couponRestored: booking.couponRestoredAfterRefund === true,
      referralReversed: booking.referralReversedAfterRefund === true,
      idempotent: true,
    };
  }

  const slotLockId =
    booking.slotLockId ||
    (booking.startTimeUTC ? buildBookingSlotId(booking.startTimeUTC) : "");
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
  await transaction.commit();
  return {
    bookingId: booking._id,
    reopenedSlot: ownsSlot,
    couponRestored: canRestoreCoupon,
    referralReversed: willReverseReferral,
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
    return applyBookingRefund({
      client,
      paymentRecord: { bookingId: booking._id },
      refund: { full: true, type: "full", id: `${source}:${booking._id}` },
    });
  }

  const now = new Date().toISOString();
  const slotLockId =
    booking.slotLockId ||
    (booking.startTimeUTC ? buildBookingSlotId(booking.startTimeUTC) : "");
  const slotLock = slotLockId
    ? await client.fetch(`*[_type == "bookingSlot" && _id == $id][0]{...}`, {
        id: slotLockId,
      })
    : null;
  const becomesBlocking = isBookingBlockingStatus(canonicalStatus);
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
  await transaction.commit();
  return {
    bookingId: booking._id,
    status: canonicalStatus,
    reopenedSlot: !becomesBlocking && !!slotLock?._id,
  };
};
