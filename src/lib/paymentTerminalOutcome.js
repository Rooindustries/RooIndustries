import { removeBrowserStorage, writeBrowserStorage } from "./browserStorage";
import { clearBookingConfirmation, createBookingConfirmation } from "./confirmationReceipt";
import { extractTokenNonce } from "./checkoutConfirmation";
import {
  buildBookingFromUnresolvedSession, clearDodoNavQuery, mergeLineageCheckout, ownsSessionHold,
  parseCheckoutFingerprint, paymentSessionMatchesBookingLineage, paymentSessionMatchesCheckout,
  stripDodoReturnFromHistory, writeStoredPaymentSessionState,
} from "./checkoutSessionGuard";
import { CHECKOUT_BOOKING_STORAGE_KEY, persistBookingPackageSelection } from "./checkoutStorage";
import {
  allocatePaymentSessionSeq, canWriteRefreshedHold, commitPaymentSessionState,
  doesLiveHoldMatchLineage, isAffirmativeTerminalRelease, readLiveSlotHold,
  releasePaymentSessionLock, STORAGE_SAVE_CHANGE_ONLY_ERROR, STORAGE_SAVE_ERROR,
  verifyProviderLaunchPayload,
} from "./paymentSessionLocks";
import { areSameLineageNonces, markReservationTerminal, recordHoldNonceRotation, reservationScopeKey } from "./reservationScope";

const HOLD_KEY = "my_slot_hold";
const CLEANUP_PENDING_MSG = "Still finalizing your payment update. Click 'Check payment status' again shortly.";
const stripRetryPrompt = (msg) => msg.replace(/\s+Please\s+[^.!?]+[.!?]?\s*$/i, "").trim() || msg;

const emitHoldState = (holdState) => {
  try {
    if (holdState) writeBrowserStorage("sessionStorage", HOLD_KEY, JSON.stringify(holdState));
    else removeBrowserStorage("sessionStorage", HOLD_KEY);
    window.dispatchEvent(new CustomEvent("hold-state", { detail: holdState || null }));
  } catch {}
};

const isUpgradePaymentSession = (session) => {
  if (!session || typeof session !== "object") return false;
  if (session.scopeKey) {
    try {
      const p = JSON.parse(session.scopeKey);
      if (p?.k === "u") return true;
      if (p?.k === "b") return false;
    } catch {}
  }
  return Boolean(String(parseCheckoutFingerprint(session.fingerprint)?.originalOrderId || "").trim());
};

const getSessionHoldIdentity = (session) => {
  if (!session || isUpgradePaymentSession(session)) return { holdId: "", holdNonce: "", explicit: true };
  const sid = String(session.sessionHoldId || "").trim();
  if (sid) return { holdId: sid, holdNonce: extractTokenNonce(session.sessionHoldNonce || ""), explicit: true };
  const ref = session.result?.refreshedHold || session.result?.hold;
  if (ref?.slotHoldId) return { holdId: String(ref.slotHoldId).trim(), holdNonce: extractTokenNonce(ref.slotHoldToken || ""), explicit: true };
  if (session.scopeKey) {
    try {
      const p = JSON.parse(session.scopeKey);
      if (p?.k === "b" && p.h) return { holdId: String(p.h).trim(), holdNonce: extractTokenNonce(p.n || ""), explicit: true };
    } catch {}
  }
  return { holdId: "", holdNonce: "", explicit: false };
};

export const isLiveHoldOwnedBySession = (session, liveHold) => {
  if (!session || !liveHold?.holdId || isUpgradePaymentSession(session)) return false;
  const liveId = String(liveHold.holdId || liveHold.slotHoldId || "").trim();
  const liveNonce = extractTokenNonce(liveHold.holdToken || liveHold.slotHoldToken || "");
  if (!liveId) return false;
  const ident = getSessionHoldIdentity(session);
  if (ident.explicit) {
    return Boolean(ident.holdId && ident.holdId === liveId && (!ident.holdNonce || !liveNonce || areSameLineageNonces(ident.holdId, ident.holdNonce, liveNonce)));
  }
  const fp = parseCheckoutFingerprint(session.fingerprint);
  return Boolean(
    fp?.startTimeUTC && liveHold.startTimeUTC &&
    String(fp.startTimeUTC) === String(liveHold.startTimeUTC) &&
    (!fp.packageTitle || !liveHold.packageTitle || String(fp.packageTitle) === String(liveHold.packageTitle))
  );
};

