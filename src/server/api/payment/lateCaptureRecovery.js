import { getPaymentRecordById } from "./paymentRecord.js";
import { observedProviderState } from "./providerPaymentState.js";
import { settledDodoPaymentState } from "./dodoProvider.js";
import { ALL_PENDING_AND_PARTIAL_DODO_STATES } from "./paymentRecoveryState.js";
import { logSafeError } from "../../safeErrorLog.js";

export const RESUMABLE_WATCH_REASONS = [
  ...["paypal", "razorpay", "dodo"].flatMap((provider) =>
    [401, 403, 404, 429, 500, 502, 503, 504].map((status) => `${provider}_lookup_failed_${status}`)),
  "paypal_lookup_exception",
  "razorpay_lookup_exception",
];

const PENDING_DODO_GROQ = JSON.stringify([...ALL_PENDING_AND_PARTIAL_DODO_STATES]);

const hasExplicitOwnerReviewGroq = `(
  recoveryOwnerReviewRequired == true
  || recoveryReason in ["captured_payment_release_requires_review", "late_capture_watch_unverified_owner_review", "resource_release_exhausted_owner_review"]
  || providerRecoveryTerminalReason == "dodo_refund_details_incomplete"
  || (lower(status) == "needs_recovery" && reconciliationRecoveryTerminal == true && recoveryReason in ["upgrade_credit_changed_after_quote", "upgrade_credit_unverified"])
)`;

const hasVerifiedReversalGroq = `(providerPaymentState in ["refunded", "disputed"] && providerReversalVerified == true)`;

const hasPreservedOwnerReviewGroq = `(
  ${hasExplicitOwnerReviewGroq}
  || (provider == "dodo" && providerRecoveryTerminal == true && lower(status) == "needs_recovery" && !(${hasVerifiedReversalGroq}))
)`;

export const isCleanupPendingGroq = `(resourceReleasePending == true && !(${hasPreservedOwnerReviewGroq}))`;

export const dodoCleanupAllowedGroq = `($dodoEnabled == true || !(providerPaymentState in ${PENDING_DODO_GROQ}) || (defined(lateCaptureWatchUntil) && lateCaptureWatchUntil != "" && lateCaptureWatchUntil <= $now))`;

export const exhaustedPendingCleanupGroq = `(
  provider == "dodo"
  && reconciliationRecoveryTerminal == true
  && resourceReleasePending == true
  && providerRecoveryTerminal != true
  && !(${hasPreservedOwnerReviewGroq})
  && ${dodoCleanupAllowedGroq}
)`;

export const exhaustedLiveDodoStateGroq = `(
  $dodoEnabled == true
  && provider == "dodo"
  && reconciliationRecoveryTerminal == true
  && resourceReleasePending != true
  && providerRecoveryTerminal != true
  && !(${hasPreservedOwnerReviewGroq})
  && providerPaymentState in ${PENDING_DODO_GROQ}
)`;

export const exhaustedCleanupWatchActiveGroq = `(
  $dodoEnabled == true
  && provider == "dodo"
  && reconciliationRecoveryTerminal == true
  && providerRecoveryTerminal != true
  && !(${hasPreservedOwnerReviewGroq})
  && lower(status) in ["failed", "abandoned"]
  && defined(lateCaptureWatchUntil) && lateCaptureWatchUntil != ""
)`;

export const exhaustedResumeDueGroq = `(!defined(nextRecoveryAt) || nextRecoveryAt == "" || nextRecoveryAt <= $now || nextRecoveryAt >= "2090-01-01T00:00:00Z")`;

export const exhaustedWatchQuery = `(provider in ["paypal", "razorpay", "dodo"] && lower(status) == $abandonedStatus
  && reconciliationRecoveryTerminal == true && recoveryReason in $resumableWatchReasons
  && recoveryFailureCount == 12 && nextRecoveryAt == "9999-12-31T23:59:59.999Z"
  && defined(lateCaptureWatchUntil) && lateCaptureWatchUntil != ""
  && providerRecoveryTerminal != true
  && recoveryOwnerReviewRequired != true
  && resourceReleasePending != true
  && refundRequiresBookingSync != true
  && providerRefundDetailsMissing != true)`;

export const RECOVERY_RECORDS_GROQ = `*[_type == $type
  && (
    reconciliationRecoveryTerminal != true
    || ${exhaustedWatchQuery}
    || ${exhaustedPendingCleanupGroq}
    || ${exhaustedLiveDodoStateGroq}
    || ${exhaustedCleanupWatchActiveGroq}
  )
  && !(providerRecoveryTerminal == true
    && providerRecoveryTerminalReason in $terminalCurrencyReasons)
  && (
    provider != "dodo"
    || ($dodoEnabled && providerRecoveryTerminal != true)
    || refundRequiresBookingSync == true
    || (${isCleanupPendingGroq} && ${dodoCleanupAllowedGroq})
    || ${exhaustedPendingCleanupGroq}
    || ${exhaustedLiveDodoStateGroq}
    || (lower(status) == $emailPartialStatus && requiresReschedule == true)
    || (lower(status) in [$emailPartialStatus, $bookedStatus] && emailDispatchRequired == true)
  )
  && (
    lower(status) in $statuses
    || refundRequiresBookingSync == true
    || (lower(status) == $bookedStatus && emailDispatchRequired == true)
    || (
      lower(status) in [$abandonedStatus, "failed"]
      && (
        (${isCleanupPendingGroq} && (provider != "dodo" || ${dodoCleanupAllowedGroq}))
        || (defined(lateCaptureWatchUntil) && lateCaptureWatchUntil != "")
      )
    )
    || ${exhaustedPendingCleanupGroq}
    || ${exhaustedLiveDodoStateGroq}
  )
  && (
    !defined(nextRecoveryAt)
    || nextRecoveryAt == ""
    || nextRecoveryAt <= $now
    || ${exhaustedWatchQuery}
    || (${exhaustedPendingCleanupGroq} && ${exhaustedResumeDueGroq})
    || (${exhaustedLiveDodoStateGroq} && ${exhaustedResumeDueGroq})
  )
] | order(
  select((${exhaustedPendingCleanupGroq}) || (${exhaustedLiveDodoStateGroq}) => 0, 1) asc,
  coalesce(nextRecoveryAt, "") asc,
  coalesce(updatedAt, "") asc,
  _id asc
)[0...50]`;

