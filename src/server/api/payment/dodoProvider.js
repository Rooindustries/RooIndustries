import crypto from "crypto";
import DodoPayments from "dodopayments";
import envValue from "../../supabase/envValue.cjs";
import providerConfig from "./providerConfig.js";
import { isTerminalDisputeStatus } from "../../referrals/disputeAccounting.js";

export const DODO_CURRENCY = "USD";
const RECOGNIZED_DODO_PAYMENT_STATUSES = new Set([
  "succeeded", "failed", "cancelled", "processing", "requires_payment_method",
  "requires_customer_action", "requires_merchant_action", "requires_confirmation",
  "requires_capture", "partially_captured", "partially_captured_and_capturable",
]);
const UNRESOLVED_DISPUTE_STATUSES = new Set(["dispute_opened", "dispute_challenged"]);
const ALLOWED_DISPUTE_STAGES = new Set(["pre_dispute", "dispute", "pre_arbitration"]);
const ALLOWED_DISPUTE_STATUSES = new Set([
  "dispute_opened", "dispute_challenged", "dispute_won", "dispute_cancelled",
  "dispute_lost", "dispute_accepted", "dispute_expired",
]);

const read = (key) => envValue.outsideSetting(key);
const failure = (code, status = 503) => Object.assign(new Error(code), { code, status, retryable: status >= 500 });

export const createDodoClient = () => {
  const environment = read("DODO_PAYMENTS_ENVIRONMENT");
  if (!["test_mode", "live_mode"].includes(environment) || !read("DODO_PAYMENTS_API_KEY")) {
    throw failure("dodo_credentials_missing", 409);
  }
  const mode = environment === "test_mode" ? "test" : "live";
  if (!providerConfig.allowProviderModeInRuntime(mode)) throw failure("dodo_environment_disabled", 409);
  return new DodoPayments({
    bearerToken: read("DODO_PAYMENTS_API_KEY"),
    environment,
    maxRetries: 0,
    timeout: 8000,
  });
};

export const createDodoCheckout = async ({ record, lookupOnly = false }) => {
  if (lookupOnly) throw failure("dodo_order_creation_requires_recovery");
  const client = createDodoClient();
  const amount = Math.round(Number(record.pricingSnapshot?.netAmount) * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw failure("dodo_amount_invalid", 400);
  const productId = String(record.providerPublicData?.productId || "").trim();
  if (!productId) throw failure("dodo_package_product_missing", 400);
  const product = await client.products.retrieve(productId);
  const price = product.price;
  const taxInclusive = record.providerPublicData?.taxInclusive !== false;
  if (product.is_recurring || price?.type !== "one_time_price" ||
      price.currency !== DODO_CURRENCY || price.pay_what_you_want !== true ||
      price.tax_inclusive !== taxInclusive || price.purchasing_power_parity === true ||
      Number(price.discount) !== 0 || Number(price.price) > amount) {
    throw failure("dodo_product_configuration_invalid");
  }
  const returnUrl = new URL(read("DODO_PAYMENTS_RETURN_URL"));
  if (!["http:", "https:"].includes(returnUrl.protocol) || returnUrl.username || returnUrl.password ||
      (read("DODO_PAYMENTS_ENVIRONMENT") === "live_mode" && returnUrl.protocol !== "https:")) {
    throw failure("dodo_return_url_invalid");
  }
  const dodoReturnTag = String(record.providerPublicData?.dodoReturnTag || "").trim() || crypto.randomBytes(12).toString("hex");
  returnUrl.searchParams.set("dodo_return", "1");
  returnUrl.searchParams.set("dodo_session", dodoReturnTag);
  const cancelUrl = new URL(returnUrl);
  cancelUrl.searchParams.delete("dodo_return");
  cancelUrl.searchParams.set("dodo_cancel", "1");
  const session = await client.checkoutSessions.create({
    product_cart: [{ product_id: productId, quantity: 1, amount }],
    billing_currency: DODO_CURRENCY,
    customer: { email: record.bookingPayload.email },
    metadata: { paymentRecordId: record._id },
    return_url: returnUrl.toString(),
    cancel_url: cancelUrl.toString(),
    feature_flags: {
      allow_currency_selection: false,
      allow_discount_code: false,
      allow_customer_editing_email: false,
      allow_customer_editing_name: true,
      always_create_new_customer: true,
      allow_tax_id: false,
      redirect_immediately: true,
    },
  }, { idempotencyKey: record.providerIdempotencyKey || record._id });
  if (!session.session_id || !session.checkout_url) throw failure("dodo_checkout_incomplete");
  const checkoutUrl = new URL(session.checkout_url);
  const checkoutHost = read("DODO_PAYMENTS_ENVIRONMENT") === "live_mode"
    ? "checkout.dodopayments.com" : "test.checkout.dodopayments.com";
  if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== checkoutHost ||
      checkoutUrl.username || checkoutUrl.password) {
    throw failure("dodo_checkout_url_invalid");
  }
  return {
    orderId: session.session_id,
    checkoutUrl: session.checkout_url,
    dodoReturnTag,
    currency: DODO_CURRENCY,
    amount,
    productId,
    taxInclusive,
    environment: read("DODO_PAYMENTS_ENVIRONMENT"),
  };
};

