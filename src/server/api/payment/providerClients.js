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
  const normalized =
    typeof value === "string"
      ? value.trim().replace(/,/g, "").replace(/[$€£₹]/g, "").trim()
      : value;
  if (
    typeof normalized === "string" &&
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)
  ) {
    return 0;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 0;
  return +parsed.toFixed(2);
};

export const toSubunits = (amount, currency = "USD") => {
  const factors = { BIF: 1, CLP: 1, DJF: 1, GNF: 1, ISK: 1, JPY: 1, KMF: 1, KRW: 1, PYG: 1, RWF: 1, UGX: 1, UYI: 1, VND: 1, VUV: 1, XAF: 1, XOF: 1, XPF: 1, BHD: 1000, IQD: 1000, JOD: 1000, KWD: 1000, LYD: 1000, OMR: 1000, TND: 1000 };
  const factor = factors[String(currency).trim().toUpperCase()] ?? 100;
  return Math.round(amount * factor);
};

export const parseMoneySubunits = (value, currency = "USD") => {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const factor = toSubunits(1, currency);
  const precision = Math.log10(factor);
  const fraction = text.split(".")[1] || "";
  if (/[1-9]/.test(fraction.slice(precision))) return null;
  const amount = toSubunits(Number(text), currency);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
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
        signal: AbortSignal.timeout(8000),
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

  const payload = await response.json().catch(() => null);
  if (!payload) return { state: "unavailable", reason: "razorpay_receipt_lookup_exception" };
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
  const providedBuffer = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer);
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
      signal: AbortSignal.timeout(8000),
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
      { headers: { Authorization: getRazorpayAuthorization(credentials) }, signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) {
      return { state: "unavailable", reason: `razorpay_lookup_failed_${response.status}` };
    }

    const payload = await response.json();
    const payments = Array.isArray(payload?.items) ? payload.items : [];
    const captured = payments.find(
      (entry) => ["captured", "refunded"].includes(String(entry?.status || "").trim().toLowerCase())
    );
    if (captured?.id) {
      if (String(captured.order_id || "").trim() !== String(orderId).trim() ||
          captured.captured !== true) {
        return { state: "unavailable", reason: "razorpay_payment_binding_mismatch" };
      }
      return {
        state: captured.status === "refunded" || Number(captured.amount_refunded) > 0 ? "refunded" : "captured",
        refundStatus: String(captured.refund_status || ""),
        amountRefundedInSubunits: Number(captured.amount_refunded || 0),
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
      { headers: { Authorization: getRazorpayAuthorization(credentials) }, signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) {
      return {
        state: "unavailable",
        reason: `razorpay_payment_lookup_failed_${response.status}`,
      };
    }
    const payment = await response.json();
    if (String(payment?.id || "").trim() !== String(paymentId).trim()) {
      return { state: "unavailable", reason: "razorpay_payment_id_mismatch" };
    }
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
      providerPaymentId: String(payment.id).trim(),
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
        signal: AbortSignal.timeout(8000),
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

    const payment = await response.json();
    const status = String(payment?.status || "").trim().toLowerCase();
    const paidAmount = payment?.amount;
    const expectedSubunits = parseMoneySubunits(expectedAmount, expectedCurrency);

    if (String(payment?.id || "").trim() !== String(paymentId || "").trim()) {
      return { ok: false, reason: "razorpay_payment_id_mismatch" };
    }

    if (String(payment?.order_id || "") !== String(orderId || "")) {
      return { ok: false, reason: "razorpay_order_mismatch" };
    }

    if (String(payment?.currency || "").trim().toUpperCase() !== expectedCurrency) {
      return { ok: false, captured: status === "captured", reason: "razorpay_currency_mismatch" };
    }

    if (!["captured", "refunded"].includes(status) || payment.captured !== true) {
      return { ok: false, reason: `razorpay_status_${status || "unknown"}` };
    }

    if (!expectedSubunits || !Number.isSafeInteger(paidAmount) || paidAmount !== expectedSubunits) {
      return { ok: false, captured: true, reason: "razorpay_amount_mismatch" };
    }

    const amountRefundedInSubunits = payment.amount_refunded ?? 0;
    const refundStatus = String(payment.refund_status || "").trim().toLowerCase();
    if (!Number.isSafeInteger(amountRefundedInSubunits) || amountRefundedInSubunits < 0 || amountRefundedInSubunits > paidAmount ||
        (refundStatus === "full" && amountRefundedInSubunits !== paidAmount) ||
        (refundStatus === "partial" && (amountRefundedInSubunits <= 0 || amountRefundedInSubunits >= paidAmount)) ||
        (status === "refunded" && amountRefundedInSubunits !== paidAmount)) {
      return { ok: false, captured: true, reason: "razorpay_refund_state_mismatch" };
    }
    if (amountRefundedInSubunits === paidAmount) {
      return { ok: false, refunded: true, captured: true, reason: "razorpay_status_refunded",
        refundStatus: "full", amountRefundedInSubunits, totalAmount: paidAmount, currency: expectedCurrency,
        providerOrderId: orderId, providerPaymentId: paymentId };
    }
    if (payment.amount_captured != null && (!Number.isSafeInteger(payment.amount_captured) || payment.amount_captured !== paidAmount)) {
      return { ok: false, captured: true, reason: "razorpay_amount_mismatch" };
    }
    const refunds = new Map();
    if (amountRefundedInSubunits > 0) {
      let total = 0;
      for (let page = 0; page < 5; page += 1) {
        const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refunds?count=100&skip=${page * 100}`,
          { headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(8000) });
        if (!response.ok) return { ok: false, captured: true, reason: `razorpay_refund_lookup_failed_${response.status}` };
        const payload = await response.json();
        if (!Array.isArray(payload.items)) return { ok: false, captured: true, reason: "razorpay_refund_details_pending" };
        for (const refund of payload.items) {
          if (refund.status !== "processed") continue;
          if (!refund.id || refund.payment_id !== paymentId || refund.currency !== expectedCurrency ||
              !Number.isSafeInteger(refund.amount) || refund.amount <= 0 || refund.amount > paidAmount) {
            return { ok: false, captured: true, reason: "razorpay_refund_state_mismatch" };
          }
          const prior = refunds.get(refund.id);
          if (prior && prior.amountInSubunits !== refund.amount) return { ok: false, captured: true, reason: "razorpay_refund_state_mismatch" };
          if (!prior) total += refund.amount;
          refunds.set(refund.id, { id: refund.id, status: refund.status, amountInSubunits: refund.amount, currency: refund.currency });
        }
        if (total === amountRefundedInSubunits || payload.items.length < 100) break;
      }
      if ([...refunds.values()].reduce((sum, refund) => sum + refund.amountInSubunits, 0) !== amountRefundedInSubunits) {
        return { ok: false, captured: true, reason: "razorpay_refund_details_pending" };
      }
    }
    return { ok: true, refundStatus: amountRefundedInSubunits > 0 ? "partial" : refundStatus,
      amountRefundedInSubunits, refunds: [...refunds.values()] };
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
  const providedBuffer = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer);
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
      signal: AbortSignal.timeout(8000),
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
    signal: AbortSignal.timeout(8000),
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
  if (!Array.isArray(details.purchase_units) || details.purchase_units.length !== 1) {
    return { state: "unavailable", reason: "paypal_purchase_units_mismatch", details };
  }
  const captures = details.purchase_units[0]?.payments?.captures;
  if (Array.isArray(captures) && captures.length > 1) {
    return { state: "unavailable", reason: "paypal_captures_mismatch", details };
  }
  const capture = details?.purchase_units?.[0]?.payments?.captures?.[0] || {};
  const captureStatus = String(capture?.status || "").trim().toUpperCase();
  if (
    status === "COMPLETED" &&
    capture?.id &&
    ["COMPLETED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(captureStatus)
  ) {
    return {
      state: captureStatus === "COMPLETED" ? "captured" : "refunded",
      refundStatus: captureStatus === "REFUNDED" ? "full" : captureStatus === "PARTIALLY_REFUNDED" ? "partial" : "",
      providerOrderId: String(details?.id || "").trim(),
      providerPaymentId: String(capture.id || "").trim(),
      payerEmail: String(details?.payer?.email_address || "").trim(),
      payerId: String(details?.payer?.payer_id || "").trim(),
      details,
    };
  }
  if (status === "COMPLETED" && capture?.id) {
    return {
      state: "pending",
      reason: `paypal_capture_status_${
        captureStatus ? captureStatus.toLowerCase() : "unknown"
      }`,
      providerOrderId: String(details?.id || "").trim(),
      providerPaymentId: String(capture.id || "").trim(),
      details,
    };
  }
  if (status === "COMPLETED") {
    return { state: "unavailable", reason: "paypal_capture_missing", details };
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
      { headers: { Authorization: `Bearer ${tokenResult.token}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) {
      return { state: "unavailable", reason: `paypal_lookup_failed_${response.status}` };
    }
    const details = await response.json();
    if (String(details?.id || "").trim() !== String(orderId).trim()) {
      return { state: "unavailable", reason: "paypal_order_mismatch" };
    }
    return inspectPayPalDetails(details);
  } catch {
    return { state: "unavailable", reason: "paypal_lookup_exception" };
  }
};

export const verifyPayPalOrder = async ({
  orderId,
  expectedPaymentId = "",
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
        signal: AbortSignal.timeout(8000),
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

    const details = await response.json();
    if (String(details?.id || "").trim() !== String(orderId || "").trim()) {
      return { ok: false, reason: "paypal_order_mismatch" };
    }
    const status = String(details?.status || "").trim().toUpperCase();
    if (status !== "COMPLETED") {
      return { ok: false, reason: `paypal_status_${status || "unknown"}` };
    }

    const inspection = inspectPayPalDetails(details);
    if (inspection.state === "unavailable") return { ok: false, reason: inspection.reason };
    const capture = details?.purchase_units?.[0]?.payments?.captures?.[0] || {};
    const captureStatus = String(capture?.status || "").trim().toUpperCase();
    if (!capture?.id) {
      return { ok: false, reason: "paypal_capture_missing" };
    }
    if (expectedPaymentId && String(capture.id).trim() !== String(expectedPaymentId).trim()) {
      return { ok: false, reason: "paypal_payment_id_mismatch" };
    }
    if (!["COMPLETED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(captureStatus)) {
      return {
        ok: false,
        captured: true,
        reason: `paypal_capture_status_${
          captureStatus ? captureStatus.toLowerCase() : "unknown"
        }`,
      };
    }

    const paidCurrency = String(
      capture?.amount?.currency_code || ""
    )
      .trim()
      .toUpperCase();

    const paidAmount = parseMoneySubunits(capture?.amount?.value, paidCurrency);
    const expectedSubunits = parseMoneySubunits(expectedAmount, expectedCurrency);
    if (!paidAmount || !expectedSubunits || paidAmount !== expectedSubunits) {
      return { ok: false, captured: true, reason: "paypal_amount_mismatch" };
    }

    if (paidCurrency !== String(expectedCurrency || "USD").trim().toUpperCase()) {
      return { ok: false, captured: true, reason: "paypal_currency_mismatch" };
    }

    if (captureStatus === "REFUNDED") {
      return { ok: false, refunded: true, captured: true, reason: "paypal_capture_status_refunded",
        refundStatus: "full", amountRefundedInSubunits: paidAmount, totalAmount: paidAmount, currency: paidCurrency,
        providerOrderId: orderId, providerPaymentId: String(capture.id).trim() };
    }
    const refunds = new Map();
    let reportedRefundTotal = 0;
    for (const refund of details.purchase_units[0]?.payments?.refunds || []) {
      if (refund.status !== "COMPLETED") continue;
      const amountInSubunits = parseMoneySubunits(refund.amount?.value, paidCurrency);
      if (!refund.id || refund.amount?.currency_code !== paidCurrency || !amountInSubunits || amountInSubunits > paidAmount) {
        return { ok: false, captured: true, reason: "paypal_refund_state_mismatch" };
      }
      const reportedTotal = refund.seller_payable_breakdown?.total_refunded_amount;
      if (reportedTotal != null) {
        const total = parseMoneySubunits(reportedTotal.value, paidCurrency);
        if (!total || reportedTotal.currency_code !== paidCurrency || total < amountInSubunits || total > paidAmount) {
          return { ok: false, captured: true, reason: "paypal_refund_state_mismatch" };
        }
        reportedRefundTotal = Math.max(reportedRefundTotal, total);
      }
      const prior = refunds.get(refund.id);
      if (prior && prior.amountInSubunits !== amountInSubunits) return { ok: false, captured: true, reason: "paypal_refund_state_mismatch" };
      refunds.set(refund.id, { id: refund.id, status: refund.status, amount: refund.amount.value, amountInSubunits, currency: paidCurrency });
    }
    const identifiedRefundTotal = [...refunds.values()].reduce((sum, refund) => sum + refund.amountInSubunits, 0);
    const amountRefundedInSubunits = Math.max(identifiedRefundTotal, reportedRefundTotal);
    if (amountRefundedInSubunits === paidAmount) {
      return { ok: false, refunded: true, captured: true, reason: "paypal_capture_status_refunded",
        refundStatus: "full", amountRefundedInSubunits, totalAmount: paidAmount, currency: paidCurrency,
        providerOrderId: orderId, providerPaymentId: String(capture.id).trim() };
    }
    if (amountRefundedInSubunits > paidAmount || (captureStatus === "PARTIALLY_REFUNDED" && amountRefundedInSubunits >= paidAmount)) {
      return { ok: false, captured: true, reason: "paypal_refund_state_mismatch" };
    }
    return {
      ok: true,
      refundStatus: captureStatus === "PARTIALLY_REFUNDED" || amountRefundedInSubunits > 0 ? "partial" : "",
      amountRefundedInSubunits, refunds: [...refunds.values()],
      refundDetailsMissing: amountRefundedInSubunits > identifiedRefundTotal,
      payerEmail: String(details?.payer?.email_address || "").trim(),
      payerId: String(details?.payer?.payer_id || "").trim(),
      providerPaymentId: String(capture?.id || "").trim(),
    };
  } catch (error) {
    logSafeError("PayPal order verification failed", error);
    return { ok: false, reason: "paypal_lookup_exception" };
  }
};

export const getPayPalRefundCaptureId = (resource = {}) => {
  const relatedId = String(resource.supplementary_data?.related_ids?.capture_id || resource.capture_id || "").trim();
  const links = Array.isArray(resource.links) ? resource.links : [];
  for (const link of links) {
    if (link?.rel !== "up") continue;
    try {
      const url = new URL(link.href);
      if (!["https://api-m.paypal.com", "https://api-m.sandbox.paypal.com", "https://api.paypal.com", "https://api.sandbox.paypal.com"].includes(url.origin)) continue;
      const match = url.pathname.match(/^\/v2\/payments\/captures\/([A-Za-z0-9_-]+)$/);
      if (match) return relatedId && relatedId !== match[1] ? "" : match[1];
    } catch {}
  }
  return relatedId;
};

export const inspectPayPalCapture = async ({ paymentId }) => {
  if (!paymentId) return { state: "unavailable", reason: "paypal_payment_id_missing" };
  const tokenResult = await getPayPalToken();
  if (!tokenResult.ok) return { state: "unavailable", reason: tokenResult.reason };
  try {
    const response = await fetch(`${getPayPalBaseUrl()}/v2/payments/captures/${encodeURIComponent(paymentId)}`, {
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${tokenResult.token}` },
    });
    if (!response.ok) return { state: "unavailable", reason: `paypal_capture_lookup_failed_${response.status}` };
    const capture = await response.json();
    if (String(capture.id || "").trim() !== String(paymentId).trim()) {
      return { state: "unavailable", reason: "paypal_payment_id_mismatch" };
    }
    return { state: "found", providerPaymentId: String(capture.id).trim(),
      providerOrderId: String(capture.supplementary_data?.related_ids?.order_id || "").trim(),
      status: String(capture.status || "").trim().toUpperCase(),
      amountInSubunits: parseMoneySubunits(capture.amount?.value, capture.amount?.currency_code),
      currency: String(capture.amount?.currency_code || "").trim().toUpperCase() };
  } catch { return { state: "unavailable", reason: "paypal_capture_lookup_exception" }; }
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
    return { ok: false, retryable: true, reason: tokenResult.reason || "paypal_token_missing" };
  }

  let webhookEvent = {};
  try {
    webhookEvent = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "paypal_webhook_body_invalid" };
  }

  let response;
  try {
    response = await fetch(
      `${getPayPalBaseUrl()}/v1/notifications/verify-webhook-signature`,
      {
        method: "POST",
        signal: AbortSignal.timeout(8000),
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
  } catch { return { ok: false, retryable: true, reason: "paypal_webhook_verify_exception" }; }

  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, retryable: true, reason: "paypal_webhook_verify_exception" };
  }
  if (!response.ok) {
    return { ok: false, retryable: [401, 403, 429].includes(response.status) || response.status >= 500,
      reason: `paypal_webhook_verify_failed_${response.status}` };
  }

  const verificationStatus = String(
    data?.verification_status || ""
  ).trim().toUpperCase();
  if (verificationStatus === "FAILURE") {
    return { ok: false, reason: "paypal_webhook_signature_invalid" };
  }
  if (verificationStatus !== "SUCCESS") {
    return { ok: false, retryable: true, reason: "paypal_webhook_verify_response_invalid" };
  }

  return { ok: true };
};

export const getPayPalBase = getPayPalBaseUrl;
