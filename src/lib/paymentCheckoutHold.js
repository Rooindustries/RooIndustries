const str = (v) => String(v || "").trim();
const num = (v) => Number(v || 0);
const NON_RESUMABLE = ["needs_recovery", "finalizing", "captured_client", "captured_webhook"];
export const syncHistoryCheckoutBooking = (bookingData) => {
  try {
    const s = typeof window !== "undefined" ? window.history?.state : null;
    if (s?.usr?.bookingData) window.history.replaceState({ ...s, usr: { ...s.usr, bookingData } }, "");
  } catch {}
};
export const syncCheckoutRef = (ref, data, ready) => {
  const cur = ref.current;
  if (ready && (!cur || (data.slotHoldId && cur.slotHoldId && data.slotHoldId !== cur.slotHoldId))) ref.current = data;
};
const dropDodoQuery = (params) => {
  const had = params.has("dodo_return") || params.has("dodo_cancel");
  params.delete("dodo_return");
  params.delete("dodo_cancel");
  return had;
};
export const stripDodoReturnFromHistory = () => {
  try {
    const u = typeof window !== "undefined" ? new URL(window.location.href) : null;
    if (u && dropDodoQuery(u.searchParams)) window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`);
  } catch {}
};
export const isNonResumablePaymentData = (d) =>
  d?.manualReviewRequired === true || d?.captured === true || NON_RESUMABLE.includes(str(d?.status).toLowerCase());
const runTrackedStart = async (pendingRef, setPending, provider, run) => {
  const entry = { provider };
  setPending([...pendingRef.current, entry]);
  try { return await run(); } finally { setPending(pendingRef.current.filter((item) => item !== entry)); }
};
export const createCheckoutFlow = (ctx) => {
  const { bookingData, checkoutRef, paymentActionRef, readStoredCheckout, writeStoredCheckout } = ctx;
  const { readStoredPaymentSession, persistPaymentSession, paymentView, showBanner } = ctx;
  const navReplace = (loc, search, state) =>
    ctx.navigate({ pathname: loc.pathname, search, hash: loc.hash }, { replace: true, state });
  const patchCheckout = (patch) => {
    const next = { ...(checkoutRef.current || readStoredCheckout() || bookingData || {}), ...patch };
    checkoutRef.current = next;
    writeStoredCheckout(next);
    syncHistoryCheckoutBooking(next);
    return next;
  };
  const writeHold = (hold, phase, packagePrice) => {
    if (!hold?.slotHoldId || !hold?.slotHoldToken) return null;
    ctx.setSessionHold(hold);
    const { slotHoldId: holdId, slotHoldToken: holdToken } = hold;
    const expiresAt = hold.slotHoldExpiresAt || hold.expiresAt || "";
    const holdState = {
      holdId, holdToken, expiresAt, startTimeUTC: bookingData.startTimeUTC || "", packageTitle: ctx.packageTitle,
      ...(packagePrice !== undefined ? { packagePrice } : {}), phase: hold.phase || phase,
    };
    ctx.writeBrowserStorage("sessionStorage", "my_slot_hold", JSON.stringify(holdState));
    window.dispatchEvent(new CustomEvent("hold-state", { detail: holdState }));
    return patchCheckout({ slotHoldId: holdId, slotHoldToken: holdToken, slotHoldExpiresAt: expiresAt });
  };
  const clearDodoNav = (nextCheckout = null, force = false) => {
    if (ctx.dodoReturnHandled) ctx.dodoReturnHandled.current = "";
    const loc = ctx.latestNavRef?.current?.location;
    const query = loc ? new URLSearchParams(loc.search) : null;
    if (!query || (!dropDodoQuery(query) && !force)) return;
    navReplace(loc, query.toString(), nextCheckout ? { ...ctx.latestNavRef.current.navState, bookingData: nextCheckout } : loc.state);
  };
  const ownsHold = (session) => {
    const token = str(session?.result?.refreshedHold?.slotHoldToken || session?.result?.hold?.slotHoldToken);
    if (!token) return true;
    let storedToken = "";
    try { storedToken = JSON.parse(sessionStorage.getItem("my_slot_hold") || "null")?.holdToken; } catch {}
    const current = [
      storedToken, readStoredCheckout()?.slotHoldToken, checkoutRef.current?.slotHoldToken,
      ctx.sessionHold?.slotHoldToken, bookingData?.slotHoldToken,
    ].map(str).find(Boolean) || "";
    return !current || current === token;
  };
  const scrubPayload = (token, data) => {
    paymentActionRef.current.seq += 1;
    const cur = readStoredPaymentSession() || paymentView.session;
    if (cur?.paymentAccessToken !== token) return;
    const providerPayload = cur.providerPayload?.taxInclusive === false ? { taxInclusive: false } : {};
    persistPaymentSession({ ...cur, providerPayload, result: { ...(cur.result || {}), ...(data || {}) } });
  };
  const applyReleasedHold = (hold) => writeHold(hold, "holding", ctx.packagePrice);
  const releaseAbandoned = (resp, token, op, clearPaymentSession) => {
    if (str(resp?.status).toLowerCase() !== "abandoned") return false;
    const owns = ownsHold(readStoredPaymentSession() || ctx.paymentSession);
    const nextCheckout = owns ? applyReleasedHold(resp?.refreshedHold) : null;
    if (owns && !nextCheckout) return false;
    clearPaymentSession("", token);
    op.token = "";
    clearDodoNav(nextCheckout);
    showBanner("success", "Payment method released. Choose a payment method below.");
    return true;
  };
  const beginCancel = (createPaymentOperation, blocked) => {
    const activeSession = readStoredPaymentSession() || ctx.paymentSession;
    const paymentAccessToken = str(activeSession?.paymentAccessToken);
    if (!paymentAccessToken || paymentActionRef.current.cancelling || blocked) return null;
    const operation = createPaymentOperation(paymentAccessToken);
    if (!operation.current()) return null;
    let cancelSeq = paymentActionRef.current.seq + 1;
    paymentActionRef.current = { seq: cancelSeq, cancelling: true };
    const tokenCurrent = () => ctx.paymentMountedRef.current &&
      str((readStoredPaymentSession() || paymentView.session)?.paymentAccessToken) === operation.token;
    const cancelCurrent = () => tokenCurrent() && paymentActionRef.current.seq === cancelSeq;
    const syncSeq = () => (cancelSeq = paymentActionRef.current.seq);
    return { activeSession, paymentAccessToken, operation, tokenCurrent, cancelCurrent, syncSeq };
  };
  const checkStatus = (finalizeSessionCheckout) => {
    if (paymentActionRef.current.cancelling) return;
    finalizeSessionCheckout({ paymentAccessToken: ctx.paymentSession.paymentAccessToken, providerData: {} })
      .catch((e) => showBanner("error", e?.message || "Unable to load payment status. Please try again."));
  };
  const persistCodes = ({
    referralCode = bookingData.referralCode || "", couponCode = bookingData.couponCode || "", stripRef = false,
  } = {}) => {
    const { location: loc, navState } = ctx.latestNavRef.current;
    const next = patchCheckout({
      referralCode: ctx.stripReservedCode(referralCode), couponCode: ctx.stripReservedCode(couponCode),
    });
    const params = new URLSearchParams(loc.search);
    if (stripRef) params.delete("ref");
    const search = params.toString() ? `?${params}` : "";
    ctx.skipPreApplyKeyRef.current = `${next.referralCode}|${next.couponCode}|${search}`;
    navReplace(loc, search, { ...navState, bookingData: next });
  };
  const applyClaimed = (claimed, operation) => {
    const provider = str(claimed?.provider), token = str(claimed?.paymentAccessToken);
    if (!provider || !token) return false;
    const referralCode = ctx.stripReservedCode(claimed.referralCode), couponCode = ctx.stripReservedCode(claimed.couponCode);
    const q = claimed.quote && typeof claimed.quote === "object" ? claimed.quote : null;
    writeHold(claimed.refreshedHold, "payment_pending");
    patchCheckout({ referralCode, couponCode });
    const fingerprint = JSON.stringify({
      packageTitle: ctx.packageTitle, originalOrderId: bookingData.originalOrderId || "",
      startTimeUTC: bookingData.startTimeUTC || "", email: bookingData.email || "", referralCode, couponCode,
    });
    ctx.writeStoredReferral(referralCode);
    ctx.setReferral(referralCode ? { code: referralCode, discountPercent: num(q?.referralDiscountPercent) } : null);
    ctx.setReferralInput(referralCode);
    ctx.setCoupon(couponCode ? {
      code: couponCode, discountType: str(q?.couponDiscountType) || "percent",
      discountPercent: num(q?.couponDiscountPercent), discountValue: num(q?.couponDiscountValue),
      canCombineWithReferral: q?.canCombineWithReferral !== false,
    } : null);
    ctx.setCouponInput(couponCode);
    ctx.setReferralError("");
    ctx.setCouponError("");
    if (q) ctx.setServerQuote(q);
    if (claimed.quoteFingerprint) ctx.setQuoteFingerprint(str(claimed.quoteFingerprint));
    operation.token = token;
    if (provider === "dodo") {
      ctx.dodoReturnHandled.current = token;
      stripDodoReturnFromHistory();
    }
    persistPaymentSession({
      provider, fingerprint, paymentAccessToken: token,
      providerPayload: claimed.providerPayload && typeof claimed.providerPayload === "object" ? claimed.providerPayload : {},
      sessionExpiresAt: str(claimed.sessionExpiresAt), result: claimed,
    });
    return true;
  };
  const resume = async ({ provider, operation, fetchJson, navigateToConfirmation, clearPaymentSession }) => {
    const session = ctx.paymentSession, tok = session.paymentAccessToken, done = (value) => ({ done: true, value });
    const waitErr = "Another payment method is still starting. Please wait a moment and try again.";
    if (ctx.otherCheckoutStarting(provider)) throw new Error(waitErr);
    const resumeSeq = (paymentActionRef.current.seq += 1);
    const runStatus = () => fetchJson("/api/payment/status", {
      method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: "{}",
    });
    const { response, data } = await runTrackedStart(ctx.pendingStartsRef, ctx.setPendingStarts, provider, runStatus);
    const act = paymentActionRef.current;
    if (!operation.current() || act.cancelling || resumeSeq !== act.seq) return done({ terminal: true, stale: true });
    const status = str(data?.status).toLowerCase();
    if (isNonResumablePaymentData(data)) scrubPayload(tok, data);
    if (!response.ok) throw new Error(data?.error || "Unable to verify payment status. Please try again.");
    if (data?.manualReviewRequired === true) {
      showBanner("info", data.recoveryReason, { persistent: true });
      return done({ ...session, providerPayload: {}, result: data, terminal: true });
    }
    if (status === "booked" || status === "email_partial") {
      await navigateToConfirmation("paid", data, operation);
      return done({ ...session, result: data, terminal: true });
    }
    const msg = data?.recoveryReason || "Checkout is being recovered. Check the payment status shortly.";
    if (isNonResumablePaymentData(data)) throw new Error(msg);
    if (!["refunded", "failed", "abandoned"].includes(status)) {
      const stored = readStoredPaymentSession();
      const live = (stored?.paymentAccessToken === tok ? stored : paymentView.session) || session;
      const payload = live?.result?.manualReviewRequired === true ? null : data?.providerPayload;
      if (!payload || (!payload.checkoutUrl && !payload.orderId)) return done(live);
      const refreshed = { ...live, providerPayload: { ...(live.providerPayload || {}), ...payload } };
      persistPaymentSession(refreshed);
      return done(refreshed);
    }
    if (ownsHold(session) && !(status === "abandoned" && applyReleasedHold(data?.refreshedHold))) {
      const handled = clearPaymentSession(status, tok);
      operation.token = "";
      if (handled) return done({ ...session, result: data, terminal: true });
      throw new Error(data?.recoveryReason || "This payment session is no longer payable.");
    }
    clearPaymentSession("", tok);
    operation.token = "";
    stripDodoReturnFromHistory();
    return { done: false };
  };
  return {
    applyReleasedHold, clearDodoNav, ownsHold, scrubPayload,
    releaseAbandoned, beginCancel, checkStatus, persistCodes, applyClaimed, resume,
  };
};