export const validateDodoCaptureCore = ({ record, payment }) => {
  const fail = (reason) => ({ ok: false, captured: payment?.status === "succeeded", retryable: false, reason });
  if (!payment?.payment_id || payment.checkout_session_id !== record.providerOrderId ||
      payment.metadata?.paymentRecordId !== record._id ||
      (record.providerPaymentId && record.providerPaymentId !== payment.payment_id)) {
    return fail("dodo_payment_binding_mismatch");
  }
  if (record.providerPublicData?.environment !== read("DODO_PAYMENTS_ENVIRONMENT")) {
    return fail("dodo_environment_mismatch");
  }
  if (payment.currency !== DODO_CURRENCY ||
      payment.currency !== record.providerPublicData?.currency) return fail("dodo_currency_mismatch");
  const addedTax = record.providerPublicData?.taxInclusive === false ? payment.tax ?? 0 : 0;
  if (!Number.isSafeInteger(addedTax) || addedTax < 0 ||
      !Number.isSafeInteger(payment.total_amount) || payment.total_amount <= 0 ||
      (payment.tax != null && (!Number.isSafeInteger(payment.tax) || payment.tax < 0 || payment.tax > payment.total_amount)) ||
      payment.total_amount - addedTax !== Math.round(Number(record.pricingSnapshot?.netAmount) * 100)) {
    return fail("dodo_amount_mismatch");
  }
  const cart = payment.product_cart;
  if (payment.status === "succeeded" &&
      (!Array.isArray(cart) || cart.length !== 1 || cart[0].quantity !== 1 ||
      cart[0].product_id !== record.providerPublicData?.productId)) return fail("dodo_product_mismatch");
  return { ok: true };
};

export const validateDodoPayment = ({ record, payment }) => {
  const core = validateDodoCaptureCore({ record, payment });
  if (!core.ok) return core;
  if (!Array.isArray(payment.refunds) || !Array.isArray(payment.disputes)) {
    return { ok: false, captured: payment?.status === "succeeded", retryable: false, reason: "dodo_payment_details_incomplete" };
  }
  return { ok: true };
};

export const retrieveDodoPayment = (paymentId) => createDodoClient().payments.retrieve(paymentId);
export const retrieveDodoRefund = (refundId) => createDodoClient().refunds.retrieve(refundId);

const isPositiveSdkAmountString = (v) =>
  typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) && Number.isFinite(Number(v.trim())) && Number(v.trim()) > 0;

