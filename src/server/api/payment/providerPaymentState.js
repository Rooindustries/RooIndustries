import { logSafeError } from "../../safeErrorLog.js";
import { inspectDodoCheckout } from "./dodoProvider.js";
import { getPaymentRecordById, PAYMENT_RECORD_TYPE } from "./paymentRecord.js";
import { hasVerifiedReversal } from "./paymentRecoveryState.js";

const PROVIDER_STATE_STAGE = { succeeded: 1, refunded: 2, disputed: 2 };
const OWNER_REVIEW_STATE_CHECK_MS = 60 * 60 * 1000;
const OWNER_REVIEW_BATCH_SIZE = 20;
const SUCCEEDED_RESERVED_SLOTS = 4;
const DUE_AGE_TIERS_MS = [16, 8, 4, 2, 1].map((hours) => hours * 60 * 60 * 1000);
const CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000;
const MONEY_ARRIVED_CHECK_MS = 24 * 60 * 60 * 1000;
const NEVER_AGAIN = "9999-12-31T23:59:59.999Z";
const REVERSED_PROVIDER_STATES = new Set(["refunded", "disputed"]);
const MISMATCH_REASONS = new Set(["dodo_session_mismatch", "dodo_payment_binding_mismatch"]);
const MONEY_ARRIVED_STATUSES = new Set([
  "captured_client",
  "captured_webhook",
  "verified_server",
  "finalizing",
  "booked",
  "email_partial",
]);
const UNCONFIRMED_PROVIDER_STATE = "unknown";
const UNCONFIRMED_PROVIDER_STATES = [
  UNCONFIRMED_PROVIDER_STATE,
  "processing",
  "requires_payment_method",
  "requires_customer_action",
  "requires_merchant_action",
  "requires_confirmation",
  "requires_capture",
  "partially_captured",
  "partially_captured_and_capturable",
];

const stageOf = (state) => PROVIDER_STATE_STAGE[String(state || "").trim()] || 0;

const isConflictError = (error) =>
  Number(error?.statusCode || error?.status || 0) === 409;

const hasBooking = (record) => Boolean(String(record?.bookingId || "").trim());

const providerStateChange = (current, next) => {
  const state = String(next || "").trim();
  if (!state || state === current || stageOf(state) < stageOf(current)) return {};
  return { providerPaymentState: state, providerStateCheckedAt: new Date().toISOString() };
};

const stopsReconcile = (values) =>
  values.providerRecoveryTerminal === true || values.reconciliationRecoveryTerminal === true;

export const observedProviderState = (record, observed) =>
  hasBooking(record) ? {} : providerStateChange(record?.providerPaymentState, observed);

export const unconfirmedProviderState = (record, values) => {
  const next = { ...record, ...values };
  const recorded = String(next.providerPaymentState || "").trim();
  if (!stopsReconcile(values) || next.provider !== "dodo" || hasBooking(next) || recorded) return {};
  return { providerPaymentState: UNCONFIRMED_PROVIDER_STATE, providerStateCheckedAt: new Date().toISOString() };
};

export const recordProviderPaymentState = async ({ client, record, providerPaymentState, patchRecord }) => {
  let current = record;
  for (let attempt = 0; attempt < 3 && current?._id; attempt += 1) {
    const change = observedProviderState(current, providerPaymentState);
    if (!change.providerPaymentState) return;
    try {
      await patchRecord({ client, record: current, set: change });
      return;
    } catch (error) {
      if (!isConflictError(error)) throw error;
      current = await getPaymentRecordById(client, current._id);
    }
  }
};

const moneyArrived = (record) => {
  if (hasVerifiedReversal(record)) return false;
  const state = String(record.providerPaymentState || "").trim();
  if (REVERSED_PROVIDER_STATES.has(state)) return true;
  return (
    state === "succeeded" ||
    record.verificationState === "server_verified" ||
    MONEY_ARRIVED_STATUSES.has(String(record.status || "").trim().toLowerCase())
  );
};

