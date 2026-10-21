import crypto from "node:crypto";
import { createCommerceReadClient } from "../ref/documentStore.js";
import { createDodoClient, validateDodoPayment } from "./dodoProvider.js";
import { fetchShadowDocuments } from "../../supabase/shadowStore.js";

const WINDOW_HOURS = 72;
const SETTLE_MINUTES = 30;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const MAX_ITEMS = 50;
const MAX_BOOKING_LOOKUPS = 200;
const KEPT_BOOKING_STATUSES = ["captured", "completed"];
const SETTLED_DISPUTE_STATUSES = ["dispute_won", "dispute_cancelled"];
const DISPUTE_STATUSES = [
  ...SETTLED_DISPUTE_STATUSES,
  "dispute_opened",
  "dispute_challenged",
  "dispute_expired",
  "dispute_accepted",
  "dispute_lost",
];
const PAYMENT_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "processing",
  "requires_customer_action",
  "requires_merchant_action",
  "requires_payment_method",
  "requires_confirmation",
  "requires_capture",
  "partially_captured",
  "partially_captured_and_capturable",
];
const OWNER_REVIEW_CODES = new Set([
  "dodo_payment_binding_mismatch",
  "dodo_environment_mismatch",
  "dodo_currency_mismatch",
  "dodo_amount_mismatch",
  "dodo_product_mismatch",
  "dodo_payment_details_incomplete",
  "dodo_refund_details_incomplete",
  "dodo_refund_mismatch",
  "dodo_payment_disputed",
  "dodo_dispute_lost_owner_review",
  "dodo_dispute_accepted_owner_review",
  "dodo_dispute_expired_owner_review",
  "dodo_payment_failed",
  "dodo_payment_cancelled",
  "provider_partial_refund_details_missing_owner_review",
  "provider_order_not_found_after_late_capture_watch",
]);

const unavailable = () => new Error("reconcile_report_unavailable");
const ownerReviewReason = (record) => {
  const code = record.providerRecoveryTerminalReason || record.recoveryReason;
  return `owner_review_${OWNER_REVIEW_CODES.has(code) ? code : "unknown"}`;
};

const readBearer = (req) => {
  const header = req?.headers?.authorization || req?.headers?.Authorization || "";
  const match = String(header)
    .trim()
    .match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : "";
};

export const authorizeReportRequest = (req, env = process.env) => {
  const configured = String(env.RECONCILE_REPORT_TOKEN || "").trim();
  if (configured.length < 32) return 404;
  const provided = Buffer.from(readBearer(req));
  const expected = Buffer.from(configured);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected))
    return 403;
  return 0;
};

const keep = (value, pattern, max) =>
  String(value ?? "")
    .replace(pattern, "")
    .slice(0, max);

const toItem = ({ id, ref = "", cents = null, currency = "", reason }) => ({
  id: keep(id, /[^A-Za-z0-9_.:/-]/g, 80),
  ref: keep(ref, /[^A-Za-z0-9_.:/-]/g, 80),
  amount: Number.isSafeInteger(cents) ? (cents / 100).toFixed(2) : "",
  currency: keep(currency, /[^A-Za-z]/g, 3).toUpperCase(),
  reason: keep(
    String(reason || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, ""),
    /[^a-z0-9_]/g,
    60,
  ),
});

const listDodoPayments = async ({ dodo, from, to }) => {
  const payments = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await dodo.payments
      .list({
        created_at_gte: from,
        created_at_lte: to,
        page_size: PAGE_SIZE,
        page_number: page,
      })
      .asResponse();
    const result = await response.json();
    const items = result?.items;
    if (
      !Array.isArray(items) ||
      items.length > PAGE_SIZE ||
      items.some(
        (item) =>
          !item ||
          typeof item.payment_id !== "string" ||
          !item.payment_id ||
          (item.status != null && !PAYMENT_STATUSES.includes(item.status)),
      )
    )
      throw unavailable();
    payments.push(...items);
    if (items.length < PAGE_SIZE) return { payments, truncated: false };
  }
  return { payments, truncated: true };
};