export const validateDodoReversalDetails = async ({ payment, hydrateRefund = retrieveDodoRefund } = {}) => {
  if (!payment || !Array.isArray(payment.refunds) || !Array.isArray(payment.disputes)) {
    return { ok: false, reason: "dodo_payment_details_incomplete" };
  }
  const rawRefundStatus = payment.refund_status === undefined ? null : payment.refund_status;
  if (![null, "", "partial", "full"].includes(rawRefundStatus)) {
    return { ok: false, reason: "dodo_refund_details_incomplete" };
  }
  const normalizedStatus = String(payment.status || "").trim().toLowerCase();
  if (normalizedStatus !== "succeeded") {
    if (rawRefundStatus === "partial" || rawRefundStatus === "full" || payment.disputes.length > 0 ||
        payment.refunds.some((r) => String(r?.status || "").trim().toLowerCase() === "succeeded")) {
      return { ok: false, reason: "dodo_refund_details_incomplete" };
    }
    return { ok: true, state: normalizedStatus, providerReversalVerified: false, hasUnresolvedDispute: false, hasTerminalDispute: false, settledRefundTotal: 0 };
  }
  const seenDisputes = new Set();
  let hasUnresolvedDispute = false;
  let hasTerminalDispute = false;
  for (const d of payment.disputes) {
    const id = String(d?.dispute_id || "").trim();
    const stage = typeof d?.dispute_stage === "string" ? d.dispute_stage.trim() : "";
    const status = String(d?.dispute_status || "").trim();
    const paymentMismatch = d?.payment_id != null && String(d.payment_id).trim() !== String(payment.payment_id || "").trim();
    const currencyMismatch = d?.currency != null && String(d.currency).trim() !== String(payment.currency || DODO_CURRENCY).trim();
    if (!id || seenDisputes.has(id) || !ALLOWED_DISPUTE_STAGES.has(stage) || !ALLOWED_DISPUTE_STATUSES.has(status) ||
        !isPositiveSdkAmountString(d?.amount) || paymentMismatch || currencyMismatch) {
      return { ok: false, reason: "dodo_refund_details_incomplete" };
    }
    seenDisputes.add(id);
    if (UNRESOLVED_DISPUTE_STATUSES.has(status)) hasUnresolvedDispute = true;
    else if (isTerminalDisputeStatus(status)) hasTerminalDispute = true;
  }
  const seenRefunds = new Set();
  const settledRefunds = [];
  let settledRefundTotal = 0;
  for (const r of payment.refunds) {
    const id = String(r?.refund_id || "").trim();
    if (!id || seenRefunds.has(id)) return { ok: false, reason: "dodo_refund_details_incomplete" };
    seenRefunds.add(id);
    const rStatus = String(r?.status || "").trim().toLowerCase();
    if (rStatus !== "succeeded") {
      if (!["failed", "pending", "review"].includes(rStatus) || r.payment_id !== payment.payment_id ||
          (r.amount != null && (!Number.isSafeInteger(r.amount) || r.amount <= 0 || r.amount > payment.total_amount)) ||
          (r.currency != null && r.currency !== payment.currency)) {
        return { ok: false, reason: "dodo_refund_mismatch" };
      }
      continue;
    }
    let amount = r?.amount;
    const inlineOk = Number.isSafeInteger(amount) && amount > 0 &&
      r.payment_id === payment.payment_id && r.currency === DODO_CURRENCY;
    if (!inlineOk) {
      let hydrated;
      try { hydrated = await hydrateRefund(id); } catch { return { ok: false, retryable: true, reason: "dodo_refund_lookup_pending" }; }
      if (!hydrated || hydrated.refund_id !== id || hydrated.payment_id !== payment.payment_id ||
          hydrated.currency !== DODO_CURRENCY || String(hydrated.status || "").trim().toLowerCase() !== "succeeded" ||
          !Number.isSafeInteger(hydrated.amount) || hydrated.amount <= 0) {
        return { ok: false, reason: "dodo_refund_details_incomplete" };
      }
      amount = hydrated.amount;
    }
    settledRefunds.push({ refund_id: id, payment_id: payment.payment_id, amount, currency: DODO_CURRENCY });
    settledRefundTotal += amount;
  }
  const total = Number(payment.total_amount);
  if ((rawRefundStatus === "full" && settledRefundTotal !== total) ||
      (rawRefundStatus === "partial" && !(settledRefundTotal > 0 && settledRefundTotal < total)) ||
      ((rawRefundStatus === null || rawRefundStatus === "") && settledRefundTotal !== 0)) {
    return { ok: false, reason: "dodo_refund_details_incomplete" };
  }
  if (hasUnresolvedDispute) return { ok: true, state: "succeeded", providerReversalVerified: false, hasUnresolvedDispute: true, hasTerminalDispute, settledRefundTotal, settledRefunds };
  if (rawRefundStatus === "full") return { ok: true, state: "refunded", providerReversalVerified: true, hasUnresolvedDispute: false, hasTerminalDispute, settledRefundTotal, settledRefunds };
  if (hasTerminalDispute) return { ok: true, state: "disputed", providerReversalVerified: true, hasUnresolvedDispute: false, hasTerminalDispute: true, settledRefundTotal, settledRefunds };
  return { ok: true, state: "succeeded", providerReversalVerified: false, hasUnresolvedDispute: false, hasTerminalDispute: false, settledRefundTotal, settledRefunds };
};

