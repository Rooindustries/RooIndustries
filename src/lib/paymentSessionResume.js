import {
  extractPaymentLockId, isNonResumablePaymentData, readStoredPaymentSessionState,
  stripDodoReturnFromHistory,
} from "./checkoutSessionGuard";
import {
  allocatePaymentSessionSeq, canWriteRefreshedHold, commitPaymentSessionState,
  fetchPaymentJson, isAffirmativeTerminalRelease, readLiveSlotHold, releasePaymentSessionLock, verifyProviderLaunchPayload,
} from "./paymentSessionLocks";
import { markReservationTerminal } from "./reservationScope";

const normalizeCode = (v) => String(v || "").trim().toLowerCase();
const str = (v) => String(v || "").trim();

const mergeSessionResult = (prev, next) => {
  const merged = { ...(prev || {}), ...(next || {}) };
  if (prev?.quote && typeof prev.quote === "object" && next?.quote && typeof next.quote === "object") {
    const pCur = str(prev.quote.currency).toUpperCase(), nCur = str(next.quote.currency).toUpperCase();
    const sameTotals = Number(prev.quote.grossAmount) === Number(next.quote.grossAmount) && Number(prev.quote.netAmount) === Number(next.quote.netAmount) && (!pCur || !nCur || pCur === nCur);
    merged.quote = sameTotals ? { ...prev.quote, ...next.quote } : next.quote;
  }
  return merged;
};

const runTrackedStart = async (pendingRef, setPending, provider, run) => {
  const entry = { provider };
  setPending([...pendingRef.current, entry]);
  try { return await run(); } finally { setPending(pendingRef.current.filter((item) => item !== entry)); }
};

const canReopenResumedSession = ({
  provider, responseOk, data, storedSession, storedFingerprint, referralCode, couponCode,
}) => {
  if (!responseOk || data?.ok === false) return { ok: false };
  const status = normalizeCode(data?.status);
  if (status !== "started" || data?.providerOrderReady !== true) return { ok: false };
  if (data?.quoteFingerprintValid === false || !str(data?.quoteFingerprint)) return { ok: false };
  const quote = data?.quote;
  const net = Number(quote?.netAmount);
  const currency = str(quote?.currency).toUpperCase();
  if (!Number.isFinite(net) || net <= 0 || !/^[A-Z]{3}$/.test(currency)) return { ok: false };
  const curRef = normalizeCode(referralCode), curCpn = normalizeCode(couponCode);
  const storedRef = normalizeCode(storedFingerprint?.referralCode), storedCpn = normalizeCode(storedFingerprint?.couponCode);
  const authRef = normalizeCode(quote?.effectiveReferralCode ?? quote?.referralCode ?? storedFingerprint?.referralCode);
  const authCpn = normalizeCode(quote?.couponCode ?? storedFingerprint?.couponCode);
  if (storedRef !== authRef || storedCpn !== authCpn) return { ok: false };
  if ((curRef && curRef !== authRef) || (curCpn && curCpn !== authCpn)) return { ok: false };
  const livePayload = data?.providerPayload || null;
  const verified = verifyProviderLaunchPayload({ provider, payload: livePayload, expectedAmount: net, expectedCurrency: currency });
  if (!verified.ok) return { ok: false, reason: verified.reason };
  if (provider === "dodo") {
    const sOrd = str(storedSession?.providerPayload?.orderId), lOrd = str(livePayload?.orderId);
    if (sOrd && lOrd && sOrd !== lOrd) return { ok: false };
    const sTag = str(storedSession?.providerPayload?.dodoReturnTag || storedSession?.dodoReturnTag);
    const lTag = str(livePayload?.dodoReturnTag);
    if (sTag && lTag && sTag !== lTag) return { ok: false };
  }
  return { ok: true };
};

