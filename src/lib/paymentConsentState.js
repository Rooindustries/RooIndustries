import { removeBrowserStorage } from "./browserStorage";
import { normalizeCurrencyCode, toMoney } from "./checkoutCodes";
import { areSameLineageScopeKeys, mergeLineageCheckout, syncHistoryCheckoutBooking } from "./checkoutSessionGuard";
import { clearBookingConfirmation, createBookingConfirmation } from "./confirmationReceipt";
import { markReservationTerminal } from "./reservationScope";

const parseFiniteMoney = (value) => {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }
  return null;
};

const explicitCurrency = (value) => {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? normalizeCurrencyCode(code) : "";
};

export const buildConfirmedQuoteBreakdown = (
  quote,
  { referralCode = "", couponCode = "", referral = null, coupon = null } = {}
) => {
  if (!quote || typeof quote !== "object") return null;
  const currency = normalizeCurrencyCode(quote.currency || "USD");
  const grossAmount = Math.max(0, toMoney(quote.grossAmount ?? quote.netAmount ?? 0, currency));
  const netAmount = quote.isFree === true ? 0 : Math.max(0, toMoney(quote.netAmount ?? 0, currency));
  const couponDiscountAmount = Math.max(0, toMoney(quote.couponDiscountAmount ?? 0, currency));
  const couponDiscountPercent = Math.max(0, Number(quote.couponDiscountPercent ?? coupon?.discountPercent ?? 0) || 0);
  const rawType = String(quote.couponDiscountType || coupon?.discountType || "").trim().toLowerCase();
  const couponDiscountType = rawType === "fixed" || rawType === "percent" ? rawType : couponDiscountPercent > 0 ? "percent" : "fixed";
  return {
    currency,
    grossAmount,
    netAmount,
    referralCode: String(quote.effectiveReferralCode ?? quote.referralCode ?? referralCode ?? "").trim(),
    referralDiscountAmount: Math.max(0, toMoney(quote.referralDiscountAmount ?? 0, currency)),
    referralDiscountPercent: Math.max(0, Number(quote.referralDiscountPercent ?? referral?.currentDiscountPercent ?? 0) || 0),
    couponCode: String(quote.couponCode ?? couponCode ?? "").trim(),
    couponDiscountAmount,
    couponDiscountType,
    couponDiscountPercent,
    couponFixedAmount: coupon?.discountType === "fixed"
      ? Math.max(0, toMoney(coupon.discountAmount || 0, currency))
      : couponDiscountType === "fixed"
        ? couponDiscountAmount
        : 0,
  };
};

export const resolveInitialConsentBaseline = (bookingData = {}) => {
  if (!bookingData || typeof bookingData !== "object") {
    return { expectedClientTotal: null, expectedClientCurrency: "", acceptedQuoteTotal: null, acceptedQuoteCurrency: "", acceptedServerQuoteBreakdown: null };
  }
  const rawExpected = parseFiniteMoney(bookingData.expectedClientTotal);
  const rawAccepted = parseFiniteMoney(bookingData.acceptedQuoteTotal);
  const expCur = explicitCurrency(bookingData.expectedClientCurrency);
  const accCur = explicitCurrency(bookingData.acceptedQuoteCurrency);
  if (bookingData.originalOrderId && rawAccepted === null && rawExpected === null && bookingData.packagePrice) {
    const legacyCur = accCur || expCur || "USD";
    const legacyAmt = Math.max(0, toMoney(bookingData.packagePrice, legacyCur));
    return { expectedClientTotal: legacyAmt, expectedClientCurrency: legacyCur, acceptedQuoteTotal: legacyAmt, acceptedQuoteCurrency: legacyCur, acceptedServerQuoteBreakdown: null };
  }
  const expectedCur = expCur || accCur || (rawExpected !== null ? "USD" : "");
  const acceptedCur = accCur || expCur || (rawAccepted !== null || rawExpected !== null ? "USD" : "");
  const expectedTotal = rawExpected !== null ? toMoney(rawExpected, expectedCur || "USD") : null;
  const acceptedTotal = rawAccepted !== null ? toMoney(rawAccepted, acceptedCur || "USD") : expectedTotal !== null ? toMoney(expectedTotal, acceptedCur || "USD") : null;
  return {
    expectedClientTotal: expectedTotal,
    expectedClientCurrency: expectedTotal !== null ? expectedCur || "USD" : "",
    acceptedQuoteTotal: acceptedTotal,
    acceptedQuoteCurrency: acceptedTotal !== null ? acceptedCur || "USD" : "",
    acceptedServerQuoteBreakdown: bookingData.acceptedServerQuoteBreakdown && typeof bookingData.acceptedServerQuoteBreakdown === "object" ? bookingData.acceptedServerQuoteBreakdown : null,
  };
};

