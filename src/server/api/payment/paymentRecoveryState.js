const PENDING_DODO = new Set(["processing", "requires_payment_method", "requires_customer_action", "requires_merchant_action", "requires_confirmation", "requires_capture", "partially_captured", "partially_captured_and_capturable"]);
const REVIEW_REASONS = new Set(["captured_payment_release_requires_review", "late_capture_watch_unverified_owner_review", "resource_release_exhausted_owner_review"]);
const UPGRADE_REASONS = new Set(["upgrade_credit_changed_after_quote", "upgrade_credit_unverified"]);
const CAPTURED = new Set(["booked", "email_partial", "captured_client", "captured_webhook", "finalizing", "verified_server", "refunded"]);

export const hasExplicitOwnerReview = (r = {}) => {
  const st = String(r.status || "").trim().toLowerCase(), reason = String(r.recoveryReason || "").trim();
  return r.recoveryOwnerReviewRequired === true || REVIEW_REASONS.has(reason) ||
    String(r.providerRecoveryTerminalReason || "").trim() === "dodo_refund_details_incomplete" ||
    (st === "needs_recovery" && r.reconciliationRecoveryTerminal === true && UPGRADE_REASONS.has(reason));
};
export const hasVerifiedReversal = (r = {}) => { const ps = String(r.providerPaymentState || "").trim().toLowerCase(); return (ps === "refunded" || ps === "disputed") && r.providerReversalVerified === true; };
export const hasPreservedOwnerReview = (r = {}) => hasExplicitOwnerReview(r) || (String(r.provider || "").trim().toLowerCase() === "dodo" && r.providerRecoveryTerminal === true && String(r.status || "").trim().toLowerCase() === "needs_recovery" && !hasVerifiedReversal(r));
export const hasKnownCaptureRecord = (r = {}) => {
  const st = String(r.status || "").trim().toLowerCase(), ps = String(r.providerPaymentState || "").trim().toLowerCase();
  return CAPTURED.has(st) || String(r.verificationState || "").trim().toLowerCase() === "server_verified" || ["succeeded", "refunded", "disputed"].includes(ps) || Boolean(String(r.captureClaimedAt || "").trim()) || Boolean(String(r.bookingId || "").trim());
};
export const computePaymentRecoveryFlags = (r = {}) => {
  const st = String(r.status || "").trim().toLowerCase(), prov = String(r.provider || "").trim().toLowerCase(), ps = String(r.providerPaymentState || "").trim().toLowerCase();
  const preserved = hasPreservedOwnerReview(r), releasePending = r.resourceReleasePending === true && !preserved, cleanupPending = releasePending || r.refundRequiresBookingSync === true;
  const verifiedUnpaidDodo = prov === "dodo" && (st === "failed" || st === "abandoned") && (ps === "failed" || ps === "cancelled") && !releasePending && !hasKnownCaptureRecord(r);
  const verifiedRevComplete = hasVerifiedReversal(r) && !cleanupPending && !hasExplicitOwnerReview(r);
  const manualReviewRequired = preserved || r.dodoDisputeActive === true || (r.reconciliationRecoveryTerminal === true && !releasePending && !verifiedRevComplete) || (prov === "dodo" && r.providerRecoveryTerminal === true && !verifiedUnpaidDodo && !verifiedRevComplete);
  const terminalOutcomeComplete = st === "failed" || st === "abandoned" ? !cleanupPending && !hasKnownCaptureRecord(r) && !PENDING_DODO.has(ps) && !manualReviewRequired : ["refunded", "booked", "email_partial"].includes(st) && !cleanupPending && !manualReviewRequired;
  return { terminalOutcomeComplete, cleanupPending, manualReviewRequired };
};