export async function runResumePaymentSession(ctx) {
  const {
    provider, operation, storedActive, currentScopeKeyRef, fetchJson = fetchPaymentJson, showBanner,
    navigateToConfirmation, clearPaymentSession, parseCheckoutFingerprint,
    referral, coupon, persistPaymentSession, pendingStartsRef, setPendingStarts,
    otherCheckoutStarting, paymentActionRef, paymentMountedRef, paymentView, flow,
  } = ctx;
  if (otherCheckoutStarting(provider)) {
    throw new Error("Another payment method is still starting. Please wait a moment and try again.");
  }
  const resumeScopeKey = storedActive.scopeKey || currentScopeKeyRef.current;
  const token = storedActive.paymentAccessToken;
  const statusSeq = allocatePaymentSessionSeq();
  const resumeSeq = (paymentActionRef.current.seq += 1);
  const { response, data } = await runTrackedStart(pendingStartsRef, setPendingStarts, provider, () =>
    fetchJson("/api/payment/status", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    })
  );
  const resumedStatus = normalizeCode(data?.status);
  const act = paymentActionRef.current;
  const affirmativeRelease = ["refunded", "failed", "abandoned"].includes(resumedStatus) && isAffirmativeTerminalRelease(response.ok, data);
  const completedBooking = response.ok && (resumedStatus === "booked" || resumedStatus === "email_partial") && data?.cleanupPending !== true && data?.manualReviewRequired !== true;
  if (affirmativeRelease || completedBooking) markReservationTerminal(resumeScopeKey, resumedStatus);
  if (affirmativeRelease) {
    const wasCurrent = operation.current() && !act.cancelling && resumeSeq === act.seq;
    const owns = flow.ownsHold(storedActive);
    const restored = wasCurrent && resumedStatus === "abandoned" && owns ? flow.applyReleasedHold(data?.refreshedHold) : null;
    releasePaymentSessionLock({ token, scopeKey: resumeScopeKey, seq: statusSeq });
    if (!wasCurrent) {
      const liveViewToken = str(paymentView?.session?.paymentAccessToken);
      if (paymentMountedRef?.current && !act.cancelling && resumeSeq === act.seq && liveViewToken && extractPaymentLockId(liveViewToken) === extractPaymentLockId(token)) {
        clearPaymentSession("", token, { alreadyReleased: true });
      }
      return { terminal: true, stale: true };
    }
    if (owns && !restored) {
      const handled = clearPaymentSession(resumedStatus, token, { alreadyReleased: true });
      operation.token = "";
      if (handled) return { ...storedActive, result: data, terminal: true };
      throw new Error(data?.recoveryReason || "This payment session is no longer payable.");
    }
    clearPaymentSession("", token, { alreadyReleased: true });
    operation.token = "";
    stripDodoReturnFromHistory();
    return null;
  }
  if (!operation.current() || act.cancelling || resumeSeq !== act.seq) return { terminal: true, stale: true };
  if (isNonResumablePaymentData(data)) flow.scrubPayload(token, data);
  if (!response.ok) throw new Error(data?.error || "Unable to verify payment status. Please try again.");
  if (data?.manualReviewRequired === true) {
    showBanner("info", data.recoveryReason, { persistent: true });
    return { ...storedActive, providerPayload: {}, result: data, terminal: true };
  }
  if (resumedStatus === "booked" || resumedStatus === "email_partial") {
    if (data?.cleanupPending === true) { showBanner("info", data.recoveryReason || "Payment is still being verified.", { persistent: true }); return { ...storedActive, result: data, terminal: true }; }
    await navigateToConfirmation("paid", data, operation);
    return { ...storedActive, result: data, terminal: true };
  }
  if (["failed", "abandoned", "refunded"].includes(resumedStatus)) {
    showBanner("info", data?.recoveryReason || data?.error || "Payment is still being verified.", { persistent: true });
    return { ...storedActive, result: data, terminal: true };
  }
  if (data?.quoteFingerprintValid === false) {
    showBanner("error", "This payment session cannot be resumed. Check its status instead.", { persistent: true });
    return { ...storedActive, result: data, terminal: true };
  }
  if (isNonResumablePaymentData(data)) {
    throw new Error(data?.recoveryReason || "Checkout is being recovered. Check the payment status shortly.");
  }

  const livePayload = data?.providerPayload || null;
  const reopen = canReopenResumedSession({
    provider, responseOk: response.ok, data, storedSession: storedActive,
    storedFingerprint: parseCheckoutFingerprint(storedActive.fingerprint),
    referralCode: referral?.code, couponCode: coupon?.code,
  });
  if (reopen.ok) {
    const nextPayload = storedActive.providerPayload?.taxInclusive === false && livePayload?.taxInclusive === undefined
      ? { taxInclusive: false, ...(livePayload || {}) }
      : { ...(storedActive.providerPayload || {}), ...(livePayload || {}) };
    const updated = commitPaymentSessionState({
      ...storedActive,
      providerPayload: nextPayload,
      providerOrderReady: true,
      result: mergeSessionResult(storedActive.result, data),
    }, { seq: statusSeq, scopeKey: resumeScopeKey });
    if (!updated) return { terminal: true, stale: true };
    persistPaymentSession(updated, true);
    return updated;
  }

  const preservedPayload = { ...(storedActive.providerPayload || {}) };
  if (provider === "dodo" && (!livePayload?.checkoutUrl || data?.providerOrderReady === false)) delete preservedPayload.checkoutUrl;
  const updated = commitPaymentSessionState({
    ...storedActive,
    providerPayload: preservedPayload,
    providerOrderReady: data?.providerOrderReady ?? storedActive.providerOrderReady,
    result: mergeSessionResult(storedActive.result, data),
  }, { seq: statusSeq, scopeKey: resumeScopeKey });
  if (updated) persistPaymentSession(updated, true);
  if (data?.providerOrderReady === false) {
    showBanner("info", "This payment session is still preparing its order. Check its status shortly.", { persistent: true });
    return { ...(updated || storedActive), result: data, terminal: true };
  }
  if (provider === "dodo" && !livePayload?.checkoutUrl) {
    throw new Error("Checkout is being recovered. Check the payment status shortly.");
  }
  throw new Error(data?.error || reopen.reason || "This payment session cannot be reopened right now. Click 'Check payment status' or 'Change payment method'.");
}

