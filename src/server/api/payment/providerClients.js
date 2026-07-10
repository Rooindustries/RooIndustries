import crypto from "crypto";
import providerConfig from "./providerConfig.js";
import { logSafeError } from "../../safeErrorLog.js";

const {
  allowProviderModeInRuntime,
  resolvePayPalMode,
  resolvePaymentRuntimePolicy,
  resolveRazorpayMode,
} = providerConfig;

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
  clientSecret: String(process.env.PAYPAL_CLIENT_SECRET || "").trim(),
});

export const DEFAULT_RAZORPAY_CURRENCY = String(
  process.env.RAZORPAY_CURRENCY || "USD"
)
  .trim()
  .toUpperCase() || "USD";

export const DEFAULT_PAYPAL_CURRENCY = String(
  process.env.PAYPAL_CURRENCY || process.env.RAZORPAY_CURRENCY || "USD"
)
  .trim()
  .toUpperCase() || "USD";

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

const getRazorpayAuthorization = (credentials) =>
  `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString(
    "base64"
  )}`;

const normalizeRazorpayOrder = ({ order = {}, credentials, currency, receipt }) => ({
  orderId: String(order.id || "").trim(),
  amount: Number(order.amount || 0),
  currency: String(order.currency || currency).trim().toUpperCase(),
  key: credentials.keyId,
  receipt: String(order.receipt || receipt || "").trim(),
});

export const inspectRazorpayOrderByReceipt = async ({
  receipt,
  amount,
  currency = DEFAULT_RAZORPAY_CURRENCY,
  credentials = resolveRazorpayCredentials(),
}) => {
  if (!credentials.enabled || !receipt) {
    return {
      state: "unavailable",
      reason: !receipt
        ? "razorpay_receipt_missing"
        : "razorpay_credentials_missing",
    };
  }

  let response;
  try {
    response = await fetch(
      `https://api.razorpay.com/v1/orders?receipt=${encodeURIComponent(receipt)}&count=10`,
      {
        headers: {
          Authorization: getRazorpayAuthorization(credentials),
        },
      }
    );
  } catch {
    return { state: "unavailable", reason: "razorpay_receipt_lookup_exception" };
  }
  if (!response.ok) {
    return {
      state: "unavailable",
      reason: `razorpay_receipt_lookup_failed_${response.status}`,
    };
  }

  const payload = await response.json().catch(() => ({}));
  const expectedAmount = toSubunits(amount, currency);
  const order = (Array.isArray(payload?.items) ? payload.items : []).find(
    (entry) =>
      String(entry?.receipt || "").trim() === String(receipt).trim() &&
      Number(entry?.amount || 0) === expectedAmount &&
      String(entry?.currency || "").trim().toUpperCase() ===
        String(currency || "").trim().toUpperCase()
  );
  return order
    ? {
        state: "found",
        order: normalizeRazorpayOrder({ order, credentials, currency, receipt }),
      }
    : { state: "not_found", reason: "" };
};

export const findRazorpayOrderByReceipt = async (options) => {
  const result = await inspectRazorpayOrderByReceipt(options);
  return result.state === "found" ? result.order : null;
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
  lookupOnly = false,
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

  const stableReceipt = String(receipt || "").trim();
  const lookup = await inspectRazorpayOrderByReceipt({
    receipt: stableReceipt,
    amount,
    currency,
    credentials,
  });
  if (lookup.state === "found" && lookup.order?.orderId) return lookup.order;
  if (lookupOnly) {
    const error = new Error(
      lookup.state === "unavailable"
        ? "Razorpay receipt lookup is temporarily unavailable."
        : "The ambiguous Razorpay order is not visible yet."
    );
    error.status = 503;
    error.code =
      lookup.reason ||
      (lookup.state === "not_found"
        ? "razorpay_ambiguous_order_not_found"
        : "razorpay_receipt_lookup_unavailable");
    throw error;
  }

  let upstream;
  try {
    upstream = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: getRazorpayAuthorization(credentials),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: toSubunits(amount, currency),
        currency,
        receipt: stableReceipt,
        notes,
      }),
    });
  } catch (error) {
    const recovered = await inspectRazorpayOrderByReceipt({
      receipt: stableReceipt,
      amount,
      currency,
      credentials,
    });
    if (recovered.state === "found" && recovered.order?.orderId) {
      return recovered.order;
    }
    throw error;
  }

  const order = await upstream.json().catch(() => ({}));
  if (!upstream.ok || !order?.id) {
    const recovered = await inspectRazorpayOrderByReceipt({
      receipt: stableReceipt,
      amount,
      currency,
      credentials,
    });
    if (recovered.state === "found" && recovered.order?.orderId) {
      return recovered.order;
    }

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

  return normalizeRazorpayOrder({
    order,
    credentials,
    currency,
    receipt: stableReceipt,
  });
};

