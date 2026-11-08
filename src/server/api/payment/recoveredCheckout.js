import { checkoutRecoveryDecision } from "../../../lib/checkoutRecovery.js";
import { inspectPayPalOrder, inspectRazorpayOrder, parseMoneySubunits, toSubunits } from "./providerClients.js";
import { inspectDodoCheckout } from "./dodoProvider.js";
import { logSafeError } from "../../safeErrorLog.js";

const paymentHasSettlement = record => Boolean(record.bookingId || record.providerPaymentId ||
  record.verificationState === "server_verified");

export const canReleaseUnpaidCheckout = record => ["started", "needs_recovery"].includes(record.status) &&
  !paymentHasSettlement(record);

export const recoveredCheckout = async (record, payload, inspect = false) => {
  const inspectOrder = inspect && !paymentHasSettlement(record) && record.providerOrderId && record.provider !== "free";
  const inspection = !inspectOrder ? { state: "unpaid" } : record.provider === "paypal"
    ? await inspectPayPalOrder({ orderId: record.providerOrderId })
    : record.provider === "razorpay"
      ? await inspectRazorpayOrder({ orderId: record.providerOrderId, includeOrderDetails: true })
      : await inspectDodoCheckout({ record });
  if (["unavailable", "disabled"].includes(inspection.state)) {
    const error = Object.assign(new Error("The payment provider could not confirm checkout. Please try again."), {
      status: 503, code: "provider_checkout_unavailable", reason: inspection.reason,
    });
    logSafeError("Checkout recovery provider lookup failed", error);
    throw error;
  }
  const currency = String(record.pricingSnapshot?.currency || record.providerPublicData?.currency || "").toUpperCase();
  const amount = toSubunits(record.pricingSnapshot?.netAmount, currency);
  const details = inspection.details;
  const providerAmount = record.provider === "paypal" ? details?.purchase_units?.[0]?.amount : null;
  const matches = !inspectOrder || inspection.state !== "unpaid" || (record.provider === "paypal"
    ? providerAmount?.currency_code === currency && parseMoneySubunits(providerAmount?.value, currency) === amount
    : payload.currency === currency && payload.amount === amount && (record.provider !== "razorpay" ||
      (details?.currency === currency && details.amount === amount && ["created", "attempted"].includes(details.status))));
  const checkoutRecovery = { kind: record.bookingPayload?.originalOrderId ? "upgrade" : "booking",
    provider: record.provider, status: record.status, providerOrderId: record.providerOrderId,
    settled: paymentHasSettlement(record), providerState: inspection.state, checkedAt: Date.now(),
    amountMatches: matches && (record.provider === "free" || (Number.isSafeInteger(amount) && amount > 0)) };
  const decision = checkoutRecoveryDecision({ ...checkoutRecovery, providerPayload: payload,
    sessionExpiresAt: record.sessionExpiresAt, now: checkoutRecovery.checkedAt });
  return { checkoutRecovery, checkoutState: decision.checkoutState, providerPayload: decision.providerPayload };
};
