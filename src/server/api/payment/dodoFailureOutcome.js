import crypto from "crypto";
import { issueHoldToken } from "../../booking/holdToken.js";
import envValue from "../../supabase/envValue.cjs";
const { resolveStoreBackend } = envValue;
import {
  escalateDodoMismatchToOwnerReview,
  escalateExhaustedCleanupToOwnerReview,
  finalizeExhaustedCleanup,
  futureIso,
  getDocumentByTypeAndId,
  isConflict,
  isFutureIso,
  isLockedOrSettled,
  LATE_CAPTURE_WATCH_SECONDS,
  nowIso,
  paymentIdPatch,
  persistDodoInspectionEvidence,
  stateObsPatch,
  vetoDodoPendingCleanup,
} from "./dodoInspectionGuard.js";
import { hasActiveLateCaptureWatch, holdCapturedReleaseForReview } from "./lateCaptureRecovery.js";
import {
  ACTIVE_OR_PARTIAL_DODO_STATES,
  mapDodoFailureReason,
  normalizePaymentFailureCount,
  PARTIAL_CAPTURE_DODO_STATES,
} from "./paymentFailureReason.js";
import {
  ALL_PENDING_AND_PARTIAL_DODO_STATES,
  hasExplicitOwnerReview,
  hasKnownCaptureRecord,
  hasPreservedOwnerReview,
  isCleanupPending,
  isManualReviewRequired,
} from "./paymentRecoveryState.js";
import {
  buildPaymentRecordEvent,
  getPaymentRecordById,
  mergePaymentRecordEvents,
  PAYMENT_START_CLAIM_TYPE,
  PAYMENT_STATUS_ABANDONED,
  PAYMENT_STATUS_FAILED,
  PAYMENT_STATUS_NEEDS_RECOVERY,
  PAYMENT_STATUS_STARTED,
  PAYMENT_UPGRADE_LOCK_TYPE,
} from "./paymentRecord.js";

const MAX_DODO_HOLD_RETRIES = 3;

const isValidHoldRetentionWindow = (holdDoc) =>
  Boolean(holdDoc?._id && isFutureIso(holdDoc.expiresAt));

const makeResponse = (ok, httpStatus, paymentRecord, buildPublicStatusBody, includeRefreshedHold) => ({
  ok,
  httpStatus,
  paymentRecord,
  response: buildPublicStatusBody(paymentRecord, { includeRefreshedHold }),
});

const isActiveGate1Recovery = (current) => {
  const status = String(current?.status || "").trim().toLowerCase();
  return (
    !isManualReviewRequired(current) &&
    [PAYMENT_STATUS_NEEDS_RECOVERY, "finalizing", "captured_client", "captured_webhook", "verified_server"].includes(status)
  );
};

