export const PARTIAL_CAPTURE_DODO_STATES = new Set([
  "partially_captured", "partially_captured_and_capturable",
]);

export const ALL_PENDING_AND_PARTIAL_DODO_STATES = new Set([
  "processing", "requires_payment_method", "requires_customer_action", "requires_merchant_action",
  "requires_confirmation", "requires_capture", ...PARTIAL_CAPTURE_DODO_STATES,
]);

export const isPendingDodoStateBlockingRelease = (state = "", verifiedPriorPendingState = "") => {
  const ps = String(state || "").trim().toLowerCase();
  if (!ALL_PENDING_AND_PARTIAL_DODO_STATES.has(ps)) return false;
  if (PARTIAL_CAPTURE_DODO_STATES.has(ps)) return true;
  const allowed = String(verifiedPriorPendingState || "").trim().toLowerCase();
  return !allowed || ps !== allowed;
};

const REVIEW_REASONS = new Set([
  "captured_payment_release_requires_review", "late_capture_watch_unverified_owner_review", "resource_release_exhausted_owner_review",
]);
const UPGRADE_REASONS = new Set(["upgrade_credit_changed_after_quote", "upgrade_credit_unverified"]);
const CAPTURED_STATUSES = new Set([
  "booked", "email_partial", "captured_client", "captured_webhook", "finalizing", "verified_server", "refunded",
]);

export const isUpgradeCreditReviewRecord = (r = {}) =>
  String(r?.status || "").trim().toLowerCase() === "needs_recovery" &&
  r?.reconciliationRecoveryTerminal === true &&
  UPGRADE_REASONS.has(String(r?.recoveryReason || "").trim());

export const hasExplicitOwnerReview = (r = {}) => {
  const reason = String(r?.recoveryReason || "").trim();
  return (
    r?.recoveryOwnerReviewRequired === true ||
    REVIEW_REASONS.has(reason) ||
    String(r?.providerRecoveryTerminalReason || "").trim() === "dodo_refund_details_incomplete" ||
    isUpgradeCreditReviewRecord(r)
  );
};

export const hasVerifiedReversal = (r = {}) => {
  const ps = String(r?.providerPaymentState || "").trim().toLowerCase();
  return (ps === "refunded" || ps === "disputed") && r?.providerReversalVerified === true;
};

export const hasPreservedOwnerReview = (r = {}) =>
  hasExplicitOwnerReview(r) ||
  (String(r?.provider || "").trim().toLowerCase() === "dodo" &&
    r?.providerRecoveryTerminal === true &&
    String(r?.status || "").trim().toLowerCase() === "needs_recovery" &&
    !hasVerifiedReversal(r));

export const isSoleLateWatchOwnerReview = (r = {}) => {
  if (!r || typeof r !== "object") return false;
  if (String(r.recoveryReason || "").trim() !== "late_capture_watch_unverified_owner_review") return false;
  const st = String(r.status || "").trim().toLowerCase();
  return (
    !isUpgradeCreditReviewRecord(r) &&
    r.recoveryOwnerReviewRequired !== true &&
    String(r.providerRecoveryTerminalReason || "").trim() !== "dodo_refund_details_incomplete" &&
    !(String(r.provider || "").trim().toLowerCase() === "dodo" &&
      r.providerRecoveryTerminal === true &&
      st === "needs_recovery" &&
      !hasVerifiedReversal(r))
  );
};

export const isWebhookLateWatchRecovery = (r = {}, source = "", priorStatus = "") => {
  if (String(source || "").trim().toLowerCase() !== "webhook") return false;
  const st = String(r?.status || "").trim().toLowerCase();
  const prior = String(priorStatus || "").trim().toLowerCase();
  const effectiveStatus = st === "finalizing" && prior ? prior : st;
  return (
    (effectiveStatus === "abandoned" || effectiveStatus === "needs_recovery") &&
    isSoleLateWatchOwnerReview(r)
  );
};

export const hasKnownCaptureRecord = (r = {}) => {
  const st = String(r?.status || "").trim().toLowerCase();
  if (String(r?.provider || "").trim().toLowerCase() === "free") {
    return st === "booked" || st === "email_partial" || Boolean(String(r?.bookingId || "").trim());
  }
  const ps = String(r?.providerPaymentState || "").trim().toLowerCase();
  return (
    CAPTURED_STATUSES.has(st) ||
    String(r?.verificationState || "").trim().toLowerCase() === "server_verified" ||
    ["succeeded", "refunded", "disputed"].includes(ps) ||
    String(r?.recoveryReason || "").trim() === "dodo_refund_requires_reconciliation" ||
    Boolean(String(r?.captureClaimedAt || "").trim()) ||
    Boolean(String(r?.bookingId || "").trim())
  );
};

export const isCleanupPending = (r = {}) =>
  r?.resourceReleasePending === true && !hasPreservedOwnerReview(r);

export const isManualReviewRequired = (r = {}) => {
  const st = String(r?.status || "").trim().toLowerCase();
  const prov = String(r?.provider || "").trim().toLowerCase();
  const ps = String(r?.providerPaymentState || "").trim().toLowerCase();
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
    hasVerifiedReversal(r) && !releasePending && r?.refundRequiresBookingSync !== true && !hasExplicitOwnerReview(r);
  const verifiedFullRefund = st === "refunded" && verifiedRevComplete;
  return (
    preserved ||
    (r?.dodoDisputeActive === true && !verifiedFullRefund) ||
    (r?.reconciliationRecoveryTerminal === true && !resumablePendingCleanup && !verifiedRevComplete) ||
    (prov === "dodo" && r?.providerRecoveryTerminal === true && !verifiedUnpaidDodo && !verifiedRevComplete)
  );
};

export const isCompletedTerminalOutcome = (r = {}) => {
  const st = String(r?.status || "").trim().toLowerCase();
  const ps = String(r?.providerPaymentState || "").trim().toLowerCase();
  const cleanupPending = isCleanupPending(r) || r?.refundRequiresBookingSync === true;
  const manualReviewRequired = isManualReviewRequired(r);
  if (st === "failed" || st === "abandoned") {
    return (
      !cleanupPending &&
      r?.resourceReleasePending !== true &&
      !hasKnownCaptureRecord(r) &&
      !ALL_PENDING_AND_PARTIAL_DODO_STATES.has(ps) &&
      !manualReviewRequired
    );
  }
  return ["refunded", "booked", "email_partial"].includes(st) && !cleanupPending && !manualReviewRequired;
};

export const computePaymentRecoveryFlags = (r = {}) => ({
  terminalOutcomeComplete: isCompletedTerminalOutcome(r),
  cleanupPending: isCleanupPending(r) || r?.refundRequiresBookingSync === true,
  manualReviewRequired: isManualReviewRequired(r),
});
