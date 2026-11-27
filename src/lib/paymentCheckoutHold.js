import { fetchJsonWithTimeout } from "./clientRequest";
import { extractTokenNonce } from "./checkoutConfirmation";
import { CODE_VALIDATION_UNAVAILABLE_MESSAGE, formatCouponValue, sanitizeCouponForCheckout, sanitizeReferralForCheckout } from "./checkoutCodes";
import { areSameLineageScopeKeys, clearDodoNavQuery, isNonResumablePaymentData, mergeLineageCheckout, ownsSessionHold, stripDodoReturnFromHistory, syncCheckoutRef, syncHistoryCheckoutBooking } from "./checkoutSessionGuard";
import { fetchPaymentJson, STORAGE_SAVE_CHANGE_ONLY_ERROR, STORAGE_SAVE_ERROR, verifyProviderLaunchPayload } from "./paymentSessionLocks";
import { areSameLineageNonces, markReservationTerminal, recordHoldNonceRotation, reservationScopeKey } from "./reservationScope";

export async function runPreApplyCheckoutCodes(c) {
  let nextReferral = null, referralUnavailable = false, referralRejected = false, nextCoupon = null;
  let nextReferralInput = c.referralCode, nextCouponInput = c.couponCode, infoMessage = "", droppedPassive = false;
  const dropPassive = () => { droppedPassive = true; nextReferralInput = nextReferral?.code || ""; };
  const applyResolved = (result, source) => {
    const blocksPassive = !c.persistedRef && nextCoupon?.canCombineWithReferral === false;
    if (!result?.ok) {
      if (source !== "referral") { nextCouponInput = ""; c.setCouponError(result?.error || "Invalid coupon code."); }
      else if (result?.unavailable) {
        referralUnavailable = true;
        if (!nextReferral && !blocksPassive && c.referralResKeyRef.current === c.startedReservationKey && c.referral?.code?.toLowerCase() === c.refLower) nextReferral = c.referral;
        if (blocksPassive) nextReferralInput = "";
        c.setReferralError(result.error);
      } else { referralRejected = true; nextReferralInput = nextReferral?.code || ""; c.setReferralError("Invalid or inactive referral code."); }
      return;
    }
    if (result.type === "referral") {
      const safeReferral = sanitizeReferralForCheckout(result.value);
      if (!safeReferral) return;
      if (source === "referral" && (blocksPassive || (!c.persistedRef && nextReferral))) return dropPassive();
      nextReferral = safeReferral; nextReferralInput = safeReferral.code;
      if (source === "coupon") { nextCouponInput = ""; infoMessage = "This code is a referral, so it was applied as a referral."; }
      return;
    }
    const safeCoupon = sanitizeCouponForCheckout(result.value);
    if (!safeCoupon) return;
    if (source === "referral" && nextCoupon && !c.persistedRef) return dropPassive();
    if (safeCoupon.canCombineWithReferral === false && nextReferral) { nextCouponInput = ""; c.setCouponError("This coupon can't be used together with a referral discount."); return; }
    nextCoupon = safeCoupon; nextCouponInput = safeCoupon.code;
    if (source === "referral") { nextReferralInput = nextReferral?.code || ""; infoMessage = "This code is a coupon, so it was applied as a coupon."; }
  };
  if (c.couponCode) {
    const result = await resolveCheckoutCode(c.couponCode, c.packageTitle);
    if (!c.isCurrent()) return;
    applyResolved(result, "coupon");
  }
  if (c.referralCode && c.refLower !== c.couponCode.toLowerCase()) {
    const result = await resolveCheckoutCode(c.referralCode, c.packageTitle);
    if (!c.isCurrent()) return;
    applyResolved(result, "referral");
  } else if (c.referralCode && nextReferral) { nextCouponInput = ""; }
  if (nextReferral && nextCoupon?.canCombineWithReferral === false) {
    nextCoupon = null; nextCouponInput = ""; c.setCouponError("This coupon can't be used together with a referral discount.");
  }
  if (c.referralRef) c.referralRef.current = nextReferral;
  if (c.couponRef) c.couponRef.current = nextCoupon;
  c.setReferral(nextReferral); c.setCoupon(nextCoupon); c.setReferralInput(nextReferralInput); c.setCouponInput(nextCouponInput);
  const currentSess = c.readLinkReferralFromSession(), sameSess = currentSess.toLowerCase() === c.refLower;
  if ((droppedPassive || (!referralUnavailable && !nextReferral?.code && (referralRejected || !nextCoupon))) && sameSess) c.writeLinkReferralToSession("");
  else if (!referralUnavailable && nextReferral?.code && !currentSess) c.writeLinkReferralToSession(nextReferral.code);
  if (infoMessage) c.showBanner("info", infoMessage);
  if (droppedPassive) {
    const curSearch = window.location.search;
    const nextSearch = c.normalizeLinkReferral(new URLSearchParams(curSearch).get("ref") || "").toLowerCase() === c.refLower ? c.stripRefFromSearch(curSearch) : null;
    if (nextSearch !== null) {
      c.skipPreApplyKeyRef.current = `${c.preApplyPrefix}${nextSearch}`;
      c.navigate({ pathname: c.location.pathname, search: nextSearch, hash: c.location.hash }, { replace: true, state: c.navState });
    }
  }
}

