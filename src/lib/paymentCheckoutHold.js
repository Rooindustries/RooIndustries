import { fetchJsonWithTimeout } from "./clientRequest";
import { extractTokenNonce } from "./checkoutConfirmation";
import { CODE_VALIDATION_UNAVAILABLE_MESSAGE, formatCouponValue, normalizeCurrencyCode, sanitizeCouponForCheckout, sanitizeReferralForCheckout, toSubunitsClient } from "./checkoutCodes";
import { beginPendingPaymentStart, clearDodoNavQuery, endPendingPaymentStart, isNonResumablePaymentData, mergeLineageCheckout, ownsSessionHold, paymentSessionMatchesBookingLineage, paymentSessionMatchesCheckout, stripDodoReturnFromHistory, syncCheckoutRef, syncHistoryCheckoutBooking } from "./checkoutSessionGuard";
import { areSameLineageNonces, markReservationTerminal, recordHoldNonceRotation, reservationScopeKey } from "./reservationScope";
const str = (v) => String(v || "").trim();
const num = (v) => Number(v || 0);
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
export { isNonResumablePaymentData, stripDodoReturnFromHistory, syncCheckoutRef, syncHistoryCheckoutBooking };
export const runLegacyDodoStatusCheck = async ({ token, operation, fetchJson, setBusy, onBooked, onManualReview, onTerminalClear }) => {
  setBusy(true);
  try {
    const { response, data } = await fetchJson("/api/payment/status", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
    if (!operation.current()) return;
    const st = str(data?.status).toLowerCase();
    if (response.ok && (st === "booked" || st === "email_partial")) await onBooked(data, operation);
    else if (response.ok && data?.manualReviewRequired === true) onManualReview(data.recoveryReason);
    else if (response.ok && ["failed", "abandoned", "refunded"].includes(st) && data?.terminalOutcomeComplete !== false) onTerminalClear(st, token);
  } finally { if (operation.current()) setBusy(false); }
};
export const verifyProviderLaunchPayload = ({ provider, payload, expectedAmount, expectedCurrency }) => {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "Missing provider order details." };
  const cur = normalizeCurrencyCode(expectedCurrency), sub = toSubunitsClient(expectedAmount, cur);
  const pCur = str(payload.currency).toUpperCase(), pAmt = Number(payload.amount || 0), orderId = str(payload.orderId);
  if (provider === "razorpay") {
    const key = str(payload.key || payload.keyId);
    return orderId && key && pCur === cur && Number.isSafeInteger(pAmt) && pAmt === sub ? { ok: true, orderId, key, currency: pCur, amount: pAmt } : { ok: false, reason: "Payment order details did not match the confirmed quote." };
  }
  if (provider === "paypal") return orderId && pCur === cur && Number.isSafeInteger(pAmt) && pAmt === sub ? { ok: true, orderId, currency: pCur, amount: pAmt } : { ok: false, reason: "PayPal order details did not match the confirmed quote." };
  return { ok: true };
};
export const runStartSessionCheckout = async ({ provider, operation, startSnap, c, flow }) => {
  if (!operation.current() || c.paymentActionRef.current.cancelling) return { terminal: true, stale: true };
  const startedScopeKey = c.currentScopeKeyRef.current;
  if (c.paymentSession?.provider === provider && paymentSessionMatchesCheckout(c.paymentSession?.fingerprint, c.checkoutFingerprint) &&
      paymentSessionMatchesBookingLineage(c.paymentSession, c.bookingData) && c.paymentSession?.paymentAccessToken && c.paymentSession?.providerPayload) {
    const resumed = await flow.resume({ provider, operation, fetchJson: c.fetchJson, navigateToConfirmation: c.navigateToConfirmation, clearPaymentSession: c.clearPaymentSession });
    if (resumed.done) return resumed.value;
  }
  if (c.sessionStartRef.current?.provider === provider && c.sessionStartRef.current.operation.current()) return c.sessionStartRef.current.promise;
  if (c.otherCheckoutStarting(provider)) throw new Error("Another payment method is still starting. Please wait a moment and try again.");
  c.manualCodeAllowedRef.current = false;
  const promise = (async () => {
    if (c.quoteLoading || !c.quoteFingerprint) throw new Error("Checkout price is still being confirmed. Please try again.");
    const body = await c.paymentStartBody({ operation, provider, quoteFingerprint: c.quoteFingerprint, salesAttribution: c.bookingData.salesAttribution, startSnap, buildPayload: c.buildCheckoutPayload });
    if (!body) return { terminal: true, stale: true };
    const { response, data } = await c.fetchJson("/api/payment/start", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const moment = c.eventMoment(), booked = response.ok && data?.ok && ["booked", "email_partial"].includes(str(data.status).toLowerCase());
    if (booked) c.trackConfirmedPurchase(data.analyticsReceipt);
    if (response.ok && data?.ok) await c.countCheckoutStartOnce(data, provider, () => c.trackCheckoutSessionStarted({ packageTitle: c.bookingData.packageTitle, price: data.quote?.netAmount, provider, moment }));
    if (!operation.current() || c.paymentActionRef.current.cancelling || c.currentScopeKeyRef.current !== startedScopeKey) return { terminal: true, stale: true };
    if (!response.ok || !data?.ok) {
      if (flow.applyClaimed(data?.claimedSession || data?.lockedSession, operation)) throw new Error("A payment session is already open for this reservation. Resume it or click Change payment method.");
      const isMismatch = response.status === 409 && ["quote_changed", "quote_fingerprint_mismatch", "quote_fingerprint_required"].includes(str(data?.code));
      if (isMismatch && provider !== "free") c.selectQuoteProvider(provider, startedScopeKey);
      if (data?.quote) c.setServerQuote(data.quote);
      if (data?.quoteFingerprint || data?.fingerprint) c.setQuoteFingerprint(str(data.quoteFingerprint || data.fingerprint));
      if (data?.providers) c.setProviderConfig((cur) => ({ ...cur, ...data.providers }));
      if (isMismatch) throw new Error("The price changed. Review the updated total and click again.");
      throw new Error(data?.error || "Unable to start payment.");
    }
    if (provider !== "free") c.selectQuoteProvider(provider, startedScopeKey);
    if (data.quote) c.setServerQuote(data.quote);
    if (data.quoteFingerprint || data.fingerprint) c.setQuoteFingerprint(str(data.quoteFingerprint || data.fingerprint));
    const r = data.refreshedHold || data.hold || null;
    let nextCheckout = c.bookingData;
    if (r?.slotHoldId && r?.slotHoldToken) {
      recordHoldNonceRotation({ slotHoldId: r.slotHoldId, fromNonce: c.sessionHold?.slotHoldToken || c.checkoutRef.current?.slotHoldToken || c.bookingData?.slotHoldToken || "", toNonce: r.slotHoldToken });
      c.setSessionHold(r);
      nextCheckout = mergeLineageCheckout(c.readStoredCheckout(), c.checkoutRef.current || c.bookingData, { slotHoldId: r.slotHoldId, slotHoldToken: r.slotHoldToken, slotHoldExpiresAt: r.slotHoldExpiresAt || r.expiresAt || "" });
      c.checkoutRef.current = nextCheckout; c.writeStoredCheckout(nextCheckout); syncHistoryCheckoutBooking(nextCheckout);
      try {
        const holdState = { holdId: r.slotHoldId, holdToken: r.slotHoldToken, expiresAt: r.slotHoldExpiresAt || r.expiresAt || "", startTimeUTC: c.bookingData.startTimeUTC || "", packageTitle: c.packageTitle, phase: r.phase || "payment_pending" };
        c.writeBrowserStorage("sessionStorage", "my_slot_hold", JSON.stringify(holdState));
        window.dispatchEvent(new CustomEvent("hold-state", { detail: holdState }));
      } catch {}
    }
    const nextSession = { provider, fingerprint: c.checkoutFingerprint, scopeKey: reservationScopeKey(nextCheckout) || startedScopeKey, paymentAccessToken: str(data.paymentAccessToken), providerPayload: data.providerPayload || {}, sessionExpiresAt: str(data.sessionExpiresAt), result: data };
    if (provider !== "free" && booked) { await c.showConfirmation("paid", data, operation); return { ...nextSession, terminal: true }; }
    if (provider !== "free") {
      operation.token = nextSession.paymentAccessToken;
      if (provider === "dodo") { c.dodoReturnHandled.current = nextSession.paymentAccessToken; stripDodoReturnFromHistory(); }
      c.persistPaymentSession(nextSession);
    }
    return nextSession;
  })();
  const pendingStartId = beginPendingPaymentStart(c.holdForGuard.holdId, c.holdForGuard.holdToken);
  c.sessionStartRef.current = { provider, promise, operation };
  c.setPendingStarts([...c.pendingStartsRef.current, { provider, promise }]);
  try { return await promise; } catch (error) {
    if (!operation.current()) return { terminal: true, stale: true };
    if (!c.readStoredPaymentSession()) clearDodoNavQuery({ dodoReturnHandled: c.dodoReturnHandled, latestNavRef: c.latestNavRef, navigate: c.navigate, nextCheckout: c.checkoutRef.current });
    throw error;
  } finally {
    endPendingPaymentStart(pendingStartId);
    if (c.sessionStartRef.current?.promise === promise) c.sessionStartRef.current = null;
    c.setPendingStarts(c.pendingStartsRef.current.filter((s) => s.promise !== promise));
  }
};
export const runFinalizeSessionCheckout = async ({ paymentAccessToken, providerData, operation, captured = false, c, flow }) => {
  if (!captured && !operation.current()) return null;
  c.paymentActionRef.current.seq += 1; c.manualCodeAllowedRef.current = false;
  if (operation.current()) c.setPaymentStatusBusy(true);
  const poll = async () => {
    const deadline = Date.now() + c.pollTimeoutMs;
    while (Date.now() < deadline) {
      if (!operation.current()) return null;
      let response, data;
      try { ({ response, data } = await c.fetchJson("/api/payment/status", { method: "POST", headers: { Authorization: `Bearer ${paymentAccessToken}`, "Content-Type": "application/json" }, body: "{}" }, Math.min(c.fetchTimeoutMs, deadline - Date.now()))); }
      catch (error) { if (!operation.current()) return null; if (error?.name === "AbortError") continue; throw error; }
      if (!operation.current()) return null;
      if (isNonResumablePaymentData(data)) flow.scrubPayload(paymentAccessToken, data);
      if (!response.ok) throw new Error(data?.error || "Unable to load payment status.");
      const st = str(data?.status).toLowerCase();
      if (data?.manualReviewRequired === true || ["booked", "email_partial", "refunded", "failed", "abandoned"].includes(st)) return data;
      const rem = deadline - Date.now();
      if (rem > 0) await new Promise((r) => setTimeout(r, Math.min(c.pollIntervalMs, rem)));
    }
    throw new Error("Timed out waiting for payment confirmation.");
  };
  try {
    const { response, data } = await c.fetchJson("/api/payment/finalize", { method: "POST", headers: { Authorization: `Bearer ${paymentAccessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ providerData }) });
    if (!operation.current()) return null;
    if (isNonResumablePaymentData(data)) flow.scrubPayload(paymentAccessToken, data);
    const status = str(data?.status).toLowerCase(), isFinalizedStatus = status === "booked" || status === "email_partial";
    if (response.ok && data?.manualReviewRequired === true) { c.showBanner("info", data.recoveryReason, { persistent: true }); return data; }
    if (!response.ok && response.status !== 202 && !isFinalizedStatus) throw new Error(data?.error || "Unable to finalize payment.");
    if (isFinalizedStatus) { await c.navigateToConfirmation("paid", data, operation); return data; }
    const finishNonBooked = (payload, st, fallbackMsg) => {
      if (flow.releaseAbandoned(payload, paymentAccessToken, operation, c.clearPaymentSession)) return payload;
      const handled = c.clearPaymentSession(st, paymentAccessToken);
      operation.token = "";
      if (handled) return payload;
      throw new Error(payload?.recoveryReason || payload?.error || fallbackMsg);
    };
    if (["needs_recovery", "finalizing", "started"].includes(status)) {
      c.showBanner("info", "Finalizing your payment and booking...");
      const settled = await poll();
      if (!operation.current()) return null;
      const settledStatus = str(settled?.status).toLowerCase();
      if (settled?.manualReviewRequired === true) { flow.scrubPayload(paymentAccessToken, settled); c.showBanner("info", settled.recoveryReason, { persistent: true }); return settled; }
      if (settledStatus === "booked" || settledStatus === "email_partial") { await c.navigateToConfirmation("paid", settled, operation); return settled; }
      return finishNonBooked(settled, settledStatus, "Payment could not be finalized.");
    }
    return finishNonBooked(data, status, "Payment finalization failed.");
  } catch (error) { if (!operation.current()) return null; throw error; }
  finally { if (operation.current()) c.setPaymentStatusBusy(false); }
};
export const runDodoCheckout = async (c) => {
  const operation = c.createPaymentOperation();
  if (!operation.current() || c.payingDodo || c.paymentBusy || c.paymentActionRef.current.cancelling || c.otherCheckoutStarting("dodo") || !c.ensureSlotBeforeAction()) return;
  c.setPayingDodo(true);
  try {
    const session = await c.startSessionCheckout("dodo", operation);
    if (!operation.current() || session?.terminal) return;
    if (!session?.providerPayload?.checkoutUrl) throw new Error("Checkout is being recovered. Check the payment status shortly.");
    const r = session.result?.refreshedHold || session.result?.hold || c.sessionHold;
    const ret = { ...(c.checkoutRef.current || c.bookingData), ...(r?.slotHoldId && r?.slotHoldToken ? { slotHoldId: r.slotHoldId, slotHoldToken: r.slotHoldToken, slotHoldExpiresAt: r.slotHoldExpiresAt || r.expiresAt || "" } : {}) };
    if (!c.writeBrowserStorage("sessionStorage", c.checkoutKey, JSON.stringify(ret)) || !c.writeStoredPaymentSession(session)) {
      c.showBanner("error", "Your browser could not save this payment session. Checkout has stayed here so you can check its status or change payment method. Allow browser storage and try again to open checkout.", { persistent: true });
      return;
    }
    stripDodoReturnFromHistory(); window.location.assign(session.providerPayload.checkoutUrl);
  } catch (error) {
    if (!operation.current()) return;
    c.showBanner("error", (error?.name === "AbortError" || error?.name === "TimeoutError") ? "Checkout timed out. Please try again." : error.message || "Unable to open checkout.", { persistent: true });
  } finally { if (operation.current()) c.setPayingDodo(false); }
};
export const runValidateReferral = async (code, c, flow) => {
  const stillHere = () => c.manualCodeAllowedRef.current && (!c.currentScopeKeyRef || c.currentScopeKeyRef.current === c.scopeKey);
  if (!stillHere() || c.validating || c.validatingCoupon) return;
  const normalizedCode = str(code);
  if (!normalizedCode) {
    c.setReferral(null); c.setReferralError(""); c.writeStoredReferral("");
    flow.persistCodes({ referralCode: "", couponCode: c.coupon?.code || "", stripRef: true }); return;
  }
  try {
    c.setValidating(true); c.setReferralError("");
    const result = await resolveCheckoutCode(normalizedCode, c.packageTitle);
    if (!stillHere()) return;
    if (!result.ok) {
      if (!result.unavailable) { c.setReferral(null); c.writeStoredReferral(""); flow.persistCodes({ referralCode: "", couponCode: c.coupon?.code || "", stripRef: true }); }
      c.setReferralError(result.unavailable ? result.error : "Invalid or inactive referral code."); return;
    }
    if (result.type === "coupon") {
      const safeCoupon = sanitizeCouponForCheckout(result.value);
      if (!safeCoupon) { c.setReferralError("Invalid or inactive referral code."); return; }
      if (safeCoupon.canCombineWithReferral === false && c.referral) { c.setCouponError("This coupon can't be used together with a referral discount."); return; }
      c.setCoupon(safeCoupon); c.setCouponInput(safeCoupon.code); c.setReferralInput(c.referral?.code || "");
      c.showBanner("info", "This code is a coupon, so it was applied as a coupon."); return;
    }
    const safeReferral = sanitizeReferralForCheckout(result.value);
    if (!safeReferral) { c.setReferralError("Invalid or inactive referral code."); return; }
    c.setReferral(safeReferral); c.setReferralInput(safeReferral.code); c.writeStoredReferral(safeReferral.code);
    const nextCouponCode = c.coupon?.canCombineWithReferral === false ? "" : c.coupon?.code || "";
    if (c.coupon?.canCombineWithReferral === false) { c.setCoupon(null); c.setCouponInput(""); c.showBanner("info", "Current coupon can't be combined with referrals and was removed."); }
    flow.persistCodes({ referralCode: safeReferral.code, couponCode: nextCouponCode, stripRef: true });
  } catch { if (stillHere()) { console.error("Referral validation failed"); c.setReferralError("We couldn't validate that referral code. Please try again."); } }
  finally { c.setValidating(false); }
};
export const runValidateCoupon = async (code, c, flow) => {
  const stillHere = () => c.manualCodeAllowedRef.current && (!c.currentScopeKeyRef || c.currentScopeKeyRef.current === c.scopeKey);
  if (!stillHere() || c.validating || c.validatingCoupon) return;
  const normalizedCode = str(code);
  if (!normalizedCode) { c.setCoupon(null); c.setCouponError(""); return; }
  try {
    c.setValidatingCoupon(true); c.setCouponError("");
    const result = await resolveCheckoutCode(normalizedCode, c.packageTitle);
    if (!stillHere()) return;
    if (!result.ok) { c.setCoupon(null); c.setCouponError(result.error || "Invalid coupon code."); return; }
    if (result.type === "referral") {
      const safeReferral = sanitizeReferralForCheckout(result.value);
      if (!safeReferral) { c.setCouponError("Invalid coupon code."); return; }
      c.setReferral(safeReferral); c.setReferralInput(safeReferral.code); c.writeStoredReferral(safeReferral.code);
      c.setCoupon(null); c.setCouponInput("");
      flow.persistCodes({ referralCode: safeReferral.code, couponCode: "", stripRef: true });
      c.showBanner("info", "This code is a referral, so it was applied as a referral."); return;
    }
    const safeCoupon = sanitizeCouponForCheckout(result.value);
    if (!safeCoupon) { c.setCouponError("Invalid coupon code."); return; }
    if (safeCoupon.canCombineWithReferral === false && c.referral) { c.setCoupon(null); c.setCouponError("This coupon can't be used together with a referral discount. Remove the referral or use a different coupon."); return; }
    c.setCoupon(safeCoupon); c.setCouponInput(safeCoupon.code);
    c.showBanner("success", `Coupon applied: ${formatCouponValue(safeCoupon)}`);
  } catch { if (stillHere()) { console.error("Coupon validation failed"); c.setCoupon(null); c.setCouponError("We couldn't validate that coupon code. Please try again."); } }
  finally { c.setValidatingCoupon(false); }
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
const runTrackedStart = async (pendingRef, setPending, provider, run) => {
  const entry = { provider }; setPending([...pendingRef.current, entry]);
  try { return await run(); } finally { setPending(pendingRef.current.filter((item) => item !== entry)); }
};
export const createCheckoutFlow = (ctx) => {
  const { bookingData, checkoutRef, paymentActionRef, readStoredCheckout, writeStoredCheckout, readStoredPaymentSession, persistPaymentSession, paymentView, showBanner } = ctx;
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
    persistPaymentSession({ ...cur, providerPayload: cur.providerPayload?.taxInclusive === false ? { taxInclusive: false } : {}, result: { ...(cur.result || {}), ...(data || {}) } });
  };
  const applyReleasedHold = (hold) => writeHold(hold, "holding", ctx.packagePrice);
  const releaseAbandoned = (resp, token, op, clearPaymentSession) => {
    if (str(resp?.status).toLowerCase() !== "abandoned") return false;
    const owns = ownsHold(readStoredPaymentSession() || ctx.paymentSession), nextCheckout = owns ? applyReleasedHold(resp?.refreshedHold) : null;
    if (owns && !nextCheckout) return false;
    clearPaymentSession("", token); op.token = ""; clearDodoNav(nextCheckout);
    showBanner("success", "Payment method released. Choose a payment method below."); return true;
  };
  const beginCancel = (createPaymentOperation, blocked) => {
    const activeSession = readStoredPaymentSession() || ctx.paymentSession, paymentAccessToken = str(activeSession?.paymentAccessToken);
    if (!paymentAccessToken || paymentActionRef.current.cancelling || blocked) return null;
    const operation = createPaymentOperation(paymentAccessToken);
    if (!operation.current()) return null;
    let cancelSeq = paymentActionRef.current.seq + 1;
    paymentActionRef.current = { seq: cancelSeq, cancelling: true };
    const tokenCurrent = () => ctx.paymentMountedRef.current && str((readStoredPaymentSession() || paymentView.session)?.paymentAccessToken) === operation.token;
    return { activeSession, paymentAccessToken, operation, tokenCurrent, cancelCurrent: () => tokenCurrent() && paymentActionRef.current.seq === cancelSeq, syncSeq: () => (cancelSeq = paymentActionRef.current.seq) };
  };
  const checkStatus = (finalizeSessionCheckout) => {
    if (!paymentActionRef.current.cancelling) finalizeSessionCheckout({ paymentAccessToken: ctx.paymentSession.paymentAccessToken, providerData: {} }).catch((e) => showBanner("error", e?.message || "Unable to load payment status. Please try again."));
  };
  const persistCodes = ({ referralCode = bookingData.referralCode || "", couponCode = bookingData.couponCode || "", stripRef = false } = {}) => {
    const { location: loc, navState } = ctx.latestNavRef.current;
    const next = patchCheckout({ referralCode: ctx.stripReservedCode(referralCode), couponCode: ctx.stripReservedCode(couponCode), code: 1 });
    const params = new URLSearchParams(loc.search);
    if (stripRef) params.delete("ref");
    const search = params.toString() ? `?${params}` : "";
    ctx.skipPreApplyKeyRef.current = `${ctx.activeReservationKeyRef.current}|${next.referralCode}|${next.couponCode}|${search}`;
    navReplace(loc, search, { ...navState, bookingData: next });
  };
  const applyClaimed = (claimed, operation) => {
    const provider = str(claimed?.provider), token = str(claimed?.paymentAccessToken);
    if (!provider || !token) return false;
    const referralCode = ctx.stripReservedCode(claimed.referralCode), couponCode = ctx.stripReservedCode(claimed.couponCode);
    const q = claimed.quote && typeof claimed.quote === "object" ? claimed.quote : null;
    writeHold(claimed.refreshedHold, "payment_pending");
    const nextCheckout = patchCheckout({ referralCode, couponCode, code: 1 });
    const fingerprint = JSON.stringify({ packageTitle: ctx.packageTitle, originalOrderId: bookingData.originalOrderId || "", startTimeUTC: bookingData.startTimeUTC || "", email: bookingData.email || "", referralCode, couponCode });
    ctx.writeStoredReferral(referralCode);
    ctx.setReferral(referralCode ? { code: referralCode, discountPercent: num(q?.referralDiscountPercent) } : null); ctx.setReferralInput(referralCode);
    ctx.setCoupon(couponCode ? { code: couponCode, discountType: str(q?.couponDiscountType) || "percent", discountPercent: num(q?.couponDiscountPercent), discountValue: num(q?.couponDiscountValue), canCombineWithReferral: q?.canCombineWithReferral !== false } : null);
    ctx.setCouponInput(couponCode); ctx.setReferralError(""); ctx.setCouponError("");
    if (q) ctx.setServerQuote(q);
    if (claimed.quoteFingerprint) ctx.setQuoteFingerprint(str(claimed.quoteFingerprint));
    operation.token = token;
    if (provider === "dodo") { ctx.dodoReturnHandled.current = token; stripDodoReturnFromHistory(); }
    persistPaymentSession({ provider, fingerprint, scopeKey: reservationScopeKey(nextCheckout), paymentAccessToken: token, providerPayload: claimed.providerPayload && typeof claimed.providerPayload === "object" ? claimed.providerPayload : {}, sessionExpiresAt: str(claimed.sessionExpiresAt), result: claimed });
    return true;
  };
  const resume = async ({ provider, operation, fetchJson, navigateToConfirmation, clearPaymentSession }) => {
    const session = ctx.paymentSession, tok = session.paymentAccessToken, done = (value) => ({ done: true, value });
    if (ctx.otherCheckoutStarting(provider)) throw new Error("Another payment method is still starting. Please wait a moment and try again.");
    const resumeSeq = (paymentActionRef.current.seq += 1);
    const { response, data } = await runTrackedStart(ctx.pendingStartsRef, ctx.setPendingStarts, provider, () => fetchJson("/api/payment/status", { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: "{}" }));
    const act = paymentActionRef.current;
    if (!operation.current() || act.cancelling || resumeSeq !== act.seq) return done({ terminal: true, stale: true });
    const status = str(data?.status).toLowerCase();
    if (isNonResumablePaymentData(data)) scrubPayload(tok, data);
    if (!response.ok) throw new Error(data?.error || "Unable to verify payment status. Please try again.");
    if (data?.manualReviewRequired === true) { showBanner("info", data.recoveryReason, { persistent: true }); return done({ ...session, providerPayload: {}, result: data, terminal: true }); }
    if (status === "booked" || status === "email_partial") { await navigateToConfirmation("paid", data, operation); return done({ ...session, result: data, terminal: true }); }
    if (data?.quoteFingerprintValid === false) { showBanner("error", "This payment session cannot be resumed. Check its status instead.", { persistent: true }); return done({ ...session, result: data, terminal: true }); }
    if (isNonResumablePaymentData(data)) throw new Error(data?.recoveryReason || "Checkout is being recovered. Check the payment status shortly.");
    if (!["refunded", "failed", "abandoned"].includes(status)) {
      if (data?.providerOrderReady === false) { showBanner("info", "This payment session is still preparing its order. Check its status shortly.", { persistent: true }); return done({ ...session, result: data, terminal: true }); }
      const stored = readStoredPaymentSession(), live = (stored?.paymentAccessToken === tok ? stored : paymentView.session) || session;
      const payload = live?.result?.manualReviewRequired === true ? null : data?.providerPayload;
      if (!payload || typeof payload !== "object") return done(live);
      const nextPayload = live.providerPayload?.taxInclusive === false && payload.taxInclusive === undefined ? { taxInclusive: false, ...payload } : { ...payload };
      const refreshed = { ...live, providerPayload: nextPayload, result: { ...(live.result || {}), ...(data?.quote ? { quote: data.quote } : {}) } };
      persistPaymentSession(refreshed); return done(refreshed);
    }
    if (ownsHold(session) && !(status === "abandoned" && applyReleasedHold(data?.refreshedHold))) {
      const handled = clearPaymentSession(status, tok); operation.token = "";
      if (handled) return done({ ...session, result: data, terminal: true });
      throw new Error(data?.recoveryReason || "This payment session is no longer payable.");
    }
    clearPaymentSession("", tok); operation.token = ""; stripDodoReturnFromHistory(); return { done: false };
  };
  return { applyReleasedHold, clearDodoNav, ownsHold, scrubPayload, releaseAbandoned, beginCancel, checkStatus, persistCodes, applyClaimed, resume };
};

export { default as PayPalMethodPanel } from "../components/PayPalMethodPanel";