export const isExhaustedWatch = (record) =>
  ["paypal", "razorpay", "dodo"].includes(record.provider) && String(record.status || "").toLowerCase() === "abandoned" &&
  record.reconciliationRecoveryTerminal === true && RESUMABLE_WATCH_REASONS.includes(record.recoveryReason) &&
  record.recoveryFailureCount === 12 && record.nextRecoveryAt === "9999-12-31T23:59:59.999Z" &&
  !!record.lateCaptureWatchUntil && record.providerRecoveryTerminal !== true &&
  record.recoveryOwnerReviewRequired !== true && record.resourceReleasePending !== true &&
  record.refundRequiresBookingSync !== true && record.providerRefundDetailsMissing !== true;

export const holdLostToPayment = (hold, record) =>
  ["paypal", "razorpay", "dodo"].includes(record.provider) && !!hold &&
  !record.bookingPayload?.originalOrderId &&
  !(hold.paymentRecordId === record._id && ["payment_pending", "consumed"].includes(hold.phase));

export const buildWatchFailureState = (failureState) => ({
  ...failureState,
  reconciliationRecoveryTerminal: false,
  nextRecoveryAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});

export const boundToWatchDeadline = (record, values) => {
  const merged = { ...record, ...values };
  const deadline = new Date(merged.lateCaptureWatchUntil || "").getTime();
  return merged.reconciliationRecoveryTerminal !== true && deadline > Date.now() &&
    new Date(values.nextRecoveryAt || "").getTime() > deadline
    ? { ...values, nextRecoveryAt: merged.lateCaptureWatchUntil } : values;
};

export const isTransientVerificationFailure = (reason = "") => {
  const normalized = String(reason || "").trim().toLowerCase();
  return (
    normalized === "razorpay_lookup_exception" ||
    normalized === "paypal_lookup_exception" ||
    /^(paypal|razorpay)_lookup_failed_(401|403|404|429)$/.test(normalized) ||
    /^dodo_lookup_failed_(401|403|404|429|5\d\d)$/.test(normalized) ||
    normalized === "paypal_lookup_auth_failed" ||
    normalized.startsWith("paypal_token_") ||
    normalized.startsWith("razorpay_credentials_") ||
    normalized === "razorpay_unavailable_in_runtime" ||
    normalized.startsWith("razorpay_lookup_failed_5") ||
    normalized.startsWith("paypal_lookup_failed_5")
  );
};

export const webhookFinalizationResult = (finalized) => {
  const retry = !finalized.ok && finalized.paymentRecord?.reconciliationRecoveryTerminal === true &&
    !String(finalized.paymentRecord?.bookingId || "").trim() &&
    isTransientVerificationFailure(finalized.paymentRecord?.recoveryReason);
  return retry
    ? { httpStatus: 503, body: { ...finalized.response, ok: false }, retryWebhook: true }
    : { httpStatus: finalized.httpStatus, body: finalized.response };
};

export const hasObservedCapture = (inspection) => inspection.state === "captured" &&
  (!inspection.payment || settledDodoPaymentState(inspection.payment) === "succeeded");

export const hasKnownCapture = (record) =>
  ["succeeded", "refunded", "disputed"].includes(record.providerPaymentState) ||
  record.verificationState === "server_verified";

export const recordCapturedProviderState = async ({ client, record, currentOperation, patchRecord }) => {
  const observed = observedProviderState(record, "succeeded");
  if (!observed.providerPaymentState) return { owned: true, record };
  const operation = await currentOperation({ client, record });
  if (!operation.owned) return operation;
  try {
    return { owned: true, record: await patchRecord({ client, record, set: observed }) };
  } catch (error) {
    if (Number(error?.statusCode || error?.status || 0) !== 409) throw error;
    return { owned: false, record: await getPaymentRecordById(client, record._id) };
  }
};

export const holdCapturedReleaseForReview = async ({ client, record, patchRecord }) => {
  if (record.reconciliationRecoveryTerminal === true) return record;
  try {
    const retained = await patchRecord({ client, record, set: {
      reconciliationRecoveryTerminal: true,
      recoveryReason: "captured_payment_release_requires_review",
      nextRecoveryAt: "9999-12-31T23:59:59.999Z",
    } });
    logSafeError("Captured payment release requires owner review", Object.assign(new Error(), {
      code: "captured_payment_release_requires_review",
    }));
    return retained;
  } catch (error) {
    if (Number(error?.statusCode || error?.status || 0) !== 409) throw error;
    return getPaymentRecordById(client, record._id);
  }
};
