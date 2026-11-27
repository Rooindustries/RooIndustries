import { getPaymentRecordById } from "./paymentRecord.js";
import { observedProviderState } from "./providerPaymentState.js";
import { settledDodoPaymentState } from "./dodoProvider.js";
import {
  ALL_PENDING_AND_PARTIAL_DODO_STATES,
  hasKnownCaptureRecord,
  hasPreservedOwnerReview,
  isWebhookLateWatchRecovery,
} from "./paymentRecoveryState.js";
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

export const dodoCleanupAllowedGroq = `($dodoEnabled == true || !(providerPaymentState in ${PENDING_DODO_GROQ}) || (defined(lateCaptureWatchUntil) && defined(dateTime(lateCaptureWatchUntil)) && dateTime(lateCaptureWatchUntil) <= dateTime($now)))`;

export const exhaustedPendingCleanupGroq = `(provider == "dodo" && reconciliationRecoveryTerminal == true && resourceReleasePending == true && providerRecoveryTerminal != true && !(${hasPreservedOwnerReviewGroq}) && ${dodoCleanupAllowedGroq})`;

export const exhaustedLiveDodoStateGroq = `($dodoEnabled == true && provider == "dodo" && reconciliationRecoveryTerminal == true && resourceReleasePending != true && providerRecoveryTerminal != true && !(${hasPreservedOwnerReviewGroq}) && providerPaymentState in ${PENDING_DODO_GROQ})`;

export const exhaustedCleanupWatchActiveGroq = `($dodoEnabled == true && provider == "dodo" && reconciliationRecoveryTerminal == true && providerRecoveryTerminal != true && !(${hasPreservedOwnerReviewGroq}) && lower(status) in ["failed", "abandoned"] && defined(dateTime(lateCaptureWatchUntil)))`;

export const exhaustedResumeDueGroq = `(!defined(nextRecoveryAt) || nextRecoveryAt == "" || (defined(dateTime(nextRecoveryAt)) && (dateTime(nextRecoveryAt) <= dateTime($now) || dateTime(nextRecoveryAt) >= dateTime("2090-01-01T00:00:00Z"))))`;

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
        || defined(dateTime(lateCaptureWatchUntil))
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

export const hasActiveLateCaptureWatch = (record = {}) =>
  typeof record?.lateCaptureWatchUntil === "string" &&
  record.lateCaptureWatchUntil.replace(/[ \t\r\n]+/g, "").length > 0;

export const isExhaustedWatch = (record) =>
  ["paypal", "razorpay", "dodo"].includes(record.provider) && String(record.status || "").toLowerCase() === "abandoned" &&
  record.reconciliationRecoveryTerminal === true && RESUMABLE_WATCH_REASONS.includes(record.recoveryReason) &&
  record.recoveryFailureCount === 12 && record.nextRecoveryAt === "9999-12-31T23:59:59.999Z" &&
  hasActiveLateCaptureWatch(record) && record.providerRecoveryTerminal !== true &&
  record.recoveryOwnerReviewRequired !== true && record.resourceReleasePending !== true &&
  record.refundRequiresBookingSync !== true && record.providerRefundDetailsMissing !== true;

const SENTINEL_RECOVERY_MS = Date.parse("2090-01-01T00:00:00Z");

const isExhaustedResumeDue = (record, nowMs = Date.now()) => {
  const next = String(record?.nextRecoveryAt || "").trim();
  if (!next) return true;
  const parsed = Date.parse(next);
  return !Number.isFinite(parsed) || parsed <= nowMs || parsed >= SENTINEL_RECOVERY_MS;
};

const STRICT_ISO_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isDodoCleanupAllowed = (record, { dodoEnabled = true, nowMs = Date.now() } = {}) => {
  if (dodoEnabled === true) return true;
  const ps = String(record?.providerPaymentState || "").trim();
  if (!ALL_PENDING_AND_PARTIAL_DODO_STATES.has(ps)) return true;
  const rawWatch = typeof record?.lateCaptureWatchUntil === "string" ? record.lateCaptureWatchUntil.trim() : "";
  if (!STRICT_ISO_TS_RE.test(rawWatch)) return false;
  const watchMs = Date.parse(rawWatch);
  return Number.isFinite(watchMs) && watchMs <= nowMs;
};