const withinCleanupWindow = (record) => {
  const expiresAt = Date.parse(record.holdSnapshot?.slotHoldExpiresAt || record.sessionExpiresAt || "");
  return Number.isFinite(expiresAt) && Date.now() <= expiresAt + CLEANUP_DELAY_MS + OWNER_REVIEW_STATE_CHECK_MS;
};

const nextCheckAt = (record) => {
  if (hasBooking(record) || hasVerifiedReversal(record)) return NEVER_AGAIN;
  if (moneyArrived(record)) {
    return new Date(Date.now() + MONEY_ARRIVED_CHECK_MS - OWNER_REVIEW_STATE_CHECK_MS).toISOString();
  }
  return withinCleanupWindow(record) ? new Date().toISOString() : NEVER_AGAIN;
};

const recordsCheckedBetween = async (client, states, limit, { before, after }) => {
  const records = await client.fetch(
    `*[_type == $type && provider == $provider && providerPaymentState in $states
      && providerStateCheckedAt <= $before${after ? " && providerStateCheckedAt > $after" : ""}][0...${limit}]`,
    { type: PAYMENT_RECORD_TYPE, provider: "dodo", states, before, ...(after ? { after } : {}) }
  );
  return Array.isArray(records) ? records : [];
};

const legacyUnverifiedReversals = async (client, limit) => {
  const dueBefore = new Date(Date.now() - OWNER_REVIEW_STATE_CHECK_MS).toISOString();
  const records = await client.fetch(
    `*[_type == $type && provider == $provider
      && providerPaymentState in ["refunded", "disputed"]
      && providerReversalVerified != true
      && (!defined(providerStateCheckedAt) || providerStateCheckedAt == ""
        || providerStateCheckedAt <= $dueBefore || providerStateCheckedAt >= "2090-01-01T00:00:00Z")][0...${limit}]`,
    { type: PAYMENT_RECORD_TYPE, provider: "dodo", dueBefore }
  );
  return Array.isArray(records) ? records : [];
};

const dueRecords = async (client, states, limit) => {
  const picked = [];
  let after = "";
  for (const age of DUE_AGE_TIERS_MS) {
    if (picked.length >= limit) break;
    const before = new Date(Date.now() - age).toISOString();
    picked.push(...(await recordsCheckedBetween(client, states, limit - picked.length, { before, after })));
    after = before;
  }
  return picked;
};

const selectOwnerReviewBatch = async (client, runId) => {
  if (typeof client?.fetchOwnerReviewDodoDocuments === "function") {
    const rows = await client.fetchOwnerReviewDodoDocuments({
      runId,
      now: new Date().toISOString(),
      limit: OWNER_REVIEW_BATCH_SIZE,
    });
    return Array.isArray(rows) ? rows : [];
  }
  const succeeded = await dueRecords(client, ["succeeded"], SUCCEEDED_RESERVED_SLOTS);
  const nonReservedBudget = Math.max(0, OWNER_REVIEW_BATCH_SIZE - succeeded.length);
  const legacy = nonReservedBudget > 0 ? await legacyUnverifiedReversals(client, nonReservedBudget) : [];
  const remaining = Math.max(0, nonReservedBudget - legacy.length);
  const unconfirmed = remaining > 0 ? await dueRecords(client, UNCONFIRMED_PROVIDER_STATES, remaining) : [];
  const extraLimit = Math.max(0, remaining - unconfirmed.length);
  const extraSucceeded = extraLimit > 0 ? await dueRecords(client, ["succeeded"], SUCCEEDED_RESERVED_SLOTS + extraLimit) : [];
  const seen = new Set();
  return [...legacy, ...unconfirmed, ...succeeded, ...extraSucceeded].filter((r) => {
    if (!r?._id || seen.has(r._id)) return false;
    seen.add(r._id);
    return true;
  }).slice(0, OWNER_REVIEW_BATCH_SIZE);
};

