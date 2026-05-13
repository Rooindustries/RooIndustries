import crypto from "crypto";
import providerConfig from "./providerConfig.js";
import marketConfig from "../../../lib/market.js";

const {
  allowProviderModeInRuntime,
  resolvePayPalMode,
  resolvePaymentRuntimePolicy,
  resolveRazorpayMode,
} = providerConfig;
const { resolveMarketCurrency } = marketConfig;

const getPayPalBaseUrl = (runtimePolicy = resolvePaymentRuntimePolicy()) =>
  resolvePayPalMode(runtimePolicy) === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

export const getPayPalCredentials = () => ({
  clientId: String(
    process.env.PAYPAL_CLIENT_ID ||
      process.env.REACT_APP_PAYPAL_CLIENT_ID ||
      process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ||
      ""
  ).trim(),
  clientSecret: String(
    process.env.PAYPAL_CLIENT_SECRET || process.env.REACT_APP_PAYPAL_CLIENT_SECRET || ""
  ).trim(),
});

export const DEFAULT_RAZORPAY_CURRENCY = String(
  process.env.RAZORPAY_CURRENCY || resolveMarketCurrency()
)
  .trim()
  .toUpperCase() || "USD";

export const DEFAULT_PAYPAL_CURRENCY = String(
  process.env.PAYPAL_CURRENCY || process.env.RAZORPAY_CURRENCY || "USD"
)
  .trim()
  .toUpperCase() || "USD";

export const DEFAULT_PAYU_CURRENCY = "INR";

export const toMoney = (value) => {
  const parsed = Number(
    typeof value === "string" ? value.replace(/[^0-9.]/g, "") : value
  );
  if (!Number.isFinite(parsed)) return 0;
  return +parsed.toFixed(2);
};

export const toSubunits = (amount, currency = "USD") => {
  const factors = { USD: 100, INR: 100, JPY: 1 };
  const factor = factors[currency] ?? 100;
  return Math.round(amount * factor);
};

const sha512 = (value) =>
  crypto.createHash("sha512").update(String(value || "")).digest("hex");

export const resolveRazorpayCredentials = () => {
  const runtimePolicy = resolvePaymentRuntimePolicy();
  const keyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
  const mode = resolveRazorpayMode(keyId);
  const enabled =
    !!keyId &&
    !!keySecret &&
    allowProviderModeInRuntime(mode, runtimePolicy);

  return {
    enabled,
    keyId,
    keySecret,
    mode,
    runtime: runtimePolicy.runtime,
  };
};

export const resolvePayuCredentials = () => {
  const runtimePolicy = resolvePaymentRuntimePolicy();
  const key = String(process.env.PAYU_KEY || process.env.PAYU_MERCHANT_KEY || "").trim();
  const salt = String(process.env.PAYU_SALT || process.env.PAYU_MERCHANT_SALT || "").trim();
  const explicitMode = String(process.env.PAYU_ENV || "").trim().toLowerCase();
  const mode = explicitMode === "test" ? "test" : "live";
  const enabled =
    !!key &&
    !!salt &&
    allowProviderModeInRuntime(mode, runtimePolicy);

  return {
    enabled,
    key,
    salt,
    mode,
    endpoint:
      mode === "test"
        ? "https://test.payu.in/_payment"
        : "https://secure.payu.in/_payment",
    runtime: runtimePolicy.runtime,
  };
};

export const buildPayuRequestHash = ({
  key,
  txnid,
  amount,
  productinfo,
  firstname,
  email,
  udf1 = "",
  udf2 = "",
  udf3 = "",
  udf4 = "",
  udf5 = "",
  salt,
}) =>
  sha512(
    [
      key,
      txnid,
      amount,
      productinfo,
      firstname,
      email,
      udf1,
      udf2,
      udf3,
      udf4,
      udf5,
      "",
      "",
      "",
      "",
      "",
      salt,
    ].join("|")
  );

export const buildPayuResponseHash = ({
  salt,
  status,
  udf1 = "",
  udf2 = "",
  udf3 = "",
  udf4 = "",
  udf5 = "",
  email,
  firstname,
  productinfo,
  amount,
  txnid,
  key,
  additionalCharges = "",
}) => {
  const parts = [
    salt,
    status,
    "",
    "",
    "",
    "",
    "",
    udf5,
    udf4,
    udf3,
    udf2,
    udf1,
    email,
    firstname,
    productinfo,
    amount,
    txnid,
    key,
  ];

  return sha512(additionalCharges ? [additionalCharges, ...parts].join("|") : parts.join("|"));
};