export const isExhaustedResumableDodo = (record, { dodoEnabled = true, nowMs = Date.now() } = {}) => {
  if (!record || record.provider !== "dodo" || record.reconciliationRecoveryTerminal !== true ||
      record.providerRecoveryTerminal === true || hasPreservedOwnerReview(record)) {
    return false;
  }
  const ps = String(record.providerPaymentState || "").trim();
  const st = String(record.status || "").trim().toLowerCase();
  if (record.resourceReleasePending === true && isDodoCleanupAllowed(record, { dodoEnabled, nowMs }) &&
      isExhaustedResumeDue(record, nowMs)) {
    return true;
  }
  if (dodoEnabled === true && record.resourceReleasePending !== true &&
      ALL_PENDING_AND_PARTIAL_DODO_STATES.has(ps) && isExhaustedResumeDue(record, nowMs)) {
    return true;
  }
  return dodoEnabled === true && (st === "failed" || st === "abandoned") &&
    hasActiveLateCaptureWatch(record);
};

export const isExhaustedCleanupWatchActive = (record = {}) =>
  record?.provider === "dodo" &&
  record.reconciliationRecoveryTerminal === true &&
  record.providerRecoveryTerminal !== true &&
  !hasPreservedOwnerReview(record) &&
  ["failed", "abandoned"].includes(String(record.status || "").trim().toLowerCase()) &&
  hasActiveLateCaptureWatch(record);

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
  const retry =
    finalized?.retryWebhook === true ||
    (!finalized.ok &&
      finalized.paymentRecord?.reconciliationRecoveryTerminal === true &&
      !String(finalized.paymentRecord?.bookingId || "").trim() &&
      isTransientVerificationFailure(finalized.paymentRecord?.recoveryReason));
  return retry
    ? { httpStatus: 503, body: { ...finalized.response, ok: false }, retryWebhook: true }
    : { httpStatus: finalized.httpStatus, body: finalized.response };
};

export const hasKnownCapture = (record = {}) => hasKnownCaptureRecord(record);

export const hasObservedCapture = (inspection) =>
  inspection.state === "captured" &&
  (!inspection.payment || settledDodoPaymentState(inspection.payment) === "succeeded");

const buildCaptureLineageUpdates = (record = {}, priorStatus = "") => {
  const status = String(record.status || "").trim().toLowerCase();
  const prior = String(priorStatus || "").trim().toLowerCase();
  const target = String(record.resourceReleaseTargetStatus || "").trim().toLowerCase();
  return {
    ...(status === "failed" || prior === "failed" || target === "failed" ? { capturedAfterFailure: true } : {}),
    ...(status === "abandoned" || prior === "abandoned" || target === "abandoned" ? { capturedAfterAbandonment: true } : {}),
  };
};