const readDocuments = async (client, type, options) => {
  if (!client.shadowClient) throw unavailable();
  return fetchShadowDocuments({
    client: client.shadowClient,
    documentTypes: [type],
    allowLegacyFallback: false,
    ...options,
  });
};

const fetchByIds = async (client, type, ids) => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const docs = [];
  for (let offset = 0; offset < unique.length; offset += PAGE_SIZE) {
    const batch = await readDocuments(client, type, {
      ids: unique.slice(offset, offset + PAGE_SIZE),
      limit: PAGE_SIZE,
    });
    if (!Array.isArray(batch)) throw unavailable();
    docs.push(...batch);
  }
  const found = new Map(docs.map((doc) => [doc._id, doc]));
  return new Map(unique.map((id) => [id, found.get(id) || null]));
};

const cents = (value) => Math.round(Number(value || 0) * 100);
const moneyCents = (value) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  Number.isSafeInteger(Math.round(value * 100))
    ? Math.round(value * 100)
    : null;

const frozenPricing = (record) => {
  const pricing = record.pricingSnapshot;
  const gross = moneyCents(pricing?.grossAmount);
  const net = moneyCents(pricing?.netAmount);
  const commission = moneyCents(pricing?.commissionAmount);
  const percent = pricing?.commissionPercent;
  if (
    gross === null ||
    net === null ||
    net > gross ||
    commission === null ||
    typeof percent !== "number" ||
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100 ||
    (percent === 0 && commission !== 0) ||
    typeof pricing.effectiveReferralCode !== "string" ||
    typeof pricing.effectiveReferralId !== "string"
  )
    return null;
  const referralCode = pricing.effectiveReferralCode.trim().toLowerCase();
  const referralId = pricing.effectiveReferralId.trim();
  if (
    Boolean(referralCode) !== Boolean(referralId) ||
    (!referralId && (percent !== 0 || commission !== 0))
  )
    return null;
  return { gross, net, commission, percent, referralCode, referralId };
};

const inWindow = (value, from, to) => {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) && timestamp >= Date.parse(from) && timestamp <= Date.parse(to);
};

const readSiteProductIds = (env = process.env) => {
  const ids = new Set([String(env.DODO_PAYMENTS_PRODUCT_ID || "").trim()]);
  try {
    const mapped = JSON.parse(String(env.DODO_PAYMENTS_PRODUCT_IDS || "{}"));
    for (const id of Object.values(mapped && typeof mapped === "object" ? mapped : {}))
      ids.add(String(id || "").trim());
  } catch {}
  ids.delete("");
  return ids;
};

const belongsToSite = (payment, productIds) =>
  !!String(payment.metadata?.paymentRecordId || "").trim() ||
  (payment.product_cart || []).some((item) => productIds.has(item?.product_id));

const openDispute = (payment) =>
  (payment.disputes || []).some(
    (dispute) => !SETTLED_DISPUTE_STATUSES.includes(dispute?.dispute_status),
  );

const retrievePayment = async (dodo, paymentId, allowMissing = false) => {
  let payment;
  try {
    payment = await dodo.payments.retrieve(paymentId);
  } catch (error) {
    if (allowMissing && error?.status === 404) return null;
    throw error;
  }
  if (
    !payment ||
    payment.payment_id !== paymentId ||
    (payment.status != null && !PAYMENT_STATUSES.includes(payment.status)) ||
    !Number.isSafeInteger(payment.total_amount) ||
    payment.total_amount < 0 ||
    typeof payment.currency !== "string" ||
    !/^[A-Z]{3}$/.test(payment.currency) ||
    !payment.metadata ||
    typeof payment.metadata !== "object" ||
    Array.isArray(payment.metadata) ||
    !Array.isArray(payment.refunds) ||
    !Array.isArray(payment.disputes)
  )
    throw unavailable();
  return payment;
};

