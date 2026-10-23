import crypto from "node:crypto";
import { createCommerceReadClient } from "../ref/documentStore.js";
import { createDodoClient, validateDodoPayment } from "./dodoProvider.js";
import { fetchShadowDocuments } from "../../supabase/shadowStore.js";
import { reportPaymentMismatches } from "../../../lib/monitoring/commerce.js";

const WINDOW_HOURS = 72;
const SETTLE_MINUTES = 30;
const PAGE_SIZE = 100;
const PAYMENT_LOOKUP_CONCURRENCY = 8;
const REPORT_BUDGET_MS = 240000;
const MAX_PAGES = 20;
const MAX_ITEMS = 50;
const MAX_BOOKING_LOOKUPS = 200;
const MAX_CHECKS = 20;
const MAX_CHECK_QUERY_LENGTH = 2048;
const KEPT_BOOKING_STATUSES = ["captured", "completed"];
const AUDITED_BOOKING_STATUSES = [...KEPT_BOOKING_STATUSES, "refunded"];
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
  "upgrade_credit_changed_after_quote",
]);

const unavailable = () => new Error("reconcile_report_unavailable");
const checkBudget = (deadline) => {
  if (Date.now() >= deadline)
    throw Object.assign(unavailable(), { code: "reconcile_report_budget_exceeded" });
};
const checksInvalid = () => new Error("reconcile_report_checks_invalid");
const isIdentity = (value) =>
  typeof value === "string" && value.match(/^[A-Za-z0-9_.:/-]{1,80}$/)?.[0] === value;
const entityKey = (type, id) =>
  isIdentity(id) ? `${type}:${id}` : "scan:identity-invalid";
const validChecks = (checks, allowEmpty = true) =>
  Array.isArray(checks) &&
  (allowEmpty || checks.length > 0) &&
  checks.length <= MAX_CHECKS &&
  new Set(checks).size === checks.length &&
  checks.every((key) => {
    if (typeof key !== "string") return false;
    const separator = key.indexOf(":");
    return (
      separator > 0 &&
      ["payment", "booking", "record"].includes(key.slice(0, separator)) &&
      isIdentity(key.slice(separator + 1))
    );
  });
const parseChecks = (value) => {
  if (typeof value !== "string" || value.length > MAX_CHECK_QUERY_LENGTH) throw checksInvalid();
  let checks;
  try {
    checks = JSON.parse(value);
  } catch {
    throw checksInvalid();
  }
  if (!validChecks(checks, false)) throw checksInvalid();
  return checks;
};
const ownerReviewReason = (record) => {
  const code = record.providerRecoveryTerminalReason || record.recoveryReason;
  return `owner_review_${OWNER_REVIEW_CODES.has(code) ? code : "unknown"}`;
};
const isTerminalRecovery = (record) =>
  String(record.status).toLowerCase() === "needs_recovery" &&
  (record.providerRecoveryTerminal === true || record.reconciliationRecoveryTerminal === true);

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

