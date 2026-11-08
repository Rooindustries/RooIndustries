import { getNextPaymentRecoveryAt } from "./paymentRecord.js";
import { logSafeError } from "../../safeErrorLog.js";

export const buildCaptureVerificationState = (record) => ({
  verificationState: record.provider === "free" ? String(record.verificationState || "").trim() : "server_verified",
  verificationWarning: "",
  ...(record.provider !== "free" && record.verificationState !== "server_verified" ? {
    recoveryAttemptCount: 0,
    recoveryFailureCount: 0,
    reconciliationRecoveryTerminal: false,
    nextRecoveryAt: "",
  } : {}),
});

export const buildOwnerReviewState = (record, required) =>
  required || record.recoveryOwnerReviewRequired === true
    ? { recoveryOwnerReviewRequired: required } : {};

const normalizeCount = (value) => {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
};

export const buildRecoveryFailureState = (record) => {
  const recoveryAttemptCount = Math.min(12, normalizeCount(record.recoveryAttemptCount) + 1);
  const recoveryFailureCount = Math.min(12, normalizeCount(record.recoveryFailureCount) + 1);
  const ownerReviewRequired = recoveryFailureCount >= 12;
  return {
    recoveryAttemptCount,
    recoveryFailureCount,
    ...buildOwnerReviewState(record,
      ownerReviewRequired || record.providerPaymentState === "requires_merchant_action"),
    reconciliationRecoveryTerminal: false,
    nextRecoveryAt: getNextPaymentRecoveryAt(recoveryFailureCount),
  };
};

export const buildRecoveryCompletionState = (record) => ({
  recoveryFailureCount: 0,
  ...buildOwnerReviewState(record, false),
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
