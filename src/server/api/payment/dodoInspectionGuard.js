import { logSafeError } from "../../safeErrorLog.js";
import { settledDodoPaymentState } from "./dodoProvider.js";
import {
  buildCaptureLineageUpdates,
  exhaustedLiveDodoStateNeedsResume,
  exhaustedPendingCleanupNeedsResume,
  hasActiveLateCaptureWatch,
} from "./lateCaptureRecovery.js";
import { hasKnownCaptureRecord, hasPreservedOwnerReview } from "./paymentRecoveryState.js";
import {
  buildPaymentRecordEvent,
  getPaymentRecordById,
  PAYMENT_STATUS_ABANDONED,
  PAYMENT_STATUS_BOOKED,
  PAYMENT_STATUS_EMAIL_PARTIAL,
  PAYMENT_STATUS_FAILED,
  PAYMENT_STATUS_NEEDS_RECOVERY,
  PAYMENT_STATUS_REFUNDED,
} from "./paymentRecord.js";
import { observedProviderState } from "./providerPaymentState.js";

export const LATE_CAPTURE_WATCH_SECONDS = 24 * 60 * 60;
export const NEVER_AGAIN = "9999-12-31T23:59:59.999Z";
const SETTLED_STATUSES = [PAYMENT_STATUS_BOOKED, PAYMENT_STATUS_EMAIL_PARTIAL, PAYMENT_STATUS_REFUNDED];
const MISMATCH_REASONS = ["dodo_payment_binding_mismatch", "dodo_session_mismatch"];

export const nowIso = () => new Date().toISOString();
export const futureIso = (seconds) =>
  new Date(Date.now() + Math.max(1, Number(seconds) || 1) * 1000).toISOString();
export const isConflict = (error) => Number(error?.statusCode || error?.status || 0) === 409;
export const isFutureIso = (value) => {
  const ts = new Date(value || "").getTime();
  return Number.isFinite(ts) && ts > Date.now();
};

export const getDocumentByTypeAndId = async (client, type, id) => {
  const cleanId = String(id || "").trim();
  return cleanId ? client.fetch(`*[_type == $type && _id == $id][0]`, { type, id: cleanId }) : null;
};

export const paymentIdPatch = (current, providerPaymentId) => {
  const cleanId = String(providerPaymentId || "").trim();
  return cleanId && !String(current?.providerPaymentId || "").trim() ? { providerPaymentId: cleanId } : {};
};

export const stateObsPatch = (current, state, options = {}) =>
  state ? observedProviderState(current, state, options) : {};

export const isLockedOrSettled = (record) => {
  const status = String(record?.status || "").trim().toLowerCase();
  return (
    SETTLED_STATUSES.includes(status) ||
    record?.dodoDisputeActive === true ||
    ["refunded", "disputed"].includes(record?.providerPaymentState) ||
    hasPreservedOwnerReview(record)
  );
};

export const persistDodoInspectionEvidence = async ({ client, record, inspection, patchRecord, recordState = true }) => {
  if (
    !record?._id ||
    !inspection ||
    MISMATCH_REASONS.includes(inspection.reason) ||
    String(inspection.payment?.status || "").trim().toLowerCase() === "succeeded"
  ) {
    return record;
  }
  const cleanId = String(inspection.providerPaymentId || inspection.payment?.payment_id || "").trim();
  const state = inspection.payment
    ? settledDodoPaymentState(inspection.payment)
    : String(inspection.providerPaymentState || "").trim();
  if (!cleanId && !state && !inspection.payment) return record;
  let current = record;
  for (let attempt = 0; attempt < 3 && current?._id; attempt += 1) {
    if (isLockedOrSettled(current) || hasKnownCaptureRecord(current)) return current;
    const set = {
      ...(recordState ? stateObsPatch(current, state) : {}),
      ...paymentIdPatch(current, cleanId),
      ...(current.dodoAttemptObserved !== true ? { dodoAttemptObserved: true } : {}),
    };
    if (!Object.keys(set).length) return current;
    try {
      return await patchRecord({ client, record: current, set });
    } catch (error) {
      if (!isConflict(error)) throw error;
      current = (await getPaymentRecordById(client, current._id)) || current;
    }
  }
  return current;
};