const evaluateOwnerReviewUpdate = (record, inspection) => {
  const cur = String(record.providerPaymentState || "").trim().toLowerCase();
  const legacyUnverified = REVERSED_PROVIDER_STATES.has(cur) && record.providerReversalVerified !== true;
  if (inspection.retryable === false && MISMATCH_REASONS.has(inspection.reason)) {
    return {
      conclusive: true,
      forceNeverAgain: true,
      updates: {
        recoveryOwnerReviewRequired: true,
        providerRecoveryTerminal: true,
        providerRecoveryTerminalReason: inspection.reason,
        recoveryReason: inspection.reason,
        providerReversalVerified: false,
      },
    };
  }
  if (inspection.state === "disabled" || inspection.retryable === true || inspection.coreValidated !== true) {
    if (legacyUnverified) return { conclusive: false, updates: { providerReversalVerified: false } };
    if (inspection.providerPaymentState === "succeeded") {
      return { conclusive: false, updates: { ...providerStateChange(record.providerPaymentState, "succeeded"), providerReversalVerified: false } };
    }
    return { conclusive: false, updates: {} };
  }
  if (inspection.noPaymentId === true) {
    return { conclusive: true, updates: legacyUnverified ? { providerReversalVerified: false } : {} };
  }
  if (inspection.normalizedStatus === "succeeded") {
    if (inspection.reversalValidated === true && inspection.providerReversalVerified === true && REVERSED_PROVIDER_STATES.has(inspection.settledState)) {
      return { conclusive: true, updates: { providerPaymentState: inspection.settledState, providerReversalVerified: true } };
    }
    return { conclusive: true, updates: { providerPaymentState: "succeeded", providerReversalVerified: false } };
  }
  if (inspection.recognizedStatus === true) {
    return { conclusive: true, updates: legacyUnverified ? { providerReversalVerified: false } : providerStateChange(record.providerPaymentState, inspection.normalizedStatus) };
  }
  return { conclusive: false, updates: legacyUnverified ? { providerReversalVerified: false } : {} };
};

export const refreshOwnerReviewDodoStates = async ({ client, patchRecord, runId = null }) => {
  const batch = await selectOwnerReviewBatch(client, runId);
  let checked = 0;
  let failed = 0;
  for (const record of batch) {
    let recordFailed = false;
    let conclusive = false;
    try {
      if (hasBooking(record)) {
        await patchRecord({ client, record, set: { providerStateCheckedAt: NEVER_AGAIN } });
        checked += 1;
        continue;
      }
      if (runId && typeof client?.beginReconcileRecordInspection === "function") {
        const begun = await client.beginReconcileRecordInspection({ runId, paymentRecordId: record._id });
        if (!begun?.ok) throw Object.assign(new Error("Reconcile run is no longer active."), { code: "reconcile_run_not_active", status: 503 });
      }
      const decision = evaluateOwnerReviewUpdate(record, await inspectDodoCheckout({ record }));
      conclusive = decision.conclusive;
      const next = { ...record, ...decision.updates };
      await patchRecord({
        client,
        record,
        set: { ...decision.updates, providerStateCheckedAt: decision.forceNeverAgain ? NEVER_AGAIN : nextCheckAt(next) },
      });
      checked += 1;
    } catch (error) {
      recordFailed = true;
      failed += 1;
      logSafeError("Owner review payment state check failed", error);
    } finally {
      if (!recordFailed && runId && typeof client?.clearReconcileCleanupBlock === "function") {
        const cleared = await client.clearReconcileCleanupBlock({ runId, paymentRecordId: record._id, conclusiveProviderEvidence: conclusive });
        if (!cleared?.ok) failed += 1;
      }
    }
  }
  if (failed > 0) {
    throw Object.assign(new Error("Owner review payment state check failed."), { code: "owner_review_dodo_refresh_failed", status: 503, checked, failed });
  }
  return checked;
};