export const createPayuOrder = async ({
  amount,
  description = "",
  bookingSeedKey = "",
  email = "",
  firstname = "Roo Customer",
  receipt = `payu_${Date.now()}`,
  successUrl = "",
  failureUrl = "",
}) => {
  const credentials = resolvePayuCredentials();
  if (!credentials.enabled) {
    const missingCredentials = !credentials.key || !credentials.salt;
    const error = new Error(
      missingCredentials
        ? "PayU keys are missing on the server"
        : "PayU is not available in this environment."
    );
    error.status = missingCredentials ? 500 : 400;
    error.code = missingCredentials
      ? "payu_credentials_missing"
      : "payu_unavailable_in_runtime";
    throw error;
  }

  const amountString = toMoney(amount).toFixed(2);
  const txnid = String(receipt || `payu_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "");
  const productinfo = String(description || "Roo Industries booking").trim();
  const customerEmail = String(email || "").trim();
  const customerName = String(firstname || "Roo Customer").trim();
  const udf1 = String(bookingSeedKey || "").trim();
  const enforcePayMethod = String(process.env.PAYU_ENFORCE_PAYMETHOD || "").trim();
  const hash = buildPayuRequestHash({
    key: credentials.key,
    txnid,
    amount: amountString,
    productinfo,
    firstname: customerName,
    email: customerEmail,
    udf1,
    salt: credentials.salt,
  });

  return {
    orderId: txnid,
    amount: Math.round(toMoney(amount) * 100),
    currency: DEFAULT_PAYU_CURRENCY,
    action: credentials.endpoint,
    method: "POST",
    fields: {
      key: credentials.key,
      txnid,
      amount: amountString,
      productinfo,
      firstname: customerName,
      email: customerEmail,
      udf1,
      surl: successUrl,
      furl: failureUrl,
      hash,
      ...(enforcePayMethod ? { enforce_paymethod: enforcePayMethod } : {}),
    },
  };
};

export const verifyPayuResponse = ({
  payload = {},
  expectedAmount,
}) => {
  const credentials = resolvePayuCredentials();
  if (!credentials.enabled) {
    if (!credentials.key || !credentials.salt) {
      return { ok: false, reason: "payu_credentials_missing" };
    }
    return { ok: false, reason: "payu_unavailable_in_runtime" };
  }

  const status = String(payload.status || "").trim().toLowerCase();
  const txnid = String(payload.txnid || "").trim();
  const amount = String(payload.amount || "").trim();
  const hash = String(payload.hash || "").trim().toLowerCase();
  const productinfo = String(payload.productinfo || "").trim();
  const firstname = String(payload.firstname || "").trim();
  const email = String(payload.email || "").trim();

  if (!txnid || !amount || !hash || !productinfo || !firstname || !email) {
    return { ok: false, reason: "payu_response_fields_missing" };
  }

  const expectedHash = buildPayuResponseHash({
    salt: credentials.salt,
    status,
    udf1: String(payload.udf1 || "").trim(),
    udf2: String(payload.udf2 || "").trim(),
    udf3: String(payload.udf3 || "").trim(),
    udf4: String(payload.udf4 || "").trim(),
    udf5: String(payload.udf5 || "").trim(),
    email,
    firstname,
    productinfo,
    amount,
    txnid,
    key: String(payload.key || credentials.key).trim(),
    additionalCharges: String(payload.additionalCharges || payload.additional_charges || "").trim(),
  });

  if (
    hash.length !== expectedHash.length ||
    !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash))
  ) {
    return { ok: false, reason: "payu_hash_invalid" };
  }

  if (toMoney(amount) !== toMoney(expectedAmount)) {
    return { ok: false, reason: "payu_amount_mismatch" };
  }

  if (status !== "success") {
    return { ok: false, reason: `payu_status_${status || "unknown"}` };
  }

  return {
    ok: true,
    providerPaymentId: String(payload.mihpayid || payload.payuMoneyId || "").trim(),
    payerEmail: email,
  };
};

export const verifyRazorpaySignature = ({
  orderId,
  paymentId,
  signature,
  secret,
}) => {
  if (!orderId || !paymentId || !signature || !secret) return false;
  const payload = `${orderId}|${paymentId}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return (
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
};

export const createRazorpayOrder = async ({
  amount,
  currency = DEFAULT_RAZORPAY_CURRENCY,
  notes = {},
  receipt = `booking_${Date.now()}`,
}) => {
  const credentials = resolveRazorpayCredentials();
  if (!credentials.enabled) {
    const missingCredentials = !credentials.keyId || !credentials.keySecret;
    const error = new Error(
      missingCredentials
        ? "Razorpay keys are missing on the server"
        : "Razorpay is not available in this environment."
    );
    error.status = missingCredentials ? 500 : 400;
    error.code = missingCredentials
      ? "razorpay_credentials_missing"
      : "razorpay_unavailable_in_runtime";
    throw error;
  }

  const basic = Buffer.from(
    `${credentials.keyId}:${credentials.keySecret}`
  ).toString("base64");

  const upstream = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: toSubunits(amount, currency),
      currency,
      receipt,
      notes,
    }),
  });

  const order = await upstream.json().catch(() => ({}));
  if (!upstream.ok || !order?.id) {
    const message =
      order?.error?.description ||
      order?.error?.reason ||
      order?.error?.code ||
      `Razorpay order create failed (${upstream.status})`;
    const error = new Error(message);
    error.status = 500;
    error.code = "razorpay_order_create_failed";
    throw error;
  }

  return {
    orderId: String(order.id),
    amount: Number(order.amount || 0),
    currency: String(order.currency || currency).trim().toUpperCase(),
    key: credentials.keyId,
  };
};