export const quoteExceedsAcceptedCeiling = ({ quote, acceptedQuoteTotal, acceptedQuoteCurrency }) => {
  if (!quote || typeof quote !== "object" || acceptedQuoteTotal === null || !acceptedQuoteCurrency) return false;
  const qCur = normalizeCurrencyCode(quote.currency || "USD");
  const aCur = normalizeCurrencyCode(acceptedQuoteCurrency);
  if (qCur !== aCur) return true;
  const qNet = quote.isFree === true ? 0 : Math.max(0, toMoney(quote.netAmount ?? 0, qCur));
  return qNet > toMoney(acceptedQuoteTotal, aCur);
};

export const reconcileAuthoritativeQuote = ({
  quote, quoteVersion, quoteFingerprint, scopeKey,
  acceptedQuoteTotal, acceptedQuoteCurrency,
  referralCode = "", couponCode = "", referral = null, coupon = null,
}) => {
  if (!quote || typeof quote !== "object") return { status: "none", acceptedQuoteTotal, acceptedQuoteCurrency, hold: null, breakdown: null };
  const qCur = normalizeCurrencyCode(quote.currency || "USD");
  const qNet = quote.isFree === true ? 0 : Math.max(0, toMoney(quote.netAmount ?? 0, qCur));
  const breakdown = buildConfirmedQuoteBreakdown(quote, { referralCode, couponCode, referral, coupon });
  if (acceptedQuoteTotal === null || !acceptedQuoteCurrency) {
    return { status: "accepted", acceptedQuoteTotal: qNet, acceptedQuoteCurrency: qCur, hold: null, breakdown };
  }
  const aCur = normalizeCurrencyCode(acceptedQuoteCurrency);
  const aTotal = toMoney(acceptedQuoteTotal, aCur);
  if (qCur !== aCur || qNet > aTotal) {
    return {
      status: "hold",
      acceptedQuoteTotal: aTotal,
      acceptedQuoteCurrency: aCur,
      hold: {
        reason: qCur !== aCur ? "currency_changed" : "price_increased",
        amount: qNet, currency: qCur, previousAmount: aTotal, previousCurrency: aCur,
        quoteVersion, quoteFingerprint: String(quoteFingerprint || "").trim(), scopeKey: String(scopeKey || "").trim(),
        referralCode: String(referralCode || "").trim(), couponCode: String(couponCode || "").trim(), quote,
      },
      breakdown: null,
    };
  }
  return { status: "accepted", acceptedQuoteTotal: toMoney(Math.min(aTotal, qNet), qCur), acceptedQuoteCurrency: qCur, hold: null, breakdown };
};