const stageCleanupFailure = async (args) => {
  const {
    client, record, targetStatus, reason, observedState, providerPaymentId, source,
    patchRecord, getNextPaymentRecoveryAt, buildPublicStatusBody, includeRefreshedHold,
    failureFields, freshLiveTerminal = false,
  } = args;
  const current = (await getPaymentRecordById(client, record._id)) || record;
  if (isLockedOrSettled(current)) {
    return makeResponse(true, 200, current, buildPublicStatusBody, includeRefreshedHold);
  }
  if (hasKnownCaptureRecord(current)) {
    if (isActiveGate1Recovery(current)) {
      return makeResponse(true, 200, current, buildPublicStatusBody, includeRefreshedHold);
    }
    const retained = await holdCapturedReleaseForReview({ client, record: current, patchRecord });
    return makeResponse(false, 202, retained, buildPublicStatusBody, includeRefreshedHold);
  }
  const completedStatus = String(current.status || "").trim().toLowerCase();
  if (completedStatus === targetStatus && !isCleanupPending(current) && current.resourceReleasePending !== true) {
    return makeResponse(true, 200, current, buildPublicStatusBody, includeRefreshedHold);
  }
  const storedState = String(current.providerPaymentState || "").trim().toLowerCase();
  const revisionUnchanged = !record?._rev || current._rev === record._rev;
  const partialCaptured = PARTIAL_CAPTURE_DODO_STATES.includes(storedState);
  const effectiveFreshLiveTerminal = freshLiveTerminal && revisionUnchanged && !partialCaptured;
  if (partialCaptured || (!effectiveFreshLiveTerminal && ALL_PENDING_AND_PARTIAL_DODO_STATES.has(storedState))) {
    const vetoed = await vetoDodoPendingCleanup({
      client, record: current, observedState: storedState, providerPaymentId, targetStatus, source,
      reason: partialCaptured
        ? "dodo_partial_capture_requires_recovery" : "dodo_payment_still_live",
      patchRecord,
    });
    return makeResponse(vetoed.ok, vetoed.httpStatus, vetoed.paymentRecord, buildPublicStatusBody, includeRefreshedHold);
  }
  const nextFailures = normalizePaymentFailureCount(current.recoveryFailureCount) + 1;
  if (nextFailures >= 12) return finalizeExhaustedCleanup({ ...args, record: current, freshLiveTerminal: effectiveFreshLiveTerminal });
  const nextAttempts = Math.min(12, normalizePaymentFailureCount(current.recoveryAttemptCount) + 1);
  let staged = current;
  try {
    staged = await patchRecord({
      client,
      record: current,
      set: {
        ...stateObsPatch(current, observedState, { allowTerminal: effectiveFreshLiveTerminal }),
        ...paymentIdPatch(current, providerPaymentId),
        ...failureFields,
        status: PAYMENT_STATUS_NEEDS_RECOVERY,
        recoveryReason: "resource_release_pending",
        recoveryFailureCount: nextFailures,
        recoveryAttemptCount: nextAttempts,
        reconciliationRecoveryTerminal: false,
        resourceReleasePending: true,
        resourceReleaseTargetStatus: targetStatus,
        resourceReleaseReason: reason,
        nextRecoveryAt: getNextPaymentRecoveryAt(nextFailures),
        finalizationLeaseId: "",
        finalizationLeaseExpiresAt: "",
        ...(current.provider === "dodo" ? { dodoAttemptObserved: true } : {}),
      },
      event: buildPaymentRecordEvent({ status: PAYMENT_STATUS_NEEDS_RECOVERY, source, reason: "resource_release_pending" }),
    });
  } catch (error) {
    if (!isConflict(error)) throw error;
    staged = (await getPaymentRecordById(client, current._id)) || current;
  }
  return makeResponse(false, 202, staged, buildPublicStatusBody, includeRefreshedHold);
};

const buildHoldOutcome = ({ isCancel, isUpgrade, holdDoc, holdOwned, current, failureFields, now }) => {
  const priorFailures = holdOwned ? normalizePaymentFailureCount(holdDoc.paymentFailureCount) : 0;
  if (!isCancel && !isUpgrade && holdOwned && isValidHoldRetentionWindow(holdDoc) && priorFailures < MAX_DODO_HOLD_RETRIES) {
    const nextCount = priorFailures + 1;
    const holdNonce = crypto.randomUUID();
    const preservedExpiresAt = String(holdDoc.expiresAt || "").trim();
    const holdToken = issueHoldToken({
      holdId: holdDoc._id,
      startTimeUTC: holdDoc.startTimeUTC,
      expiresAt: preservedExpiresAt,
      holdNonce,
      backend: resolveStoreBackend(holdDoc.backendOwner || current.backendOwner),
      cutoverGeneration: Number(holdDoc.cutoverGeneration ?? current.cutoverGeneration ?? 0),
    });
    return {
      holdPatch: {
        phase: "active",
        holdNonce,
        paymentRecordId: "",
        paymentProvider: "",
        expiresAt: preservedExpiresAt,
        paymentFailureCount: nextCount,
      },
      outcomeMeta: {
        ...failureFields,
        holdRetained: true,
        slotReleased: false,
        retriesRemaining: Math.max(0, MAX_DODO_HOLD_RETRIES - nextCount),
        refreshedHoldSnapshot: { slotHoldId: holdDoc._id, slotHoldToken: holdToken, slotHoldExpiresAt: preservedExpiresAt, phase: "active" },
      },
    };
  }
  const releaseReason = isCancel
    ? "cancelled" : !holdOwned ? "payment_failed" : !isValidHoldRetentionWindow(holdDoc) ? "expired" : "retry_limit";
  const holdPatch = holdOwned
    ? { phase: "released", expiresAt: now, releasedAt: now, paymentRecordId: "", paymentProvider: "", releaseReason }
    : null;
  const keepPriorFlags = !holdOwned && typeof current.holdRetained === "boolean";
  const outcomeMeta = isCancel
    ? {}
    : { ...failureFields, ...(keepPriorFlags ? {} : { holdRetained: false, slotReleased: !isUpgrade, retriesRemaining: 0 }) };
  return { holdPatch, outcomeMeta };
};