const refundedCents = async (dodo, payment) => {
  let amount = 0;
  const seen = new Set();
  for (const summary of payment.refunds) {
    if (
      !summary?.refund_id ||
      seen.has(summary.refund_id) ||
      summary.payment_id !== payment.payment_id ||
      !["succeeded", "pending", "failed", "review"].includes(summary.status) ||
      (summary.currency != null && summary.currency !== payment.currency)
    )
      throw unavailable();
    seen.add(summary.refund_id);
    if (summary.status !== "succeeded") continue;
    const refund =
      summary.amount == null || !summary.currency
        ? await dodo.refunds.retrieve(summary.refund_id)
        : summary;
    if (
      refund.refund_id !== summary.refund_id ||
      refund.payment_id !== payment.payment_id ||
      refund.status !== "succeeded" ||
      refund.currency !== payment.currency ||
      !Number.isSafeInteger(refund.amount) ||
      refund.amount <= 0
    )
      throw unavailable();
    amount += refund.amount;
  }
  if (
    !Number.isSafeInteger(amount) ||
    amount > payment.total_amount ||
    (payment.refund_status === "full" && amount !== payment.total_amount) ||
    (payment.refund_status === "partial" && (amount === 0 || amount >= payment.total_amount)) ||
    (payment.refund_status != null && !["full", "partial"].includes(payment.refund_status))
  )
    throw unavailable();
  return amount;
};

const checkBooking = ({ payment, record, booking, refunded, pricing }) => {
  if (
    String(record.bookingId || "").trim() !== booking._id ||
    booking.paymentProvider !== "dodo" ||
    booking.paymentRecordId !== record._id ||
    booking.dodoPaymentId !== payment.payment_id ||
    booking.dodoCheckoutSessionId !== payment.checkout_session_id
  )
    return "payment_record_mismatch";
  if (
    moneyCents(booking.grossAmount) !== pricing.gross ||
    moneyCents(booking.netAmount) !== pricing.net ||
    (booking.dodoTotalAmount != null && cents(booking.dodoTotalAmount) !== payment.total_amount) ||
    (booking.currency != null && booking.currency !== payment.currency)
  )
    return "amount_mismatch";
  const fullRefund = refunded === payment.total_amount;
  if (
    cents(booking.refundedAmount) !== refunded ||
    (fullRefund && booking.status !== "refunded") ||
    (refunded > 0 && booking.refundStatus !== (fullRefund ? "full" : "partial")) ||
    (refunded === 0 && ["full", "partial"].includes(booking.refundStatus)) ||
    (refunded > 0 && booking.refundCurrency != null && booking.refundCurrency !== payment.currency)
  )
    return "refund_not_applied";
  for (const dispute of payment.disputes) {
    if (
      !dispute?.dispute_id ||
      dispute.payment_id !== payment.payment_id ||
      dispute.currency !== payment.currency ||
      !DISPUTE_STATUSES.includes(dispute.dispute_status) ||
      !["pre_dispute", "dispute", "pre_arbitration"].includes(dispute.dispute_stage)
    )
      throw unavailable();
  }
  const disputed = openDispute(payment);
  if (disputed && booking.status !== "refunded" && booking.dodoDisputeActive !== true)
    return "dispute_not_applied";
  if (!disputed && booking.dodoDisputeActive === true) return "dispute_not_applied";
  if (!fullRefund && !disputed && !KEPT_BOOKING_STATUSES.includes(booking.status))
    return "payment_record_mismatch";
  if (disputed && !["pending", "refunded"].includes(booking.status)) return "dispute_not_applied";
  const referralCode =
    booking.referralCode == null
      ? ""
      : typeof booking.referralCode === "string"
        ? booking.referralCode.toLowerCase()
        : null;
  const referralId =
    booking.referral == null
      ? ""
      : typeof booking.referral._ref === "string"
        ? booking.referral._ref
        : null;
  if (referralCode !== pricing.referralCode || referralId !== pricing.referralId)
    return "referral_binding_mismatch";
  const commission = moneyCents(booking.commissionAmount);
  const hasOriginalCommission = Object.hasOwn(booking, "dodoOriginalCommissionAmount");
  const usesEarningsFallback =
    !hasOriginalCommission &&
    KEPT_BOOKING_STATUSES.includes(booking.status) &&
    commission === 0 &&
    pricing.percent > 0 &&
    (booking.netAmount || booking.grossAmount) > 0;
  const expected =
    disputed || fullRefund || !KEPT_BOOKING_STATUSES.includes(booking.status)
      ? 0
      : Math.round(pricing.commission * (1 - refunded / payment.total_amount));
  if (commission !== null && commission > expected) return "commission_exceeds_kept_share";
  if (
    commission === null ||
    commission !== expected ||
    booking.commissionPercent !== pricing.percent ||
    (refunded > 0 && !fullRefund && !hasOriginalCommission) ||
    usesEarningsFallback ||
    (hasOriginalCommission &&
      moneyCents(booking.dodoOriginalCommissionAmount) !== pricing.commission)
  )
    return "commission_mismatch";
  return "";
};

