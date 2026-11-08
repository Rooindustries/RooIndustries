import {
  PAYMENT_STATUS_STARTED,
  PAYMENT_STATUS_NEEDS_RECOVERY,
  PAYMENT_STATUS_FINALIZING,
  PAYMENT_STATUS_CAPTURED_CLIENT,
  PAYMENT_STATUS_CAPTURED_WEBHOOK,
  PAYMENT_STATUS_BOOKED,
  PAYMENT_STATUS_EMAIL_PARTIAL,
  PAYMENT_STATUS_REFUNDED,
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
]);

const hasPaymentReview = (record) =>
  record.providerPaymentState === "requires_merchant_action" || record.recoveryOwnerReviewRequired === true;

export const isPaymentAwaitingReview = (record) =>
  !record.bookingId && REVIEW_PENDING_STATUSES.has(record.status) && hasPaymentReview(record);

const isReviewRefundPending = (record) =>
  record.status === PAYMENT_STATUS_REFUNDED && record.refundRequiresBookingSync === true && hasPaymentReview(record);

export const buildPaymentReviewResultAccess = (record, values) => {
  const next = { ...record, ...values };
  if (record.reviewResultAccessUntil || !hasPaymentReview(record) || isReviewRefundPending(next) ||
      !REVIEW_RESULT_STATUSES.has(next.status)) return {};
  return { reviewResultAccessUntil: new Date(Date.now() + REVIEW_RESULT_ACCESS_MS).toISOString() };
};

export const canReadPaymentReviewResult = (record) => {
  if (isReviewRefundPending(record)) return true;
  const expiresAt = Date.parse(record.reviewResultAccessUntil || "");
  return REVIEW_RESULT_STATUSES.has(record.status) && Number.isFinite(expiresAt) && expiresAt > Date.now();
};