export const sessionOwnsCheckoutBooking = (session, booking) => {
  if (!session || !booking || typeof booking !== "object") return false;
  if (!booking.packageTitle && !booking.originalOrderId && !booking.slotHoldId && !booking.startTimeUTC) return false;
  const sessionUpgrade = isUpgradePaymentSession(session);
  if (sessionUpgrade !== Boolean(String(booking.originalOrderId || "").trim())) return false;
  const bookingFp = JSON.stringify({
    packageTitle: booking.packageTitle || "", originalOrderId: booking.originalOrderId || "",
    startTimeUTC: booking.startTimeUTC || "", email: booking.email || "",
    referralCode: booking.referralCode || "", couponCode: booking.couponCode || "",
  });
  if (!paymentSessionMatchesCheckout(session.fingerprint, bookingFp) || !paymentSessionMatchesBookingLineage(session, booking)) return false;
  if (!sessionUpgrade) {
    const ident = getSessionHoldIdentity(session);
    if (ident.explicit && ident.holdId) {
      const bHoldId = String(booking.slotHoldId || "").trim();
      if (!bHoldId || bHoldId !== ident.holdId) return false;
      const bNonce = extractTokenNonce(booking.slotHoldToken || "");
      if (ident.holdNonce && bNonce && !areSameLineageNonces(ident.holdId, ident.holdNonce, bNonce)) return false;
    }
  }
  return true;
};

const isUnexpiredHold = (hold) => {
  if (!hold?.holdId || !hold?.holdToken) return false;
  if (!hold.expiresAt) return true;
  const ts = new Date(hold.expiresAt).getTime();
  return Number.isFinite(ts) && ts > Date.now();
};

const buildFailureBanner = ({ terminalStatus, data, isUpgrade, ownsCurrentHold, holdRetainedApplied, hasVerifiedNewerHold = false, reason: explicitReason = "" }) => {
  const overrideReason = String(explicitReason || "").trim();
  if (terminalStatus === "refunded") {
    return { text: overrideReason || "This payment was refunded. Go back to booking to choose a time.", persistent: true, chooseNewTime: !isUpgrade && ownsCurrentHold };
  }
  if (terminalStatus === "abandoned") {
    return { text: overrideReason || "Payment was not completed and the slot was released. Go back to booking to choose a time.", persistent: true, chooseNewTime: !isUpgrade && ownsCurrentHold };
  }
  const rawReason = String(data?.paymentFailureMessage || data?.recoveryReason || overrideReason || "").trim();
  const reason = rawReason || "Your payment could not be completed. Please try again or use another payment method.";
  if (isUpgrade) return { text: reason, persistent: true };
  if (!ownsCurrentHold) {
    return hasVerifiedNewerHold
      ? { text: reason, detail: "Your current slot reservation is still active and ready for checkout.", persistent: true }
      : { text: reason, persistent: true };
  }
  if (holdRetainedApplied) {
    const rem = Number(data?.retriesRemaining);
    const remText = Number.isFinite(rem) && rem > 0 ? ` (${rem === 1 ? "1 retry left" : `${rem} retries left`})` : "";
    return { text: reason, detail: `Your time slot is still reserved${remText}.`, persistent: true };
  }
  if (!rawReason) {
    return { text: "Payment was not completed and the slot was released. Go back to booking to choose a time.", persistent: true, chooseNewTime: true };
  }
  return {
    text: stripRetryPrompt(rawReason),
    detail: data?.slotReleased === false
      ? "Your previous reservation could not be reused. Go back to booking to choose a time."
      : "Your reserved time slot was released. Go back to booking to choose a time.",
    persistent: true,
    chooseNewTime: true,
  };
};

