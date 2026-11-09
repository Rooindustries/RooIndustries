import {
  PAYMENT_STATUS_STARTED,
  PAYMENT_STATUS_NEEDS_RECOVERY,
  PAYMENT_STATUS_FINALIZING,
  PAYMENT_STATUS_CAPTURED_CLIENT,
  PAYMENT_STATUS_CAPTURED_WEBHOOK,
  PAYMENT_STATUS_BOOKED,
  PAYMENT_STATUS_EMAIL_PARTIAL,
  PAYMENT_STATUS_REFUNDED,
  PAYMENT_STATUS_FAILED,
  PAYMENT_STATUS_ABANDONED,
} from "./paymentRecord.js";

const REVIEW_RESULT_ACCESS_MS = 60 * 60 * 1000;
const REVIEW_PENDING_STATUSES = new Set([
  PAYMENT_STATUS_STARTED,
  PAYMENT_STATUS_NEEDS_RECOVERY,
  PAYMENT_STATUS_FINALIZING,
  PAYMENT_STATUS_CAPTURED_CLIENT,
  PAYMENT_STATUS_CAPTURED_WEBHOOK,
]);
const REVIEW_RESULT_STATUSES = new Set([
  PAYMENT_STATUS_BOOKED,
  PAYMENT_STATUS_EMAIL_PARTIAL,
  PAYMENT_STATUS_REFUNDED,
  PAYMENT_STATUS_FAILED,
  PAYMENT_STATUS_ABANDONED,
  "cancelled",
]);

const hasPaymentReview = (record) =>
  record.providerPaymentState === "requires_merchant_action" || record.recoveryOwnerReviewRequired === true ||
  Boolean(record.reviewResultAccessUntil);

export const isPaymentAwaitingReview = (record) =>
  !record.bookingId && REVIEW_PENDING_STATUSES.has(record.status) && hasPaymentReview(record);

export const isPaymentReviewResult = (record) => REVIEW_RESULT_STATUSES.has(record.status);

const isReviewCompletionPending = (record) =>
  hasPaymentReview(record) && (record.refundRequiresBookingSync === true || record.resourceReleasePending === true);

export const buildPaymentReviewResultAccess = (record, values) => {
  const next = { ...record, ...values };
  if (!hasPaymentReview(record) || isReviewCompletionPending(next) || !isPaymentReviewResult(next) ||
      (record.reviewResultAccessUntil && (record.reviewResultStatus || record.status) === next.status)) return {};
  return { reviewResultAccessUntil: new Date(Date.now() + REVIEW_RESULT_ACCESS_MS).toISOString(),
    reviewResultStatus: next.status };
};

export const canReadPaymentReviewResult = (record) => {
  if (isReviewCompletionPending(record)) return true;
  const expiresAt = Date.parse(record.reviewResultAccessUntil || "");
  return isPaymentReviewResult(record) && Number.isFinite(expiresAt) && expiresAt > Date.now();
};
