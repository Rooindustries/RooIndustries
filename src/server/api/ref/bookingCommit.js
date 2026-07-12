import {
  buildBookingSlotId,
  buildDeterministicBookingId,
  normalizeStartTimeUTC,
} from "../../booking/slotIdentity.js";
import { normalizeBookingStatus } from "../../booking/bookingStatus.js";
import { appendCouponConsumption } from "./couponReservations.js";
import { dispatchRescheduleNotifications } from "./bookingEmails.js";
import { getSafeErrorCode } from "../../safeErrorLog.js";

const normalize = (value) => String(value || "").trim();

const bookingConflict = (message, code = "booking_conflict") => {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
};

const patchRevision = (transaction, document, mutate) =>
  transaction.patch(document._id, (patch) => {
    const guarded = document._rev ? patch.ifRevisionId(document._rev) : patch;
    return mutate(guarded);
  });

const commitCommerceTransaction = ({ client, transaction, commandId }) =>
  client?.backend === "supabase"
    ? transaction.commit({ commandId })
    : transaction.commit();

export const prepareDeterministicBooking = ({ booking = {}, idempotencyKey = "" }) => {
  const providerOrderId =
    normalize(booking.paypalOrderId) || normalize(booking.razorpayOrderId);
  const bookingId =
    normalize(booking._id) ||
    buildDeterministicBookingId({
      paymentRecordId: booking.paymentRecordId,
      paymentProvider: booking.paymentProvider,
      providerOrderId,
      providerPaymentId: booking.razorpayPaymentId,
      idempotencyKey,
      originalOrderId: booking.originalOrderId,
      startTimeUTC: booking.startTimeUTC,
      email: booking.email || booking.payerEmail,
      couponCode: booking.couponCode,
    });
  if (!bookingId) throw new Error("A stable booking identifier is required.");
  const status = normalizeBookingStatus(booking.status, "pending");
  return {
    ...booking,
    _id: bookingId,
    _type: "booking",
    orderId: bookingId,
    status,
  };
};

export const commitBookingTransaction = async ({
  client,
  booking,
  idempotencyKey = "",
  slot = null,
  hold = null,
  couponReservation = null,
  referralId = "",
  paymentProofClaim = null,
  paymentRecordMutation = null,
  allowMissingHold = false,
}) => {
  if (!client) throw new Error("Booking transaction requires a Sanity client.");
  const doc = prepareDeterministicBooking({ booking, idempotencyKey });
  const existingBooking = await client.fetch(
    `*[_type == "booking" && _id == $id][0]{...}`,
    { id: doc._id }
  );
  if (existingBooking?._id) {
    return { booking: existingBooking, bookingId: existingBooking._id, idempotent: true };
  }

  const startTimeUTC = slot
    ? normalizeStartTimeUTC(slot.startTimeUTC || doc.startTimeUTC)
    : "";
  const slotLockId = startTimeUTC ? buildBookingSlotId(startTimeUTC) : "";
  const slotLock = slotLockId
    ? slot?.lock ||
      (await client.fetch(`*[_type == "bookingSlot" && _id == $id][0]{...}`, {
        id: slotLockId,
      }))
    : null;
  if (slotLock && slotLock.status !== "released" && slotLock.bookingId !== doc._id) {
    throw bookingConflict("This slot is already booked.", "slot_already_booked");
  }

  const proofClaim = paymentProofClaim?.document || paymentProofClaim;
  if (proofClaim?.bookingId && proofClaim.bookingId !== doc._id) {
    throw bookingConflict("Payment proof was already used.", "payment_proof_reused");
  }
  if (!hold && slotLockId && !allowMissingHold) {
    throw bookingConflict("The slot reservation is no longer available.", "hold_missing");
  }

  const now = new Date().toISOString();
  const bookingDocument = {
    ...doc,
    ...(slotLockId ? { slotLockId } : {}),
    ...(couponReservation?.redemption?._id
      ? { couponRedemptionId: couponReservation.redemption._id }
      : {}),
    ...(normalize(referralId) ? { referralAccountingApplied: true } : {}),
    createdAt: doc.createdAt || now,
    updatedAt: now,
  };
  const transaction = client.transaction().create(bookingDocument);

  if (slotLockId) {
    const lockValues = {
      _type: "bookingSlot",
      backendOwner: doc.backendOwner === "supabase" ? "supabase" : "sanity",
      startTimeUTC,
      bookingId: doc._id,
      status: "active",
      lockedAt: now,
      releasedAt: "",
    };
    if (slotLock?._id) {
      patchRevision(transaction, slotLock, (patch) => patch.set(lockValues));
    } else {
      transaction.create({ _id: slotLockId, ...lockValues });
    }
  }

  if (hold?._id) {
    patchRevision(transaction, hold, (patch) =>
      patch.set({
        phase: "consumed",
        consumedAt: now,
        expiresAt: now,
        bookingId: doc._id,
      })
    );
  }

  if (couponReservation?.redemption?._id) {
    appendCouponConsumption({
      transaction,
      coupon: couponReservation.coupon,
      redemption: couponReservation.redemption,
      bookingId: doc._id,
      consumedAt: now,
    });
  }

  if (normalize(referralId)) {
    transaction.patch(normalize(referralId), (patch) =>
      patch.setIfMissing({ successfulReferrals: 0 }).inc({ successfulReferrals: 1 })
    );
  }

  if (proofClaim?._id) {
    if (proofClaim._rev) {
      patchRevision(transaction, proofClaim, (patch) =>
        patch.set({ bookingId: doc._id, claimedAt: now, status: "claimed" })
      );
    } else {
      transaction.create({
        ...proofClaim,
        _type: proofClaim._type || "paymentProofClaim",
        bookingId: doc._id,
        claimedAt: now,
        status: "claimed",
      });
    }
  }

  if (paymentRecordMutation?.id) {
    transaction.patch(paymentRecordMutation.id, (patch) => {
      const guarded = paymentRecordMutation.revision
        ? patch.ifRevisionId(paymentRecordMutation.revision)
        : patch;
      return guarded.set({
        ...paymentRecordMutation.set,
        bookingId: doc._id,
        updatedAt: now,
      });
    });
  }

  try {
    await commitCommerceTransaction({
      client,
      transaction,
      commandId: `booking-finalize:${doc._id}`,
    });
  } catch (error) {
    if (Number(error?.statusCode || error?.status || 0) === 409) {
      const racedBooking = await client.fetch(
        `*[_type == "booking" && _id == $id][0]{...}`,
        { id: doc._id }
      );
      if (racedBooking?._id) {
        return { booking: racedBooking, bookingId: racedBooking._id, idempotent: true };
      }
      throw bookingConflict("Booking state changed during finalization.");
    }
    throw error;
  }
  return { booking: bookingDocument, bookingId: doc._id, idempotent: false };
};