const applyDodoTerminalHoldOutcome = ({
  activeSession, terminalStatus, responseData, bookingData, storedCheckout,
  packageTitle, packagePrice, setSessionHold, writeStoredCheckout, reason = "",
}) => {
  const sessionIsUpgrade = isUpgradePaymentSession(activeSession);
  const liveHold = readLiveSlotHold();
  const ownsLiveHold = isLiveHoldOwnedBySession(activeSession, liveHold);
  const ownsStoredCheckout = sessionOwnsCheckoutBooking(activeSession, storedCheckout);
  const hasStoredT2 = Boolean(storedCheckout?.packageTitle && !ownsStoredCheckout);
  const liveT2Hold = !ownsLiveHold && isUnexpiredHold(liveHold) ? liveHold : null;

  if (sessionIsUpgrade) {
    return {
      nextCheckout: hasStoredT2 ? storedCheckout : null, requote: hasStoredT2, returnToBookingWithHold: !hasStoredT2 ? liveT2Hold : null,
      banner: buildFailureBanner({ terminalStatus, data: responseData, isUpgrade: true, ownsCurrentHold: false, holdRetainedApplied: false, reason }),
    };
  }
  if (!ownsStoredCheckout) {
    if (ownsLiveHold && (terminalStatus !== "failed" || responseData?.holdRetained !== true)) emitHoldState(null);
    if (!hasStoredT2 && liveT2Hold) {
      return {
        nextCheckout: null, requote: false, returnToBookingWithHold: liveT2Hold,
        banner: buildFailureBanner({ terminalStatus, data: responseData, isUpgrade: false, ownsCurrentHold: false, holdRetainedApplied: false, hasVerifiedNewerHold: true, reason }),
      };
    }
    if (hasStoredT2) {
      const matchedLiveT2 = Boolean(liveT2Hold && String(storedCheckout.slotHoldId || "") === String(liveT2Hold.holdId || ""));
      const hasVerifiedNewerHold = matchedLiveT2 || isUnexpiredHold({
        holdId: storedCheckout.slotHoldId, holdToken: storedCheckout.slotHoldToken, expiresAt: storedCheckout.slotHoldExpiresAt,
      });
      setSessionHold(
        matchedLiveT2
          ? { slotHoldId: liveT2Hold.holdId, slotHoldToken: liveT2Hold.holdToken, slotHoldExpiresAt: liveT2Hold.expiresAt || "", phase: liveT2Hold.phase || "active" }
          : null,
        storedCheckout
      );
      return {
        nextCheckout: storedCheckout, requote: true, returnToBookingWithHold: null,
        banner: buildFailureBanner({ terminalStatus, data: responseData, isUpgrade: false, ownsCurrentHold: false, holdRetainedApplied: false, hasVerifiedNewerHold, reason }),
      };
    }
  }
  const ref = responseData?.holdRetained === true ? responseData?.refreshedHold : null;
  if (terminalStatus === "failed" && ref?.slotHoldId && ref?.slotHoldToken) {
    const expiresAt = ref.slotHoldExpiresAt || ref.expiresAt || bookingData?.slotHoldExpiresAt || "";
    recordHoldNonceRotation({
      slotHoldId: ref.slotHoldId, fromNonce: getSessionHoldIdentity(activeSession).holdNonce || bookingData?.slotHoldToken || "", toNonce: ref.slotHoldToken,
    });
    const nextCheckout = mergeLineageCheckout(storedCheckout, bookingData, {
      slotHoldId: ref.slotHoldId, slotHoldToken: ref.slotHoldToken, slotHoldExpiresAt: expiresAt,
    });
    setSessionHold({ slotHoldId: ref.slotHoldId, slotHoldToken: ref.slotHoldToken, slotHoldExpiresAt: expiresAt, phase: ref.phase || "active" }, nextCheckout);
    writeStoredCheckout(nextCheckout);
    if (ownsLiveHold || !liveT2Hold) {
      emitHoldState({
        holdId: ref.slotHoldId, holdToken: ref.slotHoldToken, expiresAt,
        startTimeUTC: nextCheckout.startTimeUTC || bookingData?.startTimeUTC || "",
        packageTitle: nextCheckout.packageTitle || packageTitle,
        packagePrice: nextCheckout.packagePrice || packagePrice,
        phase: ref.phase || "active",
      });
    }
    return {
      nextCheckout, requote: true, returnToBookingWithHold: null,
      banner: buildFailureBanner({ terminalStatus, data: responseData, isUpgrade: false, ownsCurrentHold: true, holdRetainedApplied: true, reason }),
    };
  }
  const nextCheckout = mergeLineageCheckout(storedCheckout, bookingData, { slotHoldId: "", slotHoldToken: "", slotHoldExpiresAt: "" });
  setSessionHold(null);
  writeStoredCheckout(nextCheckout);
  if (ownsLiveHold || !liveHold) emitHoldState(null);
  return {
    nextCheckout, requote: false, returnToBookingWithHold: null,
    banner: buildFailureBanner({ terminalStatus, data: responseData, isUpgrade: false, ownsCurrentHold: true, holdRetainedApplied: false, reason }),
  };
};