const str = (v) => String(v || "").trim();
const unavailableCode = () => ({ ok: false, unavailable: true, error: CODE_VALIDATION_UNAVAILABLE_MESSAGE });
const lookupCode = async (url, fetchImpl) => {
  try {
    const { response, data } = await fetchJsonWithTimeout(url, {}, fetchImpl);
    if (response.ok === false && (response.status !== 400 || data?.ok !== false)) return unavailableCode();
    if (typeof data?.ok !== "boolean" || data?.reason === "unavailable") return unavailableCode();
    return data;
  } catch { return unavailableCode(); }
};
export const fetchCheckoutQuote = async (body, { signal }) => {
  const response = await fetch("/api/payment/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || "Unable to confirm checkout price.");
  return data;
};
export const validateReferralCode = async (code, fetchImpl = fetch) => {
  const data = await lookupCode(`/api/ref/validateReferral?code=${encodeURIComponent(code)}`, fetchImpl);
  if (data.unavailable) return data;
  if (!data?.ok) return { ok: false, error: data?.error || "Invalid or inactive referral code." };
  const referral = sanitizeReferralForCheckout(data.referral);
  if (!referral || data.active === false || data.eligible === false) return { ok: false, error: "Invalid or inactive referral code." };
  return { ok: true, active: data.active !== false, eligible: data.eligible !== false, referral };
};
export const validateCouponCode = async (code, packageTitle, fetchImpl = fetch) => {
  const data = await lookupCode(`/api/ref/validateCoupon?code=${encodeURIComponent(code)}&packageTitle=${encodeURIComponent(packageTitle)}`, fetchImpl);
  if (data.unavailable) return data;
  if (!data?.ok) return { ok: false, error: data?.error || "Invalid referral or coupon code." };
  const coupon = sanitizeCouponForCheckout(data.coupon);
  return coupon ? { ok: true, coupon } : { ok: false, error: "Invalid referral or coupon code." };
};
export const resolveCheckoutCode = async (code, packageTitle, fetchImpl = fetch) => {
  const [rA, cA] = await Promise.allSettled([validateReferralCode(code, fetchImpl), validateCouponCode(code, packageTitle, fetchImpl)]);
  const rR = rA.status === "fulfilled" ? rA.value : null, cR = cA.status === "fulfilled" ? cA.value : null;
  const hasR = !!(rR?.ok && rR.referral), hasC = !!(cR?.ok && cR.coupon);
  if (hasR && hasC) console.warn("checkout_code_namespace_collision", { event: "checkout_code_namespace_collision", code: str(code).toLowerCase(), precedence: "referral_first", resolvedType: "referral" });
  if (hasR) return { ok: true, type: "referral", value: rR.referral };
  if (!rR || !cR || rR.unavailable || cR.unavailable) return unavailableCode();
  if (hasC) return { ok: true, type: "coupon", value: cR.coupon };
  return { ok: false, error: cR?.error || rR?.error || "We couldn't validate that referral or coupon code. Please try again." };
};
export const hasSessionOwnedHoldForCancel = (hold, session) => {
  if (!hold || !session?.paymentAccessToken) return false;
  const holdId = str(hold.holdId || hold.slotHoldId), holdNonce = extractTokenNonce(hold.holdToken || hold.slotHoldToken);
  if (!holdId || !holdNonce) return false;
  const r = session.result?.refreshedHold || session.result?.hold;
  if (r?.slotHoldId) return str(r.slotHoldId) === holdId && areSameLineageNonces(holdId, r.slotHoldToken, holdNonce);
  if (session.scopeKey) { try { const p = JSON.parse(session.scopeKey); return p?.k === "b" && str(p.h) === holdId && areSameLineageNonces(holdId, p.n, holdNonce); } catch { return false; } }
  return false;
};
export async function runBookingPaymentRelease({ hold, checkout, packageTitle, holdKey, sessKey, checkoutKey, timeoutMs, writeHold, updateCheckout, broadcast, onCaptured, onExpired, onReleased, onError }) {
  const holdId = str(hold?.holdId), holdToken = str(hold?.holdToken), holdNonce = extractTokenNonce(holdToken);
  let tok = "";
  const isCurrent = () => { try { const lh = JSON.parse(sessionStorage.getItem(holdKey) || "null"), ls = JSON.parse(sessionStorage.getItem(sessKey) || "null"); return lh?.holdId === holdId && lh?.holdToken === holdToken && (!ls?.paymentAccessToken || ls.paymentAccessToken === tok); } catch { return false; } };
  const clearMatchingSess = () => { try { const c = JSON.parse(sessionStorage.getItem(sessKey) || "null"); if (!c?.paymentAccessToken || c.paymentAccessToken === tok) sessionStorage.removeItem(sessKey); } catch {} };
  try {
    const stored = JSON.parse(sessionStorage.getItem(sessKey) || "null");
    tok = str(stored?.paymentAccessToken);
    if (!tok || !hasSessionOwnedHoldForCancel(hold, stored)) throw new Error("Return to payment once so the active session can be checked.");
    const sk = reservationScopeKey({ ...(checkout || {}), slotHoldId: holdId, slotHoldToken: holdToken, packageTitle: hold?.packageTitle || checkout?.packageTitle || packageTitle, startTimeUTC: hold?.startTimeUTC || checkout?.startTimeUTC || "" });
    const res = await fetch("/api/payment/cancel", { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json().catch(() => ({}));
    markReservationTerminal(sk, data?.status);
    if (!isCurrent()) return;
    if (data?.captured) {
      const capStatus = str(data?.status).toLowerCase();
      if (capStatus === "booked" || capStatus === "email_partial") {
        clearMatchingSess();
        try { const cc = JSON.parse(sessionStorage.getItem(checkoutKey) || "null"); if (cc?.slotHoldId === holdId && (!holdNonce || extractTokenNonce(cc.slotHoldToken) === holdNonce)) sessionStorage.removeItem(checkoutKey); } catch {}
      }
      onCaptured(data); return;
    }
    if (!res.ok || data?.cancelled !== true) throw new Error(data?.error || "The payment session could not be released.");
    const r = data.refreshedHold;
    if (!r?.slotHoldId || !r?.slotHoldToken) { clearMatchingSess(); onExpired("The reservation expired. Please choose the slot again."); return; }
    recordHoldNonceRotation({ slotHoldId: r.slotHoldId, fromNonce: holdToken, toNonce: r.slotHoldToken });
    const nextHold = { ...hold, holdId: r.slotHoldId, holdToken: r.slotHoldToken, expiresAt: r.slotHoldExpiresAt, phase: "holding" };
    writeHold(nextHold); const updated = updateCheckout(r, { expectedHoldId: holdId, expectedHoldNonce: holdNonce }); clearMatchingSess(); broadcast(nextHold);
    onReleased(updated ? "Payment method released. You can choose another payment method." : "Payment method released. Review your booking details and submit again.");
  } catch (error) {
    if (!isCurrent()) return;
    onError((error?.name === "AbortError" || error?.name === "TimeoutError") ? "The payment session could not be released. Please try again." : error?.message || "The payment session could not be released.");
  }
}
export { fetchPaymentJson, isNonResumablePaymentData, STORAGE_SAVE_ERROR, stripDodoReturnFromHistory, syncCheckoutRef, syncHistoryCheckoutBooking, verifyProviderLaunchPayload };
export const runLegacyDodoStatusCheck = async ({ token, operation, fetchJson = fetchPaymentJson, setBusy, onBooked, onManualReview, onTerminalClear }) => {
  setBusy(true);
  try {
    const { response, data } = await fetchJson("/api/payment/status", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
    if (!operation.current()) return;
    const st = str(data?.status).toLowerCase();
    if (response.ok && (st === "booked" || st === "email_partial") && data?.cleanupPending !== true && data?.manualReviewRequired !== true) await onBooked(data, operation);
    else if (response.ok && (data?.manualReviewRequired === true || data?.cleanupPending === true)) onManualReview(data.recoveryReason || "Payment is still being verified.");
    else if (response.ok && ["failed", "abandoned", "refunded"].includes(st) && data?.cleanupPending !== true && data?.manualReviewRequired !== true && (st === "refunded" ? data?.terminalOutcomeComplete !== false : data?.terminalOutcomeComplete === true)) onTerminalClear(st, token);
  } finally { if (operation.current()) setBusy(false); }
};
export const runDodoCheckout = async (c) => {
  const operation = c.createPaymentOperation();
  if (!operation.current() || c.payingDodo || c.paymentBusy || c.paymentActionRef.current.cancelling || c.otherCheckoutStarting("dodo") || !c.ensureSlotBeforeAction()) return;
  c.setPayingDodo(true);
  try {
    const session = await c.startSessionCheckout("dodo", operation);
    if (!operation.current() || session?.terminal) return;
    const verified = verifyProviderLaunchPayload({ provider: "dodo", payload: session?.providerPayload, expectedAmount: session?.result?.quote?.netAmount ?? c.finalAmount, expectedCurrency: session?.result?.quote?.currency || c.displayQuoteCurrency });
    if (!verified.ok) throw new Error(verified.reason);
    const r = session.result?.refreshedHold || session.result?.hold || c.sessionHold;
    const ret = mergeLineageCheckout(c.readStoredCheckout(), c.checkoutRef.current || c.bookingData, r?.slotHoldId && r?.slotHoldToken ? { slotHoldId: r.slotHoldId, slotHoldToken: r.slotHoldToken, slotHoldExpiresAt: r.slotHoldExpiresAt || r.expiresAt || "" } : {});
    if (!c.writeBrowserStorage("sessionStorage", c.checkoutKey, JSON.stringify(ret)) || !c.writeStoredPaymentSession(session)) {
      c.showBanner("error", STORAGE_SAVE_ERROR, { persistent: true });
      return;
    }
    stripDodoReturnFromHistory(); window.location.assign(verified.checkoutUrl);
  } catch (error) {
    if (!operation.current()) return;
    c.showBanner("error", (error?.name === "AbortError" || error?.name === "TimeoutError") ? "Checkout timed out. Please try again." : error.message || "Unable to open checkout.", { persistent: true });
  } finally { if (operation.current()) c.setPayingDodo(false); }
};
export const runValidateReferral = async (code, c, flow) => {
  const sameScope = () => !c.currentScopeKeyRef || areSameLineageScopeKeys(c.currentScopeKeyRef.current, c.scopeKey);
  const stillHere = () => c.manualCodeAllowedRef.current && sameScope();
  if (!stillHere() || c.validating || c.validatingCoupon) return;
  const normalizedCode = str(code);
  if (!normalizedCode) {
    c.setReferralInput(c.referral?.code || ""); c.setReferralError(""); return;
  }
  const myGen = ++c.referralCheckGenRef.current;
  c.validationGenRef.current += 1;
  try {
    c.setValidating(true); c.setReferralError("");
    const result = await resolveCheckoutCode(normalizedCode, c.packageTitle);
    if (c.referralCheckGenRef.current !== myGen || !stillHere()) return;
    c.validationGenRef.current += 1;
    if (!result.ok) {
      if (!result.unavailable) { if (c.referralRef) c.referralRef.current = null; c.setReferral(null); c.writeStoredReferral(""); flow.persistCodes({ referralCode: "", couponCode: c.coupon?.code || "", stripRef: true }); }
      c.setReferralError(result.unavailable ? result.error : "Invalid or inactive referral code."); return;
    }
    if (result.type === "coupon") {
      const safeCoupon = sanitizeCouponForCheckout(result.value);
      if (!safeCoupon) { c.setReferralError("Invalid or inactive referral code."); return; }
      if (safeCoupon.canCombineWithReferral === false && c.referral) { c.setCouponError("This coupon can't be used together with a referral discount."); return; }
      if (c.couponRef) c.couponRef.current = safeCoupon;
      c.setCoupon(safeCoupon); c.setCouponInput(safeCoupon.code); c.setReferralInput(c.referral?.code || "");
      flow.persistCodes({ referralCode: c.referral?.code || "", couponCode: safeCoupon.code });
      c.showBanner("info", "This code is a coupon, so it was applied as a coupon."); return;
    }
    const safeReferral = sanitizeReferralForCheckout(result.value);
    if (!safeReferral) { c.setReferralError("Invalid or inactive referral code."); return; }
    if (c.referralRef) c.referralRef.current = safeReferral;
    c.setReferral(safeReferral); c.setReferralInput(safeReferral.code); c.writeStoredReferral(safeReferral.code);
    const nextCouponCode = c.coupon?.canCombineWithReferral === false ? "" : c.coupon?.code || "";
    if (c.coupon?.canCombineWithReferral === false) { if (c.couponRef) c.couponRef.current = null; c.setCoupon(null); c.setCouponInput(""); c.showBanner("info", "Current coupon can't be combined with referrals and was removed."); }
    flow.persistCodes({ referralCode: safeReferral.code, couponCode: nextCouponCode, stripRef: true });
  } catch { if (c.referralCheckGenRef.current === myGen && stillHere()) { c.validationGenRef.current += 1; console.error("Referral validation failed"); c.setReferralError("We couldn't validate that referral code. Please try again."); } }
  finally { if (c.referralCheckGenRef.current === myGen && sameScope()) c.setValidating(false); }
};
export const runValidateCoupon = async (code, c, flow) => {
  const sameScope = () => !c.currentScopeKeyRef || areSameLineageScopeKeys(c.currentScopeKeyRef.current, c.scopeKey);
  const stillHere = () => c.manualCodeAllowedRef.current && sameScope();
  if (!stillHere() || c.validating || c.validatingCoupon) return;
  const normalizedCode = str(code);
  if (!normalizedCode) {
    c.setCouponInput(c.coupon?.code || ""); c.setCouponError(""); return;
  }
  const myGen = ++c.couponCheckGenRef.current;
  c.validationGenRef.current += 1;
  try {
    c.setValidatingCoupon(true); c.setCouponError("");
    const result = await resolveCheckoutCode(normalizedCode, c.packageTitle);
    if (c.couponCheckGenRef.current !== myGen || !stillHere()) return;
    c.validationGenRef.current += 1;
    if (!result.ok) {
      if (!result.unavailable) { if (c.couponRef) c.couponRef.current = null; c.setCoupon(null); flow.persistCodes({ referralCode: c.referral?.code || "", couponCode: "" }); }
      c.setCouponError(result.error || "Invalid coupon code."); return;
    }
    if (result.type === "referral") {
      const safeReferral = sanitizeReferralForCheckout(result.value);
      if (!safeReferral) { c.setCouponError("Invalid coupon code."); return; }
      if (c.referralRef) c.referralRef.current = safeReferral;
      if (c.couponRef) c.couponRef.current = null;
      c.setReferral(safeReferral); c.setReferralInput(safeReferral.code); c.writeStoredReferral(safeReferral.code);
      c.setCoupon(null); c.setCouponInput("");
      flow.persistCodes({ referralCode: safeReferral.code, couponCode: "", stripRef: true });
      c.showBanner("info", "This code is a referral, so it was applied as a referral."); return;
    }
    const safeCoupon = sanitizeCouponForCheckout(result.value);
    if (!safeCoupon) { if (c.couponRef) c.couponRef.current = null; c.setCoupon(null); flow.persistCodes({ referralCode: c.referral?.code || "", couponCode: "" }); c.setCouponError("Invalid coupon code."); return; }
    if (safeCoupon.canCombineWithReferral === false && c.referral) { if (c.couponRef) c.couponRef.current = null; c.setCoupon(null); flow.persistCodes({ referralCode: c.referral?.code || "", couponCode: "" }); c.setCouponError("This coupon can't be used together with a referral discount. Remove the referral or use a different coupon."); return; }
    if (c.couponRef) c.couponRef.current = safeCoupon;
    c.setCoupon(safeCoupon); c.setCouponInput(safeCoupon.code);
    flow.persistCodes({ referralCode: c.referral?.code || "", couponCode: safeCoupon.code });
    c.showBanner("success", `Coupon applied: ${formatCouponValue(safeCoupon)}`);
  } catch { if (c.couponCheckGenRef.current === myGen && stillHere()) { c.validationGenRef.current += 1; console.error("Coupon validation failed"); c.setCouponError("We couldn't validate that coupon code. Please try again."); } }
  finally { if (c.couponCheckGenRef.current === myGen && sameScope()) c.setValidatingCoupon(false); }
};
export const runFreeBookingCheckout = async (c) => {
  const operation = c.createPaymentOperation();
  if (!operation.current() || !c.isFree || c.validating || c.validatingCoupon || c.paymentBusy || c.paymentActionRef.current.cancelling || c.otherCheckoutStarting("free") || !c.ensureSlotBeforeAction()) return;
  c.manualCodeAllowedRef.current = false; c.setCreatingFree(true);
  const endConfirmation = c.beginCheckoutConfirmation(c.holdForGuard);
  try {
    c.showBanner("info", "Confirming your free booking...");
    const session = await c.startSessionCheckout("free", operation);
    if (!operation.current() || session?.stale) return;
    const data = session?.result || {}, status = str(data.status).toLowerCase();
    if (!data.bookingId || (status !== "booked" && status !== "email_partial")) throw new Error(data.error || "Could not save your free booking.");
    await c.showConfirmation("free", data, operation);
  } catch (err) {
    if (!operation.current()) return;
    console.error("Free booking failed"); c.showBanner("error", err?.message || "Something went wrong saving your free booking. Please contact support.");
    if (c.holdExpiresAt && new Date(c.holdExpiresAt).getTime() <= Date.now()) { c.holdExpiryHandledRef.current = true; c.navigate("/", { replace: true }); }
  } finally { endConfirmation(); if (operation.current()) c.setCreatingFree(false); }
};
export const runPayPalCreateOrder = async ({ paymentActionRef, startSessionCheckout, finalAmount, displayQuoteCurrency, writeStoredPaymentSession, showBanner }) => {
  const releasing = "Payment method release is in progress.";
  if (paymentActionRef.current.cancelling) throw new Error(releasing);
  const session = await startSessionCheckout("paypal");
  if (session?.stale) throw new Error(releasing);
  if (session?.terminal) throw new Error("This payment is already complete.");
  const verified = verifyProviderLaunchPayload({
    provider: "paypal", payload: session?.providerPayload,
    expectedAmount: session?.result?.quote?.netAmount ?? finalAmount,
    expectedCurrency: session?.result?.quote?.currency || displayQuoteCurrency,
  });
  if (!verified.ok) throw new Error(verified.reason);
  if (!writeStoredPaymentSession(session)) {
    showBanner("error", STORAGE_SAVE_CHANGE_ONLY_ERROR, { persistent: true });
    throw new Error(STORAGE_SAVE_CHANGE_ONLY_ERROR);
  }
  return verified.orderId;
};
export const runRazorpayCheckout = async (c) => {
  const operation = c.createPaymentOperation();
  if (!operation.current() || c.payingRzp || c.paymentBusy || c.paymentActionRef.current.cancelling || c.otherCheckoutStarting("razorpay")) return;
  if (!c.canUseRazorpay) { c.showBanner("error", "Razorpay secure checkout is currently unavailable. Please try again shortly."); return; }
  if (!c.rzpReady || !window.Razorpay) { c.showBanner("error", "Payment system is still loading. Please wait a few seconds and try again."); return; }
  if (!c.ensureSlotBeforeAction()) return;
  if (c.isFree) { c.showBanner("error", "This booking is fully discounted. Use the 'Confirm Free Booking' button instead."); return; }
  try {
    if (c.finalAmount <= 0) { c.showBanner("error", "Final amount is zero or negative. Please contact support."); return; }
    c.setPayingRzp(true); c.showBanner("info", "Opening secure checkout...");
    const rzpSession = await c.startSessionCheckout("razorpay", operation);
    if (!operation.current() || rzpSession?.terminal) return;
    const verified = verifyProviderLaunchPayload({ provider: "razorpay", payload: rzpSession.providerPayload, expectedAmount: rzpSession.result?.quote?.netAmount ?? c.finalAmount, expectedCurrency: rzpSession.result?.quote?.currency || c.displayQuoteCurrency });
    if (!verified.ok) { c.showBanner("error", verified.reason); return; }
    if (c.writeStoredPaymentSession && !c.writeStoredPaymentSession(rzpSession)) {
      c.showBanner("error", STORAGE_SAVE_CHANGE_ONLY_ERROR, { persistent: true });
      return;
    }
    const paymentAccessToken = rzpSession.paymentAccessToken;
    new window.Razorpay({
      key: verified.key, amount: verified.amount, currency: verified.currency, name: "Roo Industries", description: `${c.packageTitle} booking`, order_id: verified.orderId,
      method: { card: true, netbanking: true, upi: true, wallet: true }, theme: { color: "#0ea5e9" },
      handler: async (response) => {
        if (!operation.current()) return;
        try {
          await c.finalizeSessionCheckout({ operation, paymentAccessToken: str(paymentAccessToken || c.paymentSession?.paymentAccessToken), providerData: { razorpayOrderId: response.razorpay_order_id, razorpayPaymentId: response.razorpay_payment_id, razorpaySignature: response.razorpay_signature } });
        } catch { if (operation.current()) { console.error("Razorpay booking finalization failed"); c.showBanner("error", "Payment succeeded but something went wrong saving your booking. Please contact support."); } }
      },
      modal: { ondismiss: () => { if (operation.current()) c.showBanner("info", "Checkout closed. Your payment session is still reserved for this method."); } },
    }).open();
  } catch (err) { if (operation.current()) { console.error("Razorpay checkout failed"); c.showBanner("error", err?.message || "Payment could not be processed. Please try again."); } }
  finally { if (operation.current()) c.setPayingRzp(false); }
};
export const createCheckoutFlow = (ctx) => {
  const { bookingData, checkoutRef, paymentActionRef, readStoredCheckout, writeStoredCheckout, readStoredPaymentSession, persistPaymentSession, paymentView } = ctx;
  const navReplace = (loc, search, state) => ctx.navigate({ pathname: loc.pathname, search, hash: loc.hash }, { replace: true, state });
  const patchCheckout = (patch) => {
    const next = mergeLineageCheckout(readStoredCheckout(), checkoutRef.current || bookingData || {}, patch);
    checkoutRef.current = next; writeStoredCheckout(next); syncHistoryCheckoutBooking(next); return next;
  };
  const writeHold = (hold, phase, packagePrice) => {
    if (!hold?.slotHoldId || !hold?.slotHoldToken) return null;
    recordHoldNonceRotation({ slotHoldId: hold.slotHoldId, fromNonce: ctx.sessionHold?.slotHoldToken || checkoutRef.current?.slotHoldToken || bookingData?.slotHoldToken || "", toNonce: hold.slotHoldToken });
    ctx.setSessionHold(hold);
    const { slotHoldId: holdId, slotHoldToken: holdToken } = hold, expiresAt = hold.slotHoldExpiresAt || hold.expiresAt || "";
    const holdState = { holdId, holdToken, expiresAt, startTimeUTC: bookingData.startTimeUTC || "", packageTitle: ctx.packageTitle, ...(packagePrice !== undefined ? { packagePrice } : {}), phase: hold.phase || phase };
    ctx.writeBrowserStorage("sessionStorage", "my_slot_hold", JSON.stringify(holdState));
    window.dispatchEvent(new CustomEvent("hold-state", { detail: holdState }));
    return patchCheckout({ slotHoldId: holdId, slotHoldToken: holdToken, slotHoldExpiresAt: expiresAt });
  };
  const clearDodoNav = (nextCheckout = null, force = false) => clearDodoNavQuery({ dodoReturnHandled: ctx.dodoReturnHandled, latestNavRef: ctx.latestNavRef, navigate: ctx.navigate, nextCheckout, force });
  const ownsHold = (session) => ownsSessionHold(session, ctx);
  const scrubPayload = (token, data) => {
    paymentActionRef.current.seq += 1;
    const cur = readStoredPaymentSession() || paymentView.session;
    if (cur?.paymentAccessToken !== token) return;
    const nextResult = { ...(cur.result || {}), ...(data || {}) };
    const pq = cur.result?.quote, nq = data?.quote;
    if (pq && nq && Number(pq.grossAmount) === Number(nq.grossAmount) && Number(pq.netAmount) === Number(nq.netAmount) && (!pq.currency || !nq.currency || str(pq.currency).toUpperCase() === str(nq.currency).toUpperCase())) {
      nextResult.quote = { ...pq, ...nq };
    }
    persistPaymentSession({ ...cur, providerPayload: cur.providerPayload?.taxInclusive === false ? { taxInclusive: false } : {}, result: nextResult });
  };
  const applyReleasedHold = (hold) => writeHold(hold, "holding", ctx.packagePrice);
  const beginCancel = (createPaymentOperation, blocked, existingOp = null) => {
    const activeSession = readStoredPaymentSession() || ctx.paymentSession, paymentAccessToken = str(activeSession?.paymentAccessToken);
    if (!paymentAccessToken || paymentActionRef.current.cancelling || blocked) return null;
    const operation = existingOp && typeof existingOp.current === "function" ? existingOp : createPaymentOperation(paymentAccessToken);
    if (!operation.current()) return null;
    let cancelSeq = paymentActionRef.current.seq + 1;
    paymentActionRef.current = { seq: cancelSeq, cancelling: true };
    const tokenCurrent = () => ctx.paymentMountedRef.current && str((readStoredPaymentSession() || paymentView.session)?.paymentAccessToken) === operation.token;
    return { activeSession, paymentAccessToken, operation, tokenCurrent, cancelCurrent: () => tokenCurrent() && paymentActionRef.current.seq === cancelSeq, syncSeq: () => (cancelSeq = paymentActionRef.current.seq) };
  };
  const persistCodes = ({ referralCode = bookingData.referralCode || "", couponCode = bookingData.couponCode || "", stripRef = false, extra = {} } = {}) => {
    const { location: loc, navState } = ctx.latestNavRef.current;
    const next = patchCheckout({ referralCode: ctx.stripReservedCode(referralCode), couponCode: ctx.stripReservedCode(couponCode), code: 1, ...extra });
    const params = new URLSearchParams(loc.search);
    if (stripRef) params.delete("ref");
    const search = params.toString() ? `?${params}` : "";
    ctx.skipPreApplyKeyRef.current = `${ctx.activeReservationKeyRef.current}|${next.referralCode}|${next.couponCode}|${search}`;
    navReplace(loc, search, { ...navState, bookingData: next });
  };
  return { applyReleasedHold, clearDodoNav, ownsHold, scrubPayload, beginCancel, persistCodes };
};

export { default as ActiveUpgradeBlocker } from "../components/ActiveUpgradeBlocker";
export { default as PayPalMethodPanel } from "../components/PayPalMethodPanel";
export {
  runChangePaymentMethod,
  runCheckPaymentStatus,
  runFinalizeSessionCheckout,
  runNewPaymentStart,
  runResumePaymentSession,
  runStartSessionCheckout,
} from "./paymentSessionFlow";
