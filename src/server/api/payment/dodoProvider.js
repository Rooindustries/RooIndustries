import DodoPayments from "dodopayments";
import providerConfig from "./providerConfig.js";

export const DODO_CURRENCY = "USD";
const read = (key) => String(process.env[key] || "").trim();
const failure = (code, status = 503) => Object.assign(new Error(code), { code, status });

export const createDodoClient = () => {
  const environment = read("DODO_PAYMENTS_ENVIRONMENT");
  if (!["test_mode", "live_mode"].includes(environment) || !read("DODO_PAYMENTS_API_KEY")) {
    throw failure("dodo_credentials_missing");
  }
  const mode = environment === "test_mode" ? "test" : "live";
  if (!providerConfig.allowProviderModeInRuntime(mode)) throw failure("dodo_environment_disabled");
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
  const productId = read("DODO_PAYMENTS_PRODUCT_ID");
  const product = await client.products.retrieve(productId);
  const price = product.price;
  if (product.is_recurring || price?.type !== "one_time_price" ||
      price.currency !== DODO_CURRENCY || price.pay_what_you_want !== true ||
      price.tax_inclusive !== true || price.purchasing_power_parity === true ||
      Number(price.discount) !== 0 || Number(price.price) > amount) {
    throw failure("dodo_product_configuration_invalid");
  }
  const returnUrl = new URL(read("DODO_PAYMENTS_RETURN_URL"));
  if (!["http:", "https:"].includes(returnUrl.protocol) || returnUrl.username || returnUrl.password ||
      (read("DODO_PAYMENTS_ENVIRONMENT") === "live_mode" && returnUrl.protocol !== "https:")) {
    throw failure("dodo_return_url_invalid");
  }
  returnUrl.searchParams.set("dodo_return", "1");
  const cancelUrl = new URL(returnUrl);
  cancelUrl.searchParams.delete("dodo_return");
  cancelUrl.searchParams.set("dodo_cancel", "1");
  const session = await client.checkoutSessions.create({
    product_cart: [{ product_id: productId, quantity: 1, amount }],
    billing_currency: DODO_CURRENCY,
    customer: { email: record.bookingPayload.email, name: "Roo Industries customer" },
    metadata: { paymentRecordId: record._id },
    return_url: returnUrl.toString(),
    cancel_url: cancelUrl.toString(),
    feature_flags: {
      allow_currency_selection: false,
      allow_discount_code: false,
      allow_customer_editing_email: false,
      allow_customer_editing_name: true,
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
    currency: DODO_CURRENCY,
    amount,
    productId,
    environment: read("DODO_PAYMENTS_ENVIRONMENT"),
  };
};

export const validateDodoPayment = ({ record, payment }) => {
  const fail = (reason) => ({ ok: false, captured: payment?.status === "succeeded", reason });
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
  if (!Number.isSafeInteger(payment.total_amount) || payment.total_amount <= 0 ||
      payment.total_amount !== Math.round(Number(record.pricingSnapshot?.netAmount) * 100)) {
    return fail("dodo_amount_mismatch");
  }
  const cart = payment.product_cart;
  if (!Array.isArray(cart) || cart.length !== 1 || cart[0].quantity !== 1 ||
      cart[0].product_id !== record.providerPublicData?.productId) return fail("dodo_product_mismatch");
  return { ok: true };
};

export const retrieveDodoPayment = (paymentId) => createDodoClient().payments.retrieve(paymentId);

export const inspectDodoCheckout = async ({ record }) => {
  try {
    const client = createDodoClient();
    const session = await client.checkoutSessions.retrieve(record.providerOrderId);
    if (session.id !== record.providerOrderId) return { state: "unavailable", reason: "dodo_session_mismatch" };
    if (!session.payment_id) return { state: "unpaid" };
    const payment = await client.payments.retrieve(session.payment_id);
    const validation = validateDodoPayment({ record, payment });
    if (!validation.ok) return { state: "unavailable", ...validation };
    const state = payment.status === "succeeded" ? "captured"
      : ["failed", "cancelled"].includes(payment.status) ? "unpaid" : "pending";
    return { state, payment, providerPaymentId: payment.payment_id };
  } catch (error) {
    return { state: "unavailable", reason: error.status === 404 ? "dodo_lookup_failed_404" : error.code || `dodo_lookup_failed_${error.status || "exception"}` };
  }
};

export const verifyDodoCapture = async ({ record, payment: suppliedPayment }) => {
  const inspection = suppliedPayment ? { payment: suppliedPayment } : await inspectDodoCheckout({ record });
  const payment = inspection.payment;
  if (!payment) return { ok: false, retryable: true, reason: inspection.reason || "dodo_payment_pending" };
  const validation = validateDodoPayment({ record, payment });
  if (!validation.ok) return validation;
  if (payment.status !== "succeeded") return { ok: false, retryable: true, reason: `dodo_payment_${payment.status || "pending"}` };
  if ((payment.disputes || []).some((dispute) => dispute.dispute_status !== "dispute_won")) {
    return { ok: false, captured: true, retryable: false, reason: "dodo_payment_disputed" };
  }
  if ((payment.refunds || []).some((r) => r.status === "succeeded") && !suppliedPayment) {
    return { ok: false, retryable: true, reason: "dodo_refund_requires_reconciliation" };
  }
  return {
    ok: true, trustedCapture: true,
    providerOrderId: payment.checkout_session_id,
    providerPaymentId: payment.payment_id,
    payerEmail: String(payment.customer?.email || ""),
  };
};

export const unwrapDodoWebhook = ({ rawBody, headers }) => {
  const secret = read("DODO_PAYMENTS_WEBHOOK_KEY");
  if (!secret) throw failure("dodo_webhook_key_missing");
  return createDodoClient().webhooks.unwrap(rawBody, { headers, key: secret });
};
