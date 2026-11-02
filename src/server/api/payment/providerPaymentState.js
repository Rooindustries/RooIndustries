import { logSafeError } from "../../safeErrorLog.js";
import { inspectDodoCheckout, settledDodoPaymentState } from "./dodoProvider.js";
import { getPaymentRecordById, PAYMENT_RECORD_TYPE } from "./paymentRecord.js";

const PROVIDER_STATE_STAGE = { succeeded: 1, refunded: 2, disputed: 2 };
const OWNER_REVIEW_STATE_CHECK_MS = 60 * 60 * 1000;
const OWNER_REVIEW_BATCH_SIZE = 20;
const CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000;
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
const UNSETTLED_PROVIDER_STATES = [
  UNCONFIRMED_PROVIDER_STATE,
  "succeeded",
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
  const state = String(record.providerPaymentState || "").trim();
  if (REVERSED_PROVIDER_STATES.has(state)) return false;
  return state === "succeeded" ||
    record.verificationState === "server_verified" ||
    MONEY_ARRIVED_STATUSES.has(String(record.status || "").trim().toLowerCase());
};

const withinCleanupWindow = (record) => {
  const expiresAt = Date.parse(record.holdSnapshot?.slotHoldExpiresAt || record.sessionExpiresAt || "");
  return Number.isFinite(expiresAt) && Date.now() <= expiresAt + CLEANUP_DELAY_MS + OWNER_REVIEW_STATE_CHECK_MS;
};

const stillNeedsRecheck = (record) =>
  !hasBooking(record) && (moneyArrived(record) || withinCleanupWindow(record));

const currentSettledState = async (record) => {
  if (hasBooking(record)) return "";
  const inspection = await inspectDodoCheckout({ record });
  return inspection.payment
    ? settledDodoPaymentState(inspection.payment)
    : inspection.providerPaymentState;
};

export const refreshOwnerReviewDodoStates = async ({ client, patchRecord }) => {
  const records = await client.fetch(
    `*[_type == $type && provider == $provider && providerPaymentState in $states
      && providerStateCheckedAt <= $due][0...${OWNER_REVIEW_BATCH_SIZE}]`,
    {
      type: PAYMENT_RECORD_TYPE,
      provider: "dodo",
      states: UNSETTLED_PROVIDER_STATES,
      due: new Date(Date.now() - OWNER_REVIEW_STATE_CHECK_MS).toISOString(),
    }
  );
  let checked = 0;
  for (const record of Array.isArray(records) ? records : []) {
    try {
      const change = providerStateChange(record.providerPaymentState, await currentSettledState(record));
      const next = { ...record, ...change };
      await patchRecord({ client, record, set: {
        ...change,
        providerStateCheckedAt: stillNeedsRecheck(next) ? new Date().toISOString() : NEVER_AGAIN,
      } });
      checked += 1;
    } catch (error) {
      logSafeError("Owner review payment state check failed", error);
    }
  }
  return checked;
};
