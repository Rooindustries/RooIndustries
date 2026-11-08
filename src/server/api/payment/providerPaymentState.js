import { logSafeError } from "../../safeErrorLog.js";
import { inspectDodoCheckout, settledDodoPaymentState } from "./dodoProvider.js";
import { getPaymentRecordById, PAYMENT_RECORD_TYPE } from "./paymentRecord.js";

const PROVIDER_STATE_STAGE = { succeeded: 1, refunded: 2, disputed: 2 };
const OWNER_REVIEW_STATE_CHECK_MS = 60 * 60 * 1000;
const OWNER_REVIEW_BATCH_SIZE = 20;
const SUCCEEDED_RESERVED_SLOTS = 4;
const DUE_AGE_TIERS_MS = [16, 8, 4, 2, 1].map((hours) => hours * 60 * 60 * 1000);
const CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000;
const MONEY_ARRIVED_CHECK_MS = 24 * 60 * 60 * 1000;
const NEVER_AGAIN = "9999-12-31T23:59:59.999Z";
const REVERSED_PROVIDER_STATES = new Set(["refunded", "disputed"]);
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

const paymentNeedsRetainedHold = (record) => {
  const state = String(record.providerPaymentState || "").trim();
  if (REVERSED_PROVIDER_STATES.has(state)) return false;
  return state === "succeeded" || state === "requires_merchant_action" ||
    record.verificationState === "server_verified" ||
    MONEY_ARRIVED_STATUSES.has(String(record.status || "").trim().toLowerCase());
};

const withinCleanupWindow = (record) => {
  const expiresAt = Date.parse(record.holdSnapshot?.slotHoldExpiresAt || record.sessionExpiresAt || "");
  return Number.isFinite(expiresAt) && Date.now() <= expiresAt + CLEANUP_DELAY_MS + OWNER_REVIEW_STATE_CHECK_MS;
};

const nextCheckAt = (record) => {
  if (hasBooking(record)) return NEVER_AGAIN;
  if (paymentNeedsRetainedHold(record)) {
    return new Date(Date.now() + MONEY_ARRIVED_CHECK_MS - OWNER_REVIEW_STATE_CHECK_MS).toISOString();
  }
  return withinCleanupWindow(record) ? new Date().toISOString() : NEVER_AGAIN;
};

const currentSettledState = async (record) => {
  if (hasBooking(record)) return "";
  const inspection = await inspectDodoCheckout({ record });
  return inspection.payment
    ? settledDodoPaymentState(inspection.payment)
    : inspection.providerPaymentState;
};

const recordsCheckedBetween = async (client, states, limit, { before, after }) => {
  const records = await client.fetch(
    `*[_type == $type && provider == $provider && providerPaymentState in $states
      && providerStateCheckedAt <= $before${after ? " && providerStateCheckedAt > $after" : ""}][0...${limit}]`,
    { type: PAYMENT_RECORD_TYPE, provider: "dodo", states, before, ...(after ? { after } : {}) }
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

export const refreshOwnerReviewDodoStates = async ({ client, patchRecord }) => {
  const unconfirmedLimit = OWNER_REVIEW_BATCH_SIZE - SUCCEEDED_RESERVED_SLOTS;
  const unconfirmed = await dueRecords(client, UNCONFIRMED_PROVIDER_STATES, unconfirmedLimit);
  const succeeded = await dueRecords(client, ["succeeded"], OWNER_REVIEW_BATCH_SIZE - unconfirmed.length);
  let checked = 0;
  for (const record of [...unconfirmed, ...succeeded]) {
    try {
      const change = providerStateChange(record.providerPaymentState, await currentSettledState(record));
      const next = { ...record, ...change };
      await patchRecord({ client, record, set: {
        ...change,
        providerStateCheckedAt: nextCheckAt(next),
      } });
      checked += 1;
    } catch (error) {
      logSafeError("Owner review payment state check failed", error);
    }
  }
  return checked;
};
