import { getPaymentRecordById } from "./paymentRecord.js";
import { observedProviderState } from "./providerPaymentState.js";
import { settledDodoPaymentState } from "./dodoProvider.js";
import { logSafeError } from "../../safeErrorLog.js";

export const exhaustedPayPalWatchQuery = `(provider == "paypal" && lower(status) == $abandonedStatus
  && reconciliationRecoveryTerminal == true && recoveryReason == "paypal_lookup_failed_404"
  && recoveryFailureCount == 12 && nextRecoveryAt == "9999-12-31T23:59:59.999Z"
  && defined(lateCaptureWatchUntil) && lateCaptureWatchUntil != ""
  && coalesce(providerRecoveryTerminal, false) == false
  && coalesce(recoveryOwnerReviewRequired, false) == false
  && coalesce(resourceReleasePending, false) == false
  && coalesce(refundRequiresBookingSync, false) == false
  && coalesce(providerRefundDetailsMissing, false) == false)`;

export const isExhaustedPayPalWatch = (record) =>
  record.provider === "paypal" && String(record.status || "").toLowerCase() === "abandoned" &&
  record.reconciliationRecoveryTerminal === true && record.recoveryReason === "paypal_lookup_failed_404" &&
  record.recoveryFailureCount === 12 && record.nextRecoveryAt === "9999-12-31T23:59:59.999Z" &&
  !!record.lateCaptureWatchUntil && record.providerRecoveryTerminal !== true &&
  record.recoveryOwnerReviewRequired !== true && record.resourceReleasePending !== true &&
  record.refundRequiresBookingSync !== true && record.providerRefundDetailsMissing !== true;

export const buildWatchFailureState = (record, failureState) => ({
  ...failureState,
  reconciliationRecoveryTerminal: false,
  nextRecoveryAt: new Date(Math.min(
    Date.now() + 60 * 60 * 1000,
    new Date(record.lateCaptureWatchUntil).getTime()
  )).toISOString(),
});

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