export const handleDodoTerminalNavigation = (ctx) => {
  const { dodoReturnHandled, location, navState, backToBookingState, navigate, lastQuoteKeyRef, setQuoteRetryCount, showBanner } = ctx;
  const outcome = applyDodoTerminalHoldOutcome(ctx);
  dodoReturnHandled.current = "";
  if (outcome.returnToBookingWithHold) {
    const liveT2 = outcome.returnToBookingWithHold;
    removeBrowserStorage("sessionStorage", "booking_modal_state");
    const holdPkg = liveT2.packageTitle
      ? persistBookingPackageSelection({ title: liveT2.packageTitle, price: liveT2.packagePrice || "", tag: liveT2.packageTag || "" })
      : null;
    navigate("/booking", { replace: true, state: { ...backToBookingState, ...(holdPkg ? { bookingPackage: holdPkg } : {}), resumeHoldStep: true } });
    return true;
  }
  const query = new URLSearchParams(location.search);
  query.delete("dodo_return"); query.delete("dodo_cancel"); query.delete("dodo_session");
  navigate({ pathname: location.pathname, search: query.toString() ? `?${query}` : "", hash: location.hash }, {
    replace: true, state: outcome.nextCheckout ? { ...navState, bookingData: outcome.nextCheckout } : navState,
  });
  if (outcome.requote) { lastQuoteKeyRef.current = ""; setQuoteRetryCount((c) => c + 1); }
  showBanner("error", outcome.banner.text, outcome.banner);
  return true;
};

export function createConfirmationNavigationState({
  responseBody = {}, baseState, scopeKey, holdExpiryHandledRef, writeStoredCheckout,
  activeSession = null, readStoredCheckout = null,
}) {
  const bookingId = String(responseBody?.bookingId || "").trim();
  const storedCheckout = typeof readStoredCheckout === "function" ? readStoredCheckout() : null;
  const ownsCheckout = !activeSession || sessionOwnsCheckoutBooking(activeSession, storedCheckout);
  const ownsHold = !activeSession || isLiveHoldOwnedBySession(activeSession, readLiveSlotHold());
  const terminalScope = activeSession
    ? String(activeSession.scopeKey || reservationScopeKey(buildBookingFromUnresolvedSession(activeSession)) || "").trim()
    : scopeKey;
  if (ownsCheckout) holdExpiryHandledRef.current = true;
  if (terminalScope) markReservationTerminal(terminalScope, responseBody?.status || "booked");
  if (ownsCheckout) writeStoredCheckout(null);
  if (ownsHold) emitHoldState(null);
  if (!bookingId) { clearBookingConfirmation(); return baseState; }
  return { ...(baseState || {}), bookingConfirmation: createBookingConfirmation(responseBody) };
}