const toItem = ({ key, id, ref = "", cents = null, currency = "", reason }) => ({
  key,
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

const listDodoPayments = async ({ dodo, to, deadline }) => {
  const payments = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    checkBudget(deadline);
    const response = await dodo.payments
      .list({
        status: "succeeded",
        created_at_lte: to,
        page_size: PAGE_SIZE,
        page_number: page,
      }, { signal: AbortSignal.timeout(8000) })
      .asResponse();
    const result = await response.json();
    checkBudget(deadline);
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

const readDocuments = async (client, type, options, deadline) => {
  checkBudget(deadline);
  if (!client.shadowClient) throw unavailable();
  const documents = await fetchShadowDocuments({
    client: client.shadowClient,
    documentTypes: [type],
    allowLegacyFallback: false,
    ...options,
  });
  checkBudget(deadline);
  return documents;
};

const fetchByIds = async (client, type, ids, deadline) => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const docs = [];
  for (let offset = 0; offset < unique.length; offset += PAGE_SIZE) {
    const batch = await readDocuments(client, type, {
      ids: unique.slice(offset, offset + PAGE_SIZE),
      limit: PAGE_SIZE,
    }, deadline);
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

const retrievePayment = async (dodo, paymentId, allowMissing, deadline) => {
  checkBudget(deadline);
  let payment;
  try {
    payment = await dodo.payments.retrieve(paymentId, { signal: AbortSignal.timeout(8000) });
  } catch (error) {
    checkBudget(deadline);
    if (allowMissing && error?.status === 404) return null;
    throw error;
  }
  checkBudget(deadline);
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

const paymentReadyForAudit = (payment, now) => {
  const observedAt = Math.max(now, Date.now());
  const updates = [
    payment.updated_at,
    ...payment.refunds.map((refund) => refund?.created_at),
    ...payment.disputes.map((dispute) => dispute?.created_at),
  ].filter((value) => value != null);
  const timestamps = [payment.created_at, ...updates].map((value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
      throw unavailable();
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp > observedAt + 60000) throw unavailable();
    return timestamp;
  });
  return Math.max(...timestamps) <= now - SETTLE_MINUTES * 60 * 1000;
};

const refundedCents = async (dodo, payment, deadline) => {
  let amount = 0;
  const seen = new Set();
  for (const summary of payment.refunds) {
    checkBudget(deadline);
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
        ? await dodo.refunds.retrieve(summary.refund_id, { signal: AbortSignal.timeout(8000) })
        : summary;
    checkBudget(deadline);
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
    (refunded > 0 && booking.refundCurrency != null && booking.refundCurrency !== payment.currency) ||
    record.refundRequiresBookingSync === true ||
    (refunded > 0 && (
      record.refundProcessedAmountInSubunits !== refunded ||
      record.refundCurrency !== payment.currency ||
      record.refundState !== (fullRefund ? "full" : "partial") ||
      record.refundRequiresBookingSync !== false ||
      (record.status === "refunded") !== fullRefund
    )) ||
    (refunded === 0 && (
      ["full", "partial"].includes(record.refundState) ||
      (record.refundProcessedAmountInSubunits != null && record.refundProcessedAmountInSubunits !== 0)
    ))
  )
    return "refund_not_applied";
  const disputed = openDispute(payment);
  const cancelledDuringDispute = booking.status === "cancelled" && payment.disputes.length > 0;
  if (disputed && booking.status !== "refunded" && booking.dodoDisputeActive !== true)
    return "dispute_not_applied";
  if (!disputed && booking.dodoDisputeActive === true) return "dispute_not_applied";
  if (!fullRefund && !disputed && !cancelledDuringDispute && !KEPT_BOOKING_STATUSES.includes(booking.status))
    return "payment_record_mismatch";
  if (disputed && !cancelledDuringDispute && !["pending", "refunded"].includes(booking.status)) return "dispute_not_applied";
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
  const payableCommission = fullRefund || (cancelledDuringDispute && !disputed) ? 0 : commission;
  if (payableCommission !== null && payableCommission > expected) return "commission_exceeds_kept_share";
  if (
    commission === null ||
    payableCommission !== expected ||
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
  checks = [],
} = {}) => {
  if (!validChecks(checks)) throw checksInvalid();
  const deadline = Date.now() + REPORT_BUDGET_MS;
  const from = new Date(now - WINDOW_HOURS * 3600 * 1000).toISOString();
  const to = new Date(now - SETTLE_MINUTES * 60 * 1000).toISOString();
  const items = [];
  const reported = new Set();
  const report = (entry) => {
    const item = toItem(entry);
    const key = JSON.stringify([item.key, item.id, item.ref, item.reason]);
    if (!reported.has(key)) {
      reported.add(key);
      items.push(item);
    }
    return item;
  };
  const unresolved = (entry) => {
    const item = report(entry);
    return { state: "unresolved", keys: [item.key], items: [item] };
  };
  const unknown = () => ({ state: "unknown", keys: [], items: [] });
  const response = (results, complete) => ({
    at: new Date(now).toISOString(),
    from,
    to,
    mode: checks.length ? "checks" : "window",
    checks: results,
    complete: { ...complete, items: items.length <= MAX_ITEMS },
    count: items.length,
    items: items.slice(0, MAX_ITEMS),
  });
  const recentRefs = new Set();
  const finishWindow = (complete) => {
    const priority = (item) =>
      item.key.startsWith("scan:") ? 0 : recentRefs.has(item.ref) ? 1 : 2;
    items.sort((left, right) => priority(left) - priority(right));
    return response([], complete);
  };
  const terminalReview = (record) => unresolved({
    key: entityKey("record", record._id),
    id: record.providerPaymentId || record._id,
    ref: record._id,
    cents: cents(record.pricingSnapshot?.netAmount),
    currency: "USD",
    reason: ownerReviewReason(record),
  });
  const paymentCache = new Map();
  const getPayment = async (id, allowMissing = false) => {
    if (!paymentCache.has(id)) paymentCache.set(id, retrievePayment(dodo, id, allowMissing, deadline));
    return paymentCache.get(id);
  };
  const records = new Map();
  const bookings = new Map();
  const checkedBookingIds = new Set();
  const getDocument = async (type, id, cache) => {
    if (!id) return null;
    if (!cache.has(id)) {
      const found = await fetchByIds(client, type, [id], deadline);
      cache.set(id, found.get(id) || null);
    }
    return cache.get(id);
  };
  const audits = new Map();
  const auditPayment = async (payment, suppliedBooking = null) => {
    checkBudget(deadline);
    const recordId = String(payment.metadata?.paymentRecordId || "").trim();
    const record = await getDocument("paymentRecord", recordId, records);
    const bookingId = String(record?.bookingId || "").trim();
    const key =
      suppliedBooking &&
      (!record || record.provider !== "dodo" || bookingId !== suppliedBooking._id)
        ? entityKey("booking", suppliedBooking._id)
        : entityKey("payment", payment.payment_id);
    const auditKey = JSON.stringify([payment.payment_id, suppliedBooking?._id || bookingId, key]);
    if (audits.has(auditKey)) return audits.get(auditKey);
    const finish = (outcome) => {
      audits.set(auditKey, outcome);
      return outcome;
    };
    const base = {
      key,
      id: payment.payment_id,
      cents: payment.total_amount,
      currency: payment.currency,
    };
    const mismatch = (ref, reason) => finish(unresolved({ ...base, ref, reason }));
    const terminal = record && isTerminalRecovery(record);
    if (!terminal && !paymentReadyForAudit(payment, now))
      return finish(unknown());
    if (!record || record.provider !== "dodo") {
      return mismatch(suppliedBooking?._id || record?._id || "", "payment_without_record");
    }
    if (suppliedBooking && bookingId !== suppliedBooking._id) {
      return mismatch(suppliedBooking._id, "payment_record_mismatch");
    }
    if (terminal) {
      return finish(terminalReview(record));
    }
    const pricing = frozenPricing(record);
    if (!pricing) {
      return mismatch(record._id, "frozen_pricing_unavailable");
    }
    const validation = validateDodoPayment({
      record,
      payment,
    });
    if (!validation.ok) {
      return mismatch(record._id, validation.reason);
    }
    const booking =
      suppliedBooking ||
      (await getDocument("booking", bookingId, bookings));
    const refunded = await refundedCents(dodo, payment, deadline);
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
    if (!booking) {
      if (
        bookingId ||
        refunded !== payment.total_amount ||
        record.status !== "refunded" ||
        record.refundState !== "full" ||
        record.refundProcessedAmountInSubunits !== refunded ||
        record.refundCurrency !== payment.currency ||
        record.refundRequiresBookingSync !== false ||
        record.resourceReleasePending === true ||
        record.providerRecoveryTerminal === true ||
        record.reconciliationRecoveryTerminal === true ||
        record.recoveryReason ||
        record.refundBookingSync?.bookingId !== "" ||
        record.refundBookingSync?.releasedUnbookedPaymentResources !== true
      )
        return mismatch(record._id, "payment_without_booking");
    } else {
      const reason = checkBooking({ payment, record, booking, refunded, pricing });
      checkedBookingIds.add(booking._id);
      if (reason) return mismatch(booking._id, reason);
    }
    const keys = [
      entityKey("payment", payment.payment_id),
      entityKey("record", record._id),
      ...(booking ? [entityKey("booking", booking._id)] : []),
    ];
    if (keys.includes("scan:identity-invalid"))
      return finish(unresolved({
        ...base,
        key: "scan:identity-invalid",
        id: isIdentity(payment.payment_id) ? payment.payment_id : "identity-invalid",
        ref: "",
        reason: "report_identity_invalid",
      }));
    return finish({
      state: "recovered",
      keys: [...new Set(keys)],
      items: [],
    });
  };
  const bookingWithoutPayment = (booking, paymentId) =>
    unresolved({
      key: entityKey("booking", booking._id),
      id: paymentId || "missing",
      ref: booking._id,
      cents: cents(booking.netAmount),
      currency: "USD",
      reason: "booking_without_payment",
    });
  const auditCheck = async (key) => {
    const separator = key.indexOf(":");
    const type = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if (type === "payment") {
      const payment = await getPayment(id, true);
      if (payment?.status !== "succeeded")
        return unresolved({
          key,
          id,
          cents: payment?.total_amount,
          currency: payment?.currency,
          reason: payment ? "payment_not_succeeded" : "payment_not_found",
        });
      return auditPayment(payment);
    }
    if (type === "booking") {
      const booking = await getDocument("booking", id, bookings);
      if (!booking || booking.paymentProvider !== "dodo") return unknown();
      const paymentId = isIdentity(booking.dodoPaymentId) ? booking.dodoPaymentId : "";
      const payment = paymentId ? await getPayment(paymentId, true) : null;
      return payment?.status === "succeeded"
        ? auditPayment(payment, booking)
        : bookingWithoutPayment(booking, paymentId);
    }
    const record = await getDocument("paymentRecord", id, records);
    if (!record || record.provider !== "dodo") return unknown();
    const base = {
      key,
      id: record.providerPaymentId || record._id,
      ref: record._id,
      cents: cents(record.pricingSnapshot?.netAmount),
      currency: "USD",
    };
    if (isTerminalRecovery(record))
      return terminalReview(record);
    let paymentId = record.providerPaymentId;
    if (paymentId != null && paymentId !== "" && !isIdentity(paymentId)) return unknown();
    if (!paymentId) {
      if (!isIdentity(record.bookingId)) return unknown();
      const booking = await getDocument("booking", record.bookingId, bookings);
      if (booking?.paymentRecordId !== record._id || !isIdentity(booking?.dodoPaymentId))
        return unknown();
      paymentId = booking.dodoPaymentId;
    }
    const payment = await getPayment(paymentId, true);
    if (payment?.status !== "succeeded")
      return unresolved({
        ...base,
        id: paymentId,
        reason: payment ? "payment_not_succeeded" : "payment_not_found",
      });
    if (payment.metadata.paymentRecordId !== record._id)
      return unresolved({ ...base, id: paymentId, reason: "payment_record_mismatch" });
    return auditPayment(payment);
  };
  try {
    if (checks.length) {
      const results = [];
      for (const key of checks) {
        const outcome = await auditCheck(key);
        results.push({ key, ...outcome, keys: [...new Set([key, ...outcome.keys])] });
      }
      return response(results, { payments: false, bookings: false, records: false });
    }

    const terminalGroups = await Promise.all(
      ["providerRecoveryTerminal", "reconciliationRecoveryTerminal"].map((flag) =>
        readDocuments(client, "paymentRecord", {
          filters: [
            { path: "provider", op: "eq", value: "dodo" },
            { path: flag, op: "eq", value: true },
            { path: "status", op: "ieq", value: "needs_recovery" },
            { path: "updatedAt", op: "gte", value: from },
            { path: "updatedAt", op: "lte", value: new Date(now).toISOString() },
          ],
          limit: MAX_BOOKING_LOOKUPS + 1,
        }, deadline),
      ),
    );
    if (terminalGroups.some((group) => !Array.isArray(group))) throw unavailable();
    const terminalRecords = [...new Map(terminalGroups.flat().map((record) => [record._id, record])).values()];
    const recordCap = terminalRecords.length > MAX_BOOKING_LOOKUPS;
    if (recordCap)
      report({ key: "scan:dodo-records", id: "dodo-records", reason: "report_truncated" });
    for (const record of terminalRecords.slice(0, MAX_BOOKING_LOOKUPS)) {
      if (
        record.provider !== "dodo" ||
        !isTerminalRecovery(record) ||
        !inWindow(record.updatedAt, from, new Date(now).toISOString())
      )
        continue;
      recentRefs.add(record._id);
      terminalReview(record);
    }

    const { payments: listed, truncated } = await listDodoPayments({ dodo, to, deadline });
    if (truncated)
      report({ key: "scan:dodo-payments", id: "dodo-payments", reason: "report_truncated" });
    const productIds = readSiteProductIds();
    const payments = [];
    for (let offset = 0; offset < listed.length; offset += PAYMENT_LOOKUP_CONCURRENCY) {
      const batch = await Promise.all(listed.slice(offset, offset + PAYMENT_LOOKUP_CONCURRENCY).map(async (summary) => {
        if (summary?.status && summary.status !== "succeeded") return null;
        const payment = await getPayment(summary.payment_id);
        if (summary.status === "succeeded" && payment.status !== "succeeded") throw unavailable();
        if (!String(payment.metadata?.paymentRecordId || "").trim() && productIds.size === 0)
          throw unavailable();
        return payment?.status === "succeeded" && belongsToSite(payment, productIds) ? payment : null;
      }));
      payments.push(...batch.filter(Boolean));
    }
    for (const [id, record] of await fetchByIds(
      client,
      "paymentRecord",
      payments.map((payment) => String(payment.metadata?.paymentRecordId || "").trim()),
      deadline,
    ))
      records.set(id, record);
    for (const [id, booking] of await fetchByIds(
      client,
      "booking",
      [...records.values()].filter(Boolean).map((record) => String(record.bookingId || "").trim()),
      deadline,
    ))
      bookings.set(id, booking);
    for (const payment of payments) await auditPayment(payment);

    const dodoBookings = await readDocuments(client, "booking", {
      filters: [
        { path: "paymentProvider", op: "eq", value: "dodo" },
        { path: "status", op: "in", value: AUDITED_BOOKING_STATUSES },
        { path: "_createdAt", op: "gte", value: from },
        { path: "_createdAt", op: "lte", value: to },
      ],
      limit: MAX_BOOKING_LOOKUPS + 1,
    }, deadline);
    if (!Array.isArray(dodoBookings)) throw unavailable();
    const bookingCap = dodoBookings.length > MAX_BOOKING_LOOKUPS;
    if (bookingCap)
      report({ key: "scan:dodo-bookings", id: "dodo-bookings", reason: "report_truncated" });
    for (const booking of dodoBookings.slice(0, MAX_BOOKING_LOOKUPS)) {
      if (
        booking.paymentProvider !== "dodo" ||
        !AUDITED_BOOKING_STATUSES.includes(booking.status) ||
        !inWindow(booking._createdAt, from, to)
      )
        continue;
      recentRefs.add(booking._id);
      if (checkedBookingIds.has(booking._id)) continue;
      const paymentId = String(booking.dodoPaymentId || "").trim();
      const payment = paymentId ? await getPayment(paymentId, true) : null;
      if (payment?.status !== "succeeded") {
        bookingWithoutPayment(booking, paymentId);
      } else await auditPayment(payment, booking);
    }

    return finishWindow({ payments: !truncated, bookings: !bookingCap, records: !recordCap });
  } catch (error) {
    if (error?.code !== "reconcile_report_budget_exceeded") throw error;
    if (checks.length) {
      items.length = 0;
      return response(checks.map((key) => ({ key, ...unknown(), keys: [key] })), {
        payments: false, bookings: false, records: false,
      });
    }
    report({ key: "scan:dodo-payments", id: "dodo-payments", reason: "report_truncated" });
    return finishWindow({ payments: false, bookings: false, records: false });
  }
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
  let checks = [];
  if (Object.hasOwn(req.query || {}, "check")) {
    try {
      checks = parseChecks(req.query.check);
    } catch {
      return res.status(400).json({
        ok: false,
        error: "Invalid reconciliation checks.",
        code: "reconcile_report_checks_invalid",
      });
    }
  }
  try {
    const report = await buildReconcileReport({ checks });
    await reportPaymentMismatches(report);
    return res.status(200).json({ ok: true, ...report });
  } catch {
    return res.status(503).json({
      ok: false,
      error: "Reconciliation is temporarily unavailable.",
      code: "reconcile_report_unavailable",
    });
  }
}