export const escalateDodoMismatchToOwnerReview = async ({
  client, record, reason, source = "reconcile", providerPaymentState = "", patchRecord,
}) => {
  let current = (await getPaymentRecordById(client, record._id)) || record;
  for (let attempt = 0; attempt < 3 && current?._id; attempt += 1) {
    if (SETTLED_STATUSES.includes(String(current.status || "").trim().toLowerCase())) return current;
    const statePatch = providerPaymentState && !MISMATCH_REASONS.includes(reason)
      ? observedProviderState(current, providerPaymentState) : {};
    try {
      const escalated = await patchRecord({
        client,
        record: current,
        set: {
          ...statePatch,
          status: PAYMENT_STATUS_NEEDS_RECOVERY,
          recoveryReason: reason,
          recoveryOwnerReviewRequired: true,
          providerRecoveryTerminal: true,
          providerRecoveryTerminalReason: reason,
          reconciliationRecoveryTerminal: true,
          resourceReleasePending: false,
          resourceReleaseTargetStatus: "",
          resourceReleaseReason: "",
          nextRecoveryAt: "",
          finalizationLeaseId: "",
          finalizationLeaseExpiresAt: "",
          dodoAttemptObserved: true,
        },
        event: buildPaymentRecordEvent({ status: PAYMENT_STATUS_NEEDS_RECOVERY, source, reason }),
      });
      logSafeError(`Dodo mismatch escalated to owner review: ${current._id}`, Object.assign(new Error(reason), { code: reason }));
      return escalated;
    } catch (error) {
      if (!isConflict(error)) throw error;
      current = (await getPaymentRecordById(client, current._id)) || current;
    }
  }
  return current;
};

export const escalateExhaustedCleanupToOwnerReview = async ({
  client, record, source = "reconcile", patchRecord,
}) => {
  let current = (await getPaymentRecordById(client, record._id)) || record;
  const reason = "resource_release_exhausted_owner_review";
  for (let attempt = 0; attempt < 3 && current?._id; attempt += 1) {
    if (isLockedOrSettled(current) || hasKnownCaptureRecord(current)) return current;
    try {
      const escalated = await patchRecord({
        client,
        record: current,
        set: {
          status: PAYMENT_STATUS_NEEDS_RECOVERY,
          recoveryReason: reason,
          recoveryOwnerReviewRequired: true,
          reconciliationRecoveryTerminal: true,
          resourceReleasePending: false,
          resourceReleaseTargetStatus: "",
          resourceReleaseReason: "",
          nextRecoveryAt: NEVER_AGAIN,
          finalizationLeaseId: "",
          finalizationLeaseExpiresAt: "",
        },
        event: buildPaymentRecordEvent({ status: PAYMENT_STATUS_NEEDS_RECOVERY, source, reason }),
      });
      logSafeError(`Exhausted cleanup escalated to owner review: ${current._id}`, Object.assign(new Error(reason), { code: reason }));
      return escalated;
    } catch (error) {
      if (!isConflict(error)) throw error;
      current = (await getPaymentRecordById(client, current._id)) || current;
    }
  }
  return current;
};

export const vetoDodoPendingCleanup = async ({
  client, record, observedState = "", providerPaymentId = "", targetStatus = "",
  source = "reconcile", reason = "dodo_payment_still_live", patchRecord,
}) => {
  let current = (await getPaymentRecordById(client, record._id)) || record;
  for (let attempt = 0; attempt < 4 && current?._id; attempt += 1) {
    if (isLockedOrSettled(current) || hasKnownCaptureRecord(current)) {
      return { ok: true, httpStatus: 200, paymentRecord: current };
    }
    const lineage = {
      ...buildCaptureLineageUpdates(current),
      ...(targetStatus === PAYMENT_STATUS_FAILED ? { capturedAfterFailure: true } : {}),
      ...(targetStatus === PAYMENT_STATUS_ABANDONED ? { capturedAfterAbandonment: true } : {}),
    };
    try {
      const saved = await patchRecord({
        client,
        record: current,
        set: {
          ...stateObsPatch(current, observedState),
          ...paymentIdPatch(current, providerPaymentId),
          ...lineage,
          status: PAYMENT_STATUS_NEEDS_RECOVERY,
          recoveryReason: reason,
          reconciliationRecoveryTerminal: false,
          resourceReleasePending: false,
          resourceReleaseTargetStatus: "",
          resourceReleaseReason: "",
          nextRecoveryAt: nowIso(),
          finalizationLeaseId: "",
          finalizationLeaseExpiresAt: "",
          ...(current.provider === "dodo" ? { dodoAttemptObserved: true } : {}),
        },
        event: buildPaymentRecordEvent({ status: PAYMENT_STATUS_NEEDS_RECOVERY, source, reason }),
      });
      return { ok: false, httpStatus: 202, paymentRecord: saved };
    } catch (error) {
      if (!isConflict(error)) throw error;
      current = (await getPaymentRecordById(client, current._id)) || current;
    }
  }
  return { ok: false, httpStatus: 202, paymentRecord: current };
};

