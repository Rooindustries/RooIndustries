import { getNextPaymentRecoveryAt } from "./paymentRecord.js";
import { logSafeError } from "../../safeErrorLog.js";

const isCapturedBookingRecovery = (record) =>
  record.verificationState === "server_verified" &&
  ["paypal", "razorpay", "dodo"].includes(record.provider) &&
  !String(record.bookingId || "").trim() && record.providerRecoveryTerminal !== true &&
  record.providerRefundDetailsMissing !== true && record.dodoDisputeActive !== true &&
  !["refunded", "disputed"].includes(record.providerPaymentState);

export const isExhaustedCaptureRecovery = (record) =>
  record.reconciliationRecoveryTerminal === true && Number(record.recoveryFailureCount) >= 12 &&
  isCapturedBookingRecovery(record);

const normalizeCount = (value) => {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
};

export const buildRecoveryFailureState = (record) => {
  const recoveryAttemptCount = Math.min(12, normalizeCount(record.recoveryAttemptCount) + 1);
  const recoveryFailureCount = Math.min(12, normalizeCount(record.recoveryFailureCount) + 1);
  const ownerReviewRequired = recoveryFailureCount >= 12;
  const stopped = ownerReviewRequired && !isCapturedBookingRecovery(record);
  return {
    recoveryAttemptCount,
    recoveryFailureCount,
    recoveryOwnerReviewRequired: ownerReviewRequired || record.providerPaymentState === "requires_merchant_action",
    reconciliationRecoveryTerminal: stopped,
    nextRecoveryAt: stopped ? "9999-12-31T23:59:59.999Z" : getNextPaymentRecoveryAt(recoveryFailureCount),
  };
};

export const buildRecoveryCompletionState = (record) => ({
  recoveryFailureCount: 0,
  recoveryOwnerReviewRequired: false,
  reconciliationRecoveryTerminal: record.providerRefundDetailsMissing === true,
});

export const logPaymentRecoveryReview = (record, values) => {
  if (values.recoveryFailureCount === 12 && normalizeCount(record.recoveryFailureCount) < 12) {
    logSafeError(`Payment recovery requires owner review: ${record._id}`, Object.assign(new Error(), {
      code: "payment_recovery_attempts_exhausted",
    }));
  }
  if (values.providerPaymentState === "requires_merchant_action" &&
      record.providerPaymentState !== "requires_merchant_action") {
    logSafeError(`Payment requires merchant review: ${record._id}`, Object.assign(new Error(), {
      code: "payment_merchant_review_required",
    }));
  }
};