export const buildReconcileReport = async ({
  client = createCommerceReadClient(),
  dodo = createDodoClient(),
  now = Date.now(),
} = {}) => {
  const from = new Date(now - WINDOW_HOURS * 3600 * 1000).toISOString();
  const to = new Date(now - SETTLE_MINUTES * 60 * 1000).toISOString();
  const items = [];
  const reported = new Set();
  const report = (entry) => {
    const item = toItem(entry);
    const key = JSON.stringify([item.id, item.ref, item.reason]);
    if (reported.has(key)) return;
    reported.add(key);
    items.push(item);
  };
  const paymentCache = new Map();
  const getPayment = async (id, allowMissing = false) => {
    if (paymentCache.has(id)) return paymentCache.get(id);
    const payment = await retrievePayment(dodo, id, allowMissing);
    if (payment) paymentCache.set(id, payment);
    return payment;
  };

  const { payments: listed, truncated } = await listDodoPayments({
    dodo,
    from,
    to,
  });
  if (truncated) report({ id: "dodo-payments", reason: "report_truncated" });

  const productIds = readSiteProductIds();
  const payments = [];
  for (const summary of listed) {
    if (summary?.status && summary.status !== "succeeded") continue;
    const payment = await getPayment(summary.payment_id);
    if (summary.status === "succeeded" && payment.status !== "succeeded") throw unavailable();
    if (!String(payment.metadata?.paymentRecordId || "").trim() && productIds.size === 0)
      throw unavailable();
    if (payment?.status === "succeeded" && belongsToSite(payment, productIds))
      payments.push(payment);
  }

  const records = await fetchByIds(
    client,
    "paymentRecord",
    payments.map((payment) => String(payment.metadata?.paymentRecordId || "").trim()),
  );
  const bookings = await fetchByIds(
    client,
    "booking",
    [...records.values()].filter(Boolean).map((record) => String(record.bookingId || "").trim()),
  );
  const checkedBookingIds = new Set();
  const getDocument = async (type, id, cache) => {
    if (!id) return null;
    if (!cache.has(id)) {
      const found = await fetchByIds(client, type, [id]);
      cache.set(id, found.get(id) || null);
    }
    return cache.get(id);
  };

  const auditPayment = async (payment, suppliedBooking = null) => {
    const base = {
      id: payment.payment_id,
      cents: payment.total_amount,
      currency: payment.currency,
    };
    const recordId = String(payment.metadata?.paymentRecordId || "").trim();
    const record = await getDocument("paymentRecord", recordId, records);
    if (!record || record.provider !== "dodo") {
      report({
        ...base,
        ref: suppliedBooking?._id || record?._id || "",
        reason: "payment_without_record",
      });
      return;
    }
    if (suppliedBooking && String(record.bookingId || "").trim() !== suppliedBooking._id) {
      report({ ...base, ref: suppliedBooking._id, reason: "payment_record_mismatch" });
      return;
    }
    if (
      record.providerRecoveryTerminal === true &&
      String(record.status).toLowerCase() === "needs_recovery"
    ) {
      report({ ...base, ref: record._id, reason: ownerReviewReason(record) });
      return;
    }
    const pricing = frozenPricing(record);
    if (!pricing) {
      report({ ...base, ref: record._id, reason: "frozen_pricing_unavailable" });
      return;
    }
    const validation = validateDodoPayment({
      record,
      payment,
    });
    if (!validation.ok) {
      report({ ...base, ref: record._id, reason: validation.reason });
      return;
    }
    const booking =
      suppliedBooking ||
      (await getDocument("booking", String(record.bookingId || "").trim(), bookings));
    if (!booking) {
      report({ ...base, ref: record._id, reason: "payment_without_booking" });
      return;
    }
    const refunded = await refundedCents(dodo, payment);
    const reason = checkBooking({ payment, record, booking, refunded, pricing });
    checkedBookingIds.add(booking._id);
    if (reason) report({ ...base, ref: booking._id, reason });
  };
  for (const payment of payments) await auditPayment(payment);

  const dodoBookings = await readDocuments(client, "booking", {
    filters: [
      { path: "paymentProvider", op: "eq", value: "dodo" },
      { path: "status", op: "in", value: KEPT_BOOKING_STATUSES },
      { path: "_createdAt", op: "gte", value: from },
      { path: "_createdAt", op: "lte", value: to },
    ],
    limit: MAX_BOOKING_LOOKUPS + 1,
  });
  if (!Array.isArray(dodoBookings)) throw unavailable();
  if (dodoBookings.length > MAX_BOOKING_LOOKUPS)
    report({ id: "dodo-bookings", reason: "report_truncated" });
  for (const booking of dodoBookings.slice(0, MAX_BOOKING_LOOKUPS)) {
    if (
      booking.paymentProvider !== "dodo" ||
      !KEPT_BOOKING_STATUSES.includes(booking.status) ||
      !inWindow(booking._createdAt, from, to)
    )
      continue;
    if (checkedBookingIds.has(booking._id)) continue;
    const paymentId = String(booking.dodoPaymentId || "").trim();
    const payment = paymentId ? await getPayment(paymentId, true) : null;
    if (payment?.status !== "succeeded") {
      report({
        id: paymentId || "missing",
        ref: booking._id,
        cents: cents(booking.netAmount),
        currency: "USD",
        reason: "booking_without_payment",
      });
    } else await auditPayment(payment, booking);
  }

  const reportedRecords = new Set(items.map((item) => item.ref));
  const terminalRecords = await readDocuments(client, "paymentRecord", {
    filters: [
      { path: "provider", op: "eq", value: "dodo" },
      { path: "providerRecoveryTerminal", op: "eq", value: true },
      { path: "status", op: "ieq", value: "needs_recovery" },
      { path: "updatedAt", op: "gte", value: from },
      { path: "updatedAt", op: "lte", value: new Date(now).toISOString() },
    ],
    limit: MAX_BOOKING_LOOKUPS + 1,
  });
  if (!Array.isArray(terminalRecords)) throw unavailable();
  if (terminalRecords.length > MAX_BOOKING_LOOKUPS)
    report({ id: "dodo-records", reason: "report_truncated" });
  for (const record of terminalRecords.slice(0, MAX_BOOKING_LOOKUPS)) {
    if (
      record.provider !== "dodo" ||
      record.providerRecoveryTerminal !== true ||
      String(record.status).toLowerCase() !== "needs_recovery" ||
      !inWindow(record.updatedAt, from, new Date(now).toISOString())
    )
      continue;
    if (reportedRecords.has(record._id)) continue;
    report({
      id: record.providerPaymentId || record._id,
      ref: record._id,
      cents: cents(record.pricingSnapshot?.netAmount),
      currency: "USD",
      reason: ownerReviewReason(record),
    });
  }

  return {
    at: new Date(now).toISOString(),
    from,
    to,
    count: items.length,
    items: items.slice(0, MAX_ITEMS),
  };
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  const denied = authorizeReportRequest(req);
  if (denied)
    return res
      .status(denied)
      .json({ ok: false, error: denied === 404 ? "Not found" : "Forbidden" });
  try {
    return res.status(200).json({ ok: true, ...(await buildReconcileReport()) });
  } catch {
    return res.status(503).json({
      ok: false,
      error: "Reconciliation is temporarily unavailable.",
      code: "reconcile_report_unavailable",
    });
  }
}