export const createRequiresRescheduleBooking = async ({
  client,
  paymentRecord,
  reason = "captured_payment_requires_reschedule",
  notify = true,
  paymentProofClaim = null,
  paymentRecordMutation = null,
  couponReservation = null,
  referralId = "",
  paymentHold = null,
  preserveHistoricalAccounting = false,
}) => {
  if (!client || !paymentRecord?._id) {
    throw new Error("A payment record is required to create a reschedule booking.");
  }
  const payload = paymentRecord.bookingPayload || {};
  const pricing = paymentRecord.pricingSnapshot || {};
  const resolvedReferralId = preserveHistoricalAccounting
    ? ""
    : normalize(referralId || pricing.effectiveReferralId || "");
  const booking = prepareDeterministicBooking({
    booking: {
      paymentRecordId: paymentRecord._id,
      backendOwner:
        paymentRecord.backendOwner === "supabase" ? "supabase" : "sanity",
      paymentProvider: paymentRecord.provider,
      paypalOrderId:
        paymentRecord.provider === "paypal" ? paymentRecord.providerOrderId : "",
      razorpayOrderId:
        paymentRecord.provider === "razorpay" ? paymentRecord.providerOrderId : "",
      razorpayPaymentId: paymentRecord.providerPaymentId || "",
      email: payload.email || paymentRecord.payerEmail || "",
      discord: payload.discord || "",
      specs: payload.specs || "",
      mainGame: payload.mainGame || "",
      message: payload.message || "",
      packageTitle: payload.packageTitle || "Payment recovery",
      packagePrice: `$${Number(pricing.grossAmount || pricing.netAmount || 0).toFixed(2)}`,
      grossAmount: Number(pricing.grossAmount || 0),
      netAmount: Number(pricing.netAmount || 0),
      discountPercent: Number(pricing.discountPercent || 0),
      discountAmount: Number(pricing.discountAmount || 0),
      referralCode: pricing.effectiveReferralCode || payload.referralCode || "",
      ...(resolvedReferralId
        ? {
            referral: { _type: "reference", _ref: resolvedReferralId },
            referralAccountingApplied: true,
          }
        : {}),
      ...(couponReservation?.redemption?._id
        ? { couponRedemptionId: couponReservation.redemption._id }
        : {}),
      ...(payload.couponCode
        ? {
            couponCode: payload.couponCode,
            couponDiscountPercent: Number(pricing.couponDiscountPercent || 0),
            couponDiscountAmount: Number(pricing.couponDiscountAmount || 0),
            couponDiscountType: pricing.couponDiscountType || "",
            couponDiscountValue: Number(pricing.couponDiscountValue || 0),
          }
        : {}),
      status: "captured",
      requiresReschedule: true,
      recoveryStatus: "requires_reschedule",
      recoveryReason: normalize(reason),
      recoveryCreatedAt: new Date().toISOString(),
      recoveryNotificationStatus: "pending",
      originalRequestedStartTimeUTC: payload.startTimeUTC || "",
      localTimeZone: payload.localTimeZone || "",
      displayDate: payload.displayDate || "",
      displayTime: payload.displayTime || "",
    },
  });
  const recoveryCase = {
    _id: `bookingRecoveryCase.${booking._id.replace(/^booking\./, "")}`,
    _type: "bookingRecoveryCase",
    backendOwner:
      paymentRecord.backendOwner === "supabase" ? "supabase" : "sanity",
    paymentRecordId: paymentRecord._id,
    bookingId: booking._id,
    reason: normalize(reason),
    status: "open",
    notificationStatus: "pending",
    createdAt: new Date().toISOString(),
  };
  const proofClaim = paymentProofClaim?.document || paymentProofClaim;
  if (proofClaim?.bookingId && proofClaim.bookingId !== booking._id) {
    throw bookingConflict("Payment proof was already used.", "payment_proof_reused");
  }

  let resolvedBooking = booking;
  let idempotent = false;
  try {
    const now = new Date().toISOString();
    const transaction = client.transaction().create(booking).create(recoveryCase);

    if (proofClaim?._id) {
      if (proofClaim._rev) {
        patchRevision(transaction, proofClaim, (patch) =>
          patch.set({ bookingId: booking._id, claimedAt: now, status: "claimed" })
        );
      } else {
        transaction.create({
          ...proofClaim,
          _type: proofClaim._type || "paymentProofClaim",
          bookingId: booking._id,
          claimedAt: now,
          status: "claimed",
        });
      }
    }

    if (couponReservation?.redemption?._id) {
      appendCouponConsumption({
        transaction,
        coupon: couponReservation.coupon,
        redemption: couponReservation.redemption,
        bookingId: booking._id,
        consumedAt: now,
        allowReleasedRecovery: true,
      });
    }

    if (resolvedReferralId) {
      transaction.patch(resolvedReferralId, (patch) =>
        patch
          .setIfMissing({ successfulReferrals: 0 })
          .inc({ successfulReferrals: 1 })
      );
    }

    if (paymentHold?._id) {
      patchRevision(transaction, paymentHold, (patch) =>
        patch.set({
          phase: "consumed",
          consumedAt: now,
          expiresAt: now,
          bookingId: booking._id,
          releaseReason: "",
        })
      );
    }

    if (paymentRecordMutation?.id) {
      transaction.patch(paymentRecordMutation.id, (patch) => {
        const guarded = paymentRecordMutation.revision
          ? patch.ifRevisionId(paymentRecordMutation.revision)
          : patch;
        return guarded.set({
          ...paymentRecordMutation.set,
          bookingId: booking._id,
          updatedAt: now,
        });
      });
    }

    await commitCommerceTransaction({
      client,
      transaction,
      commandId: `booking-reschedule:${booking._id}`,
    });
    resolvedBooking =
      (await client.fetch(`*[_type == "booking" && _id == $id][0]{...}`, {
        id: booking._id,
      })) || booking;
  } catch (error) {
    if (Number(error?.statusCode || error?.status || 0) !== 409) throw error;
    resolvedBooking = await client.fetch(
      `*[_type == "booking" && _id == $id][0]{...}`,
      { id: booking._id }
    );
    if (!resolvedBooking?._id) throw error;
    if (paymentRecordMutation?.id) {
      const linkedPaymentRecord = await client.fetch(
        `*[_type == "paymentRecord" && _id == $id][0]{_id, bookingId}`,
        { id: paymentRecordMutation.id }
      );
      if (normalize(linkedPaymentRecord?.bookingId) !== booking._id) {
        throw bookingConflict(
          "Recovery booking exists but the payment state changed.",
          "payment_recovery_state_changed"
        );
      }
    }
    idempotent = true;
  }
  const notification = notify
    ? await dispatchRescheduleNotifications({
        client,
        bookingId: booking._id,
        booking: resolvedBooking,
      }).catch((error) => ({
        ok: false,
        notificationRequired: true,
        status: "pending",
        errors: [getSafeErrorCode(error, "notification_dispatch_failed")],
      }))
    : {
        ok: false,
        notificationRequired:
          resolvedBooking?.recoveryNotificationStatus !== "sent",
        status: resolvedBooking?.recoveryNotificationStatus || "pending",
      };
  return {
    booking: resolvedBooking,
    bookingId: booking._id,
    recoveryCaseId: recoveryCase._id,
    notificationRequired: notification.notificationRequired,
    notification,
    idempotent,
    paymentRecordLinked: !!paymentRecordMutation?.id,
  };
};