export const computeManualDiscountRemoval = ({
  slot, acceptedQuoteTotal, acceptedQuoteCurrency, acceptedServerQuoteBreakdown, referral = null, coupon = null,
}) => {
  const isRef = slot === "referral";
  const activeCode = String((isRef ? referral?.code : coupon?.code) || "").trim().toLowerCase();
  const bd = acceptedServerQuoteBreakdown;
  if (!activeCode || acceptedQuoteTotal === null || !acceptedQuoteCurrency || !bd || normalizeCurrencyCode(bd.currency || "USD") !== normalizeCurrencyCode(acceptedQuoteCurrency)) {
    return { delta: 0, nextAcceptedQuoteTotal: acceptedQuoteTotal, nextBreakdown: bd || null };
  }
  const cur = normalizeCurrencyCode(acceptedQuoteCurrency);
  const bdRef = String(bd.referralCode || "").trim().toLowerCase();
  const bdCpn = String(bd.couponCode || "").trim().toLowerCase();
  if ((isRef && bdRef !== activeCode) || (!isRef && bdCpn !== activeCode)) {
    return { delta: 0, nextAcceptedQuoteTotal: acceptedQuoteTotal, nextBreakdown: bd };
  }
  const gross = Math.max(0, toMoney(bd.grossAmount ?? 0, cur));
  const netWith = Math.max(0, toMoney(bd.netAmount ?? 0, cur));
  const keepOther = isRef
    ? Boolean(coupon?.code && bdCpn && bdCpn === String(coupon.code).trim().toLowerCase())
    : Boolean(referral?.code && bdRef && bdRef === String(referral.code).trim().toLowerCase());
  let remOtherDisc = 0;
  let netWithout;
  if (keepOther) {
    if (isRef) {
      const cpnType = String(bd.couponDiscountType || coupon?.discountType || "percent").toLowerCase();
      const cpnPct = Number(bd.couponDiscountPercent || coupon?.discountPercent || 0);
      const cpnFixed = Number(bd.couponFixedAmount || coupon?.discountAmount || bd.couponDiscountAmount || 0);
      remOtherDisc = cpnType === "fixed"
        ? Math.min(gross, Math.max(0, toMoney(cpnFixed, cur)))
        : cpnPct > 0
          ? Math.min(gross, Math.max(0, toMoney(gross * (cpnPct / 100), cur)))
          : Math.min(gross, Math.max(0, toMoney(bd.couponDiscountAmount || 0, cur)));
    } else {
      const refPct = Number(bd.referralDiscountPercent || referral?.currentDiscountPercent || 0);
      remOtherDisc = refPct > 0
        ? Math.min(gross, Math.max(0, toMoney(gross * (refPct / 100), cur)))
        : Math.min(gross, Math.max(0, toMoney(bd.referralDiscountAmount || 0, cur)));
    }
    netWithout = Math.max(0, toMoney(gross - remOtherDisc, cur));
  } else {
    const removedAmt = toMoney(isRef ? bd.referralDiscountAmount || 0 : bd.couponDiscountAmount || 0, cur);
    netWithout = Math.min(gross, Math.max(0, toMoney(netWith + removedAmt, cur)));
  }
  const delta = Math.max(0, toMoney(netWithout - netWith, cur));
  const nextBreakdown = isRef
    ? { ...bd, referralCode: "", referralDiscountAmount: 0, referralDiscountPercent: 0, ...(keepOther ? { couponDiscountAmount: remOtherDisc } : {}), netAmount: netWithout }
    : { ...bd, couponCode: "", couponDiscountAmount: 0, couponDiscountPercent: 0, couponFixedAmount: 0, ...(keepOther ? { referralDiscountAmount: remOtherDisc } : {}), netAmount: netWithout };
  return { delta, nextAcceptedQuoteTotal: toMoney(acceptedQuoteTotal + delta, cur), nextBreakdown };
};

