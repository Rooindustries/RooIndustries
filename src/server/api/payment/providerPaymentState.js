import { logSafeError } from "../../safeErrorLog.js";
import { inspectDodoCheckout, settledDodoPaymentState } from "./dodoProvider.js";
import { getPaymentRecordById, PAYMENT_RECORD_TYPE } from "./paymentRecord.js";

const PROVIDER_STATE_STAGE = { succeeded: 1, refunded: 2, disputed: 2 };
const OWNER_REVIEW_STATE_CHECK_MS = 60 * 60 * 1000;
const OWNER_REVIEW_BATCH_SIZE = 20;
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

export const providerStateChange = (current, next) => {
  const state = String(next || "").trim();
  if (!state || state === current || stageOf(state) < stageOf(current)) return {};
  return { providerPaymentState: state, providerStateCheckedAt: new Date().toISOString() };
};

export const unconfirmedProviderState = (record) => {
  const recorded = String(record?.providerPaymentState || "").trim();
  if (record?.provider !== "dodo" || hasBooking(record) || recorded) return {};
  return { providerPaymentState: UNCONFIRMED_PROVIDER_STATE, providerStateCheckedAt: new Date().toISOString() };
};

export const recordProviderPaymentState = async ({ client, record, providerPaymentState, patchRecord }) => {
  let current = record;
  for (let attempt = 0; attempt < 3 && current?._id; attempt += 1) {
    const change = providerStateChange(current.providerPaymentState, providerPaymentState);
    if (!change.providerPaymentState || hasBooking(current)) return;
    try {
      await patchRecord({ client, record: current, set: change });
      return;
    } catch (error) {
      if (!isConflictError(error)) throw error;
      current = await getPaymentRecordById(client, current._id);
    }
  }
};

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
      const state = await currentSettledState(record);
      await patchRecord({ client, record, set: {
        providerStateCheckedAt: new Date().toISOString(),
        ...providerStateChange(record.providerPaymentState, state),
      } });
      checked += 1;
    } catch (error) {
      logSafeError("Owner review payment state check failed", error);
    }
  }
  return checked;
};