export const recordCapturedProviderState = async ({
  client,
  record,
  currentOperation,
  patchRecord,
  source = "",
  priorStatus = "",
  providerPaymentId = "",
  captureAmountUpdates = null,
  validateBinding = null,
}) => {
  const expectedLeaseId = String(record?.finalizationLeaseId || "").trim();
  const normalizedPrior = String(priorStatus || "").trim().toLowerCase();
  let current = record;
  let hadConflict = false;
  for (let attempt = 0; attempt < 5 && current?._id; attempt += 1) {
    const status = String(current.status || "").trim().toLowerCase();
    const effectiveStatus = status === "finalizing" && normalizedPrior ? normalizedPrior : status;
    const clearingLateWatch = isWebhookLateWatchRecovery(current, source, normalizedPrior);
    if (
      ["booked", "email_partial", "refunded"].includes(status) ||
      current.dodoDisputeActive === true ||
      ["refunded", "disputed"].includes(current.providerPaymentState) ||
      (!clearingLateWatch && hasPreservedOwnerReview(current))
    ) {
      return { owned: false, record: current };
    }
    if (typeof validateBinding === "function") {
      const check = validateBinding(current);
      if (!check?.ok) return { owned: false, record: current, bindingError: check };
    }
    const observed = observedProviderState(current, "succeeded");
    const lineage = buildCaptureLineageUpdates(current, normalizedPrior);
    const hasPendingRelease =
      current.resourceReleasePending === true ||
      Boolean(current.resourceReleaseTargetStatus) ||
      Boolean(current.resourceReleaseReason);
    const alreadyClaimed =
      Boolean(String(current.captureClaimedAt || "").trim()) &&
      String(current.providerPaymentState || "").trim().toLowerCase() === "succeeded";
    const needsResumeStatus =
      clearingLateWatch || ["failed", "abandoned"].includes(status) || current.reconciliationRecoveryTerminal === true;
    const needsLineagePatch =
      (lineage.capturedAfterFailure === true && current.capturedAfterFailure !== true) ||
      (lineage.capturedAfterAbandonment === true && current.capturedAfterAbandonment !== true);
    if (alreadyClaimed && !needsResumeStatus && !hasPendingRelease && !needsLineagePatch) {
      return { owned: true, record: current };
    }
    const cleanId = String(providerPaymentId || "").trim();
    const idPatch = cleanId && !String(current.providerPaymentId || "").trim() ? { providerPaymentId: cleanId } : {};
    const resolvedAmounts = typeof captureAmountUpdates === "function" ? captureAmountUpdates(current) : captureAmountUpdates;
    const amountPatch =
      resolvedAmounts && Object.keys(resolvedAmounts).length
        ? { providerPublicData: { ...(current.providerPublicData || {}), ...resolvedAmounts } }
        : {};
    const attemptPatch =
      current.provider === "dodo" && current.dodoAttemptObserved !== true ? { dodoAttemptObserved: true } : {};
    const now = new Date().toISOString();
    const needsDueRecovery =
      needsResumeStatus ||
      hasPendingRelease ||
      (Boolean(current.nextRecoveryAt) && String(current.nextRecoveryAt) > now);
    const resumeStatusPatch = needsResumeStatus
      ? {
          ...(status !== "finalizing" ? { status: "needs_recovery" } : {}),
          reconciliationRecoveryTerminal: false,
          providerRecoveryTerminal: false,
        }
      : {};
    const set = {
      ...observed,
      ...lineage,
      ...idPatch,
      ...amountPatch,
      ...attemptPatch,
      ...(!current.captureClaimedAt ? { captureClaimedAt: now } : {}),
      ...(clearingLateWatch
        ? { recoveryReason: "", ...(effectiveStatus === "abandoned" ? { capturedAfterAbandonment: true } : {}) }
        : {}),
      ...(hasPendingRelease ? { resourceReleasePending: false, resourceReleaseTargetStatus: "", resourceReleaseReason: "" } : {}),
      ...resumeStatusPatch,
      ...(needsDueRecovery ? { nextRecoveryAt: now } : {}),
    };
    if (!Object.keys(set).length) return { owned: true, record: current };
    const operation = await currentOperation({ client, record: current });
    if (!operation.owned) {
      const reloadedLeaseId = String(operation.record?.finalizationLeaseId || "").trim();
      if (
        operation.record?._id &&
        operation.record._rev !== current._rev &&
        reloadedLeaseId === expectedLeaseId
      ) {
        hadConflict = true;
        current = operation.record;
        continue;
      }
      return operation;
    }
    try {
      return { owned: true, record: await patchRecord({ client, record: current, set }) };
    } catch (error) {
      if (Number(error?.statusCode || error?.status || 0) !== 409) throw error;
      hadConflict = true;
      const reloaded = await getPaymentRecordById(client, current._id);
      if (String(reloaded?.finalizationLeaseId || "").trim() !== expectedLeaseId) {
        return { owned: false, record: reloaded || current };
      }
      current = reloaded;
    }
  }
  return { owned: false, record: current || record, conflictExhausted: hadConflict };
};

export const holdCapturedReleaseForReview = async ({ client, record, patchRecord }) => {
  const status = String(record?.status || "").trim().toLowerCase();
  if (["booked", "email_partial", "refunded"].includes(status) || (record.reconciliationRecoveryTerminal === true && hasPreservedOwnerReview(record))) {
    return record;
  }
  try {
    const retained = await patchRecord({
      client,
      record,
      set: {
        status: "needs_recovery",
        reconciliationRecoveryTerminal: true,
        recoveryOwnerReviewRequired: true,
        recoveryReason: "captured_payment_release_requires_review",
        resourceReleasePending: false,
        resourceReleaseTargetStatus: "",
        resourceReleaseReason: "",
        nextRecoveryAt: "9999-12-31T23:59:59.999Z",
      },
    });
    logSafeError("Captured payment release requires owner review", Object.assign(new Error(), { code: "captured_payment_release_requires_review" }));
    return retained;
  } catch (error) {
    if (Number(error?.statusCode || error?.status || 0) !== 409) throw error;
    return (await getPaymentRecordById(client, record._id)) || record;
  }
};
