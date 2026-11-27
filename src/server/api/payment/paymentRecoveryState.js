export const ALL_PENDING_AND_PARTIAL_DODO_STATES = new Set([
  "processing",
  "requires_payment_method",
  "requires_customer_action",
  "requires_merchant_action",
  "requires_confirmation",
  "requires_capture",
  "partially_captured",
  "partially_captured_and_capturable",
]);

const REVIEW_REASONS = new Set([
  "captured_payment_release_requires_review",
  "late_capture_watch_unverified_owner_review",
  "resource_release_exhausted_owner_review",
]);
const UPGRADE_REASONS = new Set([
  "upgrade_credit_changed_after_quote",
  "upgrade_credit_unverified",
]);
const CAPTURED_STATUSES = new Set([
  "booked",
  "email_partial",
  "captured_client",
  "captured_webhook",
  "finalizing",
  "verified_server",
  "refunded",
]);

const hasExplicitOwnerReview = (r = {}) => {
  const st = String(r.status || "").trim().toLowerCase();
  const reason = String(r.recoveryReason || "").trim();
  return (
    r.recoveryOwnerReviewRequired === true ||
    REVIEW_REASONS.has(reason) ||
    String(r.providerRecoveryTerminalReason || "").trim() === "dodo_refund_details_incomplete" ||
    (st === "needs_recovery" && r.reconciliationRecoveryTerminal === true && UPGRADE_REASONS.has(reason))
  );
};

export const hasVerifiedReversal = (r = {}) => {
  const ps = String(r.providerPaymentState || "").trim().toLowerCase();
  return (ps === "refunded" || ps === "disputed") && r.providerReversalVerified === true;
};

export const hasPreservedOwnerReview = (r = {}) =>
  hasExplicitOwnerReview(r) ||
  (String(r.provider || "").trim().toLowerCase() === "dodo" &&
    r.providerRecoveryTerminal === true &&
    String(r.status || "").trim().toLowerCase() === "needs_recovery" &&
    !hasVerifiedReversal(r));

export const hasKnownCaptureRecord = (r = {}) => {
  const st = String(r.status || "").trim().toLowerCase();
  const ps = String(r.providerPaymentState || "").trim().toLowerCase();
  return (
    CAPTURED_STATUSES.has(st) ||
    String(r.verificationState || "").trim().toLowerCase() === "server_verified" ||
    ["succeeded", "refunded", "disputed"].includes(ps) ||
    String(r.recoveryReason || "").trim() === "dodo_refund_requires_reconciliation" ||
    Boolean(String(r.captureClaimedAt || "").trim()) ||
    Boolean(String(r.bookingId || "").trim())
  );
};

const isCleanupPending = (r = {}) =>
  r.resourceReleasePending === true && !hasPreservedOwnerReview(r);

const isManualReviewRequired = (r = {}) => {
  const st = String(r.status || "").trim().toLowerCase();
  const prov = String(r.provider || "").trim().toLowerCase();
  const ps = String(r.providerPaymentState || "").trim().toLowerCase();
  const preserved = hasPreservedOwnerReview(r);
  const releasePending = isCleanupPending(r);
  const resumablePendingCleanup = releasePending && !hasKnownCaptureRecord(r);
  const verifiedUnpaidDodo =
    prov === "dodo" &&
    (st === "failed" || st === "abandoned") &&
    (ps === "failed" || ps === "cancelled") &&
    !releasePending &&
    !hasKnownCaptureRecord(r);
  const verifiedRevComplete =
    hasVerifiedReversal(r) && !releasePending && r.refundRequiresBookingSync !== true && !hasExplicitOwnerReview(r);
  return (
    preserved ||
    r.dodoDisputeActive === true ||
    (r.reconciliationRecoveryTerminal === true && !resumablePendingCleanup && !verifiedRevComplete) ||
    (prov === "dodo" && r.providerRecoveryTerminal === true && !verifiedUnpaidDodo && !verifiedRevComplete)
  );
};

const isCompletedTerminalOutcome = (r = {}) => {
  const st = String(r.status || "").trim().toLowerCase();
  const ps = String(r.providerPaymentState || "").trim().toLowerCase();
  const cleanupPending = isCleanupPending(r) || r.refundRequiresBookingSync === true;
  const manualReviewRequired = isManualReviewRequired(r);
  if (st === "failed" || st === "abandoned") {
    return (
      !cleanupPending &&
      r.resourceReleasePending !== true &&
      !hasKnownCaptureRecord(r) &&
      !ALL_PENDING_AND_PARTIAL_DODO_STATES.has(ps) &&
      !manualReviewRequired
    );
  }
  return ["refunded", "booked", "email_partial"].includes(st) && !cleanupPending && !manualReviewRequired;
};

export const computePaymentRecoveryFlags = (r = {}) => ({
  terminalOutcomeComplete: isCompletedTerminalOutcome(r),
  cleanupPending: isCleanupPending(r) || r.refundRequiresBookingSync === true,
  manualReviewRequired: isManualReviewRequired(r),
});