const commitDodoTerminalOutcome = async ({
  mode, client, record, payment = null, source = "reconcile", reason = "",
  prepareCouponRelease = null, appendCouponRelease = null, loadCouponReservationHandlers = null,
  patchRecord, getNextPaymentRecoveryAt, buildPublicStatusBody, includeRefreshedHold = false,
  allowStoredTerminalRelease = false, allowUnattemptedRelease = false, deadlinePinnedRev = "", deadlinePinnedCheckedAt = "", closeWatchOnCommit = false,
}) => {
  const isCancel = mode === "cancelled";
  const targetStatus = isCancel ? PAYMENT_STATUS_ABANDONED : PAYMENT_STATUS_FAILED;
  const outcomeReason = reason || (isCancel ? "dodo_payment_cancelled" : "dodo_payment_failed");
  const liveState = String(payment?.status || "").trim().toLowerCase();
  const liveTerminalValid = Boolean(payment) && (isCancel ? liveState === "cancelled" : liveState === "failed") && !PARTIAL_CAPTURE_DODO_STATES.includes(liveState);
  const cleanId = String(payment?.payment_id || "").trim();
  const maxAttempts = deadlinePinnedRev ? 1 : 5;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = (await getPaymentRecordById(client, record._id)) || record;
    const status = String(current.status || "").trim().toLowerCase();
    const storedState = String(current.providerPaymentState || "").trim().toLowerCase();
    if (deadlinePinnedRev && (current._rev !== deadlinePinnedRev || String(current.providerStateCheckedAt || "") !== String(deadlinePinnedCheckedAt || ""))) {
      return makeResponse(false, 202, current, buildPublicStatusBody, includeRefreshedHold);
    }
    if (isLockedOrSettled(current)) return makeResponse(true, 200, current, buildPublicStatusBody, includeRefreshedHold);
    if (hasKnownCaptureRecord(current)) {
      if (isActiveGate1Recovery(current)) return makeResponse(true, 200, current, buildPublicStatusBody, includeRefreshedHold);
      const retained = await holdCapturedReleaseForReview({ client, record: current, patchRecord });
      return makeResponse(false, 202, retained, buildPublicStatusBody, includeRefreshedHold);
    }
    const freshRevisionMatchedTerminal =
      liveTerminalValid && (!deadlinePinnedRev || (current._rev === deadlinePinnedRev && String(current.providerStateCheckedAt || "") === String(deadlinePinnedCheckedAt || "")));
    const partialCaptured = PARTIAL_CAPTURE_DODO_STATES.includes(storedState) || PARTIAL_CAPTURE_DODO_STATES.includes(liveState);
    const pendingBlind = !freshRevisionMatchedTerminal && (ALL_PENDING_AND_PARTIAL_DODO_STATES.has(storedState) || ALL_PENDING_AND_PARTIAL_DODO_STATES.has(liveState));
    if (partialCaptured || pendingBlind) {
      const vetoed = await vetoDodoPendingCleanup({
        client, record: current, observedState: liveState || storedState, providerPaymentId: cleanId, targetStatus, source,
        reason: partialCaptured ? "dodo_partial_capture_requires_recovery" : "dodo_payment_still_live",
        patchRecord,
      });
      return makeResponse(vetoed.ok, vetoed.httpStatus, vetoed.paymentRecord, buildPublicStatusBody, includeRefreshedHold);
    }
    if (status === targetStatus && !isCleanupPending(current) && current.resourceReleasePending !== true) {
      return makeResponse(true, 200, current, buildPublicStatusBody, includeRefreshedHold);
    }

    const mapped = mapDodoFailureReason(payment?.error_code);
    const failureFields = isCancel ? {} : {
      paymentFailureCode: String(current.paymentFailureCode || "").trim() || mapped.code,
      paymentFailureMessage: String(current.paymentFailureMessage || "").trim() || mapped.message,
    };
    const stageArgs = {
      client, record: current, targetStatus, reason: outcomeReason, observedState: liveState,
      providerPaymentId: cleanId, source, patchRecord, getNextPaymentRecoveryAt, buildPublicStatusBody,
      includeRefreshedHold, failureFields, freshLiveTerminal: freshRevisionMatchedTerminal,
    };
    const holdId = String(current?.holdSnapshot?.slotHoldId || current?.bookingPayload?.slotHoldId || "").trim();
    const isUpgrade = Boolean(String(current?.bookingPayload?.originalOrderId || "").trim()) && !holdId;
    const holdDoc = holdId ? await getDocumentByTypeAndId(client, "slotHold", holdId) : null;
    const holdOwned = Boolean(holdDoc?._id && String(holdDoc.paymentRecordId || "").trim() === String(current._id).trim());
    const startClaimId = String(current.startClaimId || "").trim();
    const claim = startClaimId
      ? await getDocumentByTypeAndId(client, startClaimId.startsWith("paymentUpgradeLock.") ? PAYMENT_UPGRADE_LOCK_TYPE : PAYMENT_START_CLAIM_TYPE, startClaimId)
      : null;
    const claimOwned = Boolean(claim?._id && String(claim.paymentRecordId || "").trim() === String(current._id).trim());

    let couponReleasePlan = null;
    let appendCoupon = appendCouponRelease;
    if (current.couponReservationId) {
      const loaded = typeof prepareCouponRelease === "function" && typeof appendCoupon === "function"
        ? { prepareCouponRelease, appendCouponRelease: appendCoupon }
        : typeof loadCouponReservationHandlers === "function" ? await loadCouponReservationHandlers() : {};
      const prepareFn = prepareCouponRelease || loaded.prepareCouponRelease;
      appendCoupon = appendCoupon || loaded.appendCouponRelease;
      if (typeof prepareFn !== "function" || typeof appendCoupon !== "function") return stageCleanupFailure(stageArgs);
      try {
        couponReleasePlan = await prepareFn({ client, redemptionId: current.couponReservationId });
      } catch {
        return stageCleanupFailure(stageArgs);
      }
      const rStatus = String(couponReleasePlan?.redemption?.status || "").trim().toLowerCase();
      if (rStatus === "consumed" || rStatus === "refunded") {
        return makeResponse(true, 200, current, buildPublicStatusBody, includeRefreshedHold);
      }
    }

    const now = nowIso();
    const watchUntil = closeWatchOnCommit ? "" : hasActiveLateCaptureWatch(current) ? current.lateCaptureWatchUntil : futureIso(LATE_CAPTURE_WATCH_SECONDS);
    const terminalObsState = freshRevisionMatchedTerminal ? liveState : allowStoredTerminalRelease && ["failed", "cancelled"].includes(storedState) ? storedState : "";
    if (!terminalObsState && !allowUnattemptedRelease) return stageCleanupFailure(stageArgs);
    const { holdPatch, outcomeMeta } = buildHoldOutcome({ isCancel, isUpgrade, holdDoc, holdOwned, current, failureFields, now });
    const recordSet = {
      ...stateObsPatch(current, terminalObsState, { allowTerminal: true }),
      ...paymentIdPatch(current, cleanId),
      ...outcomeMeta,
      status: targetStatus,
      recoveryReason: outcomeReason,
      resourceReleasePending: false,
      resourceReleaseTargetStatus: "",
      resourceReleaseReason: "",
      recoveryFailureCount: 0,
      recoveryAttemptCount: 0,
      reconciliationRecoveryTerminal: false,
      providerRecoveryTerminal: closeWatchOnCommit,
      providerRecoveryTerminalReason: closeWatchOnCommit ? outcomeReason : "",
      lateCaptureWatchUntil: watchUntil,
      nextRecoveryAt: isFutureIso(watchUntil) ? futureIso(60 * 60) : "",
      finalizationLeaseId: "",
      finalizationLeaseExpiresAt: "",
      dodoAttemptObserved: true,
      updatedAt: now,
      events: mergePaymentRecordEvents(current.events, buildPaymentRecordEvent({ status: targetStatus, source, reason: outcomeReason })),
    };

    let tx = client.transaction();
    tx = tx.patch(current._id, (patch) => patch.ifRevisionId(current._rev).set(recordSet));
    if (holdPatch && holdDoc?._id) tx = tx.patch(holdDoc._id, (patch) => patch.ifRevisionId(holdDoc._rev).set(holdPatch));
    if (couponReleasePlan?.redemption?._id && !couponReleasePlan.idempotent) {
      tx = appendCoupon({ transaction: tx, prepared: couponReleasePlan, reason: outcomeReason, releasedAt: now });
    }
    if (claimOwned) tx = tx.delete(claim._id, { ifRevisionId: claim._rev });
    try {
      await tx.commit();
    } catch (error) {
      if (isConflict(error)) {
        if (!deadlinePinnedRev && attempt < maxAttempts - 1) continue;
        const fresh = (await getPaymentRecordById(client, current._id)) || current;
        return makeResponse(false, 202, fresh, buildPublicStatusBody, includeRefreshedHold);
      }
      return stageCleanupFailure(stageArgs);
    }
    let committed = { ...current, ...recordSet };
    try {
      committed = (await getPaymentRecordById(client, current._id)) || committed;
    } catch {}
    return makeResponse(true, 200, committed, buildPublicStatusBody, includeRefreshedHold);
  }
  const latest = (await getPaymentRecordById(client, record._id)) || record;
  return makeResponse(false, 202, latest, buildPublicStatusBody, includeRefreshedHold);
};

