import { writeBrowserStorage } from "./browserStorage";
import { toMoney } from "./checkoutCodes";
import { extractTokenNonce } from "./checkoutConfirmation";
import {
  areSameLineageScopeKeys, beginPendingPaymentStart, clearDodoNavQuery,
  endPendingPaymentStart, extractPaymentLockId, isPaymentLockReleased,
  mergeLineageCheckout, paymentSessionMatchesBookingLineage, paymentSessionMatchesCheckout,
  readStoredPaymentSessionState, stripDodoReturnFromHistory, syncHistoryCheckoutBooking,
} from "./checkoutSessionGuard";
import {
  allocatePaymentSessionSeq, commitPaymentSessionState, doesLiveHoldMatchLineage,
  fetchPaymentJson, persistDetachedStartResult, readLiveSlotHold,
} from "./paymentSessionLocks";
import { runResumePaymentSession } from "./paymentSessionResume";
import { markReservationTerminal, recordHoldNonceRotation, reservationScopeKey } from "./reservationScope";

const CLAIMED_CODES = [
  "payment_provider_already_claimed",
  "payment_quote_already_claimed",
  "provider_order_creation_in_progress",
];
const REPRICING_CODES = [
  "quote_changed",
  "quote_fingerprint_mismatch",
  "quote_fingerprint_required",
];
const str = (v) => String(v || "").trim();
const num = (v) => Number(v || 0);

