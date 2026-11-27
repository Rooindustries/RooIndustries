import { normalizeCurrencyCode, toMoney } from "./checkoutCodes";
import { areSameLineageScopeKeys, mergeLineageCheckout, syncHistoryCheckoutBooking } from "./checkoutSessionGuard";

const finiteNonNeg = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const explicitCur = (v) => {
  const c = String(v || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? normalizeCurrencyCode(c) : "";
};

export const resolveInitialConsentBaseline = (b = {}) => {
  const rawExp = finiteNonNeg(b?.expectedClientTotal), rawAcc = finiteNonNeg(b?.acceptedQuoteTotal);
  const expCur = explicitCur(b?.expectedClientCurrency), accCur = explicitCur(b?.acceptedQuoteCurrency);
  if (rawAcc === null && rawExp === null && b?.packagePrice) {
    const c = accCur || expCur || "USD", a = Math.max(0, toMoney(b.packagePrice, c));
    if (a > 0) return { expectedClientTotal: a, expectedClientCurrency: c, acceptedQuoteTotal: a, acceptedQuoteCurrency: c, acceptedServerQuoteBreakdown: null };
  }
  const eCur = expCur || accCur || (rawExp !== null ? "USD" : ""), aCur = accCur || expCur || (rawAcc !== null || rawExp !== null ? "USD" : "");
  const eTot = rawExp !== null ? toMoney(rawExp, eCur || "USD") : null;
  const aTot = rawAcc !== null ? toMoney(rawAcc, aCur || "USD") : (eTot !== null ? toMoney(eTot, aCur || "USD") : null);
  return {
    expectedClientTotal: eTot,
    expectedClientCurrency: eTot !== null ? eCur || "USD" : "",
    acceptedQuoteTotal: aTot,
    acceptedQuoteCurrency: aTot !== null ? aCur || "USD" : "",
    acceptedServerQuoteBreakdown: b?.acceptedServerQuoteBreakdown && typeof b.acceptedServerQuoteBreakdown === "object" ? b.acceptedServerQuoteBreakdown : null,
  };
};

export const ensureConsentBaseline = (c) => {
  const scope = c.currentScopeKeyRef.current;
  if (!areSameLineageScopeKeys(c.consentScopeRef.current, scope)) {
    c.consentScopeRef.current = scope;
    c.consentStateRef.current = resolveInitialConsentBaseline(c.bookingData);
  }
  return c.consentStateRef.current;
};

export const buildConfirmedQuoteBreakdown = (
  quote,
  { referralCode = "", couponCode = "", referral = null, coupon = null } = {}
) => {
  if (!quote || typeof quote !== "object") return null;
  const currency = normalizeCurrencyCode(quote.currency || "USD");
  const grossAmount = Math.max(0, toMoney(quote.grossAmount ?? quote.netAmount ?? 0, currency));
  const netAmount = quote.isFree === true ? 0 : Math.max(0, toMoney(quote.netAmount ?? 0, currency));
  const rawCouponAmt = finiteNonNeg(quote.couponDiscountAmount);
  const couponDiscountAmount = rawCouponAmt !== null ? toMoney(rawCouponAmt, currency) : 0;
  const couponDiscountPercent = Math.max(0, Number(quote.couponDiscountPercent ?? coupon?.discountPercent ?? 0) || 0);
  const rawType = String(quote.couponDiscountType || coupon?.discountType || "").trim().toLowerCase();
  const couponDiscountType = rawType === "fixed" || rawType === "percent" ? rawType : couponDiscountPercent > 0 ? "percent" : "fixed";
  const serverFixedVal = finiteNonNeg(quote.couponDiscountValue);
  const couponFixedAmount = couponDiscountType === "fixed"
    ? (serverFixedVal !== null
      ? toMoney(serverFixedVal, currency)
      : (rawCouponAmt !== null && couponDiscountAmount < grossAmount ? couponDiscountAmount : null))
    : 0;
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
    couponFixedAmount,
  };
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
  const curRef = String(referral?.code || "").trim().toLowerCase();
  const curCpn = String(coupon?.code || "").trim().toLowerCase();
  if ((isRef && bdRef !== activeCode) || (!isRef && bdCpn !== activeCode) || curRef !== bdRef || curCpn !== bdCpn) {
    return { delta: 0, nextAcceptedQuoteTotal: acceptedQuoteTotal, nextBreakdown: bd };
  }
  const gross = Math.max(0, toMoney(bd.grossAmount ?? 0, cur));
  const netWith = Math.max(0, toMoney(bd.netAmount ?? 0, cur));
  const keepOther = isRef ? Boolean(bdCpn) : Boolean(bdRef);
  let remOtherDisc = 0;
  let netWithout;
  if (keepOther) {
    if (isRef) {
      const cpnType = String(bd.couponDiscountType || coupon?.discountType || "percent").toLowerCase();
      if (cpnType === "fixed") {
        const cpnFixed = finiteNonNeg(bd.couponFixedAmount);
        if (cpnFixed === null) {
          const nextBreakdown = { ...bd, referralCode: "", referralDiscountAmount: 0, referralDiscountPercent: 0 };
          return { delta: 0, nextAcceptedQuoteTotal: acceptedQuoteTotal, nextBreakdown };
        }
        remOtherDisc = Math.min(gross, toMoney(cpnFixed, cur));
      } else {
        const cpnPct = Number(bd.couponDiscountPercent || coupon?.discountPercent || 0);
        remOtherDisc = cpnPct > 0
          ? Math.min(gross, Math.max(0, toMoney(gross * (cpnPct / 100), cur)))
          : Math.min(gross, Math.max(0, toMoney(bd.couponDiscountAmount || 0, cur)));
      }
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
    const cur = ensureConsentBaseline(c);
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
    ensureConsentBaseline(c);
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
    const cur = ensureConsentBaseline(c);
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
  const changePaymentMethod = async (existingOp = null) => {
    const isBlocked = (ctx) => ctx.paymentBusy || ctx.payingDodo || ctx.payingRzp || ctx.pendingStartCount > 0 || ctx.pendingStartsRef.current.length > 0;
    if (isBlocked(c)) return;
    let m;
    try { m = await c.loadCheckoutHold(); } catch {
      c.showBanner("error", "The payment method could not be changed. Please try again.", { persistent: true });
      return;
    }
    const live = c.consentCtxRef?.current || c;
    const flow = m.createCheckoutFlow(live.checkoutFlowCtxRef.current);
    const cancel = flow.beginCancel(live.createPaymentOperation, isBlocked(live), existingOp);
    if (!cancel) return;
    await m.runChangePaymentMethod({
      ...live.checkoutFlowCtxRef.current, cancel, currentScopeKeyRef: live.currentScopeKeyRef, setCancellingPayment: live.setCancellingPayment,
      navigateToConfirmation: live.navigateToConfirmation, showBanner: live.showBanner, clearPaymentSession: live.clearPaymentSession,
      manualCodeAllowedRef: live.manualCodeAllowedRef, flow,
    });
  };
  const checkPaymentStatus = async () => {
    const activeSession = c.readStoredPaymentSession() || c.paymentSession;
    const token = String(activeSession?.paymentAccessToken || "").trim();
    if (!token || c.paymentStatusBusy || c.cancellingPayment || c.paymentActionRef.current.cancelling) return;
    if (!(activeSession?.providerOrderReady === false || activeSession?.result?.providerOrderReady === false)) {
      c.finalizeSessionCheckout({ paymentAccessToken: token, providerData: {} }).catch((error) =>
        c.showBanner("error", error?.message || "Unable to load payment status. Please try again.")
      );
      return;
    }
    const operation = c.createPaymentOperation(token);
    if (!operation.current()) return;
    c.loadCheckoutHold()
      .then((m) => operation.current() && m.runCheckPaymentStatus({
        activeSession, operation, currentScopeKeyRef: c.currentScopeKeyRef, setPaymentStatusBusy: c.setPaymentStatusBusy,
        navigateToConfirmation: c.navigateToConfirmation, showBanner: c.showBanner, clearPaymentSession: c.clearPaymentSession,
        persistPaymentSession: c.persistPaymentSession, flow: m.createCheckoutFlow(c.checkoutFlowCtxRef.current),
      }))
      .catch((error) => { if (operation.current()) c.showBanner("error", error?.message || "Unable to load payment status. Please try again."); });
  };
  const validateCode = ({ slot, code }) => {
    const isRef = slot === "referral", scopeKey = c.currentScopeKeyRef.current;
    return c.loadCheckoutHold()
      .then((m) => (isRef ? m.runValidateReferral : m.runValidateCoupon)(code, { ...c, scopeKey }, m.createCheckoutFlow(c.checkoutFlowCtxRef.current)))
      .catch(() => {
        if (c.currentScopeKeyRef.current === scopeKey) {
          (isRef ? c.setReferralError : c.setCouponError)(isRef ? "We couldn't validate that referral code. Please try again." : "We couldn't validate that coupon code. Please try again.");
        }
      });
  };
  return { applyAuthoritativeQuote, handleAcceptQuoteHold, handleRemoveDiscount, changePaymentMethod, checkPaymentStatus, validateCode };
};

export const fetchPaymentProviders = ({ req, hasPaypalClientId, paypalClientIdFromEnv, setProviderAvailabilityKnown, setProviderConfig, setProvidersSettled, isActive, isSuperseded }) =>
  req
    .then((res) => {
      if (!isActive() || isSuperseded?.()) return;
      if (!res?.ok) {
        if (typeof window === "undefined") return;
        const host = String(window.location.hostname || "").toLowerCase();
        if ((host === "localhost" || host === "127.0.0.1") && hasPaypalClientId) {
          setProviderConfig((prev) => ({ ...prev, paypal: { enabled: true, mode: "sandbox", clientId: prev?.paypal?.clientId || paypalClientIdFromEnv } }));
        }
        return;
      }
      const data = res.data;
      if (!data?.ok || !data?.providers) return;
      setProviderAvailabilityKnown(["dodo", "razorpay", "paypal"].every((p) => typeof data.providers[p]?.enabled === "boolean"));
      setProviderConfig({
        dodo: { enabled: !!data.providers?.dodo?.enabled, mode: data.providers?.dodo?.mode || "missing", currency: data.providers?.dodo?.currency || "USD" },
        razorpay: { enabled: !!data.providers?.razorpay?.enabled, mode: data.providers?.razorpay?.mode || "unknown", currency: data.providers?.razorpay?.currency || "USD", disabledReason: String(data.providers?.razorpay?.disabledReason || "").trim() },
        paypal: { enabled: !!data.providers?.paypal?.enabled, mode: data.providers?.paypal?.mode || "unknown", currency: data.providers?.paypal?.currency || "USD", clientId: String(data.providers?.paypal?.clientId || "").trim() },
      });
    })
    .finally(() => { if (isActive()) setProvidersSettled(true); });

export const runPayPalApprove = async (data, actions, c) => {
  const activeSession = c.getActivePaymentSession("paypal");
  const tokenScopeKey = activeSession?.scopeKey || c.currentScopeKeyRef.current;
  const operation = c.createPaymentOperation(activeSession?.paymentAccessToken);
  if (!activeSession?.paymentAccessToken || !operation.current() || !c.ensureSlotBeforeAction()) return;
  c.paymentActionRef.current.seq += 1;
  c.setPaymentStatusBusy(true);
  try {
    const details = await actions.order.capture();
    await c.finalizeSessionCheckout({
      operation, captured: true, scopeKey: tokenScopeKey,
      paymentAccessToken: String(activeSession.paymentAccessToken).trim(),
      providerData: { paypalOrderId: details?.id || data?.orderID || "", payerEmail: details?.payer?.email_address || "" },
    });
  } catch {
    if (!operation.current()) return;
    console.error("PayPal booking finalization failed");
    c.showBanner("error", "Payment succeeded but something went wrong saving your booking. Please contact support.");
  } finally {
    if (operation.current()) c.setPaymentStatusBusy(false);
  }
};