export const inspectRazorpayOrder = async ({ orderId }) => {
  const credentials = resolveRazorpayCredentials();
  if (!credentials.enabled || !orderId) {
    return {
      state: "unavailable",
      reason: !orderId ? "razorpay_order_id_missing" : "razorpay_credentials_missing",
    };
  }

  try {
    const response = await fetch(
      `https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}/payments`,
      { headers: { Authorization: getRazorpayAuthorization(credentials) } }
    );
    if (!response.ok) {
      return { state: "unavailable", reason: `razorpay_lookup_failed_${response.status}` };
    }

    const payload = await response.json().catch(() => ({}));
    const payments = Array.isArray(payload?.items) ? payload.items : [];
    const captured = payments.find(
      (entry) => String(entry?.status || "").trim().toLowerCase() === "captured"
    );
    if (captured?.id) {
      return {
        state: "captured",
        providerOrderId: String(orderId),
        providerPaymentId: String(captured.id),
        payerEmail: String(captured.email || "").trim(),
      };
    }

    const pending = payments.some((entry) =>
      ["authorized", "created"].includes(
        String(entry?.status || "").trim().toLowerCase()
      )
    );
    return { state: pending ? "pending" : "unpaid", reason: "" };
  } catch {
    return { state: "unavailable", reason: "razorpay_lookup_exception" };
  }
};

export const inspectRazorpayPayment = async ({ paymentId }) => {
  const credentials = resolveRazorpayCredentials();
  if (!credentials.enabled || !paymentId) {
    return {
      state: "unavailable",
      reason: !paymentId
        ? "razorpay_payment_id_missing"
        : "razorpay_credentials_missing",
    };
  }

  try {
    const response = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`,
      { headers: { Authorization: getRazorpayAuthorization(credentials) } }
    );
    if (!response.ok) {
      return {
        state: "unavailable",
        reason: `razorpay_payment_lookup_failed_${response.status}`,
      };
    }
    const payment = await response.json().catch(() => ({}));
    const orderId = String(payment?.order_id || "").trim();
    if (!orderId) {
      return {
        state: "unavailable",
        reason: "razorpay_payment_order_id_missing",
      };
    }
    return {
      state: "found",
      providerOrderId: orderId,
      providerPaymentId: String(payment?.id || paymentId).trim(),
      status: String(payment?.status || "").trim().toLowerCase(),
      amountInSubunits: Number(payment?.amount || 0),
      currency: String(payment?.currency || "").trim().toUpperCase(),
      payerEmail: String(payment?.email || "").trim(),
    };
  } catch {
    return { state: "unavailable", reason: "razorpay_payment_lookup_exception" };
  }
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
      return { ok: false, captured: status === "captured", reason: "razorpay_currency_mismatch" };
    }

    if (status !== "captured") {
      return { ok: false, reason: `razorpay_status_${status || "unknown"}` };
    }

    if (paidAmount !== expectedSubunits) {
      return { ok: false, captured: true, reason: "razorpay_amount_mismatch" };
    }

    return { ok: true };
  } catch (error) {
    logSafeError("Razorpay payment verification failed", error);
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
    logSafeError("PayPal token fetch failed", error);
    return { ok: false, reason: "paypal_token_exception", token: "" };
  }
};

export const createPayPalOrder = async ({
  amount,
  currency = DEFAULT_PAYPAL_CURRENCY,
  description = "",
  customId = "",
  requestId = "",
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
      ...(requestId ? { "PayPal-Request-Id": String(requestId).trim() } : {}),
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

const inspectPayPalDetails = (details = {}) => {
  const status = String(details?.status || "").trim().toUpperCase();
  const capture = details?.purchase_units?.[0]?.payments?.captures?.[0] || {};
  if (status === "COMPLETED" && capture?.id) {
    return {
      state: "captured",
      providerOrderId: String(details?.id || "").trim(),
      providerPaymentId: String(capture.id || "").trim(),
      payerEmail: String(details?.payer?.email_address || "").trim(),
      payerId: String(details?.payer?.payer_id || "").trim(),
      details,
    };
  }
  if (["CREATED", "APPROVED", "PAYER_ACTION_REQUIRED", "SAVED"].includes(status)) {
    return { state: status === "CREATED" ? "unpaid" : "pending", details };
  }
  return { state: "unavailable", reason: `paypal_status_${status || "unknown"}`, details };
};

export const inspectPayPalOrder = async ({ orderId }) => {
  const tokenResult = await getPayPalToken();
  if (!tokenResult.ok || !orderId) {
    return {
      state: "unavailable",
      reason: !orderId
        ? "paypal_order_id_missing"
        : tokenResult.reason || "paypal_token_missing",
    };
  }

  try {
    const response = await fetch(
      `${getPayPalBaseUrl()}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
      { headers: { Authorization: `Bearer ${tokenResult.token}` } }
    );
    if (!response.ok) {
      return { state: "unavailable", reason: `paypal_lookup_failed_${response.status}` };
    }
    return inspectPayPalDetails(await response.json().catch(() => ({})));
  } catch {
    return { state: "unavailable", reason: "paypal_lookup_exception" };
  }
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
      return { ok: false, captured: true, reason: "paypal_amount_mismatch" };
    }

    if (paidCurrency !== String(expectedCurrency || "USD").trim().toUpperCase()) {
      return { ok: false, captured: true, reason: "paypal_currency_mismatch" };
    }

    const capture = details?.purchase_units?.[0]?.payments?.captures?.[0] || {};
    return {
      ok: true,
      payerEmail: String(details?.payer?.email_address || "").trim(),
      payerId: String(details?.payer?.payer_id || "").trim(),
      providerPaymentId: String(capture?.id || "").trim(),
    };
  } catch (error) {
    logSafeError("PayPal order verification failed", error);
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