export async function runNewPaymentStart(ctx) {
  const {
    provider, operation, startScope, startQuoteVersion, startQuoteFp, startSnap,
    initialValidationGen: capturedValGen, initialStoredScope: capturedStoredScope, initialLiveHold: capturedLiveHold,
    bookingData, sessionHold, packageTitle, checkoutFingerprint,
    buildCheckoutPayload, readStoredCheckout, writeStoredCheckout, checkoutRef,
    validationGenRef, quoteVersionRef, currentScopeKeyRef, serverQuoteRef,
    paymentMountedRef, paymentActionRef, manualCodeAllowedRef, dodoReturnHandled,
    quoteLoading, fetchJson = fetchPaymentJson, setAlreadyTargetInfo, setBlockingUpgradeSession,
    setServerQuote, setQuoteFingerprint, setProviderConfig, selectQuoteProvider,
    showBanner, setSessionHold, showConfirmation, persistPaymentSession,
    stripReservedCode, writeStoredReferral, setReferral, setReferralInput,
    setCoupon, setCouponInput, setReferralError, setCouponError,
    paymentStartBody, countCheckoutStartOnce, eventMoment, trackCheckoutSessionStarted, trackConfirmedPurchase,
  } = ctx;

  if (quoteLoading || !startQuoteFp) {
    throw new Error("Checkout price is still being confirmed. Please try again.");
  }

  manualCodeAllowedRef.current = false;
  const startSeq = allocatePaymentSessionSeq();
  const initialValidationGen = capturedValGen ?? validationGenRef.current;
  const initialStoredScope = capturedStoredScope ?? reservationScopeKey(readStoredCheckout());
  const liveHoldAtStart = capturedLiveHold !== undefined ? capturedLiveHold : readLiveSlotHold();
  const initialHoldId = str(liveHoldAtStart?.holdId);
  const initialHoldNonce = extractTokenNonce(liveHoldAtStart?.holdToken || "");
  const fallbackHoldId = str(sessionHold?.slotHoldId || bookingData?.slotHoldId);

  const body = await paymentStartBody({
    operation,
    provider,
    quoteFingerprint: startQuoteFp,
    salesAttribution: bookingData.salesAttribution,
    startSnap,
    buildPayload: buildCheckoutPayload,
  });
  if (!body || !operation.current() || paymentActionRef.current.cancelling || currentScopeKeyRef.current !== startScope) {
    return { terminal: true, stale: true };
  }
  if (validationGenRef.current !== initialValidationGen) {
    return { terminal: true, stale: true };
  }
  if (!bookingData.originalOrderId) {
    if (initialHoldId && !doesLiveHoldMatchLineage(initialHoldId, initialHoldNonce)) {
      return { terminal: true, stale: true };
    }
    if (!initialHoldId && fallbackHoldId) {
      const afterHold = readLiveSlotHold();
      if (afterHold?.holdId && str(afterHold.holdId) !== fallbackHoldId) {
        return { terminal: true, stale: true };
      }
    }
  }
  const afterStoredScope = reservationScopeKey(readStoredCheckout());
  if (afterStoredScope !== initialStoredScope && (!afterStoredScope || !areSameLineageScopeKeys(afterStoredScope, startScope))) {
    return { terminal: true, stale: true };
  }

  const { response, data } = await fetchJson("/api/payment/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const moment = eventMoment();
  const responseStatus = str(data?.status).toLowerCase();
  const booked = response.ok && data?.ok && ["booked", "email_partial"].includes(responseStatus);
  if (booked) trackConfirmedPurchase(data.analyticsReceipt);
  if (response.ok && data?.ok) {
    await countCheckoutStartOnce(data, provider, () =>
      trackCheckoutSessionStarted({
        packageTitle: bookingData.packageTitle, price: data.quote?.netAmount, provider, moment,
      })
    );
  }

  if (!paymentMountedRef.current) {
    markReservationTerminal(startScope, responseStatus);
    if (response.ok && data?.ok && provider !== "free") {
      persistDetachedStartResult({
        booking: bookingData, data, provider, fingerprint: checkoutFingerprint,
        scopeKey: startScope, seq: startSeq, initialHoldId, initialHoldNonce,
        readStoredCheckout, writeStoredCheckout,
      });
    }
    return { terminal: true, stale: true };
  }

  if (paymentActionRef.current.cancelling || currentScopeKeyRef.current !== startScope) {
    return { terminal: true, stale: true };
  }
  if (!bookingData.originalOrderId && initialHoldId && !doesLiveHoldMatchLineage(initialHoldId, initialHoldNonce)) {
    return { terminal: true, stale: true };
  }

  const applyPendingHold = (refreshedHold) => {
    if (!refreshedHold?.slotHoldId || !refreshedHold?.slotHoldToken) return null;
    if (initialHoldId && !doesLiveHoldMatchLineage(initialHoldId, initialHoldNonce)) return null;
    recordHoldNonceRotation({
      slotHoldId: refreshedHold.slotHoldId,
      fromNonce: initialHoldNonce || checkoutRef.current?.slotHoldToken || bookingData?.slotHoldToken || "",
      toNonce: refreshedHold.slotHoldToken,
    });
    setSessionHold(refreshedHold);
    const expiresAt = refreshedHold.slotHoldExpiresAt || refreshedHold.expiresAt || "";
    const nextCheckout = mergeLineageCheckout(readStoredCheckout(), checkoutRef.current || bookingData, {
      slotHoldId: refreshedHold.slotHoldId, slotHoldToken: refreshedHold.slotHoldToken, slotHoldExpiresAt: expiresAt,
    });
    checkoutRef.current = nextCheckout;
    writeStoredCheckout(nextCheckout);
    syncHistoryCheckoutBooking(nextCheckout);
    try {
      const holdState = {
        holdId: refreshedHold.slotHoldId, holdToken: refreshedHold.slotHoldToken, expiresAt,
        startTimeUTC: bookingData.startTimeUTC || "", packageTitle,
        phase: refreshedHold.phase || "payment_pending",
      };
      writeBrowserStorage("sessionStorage", "my_slot_hold", JSON.stringify(holdState));
      window.dispatchEvent(new CustomEvent("hold-state", { detail: holdState }));
    } catch {}
    return nextCheckout;
  };

  if (!response.ok || !data?.ok) {
    if (!operation.current()) return { terminal: true, stale: true };
    if (response.status === 409 && data?.code === "already_target" && data?.completedUpgrade) {
      setAlreadyTargetInfo(data.completedUpgrade);
      return { terminal: true };
    }
    if (response.status === 409 && data?.code === "upgrade_already_in_progress" && data?.lockedSession) {
      setBlockingUpgradeSession(data.lockedSession);
      return { terminal: true };
    }
    const claimed = data?.claimedSession || (response.status === 409 && CLAIMED_CODES.includes(str(data?.code)) ? data?.lockedSession : null);
    if (claimed?.paymentAccessToken) {
      const adoptedProvider = str(claimed.provider || provider).toLowerCase();
      const token = str(claimed.paymentAccessToken);
      const hasCodeFields = "referralCode" in claimed || "couponCode" in claimed;
      const referralCode = hasCodeFields ? stripReservedCode(claimed.referralCode) : stripReservedCode(bookingData.referralCode);
      const couponCode = hasCodeFields ? stripReservedCode(claimed.couponCode) : stripReservedCode(bookingData.couponCode);
      const q = claimed.quote && typeof claimed.quote === "object" ? claimed.quote : null;
      applyPendingHold(claimed.refreshedHold);
      let nextCheckout = checkoutRef.current || bookingData;
      if (hasCodeFields) {
        nextCheckout = mergeLineageCheckout(readStoredCheckout(), nextCheckout, { referralCode, couponCode, code: 1 });
        checkoutRef.current = nextCheckout;
        writeStoredCheckout(nextCheckout);
        syncHistoryCheckoutBooking(nextCheckout);
        writeStoredReferral(referralCode);
        setReferral(referralCode ? { code: referralCode, discountPercent: num(q?.referralDiscountPercent) } : null);
        setReferralInput(referralCode);
        setCoupon(couponCode ? { code: couponCode, discountType: str(q?.couponDiscountType) || "percent", discountPercent: num(q?.couponDiscountPercent), discountValue: num(q?.couponDiscountValue), canCombineWithReferral: q?.canCombineWithReferral !== false } : null);
        setCouponInput(couponCode);
        setReferralError("");
        setCouponError("");
      }
      if (q) setServerQuote(q);
      if (claimed.quoteFingerprint) setQuoteFingerprint(str(claimed.quoteFingerprint));
      const adoptedFp = hasCodeFields
        ? JSON.stringify({ packageTitle, originalOrderId: bookingData.originalOrderId || "", startTimeUTC: bookingData.startTimeUTC || "", email: bookingData.email || "", referralCode, couponCode })
        : checkoutFingerprint;
      const adoptedScope = reservationScopeKey(nextCheckout) || startScope;
      const adopted = commitPaymentSessionState({
        provider: adoptedProvider,
        fingerprint: adoptedFp,
        scopeKey: adoptedScope,
        paymentAccessToken: token,
        providerPayload: claimed.providerPayload && typeof claimed.providerPayload === "object" ? claimed.providerPayload : {},
        providerOrderReady: claimed.providerOrderReady !== false,
        sessionExpiresAt: str(claimed.sessionExpiresAt),
        result: claimed,
      }, { seq: startSeq, scopeKey: adoptedScope });
      if (adopted) {
        operation.token = adopted.paymentAccessToken;
        if (adoptedProvider === "dodo") { dodoReturnHandled.current = adopted.paymentAccessToken; stripDodoReturnFromHistory(); }
        persistPaymentSession(adopted, true);
      }
      showBanner("info", data.error || "A payment session is already open for this reservation. Resume it or click Change payment method.", { persistent: true });
      return { terminal: true };
    }
    const isMismatch = response.status === 409 && REPRICING_CODES.includes(str(data?.code));
    if (quoteVersionRef.current === startQuoteVersion) {
      if (isMismatch && provider !== "free") selectQuoteProvider(provider, startScope);
      if (data?.quote) setServerQuote(data.quote);
      if (data?.quoteFingerprint || data?.fingerprint) {
        setQuoteFingerprint(str(data.quoteFingerprint || data.fingerprint));
      }
      if (data?.providers) setProviderConfig((current) => ({ ...current, ...data.providers }));
    }
    if (isMismatch) throw new Error("The price changed. Review the updated total and click again.");
    throw new Error(data?.error || "Unable to start payment.");
  }

  const existingLocked = readStoredPaymentSessionState();
  if (existingLocked?.paymentAccessToken && extractPaymentLockId(existingLocked.paymentAccessToken) !== extractPaymentLockId(data.paymentAccessToken) && Number(existingLocked.sessionSeq || 0) >= startSeq) {
    return { terminal: true, stale: true };
  }

  const returnedFp = str(data.quoteFingerprint || data.fingerprint);
  const netOf = (q) => (q ? (q.isFree === true ? 0 : toMoney(q.netAmount)) : null);
  const returnedNet = netOf(data.quote), currentNet = netOf(serverQuoteRef.current);
  const quoteMoved =
    quoteVersionRef.current !== startQuoteVersion ||
    (returnedFp && startQuoteFp && returnedFp !== startQuoteFp) ||
    (returnedNet !== null && currentNet !== null && returnedNet !== currentNet);

  const nextCheckout = applyPendingHold(data.refreshedHold || data.hold || null) || checkoutRef.current || bookingData;
  const sessionScope = reservationScopeKey(nextCheckout) || startScope;
  const nextSession = {
    provider,
    fingerprint: checkoutFingerprint,
    scopeKey: sessionScope,
    paymentAccessToken: str(data.paymentAccessToken),
    providerPayload: data.providerPayload || {},
    providerOrderReady: data.providerOrderReady !== false,
    sessionExpiresAt: str(data.sessionExpiresAt),
    result: data,
  };
  const isCurrentOp = operation.current();
  if (provider !== "free" && booked && isCurrentOp) {
    await showConfirmation("paid", data, operation);
    return { ...nextSession, terminal: true };
  }
  const committed = provider === "free"
    ? nextSession
    : commitPaymentSessionState(nextSession, { seq: startSeq, scopeKey: sessionScope });
  if (provider !== "free" && !committed) {
    return { terminal: true, stale: true };
  }

  if (quoteMoved || !isCurrentOp) {
    if (provider !== "free") persistPaymentSession(committed, true);
    return { ...committed, terminal: true, stale: true };
  }

  if (provider !== "free") selectQuoteProvider(provider, startScope);
  if (data.quote) setServerQuote(data.quote);
  if (returnedFp) setQuoteFingerprint(returnedFp);

  if (provider !== "free") {
    operation.token = committed.paymentAccessToken;
    if (provider === "dodo") { dodoReturnHandled.current = committed.paymentAccessToken; stripDodoReturnFromHistory(); }
    persistPaymentSession(committed, true);
  }
  if (provider !== "free" && responseStatus && responseStatus !== "started") {
    if (data?.manualReviewRequired === true) showBanner("info", data.recoveryReason, { persistent: true });
    return { ...committed, terminal: true };
  }
  if (provider !== "free" && committed.providerOrderReady === false) {
    showBanner("info", "Checkout is still preparing. Click 'Check payment status' shortly.", { persistent: true });
    return { ...committed, terminal: true };
  }
  return committed;
}

export async function runStartSessionCheckout(ctx) {
  const {
    provider, operation, startSnap, currentScopeKeyRef, paymentActionRef,
    readStoredPaymentSession, paymentSession, checkoutFingerprint, bookingData,
    fetchJson = fetchPaymentJson, showBanner, navigateToConfirmation, clearPaymentSession,
    parseCheckoutFingerprint, referral, coupon, persistPaymentSession,
    pendingStartsRef, setPendingStarts, otherCheckoutStarting, sessionStartRef,
    quoteVersionRef, quoteFingerprintRef, quoteFingerprint, validationGenRef,
    readStoredCheckout, holdForGuard, dodoReturnHandled, latestNavRef, navigate,
    checkoutRef, flow,
  } = ctx;
  if (!operation.current() || paymentActionRef.current.cancelling) return { terminal: true, stale: true };
  const startScope = currentScopeKeyRef.current;
  const storedActive = readStoredPaymentSession() || paymentSession;
  if (
    storedActive?.provider === provider &&
    !isPaymentLockReleased(storedActive.paymentAccessToken) &&
    paymentSessionMatchesCheckout(storedActive?.fingerprint, checkoutFingerprint) &&
    paymentSessionMatchesBookingLineage(storedActive, bookingData) &&
    storedActive?.paymentAccessToken &&
    storedActive?.providerPayload
  ) {
    const resumed = await runResumePaymentSession({
      provider, operation, storedActive, currentScopeKeyRef, fetchJson, showBanner,
      navigateToConfirmation, clearPaymentSession, parseCheckoutFingerprint,
      referral, coupon, persistPaymentSession, pendingStartsRef, setPendingStarts,
      otherCheckoutStarting, paymentActionRef, flow,
    });
    if (resumed) return resumed;
  }

  if (sessionStartRef.current?.provider === provider && sessionStartRef.current.operation.current()) {
    return sessionStartRef.current.promise;
  }
  if (otherCheckoutStarting(provider)) {
    throw new Error("Another payment method is still starting. Please wait a moment and try again.");
  }

  const startQuoteVersion = quoteVersionRef.current;
  const startQuoteFp = quoteFingerprintRef.current || quoteFingerprint;
  const initialValidationGen = validationGenRef.current;
  const initialStoredScope = reservationScopeKey(readStoredCheckout());
  const initialLiveHold = readLiveSlotHold();
  const promise = runNewPaymentStart({
    ...ctx,
    startScope, startQuoteVersion, startQuoteFp, startSnap,
    initialValidationGen, initialStoredScope, initialLiveHold,
  });

  const pendingStartId = beginPendingPaymentStart(holdForGuard.holdId, holdForGuard.holdToken);
  sessionStartRef.current = { provider, promise, operation };
  setPendingStarts([...pendingStartsRef.current, { provider, promise }]);

  try {
    return await promise;
  } catch (error) {
    if (!operation.current()) return { terminal: true, stale: true };
    if (!readStoredPaymentSession()) {
      clearDodoNavQuery({ dodoReturnHandled, latestNavRef, navigate, nextCheckout: checkoutRef.current });
    }
    throw error;
  } finally {
    endPendingPaymentStart(pendingStartId);
    if (sessionStartRef.current?.promise === promise) sessionStartRef.current = null;
    setPendingStarts(pendingStartsRef.current.filter((start) => start.promise !== promise));
  }
}