export const commitDodoFailureOutcome = (args) => commitDodoTerminalOutcome({ ...args, mode: "failed" });
export const commitDodoCancellationOutcome = (args) => commitDodoTerminalOutcome({ ...args, mode: "cancelled" });

export const handleExhaustedCleanupWatchDeadline = async ({
  client, record, dodoEnabled, inspection = null, prepareCouponRelease = null, appendCouponRelease = null,
  loadCouponReservationHandlers = null, patchRecord, getNextPaymentRecoveryAt, buildPublicStatusBody,
}) => {
  const inspectedRev = record?._rev || "";
  const inspectedCheckedAt = record?.providerStateCheckedAt || "";
  const current = (await getPaymentRecordById(client, record._id)) || record;
  if (isLockedOrSettled(current) || hasKnownCaptureRecord(current) || hasExplicitOwnerReview(current)) {
    return makeResponse(true, 200, current, buildPublicStatusBody, false);
  }
  const storedState = String(current.providerPaymentState || "").trim().toLowerCase();
  if (ALL_PENDING_AND_PARTIAL_DODO_STATES.has(storedState) && !dodoEnabled) {
    const escalated = await escalateExhaustedCleanupToOwnerReview({ client, record: current, source: "reconcile", patchRecord });
    return makeResponse(false, 202, escalated, buildPublicStatusBody, false);
  }
  const liveStatus = String(inspection?.payment?.status || "").trim().toLowerCase();
  const liveValidTerminal = dodoEnabled && inspection?.coreValidated === true && ["failed", "cancelled"].includes(liveStatus);
  const lookupUnavailable = !dodoEnabled || !inspection || inspection.state === "disabled" || (inspection.state === "unavailable" && inspection.retryable === true);
  const storedSafeTerminal = lookupUnavailable && ["failed", "cancelled"].includes(storedState);
  if (!liveValidTerminal && !storedSafeTerminal) {
    const escalated = await escalateExhaustedCleanupToOwnerReview({ client, record: current, source: "reconcile", patchRecord });
    return makeResponse(false, 202, escalated, buildPublicStatusBody, false);
  }
  if (liveValidTerminal && inspectedRev && (current._rev !== inspectedRev || String(current.providerStateCheckedAt || "") !== String(inspectedCheckedAt || ""))) {
    return makeResponse(false, 202, current, buildPublicStatusBody, false);
  }
  const resolvedMode = liveValidTerminal ? liveStatus : storedState;
  const targetIsCancel = liveValidTerminal
    ? liveStatus === "cancelled"
    : resolvedMode === "cancelled" || String(current.resourceReleaseTargetStatus || "").trim().toLowerCase() === PAYMENT_STATUS_ABANDONED;
  return commitDodoTerminalOutcome({
    mode: targetIsCancel ? "cancelled" : "failed",
    client, record: current, payment: liveValidTerminal ? inspection.payment : null,
    source: "reconcile", reason: String(current.resourceReleaseReason || `dodo_payment_${resolvedMode}`).trim(),
    prepareCouponRelease, appendCouponRelease, loadCouponReservationHandlers, patchRecord,
    getNextPaymentRecoveryAt, buildPublicStatusBody, includeRefreshedHold: false,
    allowStoredTerminalRelease: storedSafeTerminal,
    deadlinePinnedRev: inspectedRev || current._rev,
    deadlinePinnedCheckedAt: inspectedRev ? inspectedCheckedAt : (current.providerStateCheckedAt || ""),
    closeWatchOnCommit: dodoEnabled && liveValidTerminal,
  });
};