export async function runLegacyDodoStatusCheck({
  token, activeSession = null, operation, fetchJson, setBusy, onBooked, onManualReview, onCleanupPending, onTerminalClear,
}) {
  setBusy(true);
  try {
    const { response, data } = await fetchJson("/api/payment/status", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}",
    });
    if (!operation.current()) return;
    const st = String(data?.status || "").trim().toLowerCase();
    if (response.ok && data?.manualReviewRequired === true) onManualReview(data.recoveryReason);
    else if (response.ok && data?.cleanupPending === true) onCleanupPending?.(data?.recoveryReason || CLEANUP_PENDING_MSG, data);
    else if (response.ok && (st === "booked" || st === "email_partial")) await onBooked(data, operation, activeSession);
    else if (["failed", "abandoned", "refunded"].includes(st) && isAffirmativeTerminalRelease(response.status === 200, data)) {
      releasePaymentSessionLock({ token, scopeKey: activeSession?.scopeKey || "", seq: allocatePaymentSessionSeq() });
      onTerminalClear(st, token, data);
    }
  } finally {
    if (operation.current()) setBusy(false);
  }
}

export async function runDodoCheckoutFlow(c) {
  const operation = c.createPaymentOperation();
  if (!operation.current() || c.payingDodo || c.paymentBusy || c.paymentActionRef.current.cancelling || c.otherCheckoutStarting("dodo") || !c.ensureSlotBeforeAction()) return;
  c.setPayingDodo(true);
  try {
    const session = await c.startSessionCheckout("dodo", operation);
    if (!operation.current() || session?.terminal) return;
    const verified = verifyProviderLaunchPayload({
      provider: "dodo", payload: session?.providerPayload,
      expectedAmount: session?.result?.quote?.netAmount ?? c.finalAmount,
      expectedCurrency: session?.result?.quote?.currency || c.displayQuoteCurrency,
    });
    if (!verified.ok) throw new Error(verified.reason);
    const ref = session.result?.refreshedHold || session.result?.hold || c.sessionHold;
    const returnCheckout = mergeLineageCheckout(
      c.readStoredCheckout(), c.checkoutRef.current || c.bookingData,
      ref?.slotHoldId && ref?.slotHoldToken
        ? { slotHoldId: ref.slotHoldId, slotHoldToken: ref.slotHoldToken, slotHoldExpiresAt: ref.slotHoldExpiresAt || ref.expiresAt || "" }
        : {}
    );
    if (!writeBrowserStorage("sessionStorage", CHECKOUT_BOOKING_STORAGE_KEY, JSON.stringify(returnCheckout)) || !writeStoredPaymentSessionState(session)) {
      c.showBanner("error", STORAGE_SAVE_ERROR, { persistent: true });
      return;
    }
    stripDodoReturnFromHistory();
    window.location.assign(verified.checkoutUrl);
  } catch (error) {
    if (!operation.current()) return;
    c.showBanner("error", (error?.name === "AbortError" || error?.name === "TimeoutError") ? "Checkout timed out. Please try again." : error.message || "Unable to open checkout.", { persistent: true });
  } finally {
    if (operation.current()) c.setPayingDodo(false);
  }
}

export async function runFreeBookingCheckout(c) {
  const operation = c.createPaymentOperation();
  if (!operation.current() || !c.isFree || c.validating || c.validatingCoupon || c.paymentBusy || c.paymentActionRef.current.cancelling || c.otherCheckoutStarting("free") || !c.ensureSlotBeforeAction()) return;
  c.manualCodeAllowedRef.current = false;
  c.setCreatingFree(true);
  const endConfirmation = c.beginCheckoutConfirmation(c.holdForGuard);
  try {
    c.showBanner("info", "Confirming your free booking...");
    const session = await c.startSessionCheckout("free", operation);
    if (!operation.current() || session?.stale) return;
    const data = session?.result || {};
    const status = String(data.status || "").trim().toLowerCase();
    if (!data.bookingId || (status !== "booked" && status !== "email_partial")) {
      throw new Error(data.error || "Could not save your free booking.");
    }
    await c.showConfirmation("free", data, operation);
  } catch (err) {
    if (!operation.current()) return;
    console.error("Free booking failed");
    c.showBanner("error", err?.message || "Something went wrong saving your free booking. Please contact support.");
    if (c.holdExpiresAt && new Date(c.holdExpiresAt).getTime() <= Date.now()) {
      c.holdExpiryHandledRef.current = true;
      c.navigate("/", { replace: true });
    }
  } finally {
    endConfirmation();
    if (operation.current()) c.setCreatingFree(false);
  }
}

