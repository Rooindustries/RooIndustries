import crypto from "node:crypto";
import { createCommerceReadClient } from "../ref/documentStore.js";
import { createDodoClient, validateDodoPayment } from "./dodoProvider.js";

const WINDOW_HOURS = 72;
const SETTLE_MINUTES = 30;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const MAX_ITEMS = 50;
const KEPT_BOOKING_STATUSES = ["captured", "completed"];
const SETTLED_DISPUTE_STATUSES = ["dispute_won", "dispute_cancelled"];

const readBearer = (req) => {
  const header = req?.headers?.authorization || req?.headers?.Authorization || "";
  const match = String(header).trim().match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : "";
};

export const authorizeReportRequest = (req, env = process.env) => {
  const configured = String(env.RECONCILE_REPORT_TOKEN || "").trim();
  if (configured.length < 32) return 404;
  const provided = Buffer.from(readBearer(req));
  const expected = Buffer.from(configured);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return 403;
  return 0;
};

const keep = (value, pattern, max) => String(value ?? "").replace(pattern, "").slice(0, max);

const toItem = ({ id, ref = "", cents = null, currency = "", reason }) => ({
  id: keep(id, /[^A-Za-z0-9_.:/-]/g, 80),
  ref: keep(ref, /[^A-Za-z0-9_.:/-]/g, 80),
  amount: Number.isSafeInteger(cents) ? (cents / 100).toFixed(2) : "",
  currency: keep(currency, /[^A-Za-z]/g, 3).toUpperCase(),
  reason: keep(String(reason || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""), /[^a-z0-9_]/g, 60),
});

const listDodoPayments = async ({ dodo, from, to }) => {
  const payments = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await dodo.payments.list({ created_at_gte: from, created_at_lte: to, page_size: PAGE_SIZE, page_number: page });
    const items = Array.isArray(result?.items) ? result.items : [];
    payments.push(...items);
    if (items.length < PAGE_SIZE) return { payments, truncated: false };
  }
  return { payments, truncated: true };
};

const fetchByIds = async (client, type, ids) => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const docs = await client.fetch(`*[_type == $type && _id in $ids]{...}`, { type, ids: unique });
  return new Map((docs || []).map((doc) => [doc._id, doc]));
};

const cents = (value) => Math.round(Number(value || 0) * 100);

const openDispute = (payment) =>
  (payment.disputes || []).some((dispute) => !SETTLED_DISPUTE_STATUSES.includes(dispute?.dispute_status));