export const createPaymentConsentActions = (c) => {
  const persist = (patch = {}) => {
    const next = mergeLineageCheckout(c.readStoredCheckout(), c.checkoutRef.current || c.bookingData, patch);
    c.checkoutRef.current = next; c.writeStoredCheckout(next); syncHistoryCheckoutBooking(next);
    return next;
  };
  const applyAuthoritativeQuote = ({ quote, quoteVersion, quoteFingerprint: qFp, scopeKey }) => {
    if (!quote || !areSameLineageScopeKeys(c.currentScopeKeyRef.current, scopeKey)) return;
    if (quoteVersion !== undefined && quoteVersion !== c.quoteVersionRef.current) return;
    const cur = c.consentStateRef.current;
    const rec = reconcileAuthoritativeQuote({
      quote, quoteVersion, quoteFingerprint: qFp, scopeKey,
      acceptedQuoteTotal: cur.acceptedQuoteTotal, acceptedQuoteCurrency: cur.acceptedQuoteCurrency,
      referralCode: c.referralRef.current?.code || "", couponCode: c.couponRef.current?.code || "",
      referral: c.referralRef.current, coupon: c.couponRef.current,
    });
    if (rec.status === "hold") { c.quoteHoldRef.current = rec.hold; c.setQuoteHold(rec.hold); return; }
    if (rec.status === "accepted") {
      c.quoteHoldRef.current = null; c.setQuoteHold(null);
      const patch = { acceptedQuoteTotal: rec.acceptedQuoteTotal, acceptedQuoteCurrency: rec.acceptedQuoteCurrency, acceptedServerQuoteBreakdown: rec.breakdown };
      c.consentStateRef.current = { ...cur, ...patch };
      persist(patch);
    }
  };
  const handleAcceptQuoteHold = (hold) => {
    if (!hold || c.quoteHoldRef.current !== hold || !areSameLineageScopeKeys(hold.scopeKey, c.currentScopeKeyRef.current) || hold.quoteVersion !== c.quoteVersionRef.current) return;
    if (hold.quoteFingerprint && c.quoteFingerprintRef.current && hold.quoteFingerprint !== c.quoteFingerprintRef.current) return;
    if (String(hold.referralCode || "").trim().toLowerCase() !== String(c.referralRef.current?.code || "").trim().toLowerCase()) return;
    if (String(hold.couponCode || "").trim().toLowerCase() !== String(c.couponRef.current?.code || "").trim().toLowerCase()) return;
    const breakdown = buildConfirmedQuoteBreakdown(hold.quote, { referralCode: hold.referralCode, couponCode: hold.couponCode, referral: c.referralRef.current, coupon: c.couponRef.current });
    const patch = { acceptedQuoteTotal: hold.amount, acceptedQuoteCurrency: hold.currency, acceptedServerQuoteBreakdown: breakdown };
    c.consentStateRef.current = { ...c.consentStateRef.current, ...patch };
    persist(patch);
    c.quoteHoldRef.current = null; c.setQuoteHold(null);
  };
  const handleRemoveDiscount = (slot) => {
    const isRef = slot === "referral";
    if (!c.manualCodeAllowedRef.current || c.checkingCode || !(isRef ? c.referral : c.coupon)) return;
    c.validationGenRef.current += 1; c.quoteVersionRef.current += 1; c.lastQuoteKeyRef.current = "";
    const cur = c.consentStateRef.current;
    const removed = computeManualDiscountRemoval({ slot, acceptedQuoteTotal: cur.acceptedQuoteTotal, acceptedQuoteCurrency: cur.acceptedQuoteCurrency, acceptedServerQuoteBreakdown: cur.acceptedServerQuoteBreakdown, referral: c.referral, coupon: c.coupon });
    const extra = { acceptedQuoteTotal: removed.nextAcceptedQuoteTotal, acceptedQuoteCurrency: cur.acceptedQuoteCurrency, acceptedServerQuoteBreakdown: removed.nextBreakdown };
    c.consentStateRef.current = { ...cur, ...extra };
    c.quoteHoldRef.current = null; c.setQuoteHold(null);
    if (isRef) { c.referralRef.current = null; c.setReferral(null); c.setReferralInput(""); c.setReferralError(""); c.writeStoredReferral(""); }
    else { c.couponRef.current = null; c.setCoupon(null); c.setCouponInput(""); c.setCouponError(""); }
    const { location: loc, navState: latestNav } = c.latestNavRef.current;
    const next = persist({ referralCode: c.stripReservedCode(isRef ? "" : c.referral?.code || ""), couponCode: c.stripReservedCode(isRef ? c.coupon?.code || "" : ""), code: 1, ...extra });
    const params = new URLSearchParams(loc.search);
    if (isRef) params.delete("ref");
    const search = params.toString() ? `?${params}` : "";
    c.skipPreApplyKeyRef.current = `${c.activeReservationKeyRef.current}|${next.referralCode}|${next.couponCode}|${search}`;
    c.navigate({ pathname: loc.pathname, search, hash: loc.hash }, { replace: true, state: { ...latestNav, bookingData: next } });
  };
  return { applyAuthoritativeQuote, handleAcceptQuoteHold, handleRemoveDiscount };
};

export const createConfirmationNavigationState = ({ responseBody = {}, baseState, scopeKey, holdExpiryHandledRef, writeStoredCheckout }) => {
  const bookingId = String(responseBody?.bookingId || "").trim();
  holdExpiryHandledRef.current = true;
  markReservationTerminal(scopeKey, responseBody?.status || "booked");
  writeStoredCheckout(null);
  try {
    removeBrowserStorage("sessionStorage", "my_slot_hold");
    window.dispatchEvent(new CustomEvent("hold-state", { detail: null }));
  } catch {}
  if (!bookingId) { clearBookingConfirmation(); return baseState; }
  return { ...(baseState || {}), bookingConfirmation: createBookingConfirmation(responseBody) };
};
