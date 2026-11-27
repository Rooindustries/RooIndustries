import {
  buildBookingFromUnresolvedSession, extractPaymentLockId, isNonResumablePaymentData,
  readStoredPaymentSessionState, stripDodoReturnFromHistory,
} from "./checkoutSessionGuard";
import {
  allocatePaymentSessionSeq, commitPaymentSessionState, fetchPaymentJson,
  isAffirmativeTerminalRelease, quoteExceedsAcceptedCeiling, readLiveSlotHold,
  releasePaymentSessionLock, verifyProviderLaunchPayload,
} from "./paymentSessionLocks";
import { markReservationTerminal, reservationScopeKey } from "./reservationScope";

const normalizeCode = (v) => String(v || "").trim().toLowerCase();
const str = (v) => String(v || "").trim();
const resolveSessionScopeKey = (session, fallback = "") =>
  str(session?.scopeKey || reservationScopeKey(buildBookingFromUnresolvedSession(session)) || fallback);

let cachedTerminalOutcomeMod = null;
export const loadTerminalOutcome = () =>
  import("./paymentTerminalOutcome").then((mod) => {
    cachedTerminalOutcomeMod = mod;
    return mod;
  });
export const getCachedTerminalOutcome = () => cachedTerminalOutcomeMod;

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
  checkoutMatches = true,
}) => {
  if (!checkoutMatches || !responseOk || data?.ok === false) return { ok: false };
  if (data?.cleanupPending === true || data?.manualReviewRequired === true) return { ok: false };
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
    if (data?.attemptStarted === true || !str(livePayload?.checkoutUrl)) return { ok: false };
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
    consentStateRef, quoteVersionRef, onAuthoritativeQuote, rawBookingData, bookingData,
    readStoredCheckout, writeStoredCheckout, setSessionHold, packageTitle, packagePrice,
  } = ctx;
  if (otherCheckoutStarting(provider)) {
    throw new Error("Another payment method is still starting. Please wait a moment and try again.");
  }
  const resumeScopeKey = resolveSessionScopeKey(storedActive, currentScopeKeyRef?.current);
  const token = storedActive.paymentAccessToken;
  const liveHoldAtStart = readLiveSlotHold();
  const initialHoldId = str(liveHoldAtStart?.holdId);
  const initialHoldNonce = str(liveHoldAtStart?.holdToken);
  const statusSeq = allocatePaymentSessionSeq();
  const resumeSeq = (paymentActionRef.current.seq += 1);
  const [outcomeMod, { response, data }] = await Promise.all([
    loadTerminalOutcome(),
    runTrackedStart(pendingStartsRef, setPendingStarts, provider, () =>
      fetchJson("/api/payment/status", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
      })
    ),
  ]);
  const checkoutMatches = outcomeMod.sessionOwnsCheckoutBooking(storedActive, rawBookingData || bookingData);
  const resumedStatus = normalizeCode(data?.status);
  const act = paymentActionRef.current;
  const affirmativeRelease = ["refunded", "failed", "abandoned"].includes(resumedStatus) && isAffirmativeTerminalRelease(response.status === 200, data);
  const completedBooking = response.ok && (resumedStatus === "booked" || resumedStatus === "email_partial") && data?.cleanupPending !== true && data?.manualReviewRequired !== true;
  if (affirmativeRelease || completedBooking) markReservationTerminal(resumeScopeKey, resumedStatus);
  if (affirmativeRelease) {
    const wasCurrent = operation.current() && !act.cancelling && resumeSeq === act.seq;
    const owns = Boolean(
      checkoutMatches && flow.ownsHold(storedActive) && (
        outcomeMod.isLiveHoldOwnedBySession(storedActive, readLiveSlotHold()) ||
        outcomeMod.sessionOwnsCheckoutBooking(storedActive, readStoredCheckout?.()) ||
        outcomeMod.sessionOwnsCheckoutBooking(storedActive, bookingData)
      )
    );
    const restored = wasCurrent && resumedStatus === "abandoned" && owns
      ? outcomeMod.applyCancelRefreshedHold({
          activeSession: storedActive, refreshedHold: data?.refreshedHold || null,
          storedCheckout: readStoredCheckout?.(), liveHold: readLiveSlotHold(),
          initialHoldId, initialHoldNonce, bookingData, packageTitle, packagePrice,
          setSessionHold, writeStoredCheckout,
        }).refreshedCheckout
      : null;
    releasePaymentSessionLock({ token, scopeKey: resumeScopeKey, seq: statusSeq });
    if (!wasCurrent) {
      const liveViewToken = str(paymentView?.session?.paymentAccessToken);
      if (paymentMountedRef?.current && !act.cancelling && resumeSeq === act.seq && liveViewToken && extractPaymentLockId(liveViewToken) === extractPaymentLockId(token)) {
        clearPaymentSession("", token, { alreadyReleased: true });
      }
      return { terminal: true, stale: true };
    }
    if (owns && !restored) {
      const handled = clearPaymentSession(resumedStatus, token, { alreadyReleased: true, responseData: data });
      operation.token = "";
      if (handled) return { ...storedActive, result: data, terminal: true };
      throw new Error(data?.paymentFailureMessage || data?.recoveryReason || "This payment session is no longer payable.");
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
    if (data?.cleanupPending === true) {
      const updated = outcomeMod.handleCleanupPending({ session: storedActive, data, seq: statusSeq, scopeKey: resumeScopeKey, persistPaymentSession, showBanner });
      return { ...(updated || storedActive), result: data, terminal: true };
    }
    await navigateToConfirmation("paid", data, operation, storedActive);
    return { ...storedActive, result: data, terminal: true };
  }
  if (data?.cleanupPending === true) {
    const updated = outcomeMod.handleCleanupPending({ session: storedActive, data, seq: statusSeq, scopeKey: resumeScopeKey, persistPaymentSession, showBanner });
    return { ...(updated || storedActive), result: data, terminal: true };
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
    referralCode: referral?.code, couponCode: coupon?.code, checkoutMatches,
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
    const ceiling = consentStateRef?.current;
    const exceedsCeiling = Boolean(
      data?.quote && ceiling && quoteExceedsAcceptedCeiling({
        quote: data.quote,
        acceptedQuoteTotal: ceiling.acceptedQuoteTotal,
        acceptedQuoteCurrency: ceiling.acceptedQuoteCurrency,
      })
    );
    if (data?.quote && onAuthoritativeQuote) {
      onAuthoritativeQuote({
        quote: data.quote,
        quoteVersion: quoteVersionRef?.current ?? 0,
        quoteFingerprint: str(data.quoteFingerprint),
        scopeKey: resumeScopeKey,
      });
    }
    if (exceedsCeiling) return { ...updated, terminal: true };
    return updated;
  }

  const updated = outcomeMod.persistStrippedSession({
    session: storedActive, data, seq: statusSeq, scopeKey: resumeScopeKey,
    persistPaymentSession,
    stripDodoUrl: !livePayload?.checkoutUrl || data?.providerOrderReady === false || data?.attemptStarted === true,
  });
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
    bookingData, packageTitle, packagePrice, setSessionHold, readStoredCheckout, writeStoredCheckout,
  } = ctx;
  const token = str(activeSession?.paymentAccessToken);
  if (!token || !operation.current()) return null;
  const scopeKey = resolveSessionScopeKey(activeSession, currentScopeKeyRef?.current);
  const liveHoldAtStart = readLiveSlotHold();
  const initialHoldId = str(liveHoldAtStart?.holdId);
  const initialHoldNonce = str(liveHoldAtStart?.holdToken);
  const statusSeq = allocatePaymentSessionSeq();
  setPaymentStatusBusy(true);
  try {
    const [outcomeMod, { response, data }] = await Promise.all([
      loadTerminalOutcome(),
      fetchJson("/api/payment/status", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
      }),
    ]);
    const status = normalizeCode(data?.status);
    const affirmative = ["failed", "abandoned", "refunded"].includes(status) && isAffirmativeTerminalRelease(response.status === 200, data);
    const completedBooking = response.ok && (status === "booked" || status === "email_partial") && data?.cleanupPending !== true && data?.manualReviewRequired !== true;
    if (affirmative || completedBooking) markReservationTerminal(scopeKey, status);
    if (affirmative) {
      const wasCurrent = operation.current();
      const owns = flow.ownsHold(activeSession);
      const nextCheckout = wasCurrent && status === "abandoned" && owns
        ? outcomeMod.applyCancelRefreshedHold({
            activeSession, refreshedHold: data?.refreshedHold || null,
            storedCheckout: readStoredCheckout?.(), liveHold: readLiveSlotHold(),
            initialHoldId, initialHoldNonce, bookingData, packageTitle, packagePrice,
            setSessionHold, writeStoredCheckout,
          }).refreshedCheckout
        : null;
      releasePaymentSessionLock({ token, scopeKey, seq: statusSeq });
      if (!wasCurrent) return null;
      if (status === "abandoned" && (nextCheckout || (activeSession.provider !== "dodo" && !owns))) {
        clearPaymentSession("", token, { alreadyReleased: true });
        operation.token = "";
        flow.clearDodoNav(nextCheckout);
        showBanner("success", "Payment method released. Choose a payment method below.");
        return data;
      }
      const handled = clearPaymentSession(status, token, { alreadyReleased: true, responseData: data });
      operation.token = "";
      if (!handled) showBanner("error", data?.paymentFailureMessage || data?.recoveryReason || "This payment session is no longer payable.", { persistent: true });
      return data;
    }
    if (!operation.current()) return null;
    if (isNonResumablePaymentData(data)) flow.scrubPayload(token, data);
    if (response.ok && data?.manualReviewRequired === true) {
      showBanner("info", data.recoveryReason, { persistent: true });
      return data;
    }
    if (response.ok && (status === "booked" || status === "email_partial")) {
      if (data?.cleanupPending === true) {
        outcomeMod.handleCleanupPending({ session: activeSession, data, seq: statusSeq, scopeKey, persistPaymentSession, showBanner });
        return data;
      }
      await navigateToConfirmation("paid", data, operation, activeSession);
      return data;
    }
    if (response.ok && data?.cleanupPending === true) {
      outcomeMod.handleCleanupPending({ session: activeSession, data, seq: statusSeq, scopeKey, persistPaymentSession, showBanner });
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
    outcomeMod.persistStrippedSession({ session: activeSession, data, seq: statusSeq, scopeKey, persistPaymentSession });
    showBanner(
      "info",
      data?.providerOrderReady === false
        ? "Checkout is still preparing. Check again shortly."
        : activeSession.provider === "dodo" && (data?.attemptStarted === true || !str(data?.providerPayload?.checkoutUrl))
          ? "Your payment attempt is still being verified. Click 'Check payment status' again shortly."
          : "Your payment session is ready. Click 'Resume checkout' to continue.",
      { persistent: true }
    );
    return data;
  } finally {
    if (operation.current()) setPaymentStatusBusy(false);
  }
}