export const verifyRazorpayPayment = async ({
  orderId,
  paymentId,
  expectedAmount,
  expectedCurrency = DEFAULT_RAZORPAY_CURRENCY,
}) => {
  const credentials = resolveRazorpayCredentials();
  if (!credentials.enabled) {
    if (!credentials.keyId || !credentials.keySecret) {
      return { ok: false, reason: "razorpay_credentials_missing" };
    }
    return { ok: false, reason: "razorpay_unavailable_in_runtime" };
  }

  try {
    const basic = Buffer.from(
      `${credentials.keyId}:${credentials.keySecret}`
    ).toString("base64");
    const response = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`,
      {
        headers: {
          Authorization: `Basic ${basic}`,
        },
      }
    );

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { ok: false, reason: "razorpay_credentials_invalid" };
      }
      return { ok: false, reason: `razorpay_lookup_failed_${response.status}` };
    }

    const payment = await response.json().catch(() => ({}));
    const status = String(payment?.status || "").trim().toLowerCase();
    const paidAmount = Number(payment?.amount || 0);
    const expectedSubunits = toSubunits(expectedAmount, expectedCurrency);

    if (String(payment?.order_id || "") !== String(orderId || "")) {
      return { ok: false, reason: "razorpay_order_mismatch" };
    }

    if (String(payment?.currency || "").trim().toUpperCase() !== expectedCurrency) {
      return { ok: false, reason: "razorpay_currency_mismatch" };
    }

    if (status !== "captured") {
      return { ok: false, reason: `razorpay_status_${status || "unknown"}` };
    }

    if (paidAmount !== expectedSubunits) {
      return { ok: false, reason: "razorpay_amount_mismatch" };
    }

    return { ok: true };
  } catch (error) {
    console.error("Razorpay payment verification failed:", error);
    return { ok: false, reason: "razorpay_lookup_exception" };
  }
};

export const verifyRazorpayWebhookSignature = ({
  rawBody,
  signature,
  secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim(),
}) => {
  if (!rawBody || !signature || !secret) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return (
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
};

export const getPayPalToken = async () => {
  const runtimePolicy = resolvePaymentRuntimePolicy();
  const { clientId, clientSecret } = getPayPalCredentials();
  const mode = resolvePayPalMode(runtimePolicy);

  if (!allowProviderModeInRuntime(mode, runtimePolicy)) {
    return { ok: false, reason: "paypal_unavailable_in_runtime", token: "" };
  }

  if (!clientId || !clientSecret) {
    return { ok: false, reason: "paypal_credentials_missing", token: "" };
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  try {
    const response = await fetch(`${getPayPalBaseUrl(runtimePolicy)}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const upstreamError = String(data?.error || "").trim().toLowerCase();
      if (
        response.status === 401 ||
        response.status === 403 ||
        upstreamError === "invalid_client"
      ) {
        return { ok: false, reason: "paypal_credentials_invalid", token: "" };
      }

      return {
        ok: false,
        reason: `paypal_token_failed_${response.status}`,
        token: "",
      };
    }

    const token = String(data?.access_token || "").trim();
    if (!token) {
      return { ok: false, reason: "paypal_token_missing", token: "" };
    }

    return { ok: true, reason: "", token };
  } catch (error) {
    console.error("PayPal token fetch failed:", error);
    return { ok: false, reason: "paypal_token_exception", token: "" };
  }
};