export const settledDodoPaymentState = (payment) => {
  const status = String(payment?.status || "").trim().toLowerCase();
  if (status !== "succeeded") return status;
  const disputes = Array.isArray(payment?.disputes) ? payment.disputes : [];
  if (disputes.some((dispute) => UNRESOLVED_DISPUTE_STATUSES.has(String(dispute?.dispute_status || "").trim()))) {
    return "succeeded";
  }
  if (payment?.refund_status === "full") return "refunded";
  if (disputes.some((dispute) => isTerminalDisputeStatus(dispute?.dispute_status))) {
    return "disputed";
  }
  return "succeeded";
};

export const inspectDodoCheckout = async ({ record, hydrateRefund = retrieveDodoRefund }) => {
  try {
    const client = createDodoClient();
    const session = await client.checkoutSessions.retrieve(record.providerOrderId);
    if (session.id !== record.providerOrderId) {
      return { state: "unavailable", retryable: false, reason: "dodo_session_mismatch", coreValidated: false };
    }
    if (!session.payment_id) {
      return { state: "unpaid", noPaymentId: true, coreValidated: true, recognizedStatus: true, normalizedStatus: "" };
    }
    const payment = await client.payments.retrieve(session.payment_id);
    if (payment.payment_id !== session.payment_id) {
      return { state: "unavailable", retryable: false, reason: "dodo_payment_binding_mismatch", coreValidated: false };
    }
    const core = validateDodoCaptureCore({ record, payment });
    if (!core.ok) {
      return core.reason === "dodo_payment_binding_mismatch"
        ? { state: "unavailable", ...core, coreValidated: false }
        : {
            state: "unavailable",
            ...core,
            coreValidated: false,
            providerPaymentState: payment.status === "succeeded" ? "succeeded" : String(payment.status || "").trim(),
          };
    }
    const normalizedStatus = String(payment.status || "").trim().toLowerCase();
    const recognizedStatus = RECOGNIZED_DODO_PAYMENT_STATUSES.has(normalizedStatus);
    if (!Array.isArray(payment.refunds) || !Array.isArray(payment.disputes)) {
      return {
        state: "unavailable",
        ok: false,
        captured: normalizedStatus === "succeeded",
        retryable: false,
        reason: "dodo_payment_details_incomplete",
        coreValidated: true,
        reversalValidated: false,
        recognizedStatus,
        normalizedStatus,
        providerPaymentId: payment.payment_id,
        providerPaymentState: normalizedStatus === "succeeded" ? "succeeded" : String(payment.status || "").trim(),
        payment,
      };
    }
    if (normalizedStatus === "succeeded") {
      const reversal = await validateDodoReversalDetails({ payment, hydrateRefund });
      return {
        state: "captured",
        payment,
        providerPaymentId: payment.payment_id,
        coreValidated: true,
        recognizedStatus: true,
        normalizedStatus,
        reversalValidated: reversal.ok,
        reversalReason: reversal.ok ? "" : reversal.reason,
        settledState: reversal.ok ? reversal.state : "succeeded",
        providerReversalVerified: reversal.ok ? reversal.providerReversalVerified === true : false,
        hasUnresolvedDispute: reversal.ok ? reversal.hasUnresolvedDispute === true : false,
        hasTerminalDispute: reversal.ok ? reversal.hasTerminalDispute === true : false,
      };
    }
    const state = ["failed", "cancelled", "requires_payment_method"].includes(normalizedStatus) ? "unpaid" : "pending";
    return {
      state,
      payment,
      providerPaymentId: payment.payment_id,
      coreValidated: true,
      recognizedStatus,
      normalizedStatus: recognizedStatus ? normalizedStatus : "",
      settledState: recognizedStatus ? normalizedStatus : "",
      providerReversalVerified: false,
    };
  } catch (error) {
    if (error.retryable === false) return { state: "disabled", retryable: false, reason: error.code, coreValidated: false };
    return { state: "unavailable", retryable: true, reason: error.status === 404 ? "dodo_lookup_failed_404" : error.code || `dodo_lookup_failed_${error.status || "exception"}`, coreValidated: false };
  }
};