export async function runCheckPaymentStatus(ctx) {
  const {
    activeSession, operation, currentScopeKeyRef, fetchJson = fetchPaymentJson, setPaymentStatusBusy,
    navigateToConfirmation, showBanner, clearPaymentSession, persistPaymentSession, flow,
  } = ctx;
  const token = str(activeSession?.paymentAccessToken);
  if (!token || !operation.current()) return null;
  const scopeKey = activeSession.scopeKey || currentScopeKeyRef.current;
  const statusSeq = allocatePaymentSessionSeq();
  setPaymentStatusBusy(true);
  try {
    const { response, data } = await fetchJson("/api/payment/status", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const status = normalizeCode(data?.status);
    const affirmative = ["failed", "abandoned", "refunded"].includes(status) && isAffirmativeTerminalRelease(response.ok, data);
    const completedBooking = response.ok && (status === "booked" || status === "email_partial") && data?.cleanupPending !== true && data?.manualReviewRequired !== true;
    if (affirmative || completedBooking) markReservationTerminal(scopeKey, status);
    if (affirmative) {
      const wasCurrent = operation.current();
      const owns = flow.ownsHold(activeSession);
      const nextCheckout = wasCurrent && status === "abandoned" && owns ? flow.applyReleasedHold(data?.refreshedHold) : null;
      releasePaymentSessionLock({ token, scopeKey, seq: statusSeq });
      if (!wasCurrent) return null;
      if (status === "abandoned" && (!owns || nextCheckout)) {
        clearPaymentSession("", token, { alreadyReleased: true });
        operation.token = "";
        flow.clearDodoNav(nextCheckout);
        showBanner("success", "Payment method released. Choose a payment method below.");
        return data;
      }
      const handled = clearPaymentSession(status, token, { alreadyReleased: true });
      operation.token = "";
      if (!handled) showBanner("error", data?.recoveryReason || "This payment session is no longer payable.", { persistent: true });
      return data;
    }
    if (!operation.current()) return null;
    if (isNonResumablePaymentData(data)) flow.scrubPayload(token, data);
    if (response.ok && data?.manualReviewRequired === true) {
      showBanner("info", data.recoveryReason, { persistent: true });
      return data;
    }
    if (response.ok && (status === "booked" || status === "email_partial")) {
      if (data?.cleanupPending === true) { showBanner("info", data.recoveryReason || "Payment is still being verified.", { persistent: true }); return data; }
      await navigateToConfirmation("paid", data, operation);
      return data;
    }
    if (response.ok && ["failed", "abandoned", "refunded"].includes(status)) {
      showBanner("info", data?.recoveryReason || data?.error || "Payment is still being verified.", { persistent: true });
      return data;
    }
    if (!response.ok) throw new Error(data?.error || "Unable to load payment status. Please try again.");
    if (isNonResumablePaymentData(data)) {
      showBanner("info", data?.recoveryReason || "Checkout is being recovered. Check the payment status shortly.", { persistent: true });
      return data;
    }
    const storedOrd = str(activeSession.providerPayload?.orderId), liveOrd = str(data?.providerPayload?.orderId);
    const storedTag = str(activeSession.providerPayload?.dodoReturnTag || activeSession.dodoReturnTag), liveTag = str(data?.providerPayload?.dodoReturnTag);
    if (activeSession.provider === "dodo" && ((storedOrd && liveOrd && storedOrd !== liveOrd) || (storedTag && liveTag && storedTag !== liveTag))) {
      showBanner("error", "This payment session cannot be reopened right now. Click 'Change payment method'.", { persistent: true });
      return data;
    }
    const next = commitPaymentSessionState({
      ...activeSession,
      providerPayload: { ...(activeSession.providerPayload || {}), ...(data?.providerPayload || {}) },
      providerOrderReady: data?.providerOrderReady ?? activeSession.providerOrderReady,
      result: mergeSessionResult(activeSession.result, data),
    }, { seq: statusSeq, scopeKey });
    if (next) persistPaymentSession(next, true);
    showBanner("info", data?.providerOrderReady === false ? "Checkout is still preparing. Check again shortly." : "Your payment session is ready. Click 'Resume checkout' to continue.", { persistent: true });
    return data;
  } finally {
    if (operation.current()) setPaymentStatusBusy(false);
  }
}

export async function runChangePaymentMethod(ctx) {
  const {
    cancel, currentScopeKeyRef, fetchJson = fetchPaymentJson, setCancellingPayment,
    navigateToConfirmation, showBanner, clearPaymentSession, paymentActionRef, paymentMountedRef,
    manualCodeAllowedRef, flow,
  } = ctx;
  const { activeSession, paymentAccessToken: token, operation, tokenCurrent, cancelCurrent } = cancel;
  const scopeKey = activeSession.scopeKey || currentScopeKeyRef.current;
  const lockId = extractPaymentLockId(token);
  const liveHoldAtCancel = readLiveSlotHold();
  const initialHoldId = str(liveHoldAtCancel?.holdId);
  const initialHoldNonce = str(liveHoldAtCancel?.holdToken);
  const cancelSeq = allocatePaymentSessionSeq();
  manualCodeAllowedRef.current = false;
  setCancellingPayment(true);
  try {
    const { response, data } = await fetchJson("/api/payment/cancel", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const liveBeforeRelease = readStoredPaymentSessionState();
    const stillActiveLock = tokenCurrent() && (!liveBeforeRelease?.paymentAccessToken || extractPaymentLockId(liveBeforeRelease.paymentAccessToken) === lockId);
    const status = normalizeCode(data?.status);
    const isTerminal409 = response.status === 409 && (status === "failed" || status === "refunded") && isAffirmativeTerminalRelease(true, data);
    const affirmative = isAffirmativeTerminalRelease(response.ok, data);
    const completedBooking = Boolean(data?.captured && (status === "booked" || status === "email_partial") && data?.cleanupPending !== true && data?.manualReviewRequired !== true);
    if (affirmative || isTerminal409 || completedBooking) markReservationTerminal(scopeKey, status);
    if (!stillActiveLock) {
      if ((affirmative && (data?.cancelled === true || ["failed", "abandoned", "refunded"].includes(status))) || isTerminal409) {
        releasePaymentSessionLock({ token, scopeKey, seq: cancelSeq });
      }
      return;
    }
    const wasLatest = cancelCurrent();
    if (isNonResumablePaymentData(data)) flow.scrubPayload(token, data);
    if (wasLatest) cancel.syncSeq();
    if (data?.captured) {
      if ((status === "booked" || status === "email_partial") && data?.cleanupPending !== true && data?.manualReviewRequired !== true) {
        await navigateToConfirmation("paid", data, operation);
        return;
      }
      if (cancelCurrent()) showBanner("info", data?.recoveryReason || "Your payment was received and is being finalized.", { persistent: Boolean(data?.cleanupPending || data?.manualReviewRequired) });
      return;
    }
    if (!response.ok || data?.cancelled !== true || !affirmative) {
      if (!cancelCurrent()) return;
      if (isTerminal409) {
        releasePaymentSessionLock({ token, scopeKey, seq: cancelSeq });
        const handled = clearPaymentSession(status, token, { alreadyReleased: true, reason: data?.recoveryReason });
        operation.token = "";
        if (handled) return;
      }
      if (affirmative && status === "abandoned") {
        const owns = flow.ownsHold(activeSession);
        const nextCheckout = owns && canWriteRefreshedHold(data?.refreshedHold, initialHoldId, initialHoldNonce) ? flow.applyReleasedHold(data?.refreshedHold) : null;
        if (!owns || nextCheckout) {
          releasePaymentSessionLock({ token, scopeKey, seq: cancelSeq });
          clearPaymentSession("", token, { alreadyReleased: true });
          operation.token = "";
          flow.clearDodoNav(nextCheckout);
          showBanner("success", "Payment method released. Choose a payment method below.");
          return;
        }
      }
      throw new Error(data?.error || data?.recoveryReason || "The payment method could not be changed.");
    }
    const canRotate = flow.ownsHold(activeSession) && canWriteRefreshedHold(data?.refreshedHold, initialHoldId, initialHoldNonce);
    const refreshedCheckout = canRotate ? flow.applyReleasedHold(data.refreshedHold || null) : null;
    if (!cancelCurrent()) return;
    releasePaymentSessionLock({ token, scopeKey, seq: cancelSeq });
    const released = !refreshedCheckout && data?.slotReleased === true;
    if (released && clearPaymentSession("abandoned", token, { alreadyReleased: true, forceReleaseHold: true })) {
      operation.token = "";
      return;
    }
    clearPaymentSession("", token, { alreadyReleased: true });
    operation.token = "";
    if (activeSession.provider === "dodo") flow.clearDodoNav(refreshedCheckout, true);
    showBanner("success", "Payment method released. Choose a payment method below.");
  } catch (error) {
    if (!cancelCurrent()) return;
    showBanner("error", error.message || "The payment method could not be changed.");
  } finally {
    paymentActionRef.current.cancelling = false;
    if (paymentMountedRef.current) setCancellingPayment(false);
  }
}

export async function runFinalizeSessionCheckout(ctx) {
  const {
    paymentAccessToken, providerData, operation, captured, scopeKey: explicitScopeKey = "",
    currentScopeKeyRef, paymentActionRef, manualCodeAllowedRef, fetchJson = fetchPaymentJson,
    setPaymentStatusBusy, showBanner, navigateToConfirmation, clearPaymentSession, fetchTimeoutMs,
    pollTimeoutMs, pollIntervalMs, flow,
  } = ctx;
  if (!captured && !operation.current()) return null;
  if (!(captured && paymentActionRef.current.cancelling)) paymentActionRef.current.seq += 1;
  manualCodeAllowedRef.current = false;
  const storedAtCall = readStoredPaymentSessionState();
  const matchingStoredScope = storedAtCall?.paymentAccessToken && extractPaymentLockId(storedAtCall.paymentAccessToken) === extractPaymentLockId(paymentAccessToken) ? storedAtCall.scopeKey : "";
  const scopeKey = str(explicitScopeKey) || str(matchingStoredScope) || (captured ? "" : currentScopeKeyRef.current);
  const finSeq = allocatePaymentSessionSeq();
  if (operation.current()) setPaymentStatusBusy(true);

  const finishTerminal = (payload, st, fallbackMsg) => {
    const wasCurrent = operation.current();
    const owns = flow.ownsHold(readStoredPaymentSessionState());
    const nextCheckout = wasCurrent && st === "abandoned" && owns ? flow.applyReleasedHold(payload?.refreshedHold) : null;
    releasePaymentSessionLock({ token: paymentAccessToken, scopeKey, seq: finSeq });
    if (!wasCurrent) return null;
    if (st === "abandoned" && (!owns || nextCheckout)) {
      clearPaymentSession("", paymentAccessToken, { alreadyReleased: true });
      operation.token = "";
      flow.clearDodoNav(nextCheckout);
      showBanner("success", "Payment method released. Choose a payment method below.");
      return payload;
    }
    const handled = clearPaymentSession(st, paymentAccessToken, { alreadyReleased: true });
    operation.token = "";
    if (handled) return payload;
    throw new Error(payload?.recoveryReason || payload?.error || fallbackMsg);
  };

  const poll = async () => {
    const deadline = Date.now() + pollTimeoutMs;
    while (Date.now() < deadline) {
      if (!operation.current()) return null;
      let response, data;
      try {
        ({ response, data } = await fetchJson(
          "/api/payment/status",
          { method: "POST", headers: { Authorization: `Bearer ${paymentAccessToken}`, "Content-Type": "application/json" }, body: "{}" },
          Math.min(fetchTimeoutMs, deadline - Date.now())
        ));
      } catch (error) {
        if (!operation.current()) return null;
        if (error?.name === "AbortError") continue;
        throw error;
      }
      if (!operation.current()) return null;
      if (isNonResumablePaymentData(data)) flow.scrubPayload(paymentAccessToken, data);
      if (!response.ok) throw new Error(data?.error || "Unable to load payment status.");
      const st = normalizeCode(data?.status);
      if (data?.manualReviewRequired === true || ["booked", "email_partial", "refunded", "failed", "abandoned"].includes(st)) return data;
      const rem = deadline - Date.now();
      if (rem > 0) await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, rem)));
    }
    throw new Error("Timed out waiting for payment confirmation.");
  };

  try {
    const { response, data } = await fetchJson("/api/payment/finalize", {
      method: "POST",
      headers: { Authorization: `Bearer ${paymentAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ providerData }),
    });
    const status = normalizeCode(data?.status);
    const isFinalizedStatus = status === "booked" || status === "email_partial";
    const affirmative = !isFinalizedStatus && ["failed", "abandoned", "refunded"].includes(status) && isAffirmativeTerminalRelease(response.ok, data);
    if (scopeKey && (affirmative || (response.ok && isFinalizedStatus && data?.cleanupPending !== true && data?.manualReviewRequired !== true))) {
      markReservationTerminal(scopeKey, status);
    }
    if (affirmative) {
      return finishTerminal(data, status, "Payment finalization failed.");
    }
    if (!operation.current()) return null;
    if (isNonResumablePaymentData(data)) flow.scrubPayload(paymentAccessToken, data);
    if (response.ok && data?.manualReviewRequired === true) {
      showBanner("info", data.recoveryReason, { persistent: true });
      return data;
    }
    if (!response.ok && response.status !== 202 && !isFinalizedStatus) {
      throw new Error(data?.error || "Unable to finalize payment.");
    }
    if (isFinalizedStatus) {
      if (data?.cleanupPending === true) { showBanner("info", data.recoveryReason || "Payment is still being verified.", { persistent: true }); return data; }
      await navigateToConfirmation("paid", data, operation);
      return data;
    }
    if (status === "needs_recovery" || status === "finalizing" || status === "started") {
      showBanner("info", "Finalizing your payment and booking...");
      const settled = await poll();
      if (!operation.current()) return null;
      const settledStatus = normalizeCode(settled?.status);
      if (settled?.manualReviewRequired === true) {
        flow.scrubPayload(paymentAccessToken, settled);
        showBanner("info", settled.recoveryReason, { persistent: true });
        return settled;
      }
      if (settledStatus === "booked" || settledStatus === "email_partial") {
        if (settled?.cleanupPending === true) { showBanner("info", settled.recoveryReason || "Payment is still being verified.", { persistent: true }); return settled; }
        if (scopeKey) markReservationTerminal(scopeKey, settledStatus);
        await navigateToConfirmation("paid", settled, operation);
        return settled;
      }
      if (isAffirmativeTerminalRelease(true, settled)) {
        if (scopeKey) markReservationTerminal(scopeKey, settledStatus);
        return finishTerminal(settled, settledStatus, "Payment could not be finalized.");
      }
      throw new Error(settled?.recoveryReason || settled?.error || "Payment could not be finalized.");
    }
    showBanner("info", data?.recoveryReason || data?.error || "Payment is still being verified.", { persistent: true });
    return data;
  } catch (error) {
    if (!operation.current()) return null;
    throw error;
  } finally {
    if (operation.current()) setPaymentStatusBusy(false);
  }
}