export const createPayPalOrder = async ({
  amount,
  currency = DEFAULT_PAYPAL_CURRENCY,
  description = "",
  customId = "",
}) => {
  const tokenResult = await getPayPalToken();
  if (!tokenResult.ok) {
    const error = new Error(tokenResult.reason || "PayPal token unavailable");
    error.status = 500;
    error.code = tokenResult.reason || "paypal_token_unavailable";
    throw error;
  }

  const response = await fetch(`${getPayPalBaseUrl()}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenResult.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          description,
          ...(customId ? { custom_id: customId } : {}),
          amount: {
            currency_code: currency,
            value: toMoney(amount).toFixed(2),
          },
        },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.id) {
    const error = new Error(
      data?.message || data?.name || `PayPal order create failed (${response.status})`
    );
    error.status = 500;
    error.code = "paypal_order_create_failed";
    throw error;
  }

  return {
    orderId: String(data.id),
    currency,
  };
};

export const verifyPayPalOrder = async ({
  orderId,
  expectedAmount,
  expectedCurrency = DEFAULT_PAYPAL_CURRENCY,
}) => {
  const tokenResult = await getPayPalToken();
  if (!tokenResult.ok) {
    return { ok: false, reason: tokenResult.reason || "paypal_token_missing" };
  }

  try {
    const response = await fetch(
      `${getPayPalBaseUrl()}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
      {
        headers: {
          Authorization: `Bearer ${tokenResult.token}`,
        },
      }
    );

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { ok: false, reason: "paypal_lookup_auth_failed" };
      }
      return { ok: false, reason: `paypal_lookup_failed_${response.status}` };
    }

    const details = await response.json().catch(() => ({}));
    const status = String(details?.status || "").trim().toUpperCase();
    if (status !== "COMPLETED") {
      return { ok: false, reason: `paypal_status_${status || "unknown"}` };
    }

    const paidAmount =
      toMoney(
        details?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value ||
          details?.purchase_units?.[0]?.amount?.value ||
          0
      ) || 0;
    const paidCurrency = String(
      details?.purchase_units?.[0]?.payments?.captures?.[0]?.amount
        ?.currency_code ||
        details?.purchase_units?.[0]?.amount?.currency_code ||
        ""
    )
      .trim()
      .toUpperCase();

    if (Math.abs(paidAmount - expectedAmount) > 0.01) {
      return { ok: false, reason: "paypal_amount_mismatch" };
    }

    if (paidCurrency !== String(expectedCurrency || "USD").trim().toUpperCase()) {
      return { ok: false, reason: "paypal_currency_mismatch" };
    }

    return {
      ok: true,
      payerEmail: String(details?.payer?.email_address || "").trim(),
      payerId: String(details?.payer?.payer_id || "").trim(),
    };
  } catch (error) {
    console.error("PayPal order verification failed:", error);
    return { ok: false, reason: "paypal_lookup_exception" };
  }
};

export const verifyPayPalWebhookSignature = async ({
  rawBody,
  headers = {},
  webhookId = String(process.env.PAYPAL_WEBHOOK_ID || "").trim(),
}) => {
  if (!rawBody || !webhookId) {
    return { ok: false, reason: "paypal_webhook_not_configured" };
  }

  const transmissionId = String(
    headers["paypal-transmission-id"] || headers["Paypal-Transmission-Id"] || ""
  ).trim();
  const transmissionTime = String(
    headers["paypal-transmission-time"] ||
      headers["Paypal-Transmission-Time"] ||
      ""
  ).trim();
  const transmissionSig = String(
    headers["paypal-transmission-sig"] ||
      headers["Paypal-Transmission-Sig"] ||
      ""
  ).trim();
  const certUrl = String(
    headers["paypal-cert-url"] || headers["Paypal-Cert-Url"] || ""
  ).trim();
  const authAlgo = String(
    headers["paypal-auth-algo"] || headers["Paypal-Auth-Algo"] || ""
  ).trim();

  if (
    !transmissionId ||
    !transmissionTime ||
    !transmissionSig ||
    !certUrl ||
    !authAlgo
  ) {
    return { ok: false, reason: "paypal_webhook_headers_missing" };
  }

  const tokenResult = await getPayPalToken();
  if (!tokenResult.ok) {
    return { ok: false, reason: tokenResult.reason || "paypal_token_missing" };
  }

  let webhookEvent = {};
  try {
    webhookEvent = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "paypal_webhook_body_invalid" };
  }

  const response = await fetch(
    `${getPayPalBaseUrl()}/v1/notifications/verify-webhook-signature`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenResult.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: webhookEvent,
      }),
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, reason: `paypal_webhook_verify_failed_${response.status}` };
  }

  const verificationStatus = String(
    data?.verification_status || ""
  ).trim().toUpperCase();
  if (verificationStatus !== "SUCCESS") {
    return { ok: false, reason: "paypal_webhook_signature_invalid" };
  }

  return { ok: true };
};

export const getPayPalBase = getPayPalBaseUrl;