export const verifyDodoCapture = async ({ record, payment: suppliedPayment }) => {
  const inspection = suppliedPayment ? { payment: suppliedPayment } : await inspectDodoCheckout({ record });
  const payment = inspection.payment;
  if (!payment) return { ok: false, retryable: inspection.retryable !== false, reason: inspection.reason || "dodo_payment_pending" };
  const validation = validateDodoPayment({ record, payment });
  if (!validation.ok) return validation;
  if (payment.status !== "succeeded") return { ok: false, retryable: true, reason: `dodo_payment_${payment.status || "pending"}` };
  if (
    (!Array.isArray(payment.disputes) || payment.disputes.length === 0) &&
    (payment.refund_status === "full" || (payment.refund_status === "partial" && !suppliedPayment))
  ) {
    return { ok: false, captured: true, retryable: true, reason: "dodo_refund_requires_reconciliation" };
  }
  const reversal = await validateDodoReversalDetails({ payment });
  if (!reversal.ok) {
    return { ok: false, captured: true, retryable: false, reason: reversal.reason };
  }
  if (reversal.hasUnresolvedDispute || reversal.hasTerminalDispute) {
    return { ok: false, captured: true, retryable: false, reason: "dodo_payment_disputed" };
  }
  if (payment.refund_status === "full" || (payment.refund_status === "partial" && !suppliedPayment)) {
    return { ok: false, captured: true, retryable: true, reason: "dodo_refund_requires_reconciliation" };
  }
  if ((payment.refunds || []).some((r) => r.status === "succeeded") && !suppliedPayment) {
    return { ok: false, retryable: true, reason: "dodo_refund_requires_reconciliation" };
  }
  return {
    ok: true, trustedCapture: true,
    providerOrderId: payment.checkout_session_id,
    providerPaymentId: payment.payment_id,
    totalAmount: payment.total_amount,
    taxAmount: payment.tax ?? null,
    payerEmail: String(payment.customer?.email || ""),
  };
};

export const unwrapDodoWebhook = ({ rawBody, headers }) => {
  const secret = read("DODO_PAYMENTS_WEBHOOK_KEY");
  if (!secret) throw failure("dodo_webhook_key_missing", 409);
  return createDodoClient().webhooks.unwrap(rawBody, { headers, key: secret });
};