export const finalizeExhaustedCleanup = async ({
  client, record, targetStatus, reason, observedState = "", providerPaymentId = "",
  failureFields = {}, source = "reconcile", patchRecord, getNextPaymentRecoveryAt,
  buildPublicStatusBody, includeRefreshedHold = false,
}) => {
  const current = (await getPaymentRecordById(client, record._id)) || record;
  if (isLockedOrSettled(current) || hasKnownCaptureRecord(current)) {
    return { ok: true, httpStatus: 200, paymentRecord: current, response: buildPublicStatusBody(current, { includeRefreshedHold }) };
  }
  const terminalStatus =
    targetStatus === PAYMENT_STATUS_FAILED || String(current.status || "").trim().toLowerCase() === PAYMENT_STATUS_FAILED
      ? PAYMENT_STATUS_FAILED : PAYMENT_STATUS_ABANDONED;
  const watchUntil = hasActiveLateCaptureWatch(current) ? current.lateCaptureWatchUntil : futureIso(LATE_CAPTURE_WATCH_SECONDS);
  const missingFailureFields = terminalStatus === PAYMENT_STATUS_FAILED && !String(current.paymentFailureCode || "").trim() ? failureFields : {};
  let saved = current;
  try {
    saved = await patchRecord({
      client,
      record: current,
      set: {
        ...stateObsPatch(current, observedState),
        ...paymentIdPatch(current, providerPaymentId),
        ...missingFailureFields,
        status: terminalStatus,
        recoveryReason: "resource_release_exhausted",
        recoveryFailureCount: 12,
        recoveryAttemptCount: 12,
        reconciliationRecoveryTerminal: true,
        providerRecoveryTerminal: false,
        resourceReleasePending: true,
        resourceReleaseTargetStatus: terminalStatus,
        resourceReleaseReason: reason,
        lateCaptureWatchUntil: watchUntil,
        nextRecoveryAt: getNextPaymentRecoveryAt(1),
        finalizationLeaseId: "",
        finalizationLeaseExpiresAt: "",
        ...(current.provider === "dodo" ? { dodoAttemptObserved: true } : {}),
      },
      event: buildPaymentRecordEvent({ status: terminalStatus, source, reason: "resource_release_exhausted" }),
    });
  } catch (error) {
    if (!isConflict(error)) throw error;
    saved = (await getPaymentRecordById(client, current._id)) || current;
  }
  return { ok: false, httpStatus: 202, paymentRecord: saved, response: buildPublicStatusBody(saved, { includeRefreshedHold }) };
};

export const resumeExhaustedDodoRecord = async ({ client, record, mode, dodoEnabled = true, patchRecord }) => {
  const current = (await getPaymentRecordById(client, record._id)) || record;
  const eligible = mode === "live"
    ? exhaustedLiveDodoStateNeedsResume(current, { dodoEnabled })
    : exhaustedPendingCleanupNeedsResume(current, { dodoEnabled });
  if (isLockedOrSettled(current) || hasKnownCaptureRecord(current) || !eligible) return { ok: true, record: current };
  const set = mode === "live"
    ? {
        ...buildCaptureLineageUpdates(current),
        status: PAYMENT_STATUS_NEEDS_RECOVERY,
        reconciliationRecoveryTerminal: false,
        resourceReleasePending: false,
        resourceReleaseTargetStatus: "",
        resourceReleaseReason: "",
        recoveryAttemptCount: 0,
        recoveryFailureCount: 0,
        nextRecoveryAt: nowIso(),
      }
    : { reconciliationRecoveryTerminal: false, recoveryAttemptCount: 0, recoveryFailureCount: 0, nextRecoveryAt: nowIso() };
  const eventStatus = mode === "live" ? PAYMENT_STATUS_NEEDS_RECOVERY : String(current.status || PAYMENT_STATUS_NEEDS_RECOVERY).trim().toLowerCase();
  const reason = mode === "live" ? "exhausted_live_dodo_state_resumed" : "exhausted_cleanup_resumed";
  try {
    return {
      ok: true,
      record: await patchRecord({ client, record: current, set, event: buildPaymentRecordEvent({ status: eventStatus, source: "reconcile", reason }) }),
    };
  } catch (error) {
    if (!isConflict(error)) throw error;
    return { ok: false, record: current };
  }
};