export const guardDodoCheckoutReuse = async ({
  client, existing, inspectDodoCheckout, patchRecord, buildProviderPayloadFromRecord,
  paymentAccessToken, shared, getHoldById = null,
}) => {
  let latestExisting = existing;
  let allowCheckoutUrl = false;
  const hasStoredAttempt = Boolean(existing.dodoAttemptObserved === true || existing.providerPaymentId || existing.providerPaymentState);
  if (!hasStoredAttempt && existing.providerOrderId) {
    const inspected = await inspectDodoCheckout({ record: existing });
    latestExisting = await persistDodoInspectionEvidence({ client, record: existing, inspection: inspected, patchRecord });
    latestExisting = (await getPaymentRecordById(client, existing._id)) || latestExisting;
    const holdId = String(latestExisting?.holdSnapshot?.slotHoldId || latestExisting?.bookingPayload?.slotHoldId || "").trim();
    const isUpgrade = Boolean(String(latestExisting?.bookingPayload?.originalOrderId || "").trim());
    let holdStartable = isUpgrade || !holdId;
    if (!holdStartable && typeof getHoldById === "function") {
      const holdDoc = await getHoldById(client, holdId);
      holdStartable = Boolean(
        holdDoc?._id &&
          String(holdDoc.paymentRecordId || "").trim() === String(latestExisting._id).trim() &&
          String(holdDoc.phase || "") === "payment_pending" &&
          isFutureIso(holdDoc.expiresAt)
      );
    }
    latestExisting = (await getPaymentRecordById(client, existing._id)) || latestExisting;
    allowCheckoutUrl =
      inspected.state === "unpaid" && !inspected.payment && !inspected.providerPaymentId &&
      String(latestExisting.status || "").trim().toLowerCase() === PAYMENT_STATUS_STARTED &&
      !hasKnownCaptureRecord(latestExisting) && !hasPreservedOwnerReview(latestExisting) &&
      latestExisting.dodoAttemptObserved !== true && !latestExisting.providerPaymentId && !latestExisting.providerPaymentState &&
      holdStartable;
  }
  const providerPayload = buildProviderPayloadFromRecord(latestExisting);
  if (!allowCheckoutUrl) delete providerPayload.checkoutUrl;
  return {
    httpStatus: 200,
    body: {
      ok: true, status: latestExisting.status, checkoutCreated: false, providerPayload,
      paymentAccessToken, ...shared, attemptStarted: !allowCheckoutUrl,
    },
  };
};