const mergeResult = (prev, next) => {
  const merged = { ...(prev || {}), ...(next || {}) };
  if (prev?.quote && typeof prev.quote === "object" && next?.quote && typeof next.quote === "object") {
    const pCur = String(prev.quote.currency || "").trim().toUpperCase(), nCur = String(next.quote.currency || "").trim().toUpperCase();
    const sameTotals = Number(prev.quote.grossAmount) === Number(next.quote.grossAmount) && Number(prev.quote.netAmount) === Number(next.quote.netAmount) && (!pCur || !nCur || pCur === nCur);
    merged.quote = sameTotals ? { ...prev.quote, ...next.quote } : next.quote;
  }
  return merged;
};

export const persistStrippedSession = ({ session, data, seq, scopeKey, persistPaymentSession, stripDodoUrl = false }) => {
  if (!session || !persistPaymentSession) return null;
  const cleanedPayload = session.providerPayload?.taxInclusive === false && data?.providerPayload?.taxInclusive === undefined
    ? { taxInclusive: false, ...(session.providerPayload || {}), ...(data?.providerPayload || {}) }
    : { ...(session.providerPayload || {}), ...(data?.providerPayload || {}) };
  if (
    session.provider === "dodo" &&
    (stripDodoUrl || data?.cleanupPending === true || data?.providerOrderReady === false || data?.attemptStarted === true || (data?.providerPayload && !data.providerPayload.checkoutUrl))
  ) {
    delete cleanedPayload.checkoutUrl;
  }
  const ref = data?.refreshedHold || data?.hold;
  const next = commitPaymentSessionState({
    ...session,
    ...(ref?.slotHoldId && !isUpgradePaymentSession(session) ? { sessionHoldId: String(ref.slotHoldId).trim(), sessionHoldNonce: extractTokenNonce(ref.slotHoldToken || "") } : {}),
    providerPayload: cleanedPayload,
    providerOrderReady: data?.providerOrderReady ?? session.providerOrderReady,
    result: mergeResult(session.result, data),
  }, { seq, scopeKey });
  if (next) persistPaymentSession(next, true);
  return next;
};

export const handleCleanupPending = ({ session, data, seq, scopeKey, persistPaymentSession, showBanner }) => {
  const updated = persistStrippedSession({ session, data, seq, scopeKey, persistPaymentSession, stripDodoUrl: true });
  showBanner("info", data?.recoveryReason || CLEANUP_PENDING_MSG, { persistent: true });
  return updated;
};

export const applyCancelRefreshedHold = ({
  activeSession, refreshedHold, storedCheckout, liveHold, initialHoldId, initialHoldNonce,
  bookingData, packageTitle, packagePrice, setSessionHold, writeStoredCheckout,
}) => {
  const ownsCheckout = sessionOwnsCheckoutBooking(activeSession, storedCheckout);
  const ownsLiveHold = isLiveHoldOwnedBySession(activeSession, liveHold);
  let refreshedCheckout = null;
  if (
    refreshedHold?.slotHoldId &&
    refreshedHold?.slotHoldToken &&
    (ownsCheckout || ownsLiveHold) &&
    (!ownsLiveHold || ((!initialHoldId || doesLiveHoldMatchLineage(initialHoldId, initialHoldNonce)) && canWriteRefreshedHold(refreshedHold, initialHoldId, initialHoldNonce)))
  ) {
    recordHoldNonceRotation({ slotHoldId: refreshedHold.slotHoldId, fromNonce: initialHoldNonce || bookingData?.slotHoldToken || "", toNonce: refreshedHold.slotHoldToken });
    if (ownsCheckout) {
      refreshedCheckout = mergeLineageCheckout(storedCheckout, bookingData, {
        slotHoldId: refreshedHold.slotHoldId, slotHoldToken: refreshedHold.slotHoldToken, slotHoldExpiresAt: refreshedHold.slotHoldExpiresAt,
      });
      setSessionHold(refreshedHold, refreshedCheckout);
      writeStoredCheckout(refreshedCheckout);
    }
    if (ownsLiveHold || (!liveHold && ownsCheckout)) {
      emitHoldState({
        holdId: refreshedHold.slotHoldId, holdToken: refreshedHold.slotHoldToken,
        expiresAt: refreshedHold.slotHoldExpiresAt, startTimeUTC: bookingData?.startTimeUTC || "",
        packageTitle, packagePrice, phase: "holding",
      });
    }
  }
  return { ownsCheckout, ownsLiveHold, refreshedCheckout };
};