export async function runChangePaymentMethod(ctx) {
  const {
    cancel, currentScopeKeyRef, bookingData, packageTitle, packagePrice, setSessionHold,
    readStoredCheckout, writeStoredCheckout, persistPaymentSession, fetchJson = fetchPaymentJson,
    setCancellingPayment, navigateToConfirmation, showBanner, clearPaymentSession,
    paymentActionRef, paymentMountedRef, manualCodeAllowedRef, flow,
  } = ctx;
  const { activeSession, paymentAccessToken: token, operation, tokenCurrent, cancelCurrent } = cancel;
  const scopeKey = resolveSessionScopeKey(activeSession, currentScopeKeyRef?.current);
  const lockId = extractPaymentLockId(token);
  const liveHoldAtCancel = readLiveSlotHold();
  const initialHoldId = str(liveHoldAtCancel?.holdId);
  const initialHoldNonce = str(liveHoldAtCancel?.holdToken);
  const cancelSeq = allocatePaymentSessionSeq();
  manualCodeAllowedRef.current = false;
  setCancellingPayment(true);
  try {
    const [outcomeMod, { response, data }] = await Promise.all([
      loadTerminalOutcome(),
      fetchJson("/api/payment/cancel", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
      }),
    ]);
    const liveBeforeRelease = readStoredPaymentSessionState();
    const stillActiveLock = tokenCurrent() && (!liveBeforeRelease?.paymentAccessToken || extractPaymentLockId(liveBeforeRelease.paymentAccessToken) === lockId);
    const status = normalizeCode(data?.status);
    const isTerminal409 = response.status === 409 && (status === "failed" || status === "refunded") && isAffirmativeTerminalRelease(true, data);
    const affirmative = isAffirmativeTerminalRelease(response.status === 200, data);
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
        await navigateToConfirmation("paid", data, operation, activeSession);
        return;
      }
      if (cancelCurrent()) showBanner("info", data?.recoveryReason || "Your payment was received and is being finalized.", { persistent: Boolean(data?.cleanupPending || data?.manualReviewRequired) });
      return;
    }
    if (response.ok && data?.cleanupPending === true) {
      if (cancelCurrent()) outcomeMod.handleCleanupPending({ session: activeSession, data, seq: cancelSeq, scopeKey, persistPaymentSession, showBanner });
      return;
    }
    if (response.status !== 200 || !affirmative || (data?.cancelled !== true && status !== "failed" && status !== "abandoned")) {
      if (!cancelCurrent()) return;
      if (isTerminal409) {
        releasePaymentSessionLock({ token, scopeKey, seq: cancelSeq });
        const handled = clearPaymentSession(status, token, { alreadyReleased: true, reason: data?.recoveryReason, responseData: data });
        operation.token = "";
        if (handled) return;
      }
      throw new Error(data?.error || data?.recoveryReason || "The payment method could not be changed.");
    }
    if (
      activeSession.provider === "dodo" &&
      status === "failed" &&
      data?.cancelled !== true &&
      (data?.paymentFailureMessage || data?.holdRetained === true || data?.slotReleased === true)
    ) {
      if (!cancelCurrent()) return;
      releasePaymentSessionLock({ token, scopeKey, seq: cancelSeq });
      clearPaymentSession("failed", token, { alreadyReleased: true, responseData: data });
      operation.token = "";
      return;
    }
    const { ownsCheckout, ownsLiveHold, refreshedCheckout } = outcomeMod.applyCancelRefreshedHold({
      activeSession, refreshedHold: data.refreshedHold || null, storedCheckout: readStoredCheckout(),
      liveHold: readLiveSlotHold(), initialHoldId, initialHoldNonce, bookingData, packageTitle,
      packagePrice, setSessionHold, writeStoredCheckout,
    });
    if (!cancelCurrent()) return;
    releasePaymentSessionLock({ token, scopeKey, seq: cancelSeq });
    const released = !refreshedCheckout && data?.slotReleased === true && (ownsCheckout || ownsLiveHold);
    if (released && clearPaymentSession("abandoned", token, { alreadyReleased: true, forceReleaseHold: true, responseData: data })) {
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
    activeSession = null, persistPaymentSession = null,
    currentScopeKeyRef, paymentActionRef, manualCodeAllowedRef, fetchJson = fetchPaymentJson,
    setPaymentStatusBusy, showBanner, navigateToConfirmation, clearPaymentSession,
    fetchTimeoutMs = 15_000, pollTimeoutMs = 90_000, pollIntervalMs = 2_500, flow,
    bookingData, packageTitle, packagePrice, setSessionHold, readStoredCheckout, writeStoredCheckout,
  } = ctx;
  if (!captured && !operation.current()) return null;
  if (!(captured && paymentActionRef.current.cancelling)) paymentActionRef.current.seq += 1;
  manualCodeAllowedRef.current = false;
  const storedAtCall = readStoredPaymentSessionState();
  const resolvedSession = activeSession || (storedAtCall?.paymentAccessToken && extractPaymentLockId(storedAtCall.paymentAccessToken) === extractPaymentLockId(paymentAccessToken) ? storedAtCall : null);
  const scopeKey = str(explicitScopeKey) || resolveSessionScopeKey(resolvedSession, captured ? "" : currentScopeKeyRef?.current);
  const liveHoldAtStart = readLiveSlotHold();
  const initialHoldId = str(liveHoldAtStart?.holdId);
  const initialHoldNonce = str(liveHoldAtStart?.holdToken);
  const finSeq = allocatePaymentSessionSeq();
  if (operation.current()) setPaymentStatusBusy(true);

  const finishTerminal = (outcomeMod, payload, st, fallbackMsg) => {
    const wasCurrent = operation.current();
    const targetSession = resolvedSession || readStoredPaymentSessionState();
    const owns = flow.ownsHold(targetSession);
    const nextCheckout = wasCurrent && st === "abandoned" && owns
      ? outcomeMod.applyCancelRefreshedHold({
          activeSession: targetSession, refreshedHold: payload?.refreshedHold || null,
          storedCheckout: readStoredCheckout?.(), liveHold: readLiveSlotHold(),
          initialHoldId, initialHoldNonce, bookingData, packageTitle, packagePrice,
          setSessionHold, writeStoredCheckout,
        }).refreshedCheckout
      : null;
    releasePaymentSessionLock({ token: paymentAccessToken, scopeKey, seq: finSeq });
    if (!wasCurrent) return null;
    if (st === "abandoned" && (nextCheckout || (resolvedSession?.provider !== "dodo" && !owns))) {
      clearPaymentSession("", paymentAccessToken, { alreadyReleased: true });
      operation.token = "";
      flow.clearDodoNav(nextCheckout);
      showBanner("success", "Payment method released. Choose a payment method below.");
      return payload;
    }
    const handled = clearPaymentSession(st, paymentAccessToken, { alreadyReleased: true, responseData: payload });
    operation.token = "";
    if (handled) return payload;
    throw new Error(payload?.paymentFailureMessage || payload?.recoveryReason || payload?.error || fallbackMsg);
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
      if (data?.manualReviewRequired === true || data?.cleanupPending === true || ["booked", "email_partial", "refunded", "failed", "abandoned"].includes(st)) return { ...data, _httpStatus: response.status };
      const rem = deadline - Date.now();
      if (rem > 0) await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, rem)));
    }
    throw new Error("Timed out waiting for payment confirmation.");
  };

  try {
    let [outcomeMod, { response, data }] = await Promise.all([
      loadTerminalOutcome(),
      fetchJson("/api/payment/finalize", {
        method: "POST",
        headers: { Authorization: `Bearer ${paymentAccessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ providerData }),
      }),
    ]);
    let fellBackToStatus = false;
    if (response.status === 401 && paymentAccessToken) {
      const fallback = await fetchJson("/api/payment/status", {
        method: "POST",
        headers: { Authorization: `Bearer ${paymentAccessToken}`, "Content-Type": "application/json" },
        body: "{}",
      });
      if (!operation.current()) return null;
      response = fallback.response;
      data = fallback.data;
      fellBackToStatus = true;
    }
    const status = normalizeCode(data?.status);
    const isFinalizedStatus = status === "booked" || status === "email_partial";
    const affirmative = !isFinalizedStatus && ["failed", "abandoned", "refunded"].includes(status) && isAffirmativeTerminalRelease(response.status === 200, data);
    if (scopeKey && (affirmative || (response.ok && isFinalizedStatus && data?.cleanupPending !== true && data?.manualReviewRequired !== true))) {
      markReservationTerminal(scopeKey, status);
    }
    if (affirmative) {
      return finishTerminal(outcomeMod, data, status, "Payment finalization failed.");
    }
    if (!operation.current()) return null;
    if (isNonResumablePaymentData(data)) flow.scrubPayload(paymentAccessToken, data);
    if (response.ok && data?.manualReviewRequired === true) {
      showBanner("info", data.recoveryReason, { persistent: true });
      return data;
    }
    if (response.ok && data?.cleanupPending === true) {
      outcomeMod.handleCleanupPending({ session: resolvedSession, data, seq: finSeq, scopeKey, persistPaymentSession, showBanner });
      return data;
    }
    if (!response.ok && response.status !== 202 && !isFinalizedStatus) {
      throw new Error(data?.error || "Unable to finalize payment.");
    }
    if (isFinalizedStatus) {
      await navigateToConfirmation("paid", data, operation, resolvedSession);
      return data;
    }
    if (fellBackToStatus && status === "started") {
      outcomeMod.persistStrippedSession({ session: resolvedSession, data, seq: finSeq, scopeKey, persistPaymentSession });
      showBanner(
        "info",
        data?.providerOrderReady === false
          ? "Checkout is still preparing. Check again shortly."
          : "Your payment session is still in progress. Check again shortly.",
        { persistent: true }
      );
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
      if (settled?.cleanupPending === true) {
        outcomeMod.handleCleanupPending({ session: resolvedSession, data: settled, seq: finSeq, scopeKey, persistPaymentSession, showBanner });
        return settled;
      }
      if (settledStatus === "booked" || settledStatus === "email_partial") {
        if (scopeKey) markReservationTerminal(scopeKey, settledStatus);
        await navigateToConfirmation("paid", settled, operation, resolvedSession);
        return settled;
      }
      if (isAffirmativeTerminalRelease(settled?._httpStatus === 200, settled)) {
        if (scopeKey) markReservationTerminal(scopeKey, settledStatus);
        return finishTerminal(outcomeMod, settled, settledStatus, "Payment could not be finalized.");
      }
      throw new Error(settled?.paymentFailureMessage || settled?.recoveryReason || settled?.error || "Payment could not be finalized.");
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