export const handleDodoCancelInspection = async ({
  client, record, status, inspection, prepareCouponRelease, appendCouponRelease,
  loadCouponReservationHandlers, patchRecord, getNextPaymentRecoveryAt,
  buildPublicStatusBody, buildBrowserCompletionBody, refreshDodoPayment,
}) => {
  if (inspection.retryable === false && ["dodo_payment_binding_mismatch", "dodo_session_mismatch"].includes(inspection.reason)) {
    await escalateDodoMismatchToOwnerReview({
      client, record, reason: inspection.reason, source: "client",
      providerPaymentState: inspection.providerPaymentState || "", patchRecord,
    });
    return { handled: true, result: { httpStatus: 409, body: { ok: false, code: inspection.reason, error: "The payment does not match this checkout." } } };
  }
  if (inspection.retryable === false) {
    await persistDodoInspectionEvidence({ client, record, inspection, patchRecord, stopOnConflict: true });
    return { handled: true, result: { httpStatus: 409, body: { ok: false, code: inspection.reason || "dodo_payment_mismatch", error: "The payment does not match this checkout." } } };
  }
  let evidenceConflicted = false;
  const updated = await persistDodoInspectionEvidence({
    client, record, inspection, patchRecord,
    stopOnConflict: true,
    onConflict: () => { evidenceConflicted = true; },
  });
  const liveStatus = String(inspection.payment?.status || "").trim().toLowerCase();
  const updatedState = String(updated?.providerPaymentState || "").trim().toLowerCase();
  if (ACTIVE_OR_PARTIAL_DODO_STATES.includes(liveStatus) || ACTIVE_OR_PARTIAL_DODO_STATES.includes(updatedState)) {
    return {
      handled: true,
      result: { httpStatus: 409, body: { ok: false, status, code: "provider_pending", error: "Payment is still processing. Check its status before changing methods." } },
    };
  }
  if (liveStatus === "cancelled" || liveStatus === "failed") {
    const outcomeFn = liveStatus === "cancelled" ? commitDodoCancellationOutcome : commitDodoFailureOutcome;
    const outcome = await outcomeFn({
      client, record: updated, payment: inspection.payment, source: "client", reason: `dodo_payment_${liveStatus}`,
      prepareCouponRelease, appendCouponRelease, loadCouponReservationHandlers, patchRecord,
      getNextPaymentRecoveryAt, buildPublicStatusBody, includeRefreshedHold: true,
    });
    const committedRecord = outcome.paymentRecord || updated;
    const outBody = await buildBrowserCompletionBody({ client, record: committedRecord, body: outcome.response });
    return {
      handled: true,
      result: {
        httpStatus: outcome.httpStatus,
        body: {
          ...outBody,
          ok: outcome.ok,
          cancelled: String(committedRecord.status || "").trim().toLowerCase() === PAYMENT_STATUS_ABANDONED &&
            !isCleanupPending(committedRecord) && committedRecord.resourceReleasePending !== true,
        },
      },
    };
  }
  if (inspection.state === "captured") {
    const refreshed = await refreshDodoPayment({ client, record: updated, payment: inspection.payment, source: "reconcile", includeRefreshedHold: true });
    if (refreshed.httpStatus >= 400 && ["dodo_refund_requires_reconciliation", "dodo_refund_details_pending"].includes(refreshed.body?.code)) {
      const latest = (await getPaymentRecordById(client, updated._id)) || updated;
      return { handled: false, record: latest };
    }
    return {
      handled: true,
      result: {
        httpStatus: refreshed.httpStatus,
        body: { ...(await buildBrowserCompletionBody({ client, record: updated, body: refreshed.body })), cancelled: false, captured: true },
      },
    };
  }
  if (evidenceConflicted) {
    return {
      handled: true,
      result: {
        httpStatus: 409,
        body: {
          ok: false,
          cancelled: false,
          status: String(updated?.status || status).trim().toLowerCase(),
          code: "payment_state_changed",
          error: "Payment state changed before it could be released.",
        },
      },
    };
  }
  return { handled: false, record: updated };
};