const checkBooking = ({ payment, record, booking }) => {
  if (cents(booking.netAmount) !== cents(record.pricingSnapshot?.netAmount)) return "amount_mismatch";
  if (payment.refund_status === "full" && booking.status !== "refunded") return "refund_not_applied";
  if (payment.refund_status === "partial" && !(Number(booking.refundedAmount) > 0)) return "refund_not_applied";
  const disputed = openDispute(payment);
  if (disputed && booking.status !== "refunded" && booking.dodoDisputeActive !== true) return "dispute_not_applied";
  if (KEPT_BOOKING_STATUSES.includes(booking.status) && Number(booking.commissionPercent) > 0) {
    const commission = Number(booking.commissionAmount || 0);
    const total = Number(booking.dodoTotalAmount || booking.netAmount || 0);
    const retained = total > 0 ? Math.max(0, 1 - Number(booking.refundedAmount || 0) / total) : 0;
    const ceiling = Number(booking.grossAmount || 0) * (Number(booking.commissionPercent) / 100) * retained;
    if (commission < 0 || commission > ceiling + 0.01 || (disputed && commission > 0)) return "commission_exceeds_kept_share";
  }
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
  const report = (entry) => items.push(toItem(entry));

  const { payments: listed, truncated } = await listDodoPayments({ dodo, from, to });
  if (truncated) report({ id: "dodo-payments", reason: "report_truncated" });

  const payments = [];
  for (const summary of listed) {
    if (summary?.status && summary.status !== "succeeded") continue;
    const payment = await dodo.payments.retrieve(summary.payment_id);
    if (payment?.status === "succeeded") payments.push(payment);
  }

  const records = await fetchByIds(client, "paymentRecord",
    payments.map((payment) => String(payment.metadata?.paymentRecordId || "").trim()));
  const bookings = await fetchByIds(client, "booking",
    [...records.values()].map((record) => String(record.bookingId || "").trim()));
  const seenPaymentIds = new Set();

  for (const payment of payments) {
    seenPaymentIds.add(payment.payment_id);
    const base = { id: payment.payment_id, cents: payment.total_amount, currency: payment.currency };
    const recordId = String(payment.metadata?.paymentRecordId || "").trim();
    const record = records.get(recordId);
    if (!record || record.provider !== "dodo") {
      report({ ...base, ref: recordId, reason: "payment_without_record" });
      continue;
    }
    if (record.providerRecoveryTerminal === true && String(record.status).toLowerCase() === "needs_recovery") {
      report({ ...base, ref: record._id, reason: `owner_review_${record.providerRecoveryTerminalReason || record.recoveryReason || "unknown"}` });
      continue;
    }
    const validation = validateDodoPayment({
      record: record.providerOrderId ? record : { ...record, providerOrderId: payment.checkout_session_id },
      payment,
    });
    if (!validation.ok) {
      report({ ...base, ref: record._id, reason: validation.reason });
      continue;
    }
    const booking = bookings.get(String(record.bookingId || "").trim());
    if (!booking) {
      if (String(record.status).toLowerCase() !== "refunded") report({ ...base, ref: record._id, reason: "payment_without_booking" });
      continue;
    }
    const reason = checkBooking({ payment, record, booking });
    if (reason) report({ ...base, ref: booking._id, reason });
  }

  const dodoBookings = await client.fetch(
    `*[_type == "booking" && paymentProvider == $provider && status in $statuses]{_id, _createdAt, dodoPaymentId, netAmount}`,
    { provider: "dodo", statuses: KEPT_BOOKING_STATUSES }
  );
  for (const booking of dodoBookings || []) {
    const createdAt = Date.parse(booking._createdAt || "");
    if (Number.isFinite(createdAt) && (createdAt < Date.parse(from) || createdAt > Date.parse(to))) continue;
    const paymentId = String(booking.dodoPaymentId || "").trim();
    if (paymentId && seenPaymentIds.has(paymentId)) continue;
    const payment = paymentId ? await dodo.payments.retrieve(paymentId) : null;
    if (payment?.status !== "succeeded") {
      report({ id: paymentId || "missing", ref: booking._id, cents: cents(booking.netAmount), currency: "USD", reason: "booking_without_payment" });
    }
  }

  const reportedRecords = new Set(items.map((item) => item.ref));
  const terminalRecords = await client.fetch(
    `*[_type == "paymentRecord" && provider == $provider && providerRecoveryTerminal == $terminal && lower(status) == $status]{_id, updatedAt, providerPaymentId, pricingSnapshot, providerRecoveryTerminalReason, recoveryReason}`,
    { provider: "dodo", terminal: true, status: "needs_recovery" }
  );
  for (const record of terminalRecords || []) {
    const updatedAt = Date.parse(record.updatedAt || "");
    if (!Number.isFinite(updatedAt) || updatedAt < Date.parse(from) || reportedRecords.has(record._id)) continue;
    report({
      id: record.providerPaymentId || record._id,
      ref: record._id,
      cents: cents(record.pricingSnapshot?.netAmount),
      currency: "USD",
      reason: `owner_review_${record.providerRecoveryTerminalReason || record.recoveryReason || "unknown"}`,
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
  if (denied) return res.status(denied).json({ ok: false, error: denied === 404 ? "Not found" : "Forbidden" });
  try {
    return res.status(200).json({ ok: true, ...(await buildReconcileReport()) });
  } catch (error) {
    return res.status(503).json({ ok: false, error: "Reconciliation is temporarily unavailable.", code: keep(error?.code, /[^a-z0-9_]/gi, 60) });
  }
}