export const clearPaymentSessionOutcome = (c) => {
  const { activeSession, isTerminal } = c;
  if (isTerminal && activeSession?.provider === "dodo") {
    return handleDodoTerminalNavigation({ ...c, storedCheckout: c.readStoredCheckout() });
  }
  return clearNonDodoHold(c);
};
const clearNonDodoHold = ({
  activeSession, isUpgrade, isTerminal, forceReleaseHold, flowCtx,
  checkoutRef, bookingData, setSessionHold, writeStoredCheckout,
  dodoReturnHandled, latestNavRef, navigate, showBanner, terminalStatus, reason,
}) => {
  const ownsHold = ownsSessionHold(activeSession, flowCtx);
  const keepHold = (!forceReleaseHold && activeSession?.provider !== "dodo") || isUpgrade || !isTerminal;
  const liveHold = readLiveSlotHold();
  if (keepHold || !ownsHold || (liveHold && !isLiveHoldOwnedBySession(activeSession, liveHold))) return false;
  const nextCheckout = { ...(checkoutRef.current || bookingData), slotHoldId: "", slotHoldToken: "", slotHoldExpiresAt: "" };
  checkoutRef.current = nextCheckout;
  setSessionHold(null);
  writeStoredCheckout(nextCheckout);
  emitHoldState(null);
  clearDodoNavQuery({ dodoReturnHandled, latestNavRef, navigate, nextCheckout, force: true });
  showBanner("error", String(reason || "").trim() || (terminalStatus === "refunded"
    ? "This payment was refunded. Go back to booking to choose a time."
    : "Payment was not completed and the slot was released. Go back to booking to choose a time."), { persistent: true });
  return true;
};

export const mountRazorpaySdk = ({ setRzpReady, showBanner }) => {
  const script = document.createElement("script");
  script.src = "https://checkout.razorpay.com/v1/checkout.js";
  script.async = true;
  script.onload = () => setRzpReady(true);
  script.onerror = () => {
    console.error("Failed to load Razorpay SDK");
    setRzpReady(false);
    showBanner("error", "Payment system failed to load. Please refresh the page and try again.");
  };
  document.body.appendChild(script);
  return () => { script.remove(); };
};

export const runRazorpayCheckoutFlow = async (c) => {
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
          await c.finalizeSessionCheckout({ operation, activeSession: rzpSession, paymentAccessToken: String(paymentAccessToken || c.paymentSession?.paymentAccessToken || "").trim(), providerData: { razorpayOrderId: response.razorpay_order_id, razorpayPaymentId: response.razorpay_payment_id, razorpaySignature: response.razorpay_signature } });
        } catch { if (operation.current()) { console.error("Razorpay booking finalization failed"); c.showBanner("error", "Payment succeeded but something went wrong saving your booking. Please contact support."); } }
      },
      modal: { ondismiss: () => { if (operation.current()) c.showBanner("info", "Checkout closed. Your payment session is still reserved for this method."); } },
    }).open();
  } catch (err) { if (operation.current()) { console.error("Razorpay checkout failed"); c.showBanner("error", err?.message || "Payment could not be processed. Please try again."); } }
  finally { if (operation.current()) c.setPayingRzp(false); }
};
