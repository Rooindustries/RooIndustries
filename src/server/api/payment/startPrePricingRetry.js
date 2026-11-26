import { verifyHoldToken } from "../../booking/holdToken.js";
import envValue from "../../supabase/envValue.cjs";
import { logSafeWarn } from "../../safeErrorLog.js";
import { getPaymentRecordById } from "./paymentRecord.js";
const { resolveStoreBackend } = envValue;
const num = (v) => Number(v || 0);
const str = (v) => String(v || "").trim();
const lower = (v) => str(v).toLowerCase();
export const buildQuotePayload = (q = {}) => {
  const isFree = lower(q.paymentProvider) === "free";
  return {
    grossAmount: num(q.effectiveGrossAmount), discountAmount: num(q.effectiveDiscountAmount),
    discountPercent: num(q.effectiveDiscountPercent), netAmount: isFree ? 0 : num(q.effectiveNetAmount),
    isFree, referralDiscountPercent: num(q.referralDiscountPercent),
    referralDiscountAmount: num(q.referralDiscountAmount), commissionPercent: num(q.effectiveCommissionPercent),
    couponDiscountPercent: num(q.couponDiscountPercent), couponDiscountAmount: num(q.couponDiscountAmount),
    couponDiscountType: str(q.couponDiscountType), couponDiscountValue: num(q.couponDiscountValue),
    canCombineWithReferral: q.canCombineWithReferral === true,
  };
};
export const buildQuotePayloadFromSnapshot = (record = {}) => {
  const s = record.pricingSnapshot && typeof record.pricingSnapshot === "object" ? record.pricingSnapshot : {};
  const isFree = lower(record.provider) === "free";
  return buildQuotePayload({
    ...s, effectiveGrossAmount: s.grossAmount, effectiveDiscountAmount: s.discountAmount,
    effectiveDiscountPercent: s.discountPercent, effectiveNetAmount: isFree ? 0 : s.netAmount,
    paymentProvider: isFree ? "free" : "paid", effectiveCommissionPercent: s.commissionPercent,
  });
};
const buildClaimedSession = (c, rec) => {
  const p = lower(rec?.provider), s = lower(rec?.status);
  if (!rec?._id || !p || p === "free" || ["failed", "abandoned", "refunded"].includes(s)) return null;
  const referralCode = str(rec.pricingSnapshot?.effectiveReferralCode || rec.bookingPayload?.referralCode);
  return {
    provider: p, status: s, paymentAccessToken: c.issuePaymentAccessTokenForRecord(rec),
    providerPayload: s === "started" ? c.buildProviderPayloadFromRecord(rec) : {},
    quote: buildQuotePayloadFromSnapshot(rec), quoteFingerprint: str(rec.quoteFingerprint),
    sessionExpiresAt: str(rec.sessionExpiresAt), refreshedHold: c.buildRefreshedHoldBody(rec),
    couponCode: str(rec.bookingPayload?.couponCode), referralCode,
  };
};
export const assertMatchingClaimedSession = (c) => {
  const { record, provider, quoteFingerprint } = c;
  const mismatch = lower(record?.provider) !== provider
    ? { code: "payment_provider_already_claimed", message: "This reservation already has a payment provider selected." }
    : record?.quoteFingerprint && String(record.quoteFingerprint) !== String(quoteFingerprint)
      ? { code: "payment_quote_already_claimed", message: "This reservation is already bound to a different quote." }
      : null;
  if (!mismatch) return;
  const error = Object.assign(new Error(mismatch.message), { status: 409, code: mismatch.code });
  const claimed = buildClaimedSession(c, record);
  if (claimed) error.claimedSession = claimed;
  throw error;
};
export const canRestoreUnpaidRecovery = (record, inspection = null) => {
  const payState = lower(record?.providerPaymentState || inspection?.payment?.status);
  return lower(record?.status) === "needs_recovery" && record?.resourceReleasePending !== true &&
    !str(record?.bookingId) && record?.requiresReschedule !== true &&
    record?.reconciliationRecoveryTerminal !== true && record?.providerRecoveryTerminal !== true &&
    record?.dodoDisputeActive !== true && !str(record?.providerPaymentId) &&
    !["failed", "cancelled"].includes(payState) && str(record?.providerOrderId) !== "";
};
export const resolveLiveAbandonedRefreshedHold = async ({ client, record }) => {
  if (!client || !record?._id) return null;
  const hasSnap = lower(record.status) === "abandoned" && Boolean(record.cancelledHoldSnapshot?.slotHoldToken);
  const fresh = hasSnap ? record : await getPaymentRecordById(client, record._id);
  const snap = fresh?.cancelledHoldSnapshot;
  const okSnap = lower(fresh?.status) === "abandoned" && snap?.slotHoldId && snap?.slotHoldToken &&
    Date.parse(snap.slotHoldExpiresAt) > Date.now();
  const hold = okSnap ? await client.fetch('*[_type == "slotHold" && _id == $id][0]', { id: snap.slotHoldId }) : null;
  const okHold = hold?._id && lower(hold.phase) === "holding" && !str(hold.paymentRecordId) &&
    Date.parse(hold.expiresAt) > Date.now();
  if (!okHold) return null;
  const valid = verifyHoldToken({
    token: snap.slotHoldToken, holdId: snap.slotHoldId, startTimeUTC: hold.startTimeUTC,
    holdNonce: hold.holdNonce || "", backend: resolveStoreBackend(hold.backendOwner || fresh.backendOwner),
    cutoverGeneration: num(hold.cutoverGeneration),
  });
  return valid ? snap : null;
};
const completeOrUnavailable = async (run) => {
  try { return await run(); } catch (error) {
    logSafeWarn("Payment status hold lookup unavailable", error);
    return { httpStatus: 503, body: { ok: false, error: "Payment status is temporarily unavailable." } };
  }
};
const completePublicBody = (c) => c.buildBrowserCompletionBody({
  client: c.client, record: c.record, body: c.buildPublicStatusBody(c.record),
});
export const runBrowserCompletion = (ctx) => completeOrUnavailable(async () => {
  const completed = await ctx.buildBrowserCompletionBody(ctx);
  return ctx.result ? { ...ctx.result, body: completed } : { httpStatus: ctx.httpStatus ?? 200, body: completed };
});
export const buildAbandonedCancelResponse = (ctx) => completeOrUnavailable(async () => {
  const body = await completePublicBody(ctx);
  const released = !body.refreshedHold && ctx.record?.bookingPayload?.slotHoldId &&
    ctx.record?.resourceReleasePending !== true ? { slotReleased: true } : {};
  return { httpStatus: 200, body: { ...body, ok: true, cancelled: true, ...released } };
});
export const buildPaymentStatusResponse = (ctx) => {
  const base = ctx.buildPublicStatusBody(ctx.record);
  const body = lower(ctx.record?.status) === "started" && str(ctx.record?.providerOrderId)
    ? { ...base, providerPayload: ctx.buildProviderPayloadFromRecord(ctx.record) } : base;
  return runBrowserCompletion({ ...ctx, body });
};
export const buildNotPayableStartResponse = async (ctx) => {
  const claimed = lower(ctx.record?.status) === "needs_recovery" ? buildClaimedSession(ctx, ctx.record) : null;
  return {
    httpStatus: 409,
    body: {
      ...await completePublicBody(ctx), ok: false, code: "payment_session_not_payable",
      error: ctx.getPublicRecoveryMessage(ctx.record) || "This payment session cannot be resumed right now.",
      ...(claimed ? { claimedSession: claimed } : {}),
    },
  };
};
export const tryPrePricingRetryStart = async (ctx) => {
  const { client, existing, scope, submittedQuoteFingerprint: fp, requestedProvider: reqProvider } = ctx;
  const { bookingPayload, hold, finalizePaymentRecordInternal: finalize } = ctx;
  const matches = existing?._id && fp && String(existing.sessionScope || "") === scope &&
    str(existing.quoteFingerprint) === fp;
  if (!matches) return null;
  let rec = existing;
  const status = lower(rec.status), provider = lower(rec.provider);
  const providerOk = provider === "free" ? !reqProvider || reqProvider === "free" : reqProvider === provider;
  if (!providerOk || !["started", "booked", "email_partial"].includes(status)) return null;
  const enabled = provider === "paypal"
    ? Boolean(ctx.providers?.paypal?.enabled && ctx.providers?.paypal?.clientId)
    : Boolean(ctx.providers?.[provider]?.enabled);
  if (status === "started" && provider !== "free" && !enabled) return null;
  if (!bookingPayload.originalOrderId) {
    const valid = Boolean(hold && bookingPayload.slotHoldToken && verifyHoldToken({
      token: bookingPayload.slotHoldToken, holdId: bookingPayload.slotHoldId,
      startTimeUTC: hold.startTimeUTC || bookingPayload.startTimeUTC, holdNonce: hold.holdNonce || "",
      backend: resolveStoreBackend(hold.backendOwner || rec.backendOwner),
      cutoverGeneration: num(hold.cutoverGeneration), ignoreExpiry: true,
    }));
    if (!valid) return null;
    await ctx.assertStartableHold({ client, bookingPayload });
    rec = await getPaymentRecordById(client, existing._id);
    if (!rec || lower(rec.status) !== status) return null;
  }
  const shared = {
    provider, quote: buildQuotePayloadFromSnapshot(rec), quoteFingerprint: fp,
    sessionExpiresAt: str(rec.sessionExpiresAt), refreshedHold: ctx.buildRefreshedHoldBody(rec),
  };
  if (status === "started" && provider === "free") {
    const fin = await finalize({ client, record: rec, source: "start", providerData: {} });
    const body = await ctx.buildBrowserCompletionBody({ client, record: rec, body: fin.response });
    return { httpStatus: fin.httpStatus, body: { ...body, ...shared, paymentAccessToken: "" } };
  }
  if (status === "started" && !str(rec.providerOrderId)) {
    const error = "This payment session is already creating its provider order.";
    return { httpStatus: 409, body: { ok: false, code: "provider_order_creation_in_progress", error } };
  }
  const paymentAccessToken = provider === "free" ? "" : ctx.issuePaymentAccessTokenForRecord(rec);
  if (status === "started") {
    const providerPayload = ctx.buildProviderPayloadFromRecord(rec);
    const body = { ok: true, status: rec.status, checkoutCreated: false, providerPayload, paymentAccessToken };
    return { httpStatus: 200, body: { ...body, ...shared } };
  }
  const body = await completePublicBody({ ...ctx, record: rec });
  return { httpStatus: 200, body: { ...body, providerPayload: {}, paymentAccessToken, ...shared } };
};
