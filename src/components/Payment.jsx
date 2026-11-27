import { clearBookingConfirmation } from "../lib/confirmationReceipt";
import { writeBrowserStorage } from "../lib/browserStorage";
import React, { lazy, Suspense, useState, useMemo, useEffect, useRef } from "react";
import { useLocation, Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { WalletCards } from "lucide-react";
import packagePricing from "../lib/packagePricing";
import {
  preloadPurchaseTracking, trackCheckoutSessionStarted, trackConfirmedPurchase,
} from "../lib/checkoutAnalytics";
import { eventMoment } from "../lib/loadPostHog";
import { preloadConfirmationPage, preloadConfirmationPages } from "../lib/confirmationPages";
import { useBookingDialogPending } from "../lib/bookingDialogHold";
import { beginCheckoutConfirmation, CHECKOUT_CONFIRMATION_EVENT, isHoldProtectedFromExpiry } from "../lib/checkoutConfirmation";
import {
  calculateCheckoutDiscounts,
  fetchCheckoutQuote,
  formatCheckoutAmount,
  normalizeCurrencyCode,
  toMoney,
} from "../lib/checkoutCodes";
import { requestDeadline } from "../lib/clientRequest";
import { cleanOutsideValue } from "../lib/outsideValue.cjs";
import { readLinkReferralFromSession, readStoredCheckoutBooking, stripReservedCode } from "../lib/checkoutStorage";
import { stripRefFromSearch, writeLinkReferralToSession } from "../lib/arrivalSnapshot";
import { normalizeLinkReferral } from "../lib/refShape.js";
import { markReservationTerminal, reservationScopeKey } from "../lib/reservationScope";
import {
  areSameLineageScopeKeys, buildBookingFromUnresolvedSession, clearDodoNavQuery,
  clearStoredPaymentSessionState, extractPaymentLockId, isPaymentLockReleased,
  mergeLineageCheckout, parseCheckoutFingerprint,
  paymentSessionMatchesBookingLineage, paymentSessionMatchesCheckout,
  readScopedQuoteProvider, readStoredPaymentSessionState, selectPaymentBookingData,
  syncCheckoutRef, validateDodoCallback, writeScopedQuoteProvider,
  writeStoredPaymentSessionState,
} from "../lib/checkoutSessionGuard";
import PayPalMethodPanel from "./PayPalPanelSlot";
let cachedCheckoutHoldMod = null;
const loadCheckoutHold = () => import("../lib/paymentCheckoutHold").then((m) => { cachedCheckoutHoldMod = m; return m; });
const loadConsentPanel = () => import("./PaymentConsentPanel");
const ActiveUpgradeBlocker = lazy(() => loadCheckoutHold().then((m) => ({ default: m.ActiveUpgradeBlocker })));
const PaymentConsentPanel = lazy(loadConsentPanel);
const PaymentBanner = lazy(() => loadConsentPanel().then((m) => ({ default: m.PaymentBanner })));

const GlowLines = () => (
  <>
    <span className="glow-line glow-line-top" />
    <span className="glow-line glow-line-right" />
    <span className="glow-line glow-line-bottom" />
    <span className="glow-line glow-line-left" />
  </>
);

const { applyPackagePricing } = packagePricing;
const PAYMENT_FETCH_TIMEOUT_MS = 15_000;
const CONFIRMATION_PRELOAD_WAIT_MS = 2500;

const formatLocalDate = (utcDate, timeZone) => { try { return new Intl.DateTimeFormat(undefined, { ...(timeZone ? { timeZone } : {}), weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(utcDate); } catch { return "-"; } };
const formatLocalTime = (utcDate, timeZone) => { try { return new Intl.DateTimeFormat(undefined, { ...(timeZone ? { timeZone } : {}), hour: "numeric", minute: "2-digit" }).format(utcDate); } catch { return "-"; } };

export default function Payment({ hideFooter = false }) {
  useEffect(() => { clearBookingConfirmation(); }, []);
  useEffect(preloadPurchaseTracking, []);
  useEffect(() => {
    preloadConfirmationPages().catch(() => {});
  }, []);
  const location = useLocation();
  const navigate = useNavigate();
  const [hydrated, setHydrated] = useState(false);
  const [browserTimeZone, setBrowserTimeZone] = useState("UTC");

  useEffect(() => {
    setHydrated(true);
    try { setBrowserTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"); } catch { setBrowserTimeZone("UTC"); }
  }, []);

  const FLOW_BACKGROUND_KEY = "flow_background_location";
  const CHECKOUT_BOOKING_STORAGE_KEY = "checkout_booking_state";
  const INTERNAL_PAYMENTS_KEY = "roo_internal_payments";

  const readStoredBackground = () => { try { const p = JSON.parse(sessionStorage.getItem(FLOW_BACKGROUND_KEY) || "null"); return p?.pathname ? p : null; } catch { return null; } };
  const writeStoredBackground = (loc) => { try { if (loc?.pathname) sessionStorage.setItem(FLOW_BACKGROUND_KEY, JSON.stringify({ pathname: loc.pathname, search: loc.search || "", hash: loc.hash || "" })); } catch {} };
  const writeStoredReferral = writeLinkReferralToSession;
  const readStoredPaymentSession = readStoredPaymentSessionState, writeStoredPaymentSession = writeStoredPaymentSessionState, clearStoredPaymentSession = clearStoredPaymentSessionState;
  const readStoredCheckout = readStoredCheckoutBooking;
  const writeStoredCheckout = (value) => { try { if (!value || typeof value !== "object") sessionStorage.removeItem(CHECKOUT_BOOKING_STORAGE_KEY); else sessionStorage.setItem(CHECKOUT_BOOKING_STORAGE_KEY, JSON.stringify(value)); } catch {} };

  const [popState, setPopState] = useState({ key: "", seq: 0 });
  const locationKeyRef = useRef(location.key); locationKeyRef.current = location.key;
  useEffect(() => {
    const onPop = () => setPopState((p) => ({ key: locationKeyRef.current, seq: p.seq + 1 }));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const historyUsrState = hydrated && typeof window !== "undefined" ? window.history?.state?.usr : null;
  const navState = useMemo(() => (popState.seq > 0 && popState.key === location.key ? historyUsrState || location.state : location.state || historyUsrState) || {}, [popState, location.key, historyUsrState, location.state]);

  const [sessionHoldState, setSessionHoldState] = useState(null);
  const [paymentSession, setPaymentSession] = useState(null);
  const rawBookingData = useMemo(() => {
    try {
      const parsed = selectPaymentBookingData(navState.bookingData, hydrated ? readStoredCheckout() : null, () => writeStoredCheckout(null));
      const pricedPackage = applyPackagePricing({ title: parsed.packageTitle, price: parsed.packagePrice });
      return {
        ...parsed,
        referralCode: stripReservedCode(parsed.referralCode),
        couponCode: stripReservedCode(parsed.couponCode),
        packageTitle: pricedPackage?.title || parsed.packageTitle,
        packagePrice: pricedPackage?.price || parsed.packagePrice,
      };
    } catch { return {}; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, popState.seq, location.key, location.search, navState.bookingData, sessionHoldState?.slotHoldId, sessionHoldState?.slotHoldToken, paymentSession?.paymentAccessToken]);
  const unresolvedStoredSession = hydrated ? (paymentSession || readStoredPaymentSession()) : null;
  const hasLiveUnresolvedSession = Boolean(unresolvedStoredSession?.paymentAccessToken && !isPaymentLockReleased(unresolvedStoredSession.paymentAccessToken));
  const usingUnresolvedFallback = !rawBookingData.packageTitle && hasLiveUnresolvedSession;
  const bookingData = useMemo(() => {
    if (rawBookingData.packageTitle || !hasLiveUnresolvedSession) return rawBookingData;
    const fallback = buildBookingFromUnresolvedSession(unresolvedStoredSession);
    const priced = applyPackagePricing({ title: fallback.packageTitle, price: fallback.packagePrice });
    return { ...fallback, packageTitle: priced?.title || fallback.packageTitle, packagePrice: priced?.price || fallback.packagePrice };
  }, [rawBookingData, hasLiveUnresolvedSession, unresolvedStoredSession?.paymentAccessToken, unresolvedStoredSession?.fingerprint]);
  const currentScopeKey = useMemo(() => reservationScopeKey(bookingData), [bookingData]);
  const currentScopeKeyRef = useRef(currentScopeKey); currentScopeKeyRef.current = currentScopeKey;
  const checkoutRef = useRef(null);
  const latestNavRef = useRef({ location, navState });
  latestNavRef.current = { location, navState };
  syncCheckoutRef(checkoutRef, bookingData, hydrated || Boolean(navState.bookingData));
  const skipPreApplyKeyRef = useRef("");
  const paymentActionRef = useRef({ seq: 0, cancelling: false });
  useEffect(() => {
    const syncedBookingData = checkoutRef.current || bookingData;
    if (navState.bookingData && !usingUnresolvedFallback) {
      writeStoredCheckout(mergeLineageCheckout(readStoredCheckout(), syncedBookingData));
    }

    const params = new URLSearchParams(location.search);
    const sensitiveKeys = ["data", "paymentAccessToken", "payment", "paymentFlow"];
    const shouldScrub = sensitiveKeys.some((key) => params.has(key));
    if (!shouldScrub) return;

    sensitiveKeys.forEach((key) => params.delete(key));
    const nextState = navState.bookingData ? { ...navState, bookingData: syncedBookingData } : navState;
    navigate(
      {
        pathname: location.pathname,
        search: params.toString() ? `?${params.toString()}` : "",
        hash: location.hash,
      },
      { replace: true, state: nextState }
    );
  }, [location.hash, location.pathname, location.search, navState, navigate, usingUnresolvedFallback]);

  const isUpgrade = !!bookingData.originalOrderId;
  const sessionHold = sessionHoldState && areSameLineageScopeKeys(sessionHoldState.scopeKey, currentScopeKey) ? sessionHoldState : null;
  const setSessionHold = (next, nextBooking = null) => {
    if (nextBooking) checkoutRef.current = nextBooking;
    setSessionHoldState(next ? { ...next, scopeKey: nextBooking ? reservationScopeKey(nextBooking) : currentScopeKeyRef.current } : null);
  };
  const storedBackground = hydrated ? readStoredBackground() : null;
  const modalBackground =
    navState.backgroundLocation || storedBackground || null;

  useEffect(() => {
    if (navState.backgroundLocation) {
      writeStoredBackground(navState.backgroundLocation);
    }
  }, [navState.backgroundLocation]);

  const isModalMode = !!modalBackground || navState.modal === true;
  const hideFooterEffective = hideFooter || isModalMode;

  const getModalFlowState = () => (isModalMode ? { backgroundLocation: modalBackground || { pathname: "/", search: "", hash: "" }, modal: true } : undefined);

  const backToBookingState = {
    ...(modalBackground ? { backgroundLocation: modalBackground } : {}),
    modal: true,
    ...navState,
  };

  const hasTimeslot =
    !!bookingData?.startTimeUTC &&
    !!bookingData?.displayDate &&
    !!bookingData?.displayTime;
  const holdExpiresAt =
    sessionHold?.slotHoldExpiresAt ||
    sessionHold?.expiresAt ||
    bookingData?.slotHoldExpiresAt;
  const holdExpired =
    holdExpiresAt && new Date(holdExpiresAt).getTime() <= Date.now();
  const holdForGuard = useMemo(() => ({ holdId: sessionHold?.slotHoldId || bookingData?.slotHoldId || "", holdToken: sessionHold?.slotHoldToken || bookingData?.slotHoldToken || "", startTimeUTC: bookingData?.startTimeUTC || "", packageTitle: bookingData?.packageTitle || "" }), [sessionHold?.slotHoldId, sessionHold?.slotHoldToken, bookingData?.slotHoldId, bookingData?.slotHoldToken, bookingData?.startTimeUTC, bookingData?.packageTitle]);
  const [confirmationVersion, setConfirmationVersion] = useState(0);
  useEffect(() => { const onChange = () => setConfirmationVersion((v) => v + 1); window.addEventListener(CHECKOUT_CONFIRMATION_EVENT, onChange); return () => window.removeEventListener(CHECKOUT_CONFIRMATION_EVENT, onChange); }, []);
  const holdGuarded = hydrated && isHoldProtectedFromExpiry(holdForGuard);
  const dodoRedirect = new URLSearchParams(location.search);
  const dodoReturnHandled = useRef("");
  const storedDodoReturn = dodoRedirect.has("dodo_return") || dodoRedirect.has("dodo_cancel") ? readStoredPaymentSession() : null;
  const dodoDecision = validateDodoCallback({ query: dodoRedirect, session: storedDodoReturn, visibleBooking: bookingData, visibleFingerprint: JSON.stringify({ packageTitle: bookingData.packageTitle || "", originalOrderId: bookingData.originalOrderId || "", startTimeUTC: bookingData.startTimeUTC || "", email: bookingData.email || "", referralCode: bookingData.referralCode || "", couponCode: bookingData.couponCode || "" }) });
  const processingDodoReturn = ["cancel", "finalize", "status"].includes(dodoDecision.action) || ((dodoRedirect.has("dodo_return") || dodoRedirect.has("dodo_cancel")) && !!dodoReturnHandled.current);
  const hasSlotHold =
    !!(sessionHold?.slotHoldId || bookingData?.slotHoldId) &&
    !!(sessionHold?.slotHoldToken || bookingData?.slotHoldToken) &&
    (!holdExpired || holdGuarded);
  const canSubmitBooking = isUpgrade ? hasTimeslot : hasTimeslot && hasSlotHold;
  const holdExpiryHandledRef = useRef(false);
  const codeApplicationAllowedRef = useRef(canSubmitBooking);
  codeApplicationAllowedRef.current = canSubmitBooking;
  const manualCodeAllowedRef = useRef(canSubmitBooking);

  const ensureSlotBeforeAction = () => {
    if (canSubmitBooking) return true;
    if (isUpgrade) { showBanner("error", "Missing time details for this upgrade. Please contact support."); return false; }
    showBanner("error", holdExpired ? "Your reserved slot expired. Please select a new time before completing your booking." : "Please select a time slot before completing your booking.");
    navigate("/booking", { state: backToBookingState, replace: true });
    return false;
  };

  const packageTitle = bookingData.packageTitle || "";
  const packagePrice = bookingData.packagePrice || "$0";
  const parsedUtc = bookingData.startTimeUTC
    ? new Date(bookingData.startTimeUTC)
    : null;

  const utcStart =
    parsedUtc && !isNaN(parsedUtc.getTime()) ? parsedUtc : null;

  const userTimeZone = bookingData.localTimeZone || browserTimeZone;

  const date =
    bookingData.displayDate ||
    (utcStart ? formatLocalDate(utcStart, userTimeZone) : "-");
  const time =
    bookingData.displayTime ||
    (utcStart ? formatLocalTime(utcStart, userTimeZone) : "-");
  const baseAmount = Math.max(0, toMoney(packagePrice));

  const [referralInput, setReferralInput] = useState("");
  const [referral, setReferral] = useState(null);
  const [validating, setValidating] = useState(false);
  const [referralError, setReferralError] = useState("");

  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState(null);
  const [validatingCoupon, setValidatingCoupon] = useState(false);
  const checkingCode = validating || validatingCoupon;
  const [couponError, setCouponError] = useState("");
  const [preApplyingCodes, setPreApplyingCodes] = useState(true);

  const [banner, setBanner] = useState(null);
  const bannerRef = useRef(null);
  const [creatingFree, setCreatingFree] = useState(false);
  const [serverQuote, setServerQuote] = useState(null);
  const [quoteFingerprint, setQuoteFingerprint] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteSettled, setQuoteSettled] = useState(false);
  const [quoteRetryCount, setQuoteRetryCount] = useState(0);
  const [alreadyTargetInfo, setAlreadyTargetInfo] = useState(null);
  const [blockingUpgradeSession, setBlockingUpgradeSession] = useState(null);
  const [quoteHold, setQuoteHold] = useState(null);
  const quoteHoldRef = useRef(null); quoteHoldRef.current = quoteHold;
  const referralRef = useRef(referral); referralRef.current = referral;
  const couponRef = useRef(coupon); couponRef.current = coupon;
  const consentScopeRef = useRef("");
  const consentStateRef = useRef({ expectedClientTotal: null, expectedClientCurrency: "", acceptedQuoteTotal: null, acceptedQuoteCurrency: "", acceptedServerQuoteBreakdown: null });
  const hasConsentHold = Boolean(quoteHold);
  const validationGenRef = useRef(0);
  const referralCheckGenRef = useRef(0);
  const couponCheckGenRef = useRef(0);
  const quoteVersionRef = useRef(0);
  const serverQuoteRef = useRef(null); serverQuoteRef.current = serverQuote;
  const quoteFingerprintRef = useRef(""); quoteFingerprintRef.current = quoteFingerprint;
  const lastQuoteKeyRef = useRef("");

  const prevScopeKeyRef = useRef(currentScopeKey);
  useEffect(() => {
    const prev = prevScopeKeyRef.current;
    prevScopeKeyRef.current = currentScopeKey;
    if (areSameLineageScopeKeys(prev, currentScopeKey)) return;
    validationGenRef.current += 1;
    referralCheckGenRef.current += 1;
    couponCheckGenRef.current += 1;
    setValidating(false);
    setValidatingCoupon(false);
    setAlreadyTargetInfo(null);
    setBlockingUpgradeSession(null);
    quoteHoldRef.current = null;
    setQuoteHold(null);
  }, [currentScopeKey]);

  const consentModRef = useRef(null);
  useEffect(() => { loadConsentPanel().then((m) => { consentModRef.current = m; }).catch(() => {}); }, []);
  const consentCtxRef = useRef(null);
  const runConsentAction = (name, arg, { fallback = "Unable to update checkout. Please try again.", rethrow = false } = {}) => {
    const mod = consentModRef.current;
    if (mod) return mod.createPaymentConsentActions(consentCtxRef.current)[name](arg);
    const scope = currentScopeKeyRef.current;
    return loadConsentPanel().then((m) => {
      consentModRef.current = m;
      if (!paymentMountedRef.current || !areSameLineageScopeKeys(currentScopeKeyRef.current, scope)) return;
      return m.createPaymentConsentActions(consentCtxRef.current)[name](arg);
    }, (err) => {
      if (rethrow) throw err;
      if (fallback && paymentMountedRef.current) showBanner("error", fallback, { persistent: true });
    });
  };
  const applyAuthoritativeQuote = (arg) => runConsentAction("applyAuthoritativeQuote", arg, { fallback: "" });
  const handleAcceptQuoteHold = (hold) => runConsentAction("handleAcceptQuoteHold", hold);
  const handleRemoveDiscount = (slot) => runConsentAction("handleRemoveDiscount", slot);

  const showBanner = (type, text, options = {}) => {
    setBanner({ type, text, ...options });
    if (options.persistent || type === "error") return;
    setTimeout(() => {
      setBanner((prev) => (prev?.text === text ? null : prev));
    }, 4000);
  };

  useEffect(() => {
    if (banner?.text && (banner.type === "error" || banner.persistent)) {
      bannerRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [banner]);

  useEffect(() => {
    if (!hydrated || !holdExpiresAt || processingDodoReturn || creatingFree || holdGuarded || pendingStartsRef.current.length > 0) return;
    const expiresAtMs = new Date(holdExpiresAt).getTime();
    if (!Number.isFinite(expiresAtMs)) return;

    const triggerExpiry = () => {
      if (holdExpiryHandledRef.current || isHoldProtectedFromExpiry(holdForGuard) || pendingStartsRef.current.length > 0) return;
      holdExpiryHandledRef.current = true;
      codeApplicationAllowedRef.current = false;
      manualCodeAllowedRef.current = false;
      showBanner("error", "Your reserved slot expired. Please select a new time before completing your booking.");
      navigate("/booking", { state: backToBookingState, replace: true });
    };

    let timeoutId;
    const scheduleExpiry = () => {
      const remainingMs = expiresAtMs - Date.now();
      if (remainingMs <= 0) {
        triggerExpiry();
        return;
      }

      // Browsers clamp delays above a signed 32-bit integer. Re-arm long
      // timers instead of treating a distant expiry as immediate.
      timeoutId = setTimeout(scheduleExpiry, Math.min(remainingMs, 2_147_483_647));
    };

    scheduleExpiry();
    return () => clearTimeout(timeoutId);
  }, [hydrated, holdExpiresAt, holdForGuard, holdGuarded, confirmationVersion, processingDodoReturn, creatingFree, navigate, navState, location]);

  const sessionQuote = paymentSession?.paymentAccessToken ? paymentSession?.result?.quote : null;
  const net = sessionQuote?.netAmount;
  const quoteValid = (net != null && net !== "" && Number.isFinite(Number(net))) || sessionQuote?.isFree === true;
  const lockedSessionQuote = sessionQuote && quoteValid ? sessionQuote : null;
  const {
    couponDiscountAmount,
    canStackCouponWithReferral,
    referralDiscountAmount,
    isFree,
    preventedFreeReduction,
    finalAmount,
    effectiveDiscountAmount,
    discountPercentCombined,
    displayBaseAmount,
  } = calculateCheckoutDiscounts({
    baseAmount,
    referral,
    coupon,
    serverQuote: lockedSessionQuote || serverQuote,
  });

  const [rzpReady, setRzpReady] = useState(false);
  const [payingRzp, setPayingRzp] = useState(false);
  const [payingDodo, setPayingDodo] = useState(false);
  const [providerConfig, setProviderConfig] = useState({
    dodo: { enabled: false, mode: "missing" },
    razorpay: { enabled: false, mode: "unknown", disabledReason: "" },
    paypal: { enabled: false, mode: "unknown", clientId: "" },
  });
  const [providersSettled, setProvidersSettled] = useState(false);
  const [providerAvailabilityKnown, setProviderAvailabilityKnown] = useState(false);
  const quoteProvidersAppliedRef = useRef(false);
  const [showInternalPayments, setShowInternalPayments] = useState(false);
  const [paymentStatusBusy, setPaymentStatusBusy] = useState(false);
  const [cancellingPayment, setCancellingPayment] = useState(false);
  const sessionStartRef = useRef(null);
  const pendingStartsRef = useRef([]);
  const [pendingStartCount, setPendingStartCount] = useState(0);
  const setPendingStarts = (next) => {
    pendingStartsRef.current = next;
    setPendingStartCount(next.length);
  };
  const otherCheckoutStarting = (provider) =>
    pendingStartsRef.current.some((start) => start.provider !== provider);
  const lockedProvider = String(paymentSession?.provider || "").trim();
  const lockedProviderRef = useRef(lockedProvider); lockedProviderRef.current = lockedProvider;
  const [quoteProvState, setQuoteProvState] = useState({ scopeKey: "", provider: "" });
  const selectedQuoteProvider = quoteProvState.scopeKey === currentScopeKey ? quoteProvState.provider : (hydrated ? readScopedQuoteProvider(currentScopeKey) : "");
  const selectedQuoteProviderRef = useRef(selectedQuoteProvider); selectedQuoteProviderRef.current = selectedQuoteProvider;
  const selectQuoteProvider = (p, scopeKey = currentScopeKeyRef.current) => { const n = String(p || "").trim().toLowerCase(); writeScopedQuoteProvider(scopeKey, n); setQuoteProvState({ scopeKey, provider: n }); };
  const displayQuoteCurrency = normalizeCurrencyCode(paymentSession?.result?.quote?.currency || serverQuote?.currency || (lockedProvider && providerConfig?.[lockedProvider]?.currency) || (selectedQuoteProvider && providerConfig?.[selectedQuoteProvider]?.currency) || bookingData?.acceptedQuoteCurrency || "USD");
  const paymentBusy = paymentStatusBusy || cancellingPayment;
  const checkoutActionBusy = Boolean(
    creatingFree || payingDodo || payingRzp || pendingStartCount > 0 || lockedProvider || paymentBusy
  );
  manualCodeAllowedRef.current = canSubmitBooking && !checkoutActionBusy && !readStoredPaymentSession()?.provider;
  const dodoTaxExclusive = lockedProvider === "dodo"
    ? paymentSession?.providerPayload?.taxInclusive === false
    : !lockedProvider && providerConfig.dodo?.enabled;
  const providerIsAvailableForSession = (provider) =>
    !lockedProvider || lockedProvider === provider;
  const paypalClientIdFromEnv = cleanOutsideValue(process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID) ||
    cleanOutsideValue(process.env.REACT_APP_PAYPAL_CLIENT_ID);
  const paypalClientId = (
    providerConfig?.paypal?.clientId || paypalClientIdFromEnv
  ).trim();
  const hasPaypalClientId = !!paypalClientId;
  const canUseRazorpay = !!providerConfig?.razorpay?.enabled;
  const razorpayTemporarilyDisabled =
    providerConfig?.razorpay?.disabledReason === "merchant_profile_update";
  const razorpayAvailabilityKnown =
    razorpayTemporarilyDisabled ||
    String(providerConfig?.razorpay?.mode || "unknown") !== "unknown";
  const canUsePaypal = hasPaypalClientId && !!providerConfig?.paypal?.enabled;
  const onlinePaymentUnavailable = providerAvailabilityKnown && !providerConfig.dodo?.enabled && !canUseRazorpay && !providerConfig.paypal?.enabled;
  const shouldRenderPaypalBlock =
    !!providerConfig?.paypal?.enabled || showInternalPayments;
  const canDisplayPaypalMethod = shouldRenderPaypalBlock && canUsePaypal;

  const buildCheckoutPayload = (salesAttribution) => ({
    ...bookingData, salesAttribution, packageTitle, packagePrice, email: bookingData.email || "",
    localTimeZone: userTimeZone, displayDate: date, displayTime: time, referralCode: referral?.code || "", couponCode: coupon?.code || "",
    slotHoldId: checkoutRef.current?.slotHoldId || sessionHold?.slotHoldId || bookingData.slotHoldId || "",
    slotHoldToken: checkoutRef.current?.slotHoldToken || sessionHold?.slotHoldToken || bookingData.slotHoldToken || "",
    slotHoldExpiresAt: checkoutRef.current?.slotHoldExpiresAt || holdExpiresAt || "",
  });

  const checkoutFingerprint = useMemo(
    () =>
      JSON.stringify({
        packageTitle,
        originalOrderId: bookingData.originalOrderId || "",
        startTimeUTC: bookingData.startTimeUTC || "",
        email: bookingData.email || "",
        referralCode: referral?.code || "",
        couponCode: coupon?.code || "",
      }),
    [
      packageTitle,
      bookingData.originalOrderId,
      bookingData.startTimeUTC,
      bookingData.email,
      referral?.code,
      coupon?.code,
    ]
  );

  const isForeignFingerprint = Boolean(
    paymentSession?.paymentAccessToken &&
    !paymentSessionMatchesCheckout(paymentSession.fingerprint, checkoutFingerprint)
  );
  const dodoReopenBlocked =
    lockedProvider === "dodo" &&
    (paymentSession?.providerOrderReady === false ||
      paymentSession?.result?.providerOrderReady === false ||
      paymentSession?.result?.cleanupPending === true ||
      paymentSession?.result?.attemptStarted === true ||
      !String(paymentSession?.providerPayload?.checkoutUrl || "").trim());
  useBookingDialogPending(!hydrated || !providersSettled || (Boolean(packageTitle) && !isForeignFingerprint && !usingUnresolvedFallback && !quoteSettled));

  const paymentMountedRef = useRef(true);
  const paymentViewRef = useRef(null);
  if (paymentViewRef.current?.key !== location.key ||
      paymentViewRef.current?.fingerprint !== checkoutFingerprint ||
      !areSameLineageScopeKeys(paymentViewRef.current?.scopeKey, currentScopeKey)) {
    paymentViewRef.current = { key: location.key, fingerprint: checkoutFingerprint, scopeKey: currentScopeKey, session: paymentSession };
  } else if (paymentViewRef.current.scopeKey !== currentScopeKey) {
    paymentViewRef.current.scopeKey = currentScopeKey;
  }
  const paymentView = paymentViewRef.current;
  paymentView.session = paymentSession;
  useEffect(() => {
    paymentMountedRef.current = true;
    return () => { paymentMountedRef.current = false; };
  }, []);
  const resetKey = lockedProvider ? "" : checkoutFingerprint;
  const activeSessionToken = paymentSession?.paymentAccessToken || readStoredPaymentSession()?.paymentAccessToken || "";
  useEffect(() => {
    setPaymentStatusBusy(false);
    setCancellingPayment(false);
    setPayingDodo(false);
    setPayingRzp(false);
    setCreatingFree(false);
    if (sessionStartRef.current && !sessionStartRef.current.operation.current()) sessionStartRef.current = null;
  }, [location.key, activeSessionToken, resetKey]);

  const createPaymentOperation = (expectedToken) => {
    const activeSession = readStoredPaymentSession() || paymentView.session;
    const expectedFp = String(activeSession?.fingerprint || "").trim();
    const operation = {
      token: String(expectedToken ?? activeSession?.paymentAccessToken ?? "").trim(),
      current: () => {
        if (!paymentMountedRef.current) return false;
        const currentView = paymentViewRef.current;
        const session = readStoredPaymentSession() || currentView?.session;
        const currentToken = String(session?.paymentAccessToken || "").trim();
        if (operation.token) {
          return currentView?.key === paymentView.key && currentToken === operation.token &&
            (!expectedFp || String(session?.fingerprint || "").trim() === expectedFp);
        }
        return currentView === paymentView && currentToken === "";
      },
    };
    return operation;
  };

  useEffect(() => {
    if (lockedSessionQuote) {
      let active = true;
      lastQuoteKeyRef.current = "";
      const lockedFp = String(paymentSession?.result?.quoteFingerprint || "locked-session").trim();
      const lockedScope = currentScopeKey, lockedVer = quoteVersionRef.current;
      const reconcile = (m) => {
        if (!active) return;
        consentModRef.current = m;
        m.createPaymentConsentActions(consentCtxRef.current).applyAuthoritativeQuote({ quote: lockedSessionQuote, quoteVersion: lockedVer, quoteFingerprint: lockedFp, scopeKey: lockedScope });
        setServerQuote(lockedSessionQuote);
        setQuoteFingerprint(lockedFp);
        setQuoteLoading(false);
        setQuoteSettled(true);
      };
      if (consentModRef.current) reconcile(consentModRef.current);
      else {
        setServerQuote(null);
        setQuoteFingerprint("");
        setQuoteLoading(true);
        loadConsentPanel().then(reconcile, () => {
          if (!active) return;
          setQuoteLoading(false);
          setQuoteSettled(true);
          showBanner("error", "Unable to confirm checkout price.", { persistent: true, retryQuote: true });
        });
      }
      return () => { active = false; };
    }
    if (!packageTitle || preApplyingCodes || isForeignFingerprint || usingUnresolvedFallback) {
      setServerQuote(null);
      setQuoteFingerprint("");
      setQuoteLoading(false);
      return;
    }

    const requestScopeKey = currentScopeKey, requestProvider = lockedProvider || selectedQuoteProvider || "";
    const reqRefCode = String(referral?.code || "").trim().toLowerCase(), reqCpnCode = String(coupon?.code || "").trim().toLowerCase();
    const quoteInputKey = `${requestScopeKey}|${packageTitle}|${bookingData.originalOrderId || ""}|${bookingData.upgradeIntentToken || ""}|${referral?.code || ""}|${coupon?.code || ""}|${quoteRetryCount}`;
    const targetCurrency = normalizeCurrencyCode((requestProvider && providerConfig?.[requestProvider]?.currency) || serverQuoteRef.current?.currency || "USD");
    if (lastQuoteKeyRef.current === quoteInputKey && serverQuoteRef.current && quoteFingerprintRef.current && normalizeCurrencyCode(serverQuoteRef.current.currency) === targetCurrency) {
      return;
    }
    const requestQuoteVersion = ++quoteVersionRef.current;
    const sameInputs = lastQuoteKeyRef.current === quoteInputKey;
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), PAYMENT_FETCH_TIMEOUT_MS)
      : null;
    let active = true;
    if (!sameInputs) setServerQuote(null);
    setQuoteLoading(true);

    Promise.all([
      fetchCheckoutQuote(
        {
          ...(requestProvider ? { provider: requestProvider } : {}),
          packageTitle,
          originalOrderId: bookingData.originalOrderId || "",
          startTimeUTC: bookingData.startTimeUTC || "",
          email: bookingData.email || "",
          referralCode: referral?.code || "",
          couponCode: coupon?.code || "",
          upgradeIntentToken: bookingData.upgradeIntentToken || "",
        },
        { signal: controller?.signal }
      ),
      consentModRef.current ? Promise.resolve(consentModRef.current) : loadConsentPanel(),
    ])
      .then(([data, consentMod]) => {
        if (!active || quoteVersionRef.current !== requestQuoteVersion || currentScopeKeyRef.current !== requestScopeKey || (lockedProviderRef.current || selectedQuoteProviderRef.current || "") !== requestProvider || String(referralRef.current?.code || "").trim().toLowerCase() !== reqRefCode || String(couponRef.current?.code || "").trim().toLowerCase() !== reqCpnCode) return;
        consentModRef.current = consentMod;
        lastQuoteKeyRef.current = quoteInputKey;
        const qFp = String(data.quoteFingerprint || data.fingerprint || "").trim();
        if (data.quote) consentMod.createPaymentConsentActions(consentCtxRef.current).applyAuthoritativeQuote({ quote: data.quote, quoteVersion: requestQuoteVersion, quoteFingerprint: qFp, scopeKey: requestScopeKey });
        setServerQuote(data.quote || null);
        setQuoteFingerprint(qFp);
        if (data.providers) {
          quoteProvidersAppliedRef.current = true;
          setProviderAvailabilityKnown(["dodo", "razorpay", "paypal"].every(
            (provider) => typeof data.providers[provider]?.enabled === "boolean"
          ));
          setProviderConfig((current) => ({ ...current, ...data.providers }));
        }
      })
      .catch((error) => {
        if (!active || quoteVersionRef.current !== requestQuoteVersion || currentScopeKeyRef.current !== requestScopeKey || (lockedProviderRef.current || selectedQuoteProviderRef.current || "") !== requestProvider) return;
        setServerQuote(null);
        setQuoteFingerprint("");
        const quoteTimedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
        showBanner(
          "error",
          quoteTimedOut
            ? "Checkout price confirmation took too long. Please try again."
            : error?.message || "Unable to confirm checkout price.",
          { persistent: true, retryQuote: true }
        );
        if (!lockedProviderRef.current && selectedQuoteProviderRef.current) selectQuoteProvider("", requestScopeKey);
      })
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
        if (active) {
          setQuoteLoading(false);
          setQuoteSettled(true);
        }
      });

    return () => {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
      controller?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    packageTitle,
    currentScopeKey,
    lockedProvider,
    selectedQuoteProvider,
    bookingData.originalOrderId,
    bookingData.upgradeIntentToken,
    referral?.code,
    coupon?.code,
    preApplyingCodes,
    isForeignFingerprint,
    usingUnresolvedFallback,
    quoteRetryCount,
    lockedSessionQuote, paymentSession?.result?.quoteFingerprint,
  ]);

  const activeReservationKey = `${bookingData.originalOrderId || ""}|${bookingData.slotHoldId || ""}|${bookingData.startTimeUTC || ""}|${packageTitle}`;
  const codeScopeKey = `${activeReservationKey}|${bookingData.email || ""}`;
  const activeReservationKeyRef = useRef(activeReservationKey);
  const codeScopeKeyRef = useRef(codeScopeKey);
  const referralResKeyRef = useRef("");
  activeReservationKeyRef.current = activeReservationKey;
  codeScopeKeyRef.current = codeScopeKey;
  useEffect(() => {
    referralResKeyRef.current = referral ? activeReservationKeyRef.current : "";
  }, [referral]);

  useEffect(() => {
    if (!hydrated || !packageTitle || usingUnresolvedFallback) return;
    const preApplyPrefix = `${activeReservationKey}|${bookingData.referralCode || ""}|${bookingData.couponCode || ""}|`;
    const preApplyKey = `${preApplyPrefix}${location.search}`;
    if (skipPreApplyKeyRef.current && skipPreApplyKeyRef.current === preApplyKey) {
      skipPreApplyKeyRef.current = "";
      return;
    }
    const urlRef = normalizeLinkReferral(new URLSearchParams(location.search).get("ref") || "");
    const persistedRef = stripReservedCode(bookingData.referralCode);
    const sessionRef = readLinkReferralFromSession();
    const referralCode = persistedRef || sessionRef || urlRef || "";
    const refLower = referralCode.toLowerCase();
    const couponCode = stripReservedCode(bookingData.couponCode);
    const startedReservationKey = activeReservationKey;
    const startedCodeScopeKey = codeScopeKey;
    let active = true;
    setReferralError("");
    setCouponError("");
    if (!couponCode && !referralCode) {
      setReferral(null);
      setCoupon(null);
      setReferralInput("");
      setCouponInput("");
      Promise.resolve().then(() => {
        if (active && codeScopeKeyRef.current === startedCodeScopeKey) setPreApplyingCodes(false);
      });
      return () => { active = false; };
    }
    setPreApplyingCodes(true);
    setCoupon(null);

    loadCheckoutHold()
      .then((m) => {
        if (!active || codeScopeKeyRef.current !== startedCodeScopeKey || !codeApplicationAllowedRef.current) return;
        return m.runPreApplyCheckoutCodes({
          ...consentCtxRef.current, couponCode, referralCode, refLower, persistedRef,
          referralResKeyRef, startedReservationKey, preApplyPrefix, location, navState,
          isCurrent: () => active && codeScopeKeyRef.current === startedCodeScopeKey && codeApplicationAllowedRef.current,
          readLinkReferralFromSession, writeLinkReferralToSession, normalizeLinkReferral, stripRefFromSearch,
        });
      })
      .catch(() => {})
      .finally(() => {
        if (active && codeScopeKeyRef.current === startedCodeScopeKey) setPreApplyingCodes(false);
      });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeScopeKey, bookingData.couponCode, bookingData.referralCode, hydrated, location.search, packageTitle, usingUnresolvedFallback]);

  useEffect(() => {
    if (!canUseRazorpay) { setRzpReady(false); return undefined; }
    let active = true, cleanup = null;
    loadCheckoutHold().then((m) => m.loadTerminalOutcome()).then((o) => {
      if (active) cleanup = o.mountRazorpaySdk({ setRzpReady, showBanner });
    }).catch(() => {});
    return () => { active = false; cleanup?.(); };
  }, [canUseRazorpay]);

  useEffect(() => {
    let active = true;
    const req = fetch("/api/payment/providers", { signal: requestDeadline() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad_status"))))
      .then((data) => ({ ok: true, data }), () => ({ ok: false }));
    loadConsentPanel()
      .then((m) => {
        consentModRef.current = m;
        if (active) return m.fetchPaymentProviders({ req, hasPaypalClientId, paypalClientIdFromEnv, setProviderAvailabilityKnown, setProviderConfig, setProvidersSettled, isActive: () => active, isSuperseded: () => quoteProvidersAppliedRef.current });
      })
      .catch(() => { if (active) setProvidersSettled(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const internalToggle = new URLSearchParams(location.search).get("internalPayments");
    try {
      if (internalToggle === "1") sessionStorage.setItem(INTERNAL_PAYMENTS_KEY, "1");
      else if (internalToggle === "0") sessionStorage.removeItem(INTERNAL_PAYMENTS_KEY);
      const host = String(window.location.hostname || "").toLowerCase();
      setShowInternalPayments(host === "localhost" || host === "127.0.0.1" || sessionStorage.getItem(INTERNAL_PAYMENTS_KEY) === "1");
    } catch { setShowInternalPayments(false); }
  }, [location.search]);

  useEffect(() => {
    if (!hydrated) return;
    const stored = readStoredPaymentSession();
    if (stored?.paymentAccessToken && !isPaymentLockReleased(stored.paymentAccessToken)) {
      if (
        packageTitle &&
        paymentSessionMatchesCheckout(stored.fingerprint, checkoutFingerprint) &&
        paymentSessionMatchesBookingLineage(stored, bookingData) &&
        !referral && !coupon && !referralInput && !couponInput && !bookingData.referralCode && !bookingData.couponCode
      ) {
        const storedFingerprint = parseCheckoutFingerprint(stored.fingerprint);
        const storedReferralCode = stripReservedCode(storedFingerprint?.referralCode);
        const storedCouponCode = stripReservedCode(storedFingerprint?.couponCode);
        if (storedReferralCode) setReferralInput(storedReferralCode);
        if (storedCouponCode) setCouponInput(storedCouponCode);
      }
      setPaymentSession(stored);
      return;
    }

    if (stored) {
      clearStoredPaymentSession();
    }
    setPaymentSession(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScopeKey, hydrated, packageTitle]);

  const persistPaymentSession = (nextSession, skipWrite = false) => {
    if (!nextSession) return;
    manualCodeAllowedRef.current = false;
    paymentView.session = nextSession;
    setPaymentSession(nextSession);
    if (!skipWrite) writeStoredPaymentSession(nextSession);
  };
  const checkoutFlowCtxRef = useRef(null);
  checkoutFlowCtxRef.current = {
    bookingData, packageTitle, packagePrice, sessionHold, setSessionHold, checkoutRef, latestNavRef,
    navigate, dodoReturnHandled, readStoredCheckout, writeStoredCheckout, writeBrowserStorage,
    readStoredPaymentSession, paymentView, paymentSession, persistPaymentSession, paymentActionRef,
    paymentMountedRef, stripReservedCode, skipPreApplyKeyRef, activeReservationKeyRef,
  };

  const getActivePaymentSession = (provider) =>
    [readStoredPaymentSession(), paymentSession].find((s) => s?.provider === provider && s?.paymentAccessToken && !isPaymentLockReleased(s.paymentAccessToken) && paymentSessionMatchesCheckout(s.fingerprint, checkoutFingerprint) && paymentSessionMatchesBookingLineage(s, bookingData)) || null;

  const clearPaymentSession = (terminalStatus = "", expectedToken = "", { alreadyReleased = false, forceReleaseHold = false, reason = "", responseData = null } = {}) => {
    const activeSession = readStoredPaymentSession() || paymentSession;
    if (expectedToken && activeSession?.paymentAccessToken && extractPaymentLockId(activeSession.paymentAccessToken) !== extractPaymentLockId(expectedToken)) return true;
    const outcomeMod = cachedCheckoutHoldMod?.getCachedTerminalOutcome?.();
    const activeScope = activeSession?.scopeKey || (activeSession && outcomeMod?.sessionOwnsCheckoutBooking(activeSession, bookingData) ? currentScopeKeyRef.current : "");
    sessionStartRef.current = null;
    setPaymentSession(null);
    paymentView.session = null;
    if (!alreadyReleased) clearStoredPaymentSession();
    if (terminalStatus === "refunded" && activeScope) markReservationTerminal(activeScope, "refunded");
    if (!outcomeMod) return false;
    return outcomeMod.clearPaymentSessionOutcome({
      ...consentCtxRef.current, activeSession, terminalStatus, responseData, isUpgrade,
      isTerminal: ["failed", "abandoned", "refunded"].includes(terminalStatus),
      forceReleaseHold, reason, location, navState, backToBookingState, setQuoteRetryCount,
      flowCtx: checkoutFlowCtxRef.current,
    });
  };

  const handleChangePaymentMethod = (existingOp = null, opts) => runConsentAction("changePaymentMethod", existingOp, opts);
  const handleCheckPaymentStatus = () => runConsentAction("checkPaymentStatus");

  const showConfirmation = (kind, responseBody, operation, activeSessionOverride = null) =>
    runConsentAction("showConfirmationFlow", {
      kind, responseBody, operation, activeSessionOverride,
      preloadConfirmationPage, preloadWaitMs: CONFIRMATION_PRELOAD_WAIT_MS,
      getModalFlowState, holdExpiryHandledRef,
    }, { fallback: "" });

  const navigateToConfirmation = (kind, responseBody, operation, activeSessionOverride = null) => {
    trackConfirmedPurchase(responseBody.analyticsReceipt);
    return showConfirmation(kind, responseBody, operation, activeSessionOverride);
  };

  const startSessionCheckout = async (provider, operation = createPaymentOperation()) => {
    const cm = consentModRef.current || await loadConsentPanel();
    consentModRef.current = cm;
    cm.ensureConsentBaseline(consentCtxRef.current);
    const startSnap = cm.snapPaymentStart(), m = await loadCheckoutHold();
    return m.runStartSessionCheckout({
      ...consentCtxRef.current, provider, operation, startSnap, checkoutFingerprint, rawBookingData,
      parseCheckoutFingerprint, otherCheckoutStarting, sessionStartRef, quoteFingerprint,
      holdForGuard, buildCheckoutPayload, serverQuoteRef, quoteLoading, setAlreadyTargetInfo,
      setBlockingUpgradeSession, setServerQuote, setQuoteFingerprint, setProviderConfig,
      selectQuoteProvider, showConfirmation, paymentStartBody: cm.paymentStartBody,
      countCheckoutStartOnce: cm.countCheckoutStartOnce, eventMoment, trackCheckoutSessionStarted,
      trackConfirmedPurchase, onAuthoritativeQuote: applyAuthoritativeQuote,
      flow: m.createCheckoutFlow(checkoutFlowCtxRef.current),
    });
  };

  const finalizeSessionCheckout = async ({ paymentAccessToken, providerData, operation = createPaymentOperation(paymentAccessToken), captured = false, scopeKey = "", activeSession = null }) => {
    if (!captured && !operation.current()) return null;
    const m = await loadCheckoutHold();
    if (!captured && !operation.current()) return null;
    return m.runFinalizeSessionCheckout({
      ...consentCtxRef.current, paymentAccessToken, providerData, operation, captured, scopeKey,
      activeSession: activeSession || readStoredPaymentSession() || paymentSession,
      flow: m.createCheckoutFlow(checkoutFlowCtxRef.current),
    });
  };
  consentCtxRef.current = {
    ...checkoutFlowCtxRef.current, checkoutFlowCtxRef, consentCtxRef, loadCheckoutHold, currentScopeKeyRef, consentScopeRef, consentStateRef,
    referralRef, couponRef, quoteHoldRef, setQuoteHold, quoteVersionRef, quoteFingerprintRef, manualCodeAllowedRef, checkingCode,
    referral, coupon, validationGenRef, referralCheckGenRef, couponCheckGenRef, validating, validatingCoupon, setValidating,
    setValidatingCoupon, lastQuoteKeyRef, setReferral, setReferralInput, setReferralError, writeStoredReferral, setCoupon,
    setCouponInput, setCouponError, showBanner, paymentBusy, payingDodo, payingRzp, pendingStartCount, pendingStartsRef,
    setPendingStarts, createPaymentOperation, setCancellingPayment, navigateToConfirmation, clearPaymentSession, paymentStatusBusy,
    cancellingPayment, finalizeSessionCheckout, setPaymentStatusBusy, otherCheckoutStarting, ensureSlotBeforeAction,
    startSessionCheckout, writeStoredPaymentSession, usingUnresolvedFallback,
  };

  const runOutcomeAction = (fn, fallback) =>
    loadCheckoutHold().then((m) => m.loadTerminalOutcome().then(fn)).catch(() => showBanner("error", fallback, { persistent: true }));

  const handleDodoCheckout = () => runOutcomeAction(
    (o) => o.runDodoCheckoutFlow({ ...consentCtxRef.current, setPayingDodo, finalAmount, displayQuoteCurrency }),
    "Unable to open checkout. Please try again."
  );

  useEffect(() => {
    if (!hydrated || dodoReturnHandled.current) return;
    const query = new URLSearchParams(location.search);
    if (!query.has("dodo_return") && !query.has("dodo_cancel")) return;
    const session = readStoredPaymentSession();
    const { action } = validateDodoCallback({ query, session, visibleBooking: bookingData, visibleFingerprint: checkoutFingerprint });
    if (action === "ignore") { clearDodoNavQuery({ latestNavRef, navigate }); return; }
    if (action === "none") return;
    dodoReturnHandled.current = session.paymentAccessToken;
    const callbackScope = currentScopeKeyRef.current;
    const operation = createPaymentOperation(session.paymentAccessToken);
    if (!operation.current()) return;
    runConsentAction("runDodoCallback", { action, session, callbackScope, operation }, { fallback: "" });
  }, [hydrated, location.search, paymentSession, bookingData, checkoutFingerprint]);

  const validateReferral = (code) => runConsentAction("validateCode", { slot: "referral", code });
  const validateCoupon = (code) => runConsentAction("validateCode", { slot: "coupon", code });

  const handleFreeBooking = () => runOutcomeAction(
    (o) => o.runFreeBookingCheckout({ ...consentCtxRef.current, isFree, setCreatingFree, beginCheckoutConfirmation, holdForGuard, showConfirmation, holdExpiresAt, holdExpiryHandledRef }),
    "Something went wrong saving your free booking. Please try again."
  );
  const handleRazorpayPay = () => runOutcomeAction(
    (o) => o.runRazorpayCheckoutFlow({ ...consentCtxRef.current, canUseRazorpay, rzpReady, isFree, finalAmount, setPayingRzp, displayQuoteCurrency, packageTitle }),
    "Payment could not be processed. Please try again."
  );

  const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1, delayChildren: 0.1 } } };
  const itemVariants = { hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 260, damping: 30 } } };

  const BannerComponent = consentModRef.current?.PaymentBanner || PaymentBanner;
  return (
    <motion.section
      className="booking-payment relative z-10 py-4 px-6 max-w-3xl mx-auto text-ink"
      variants={containerVariants}
      initial={false}
      animate="visible"
    >
      <motion.div variants={itemVariants}>
        <h2 className="section-title text-center">
          {isUpgrade ? "Complete Upgrade Payment" : "Complete Payment"}
        </h2>
        <p className="section-lede text-center">
          {isUpgrade
            ? "Review your upgrade details and proceed to payment"
            : "Review your booking details and proceed to payment"}
        </p>
      </motion.div>

      <motion.div variants={itemVariants}>
        {banner?.text && (
          <Suspense fallback={null}>
            <BannerComponent
              banner={banner}
              bannerRef={bannerRef}
              onChooseNewTime={() => navigate("/booking", { state: backToBookingState, replace: true })}
              onRetryQuote={() => { setBanner(null); setQuoteRetryCount((count) => count + 1); }}
              onClose={() => setBanner(null)}
            />
          </Suspense>
        )}
      </motion.div>


      {quoteHold && (
        <Suspense fallback={null}>
          <PaymentConsentPanel quoteHold={quoteHold} quoteLoading={quoteLoading} onAcceptQuoteHold={handleAcceptQuoteHold} />
        </Suspense>
      )}

      {(alreadyTargetInfo || blockingUpgradeSession) && (
        <Suspense fallback={null}>
          <ActiveUpgradeBlocker
            alreadyTargetInfo={alreadyTargetInfo}
            blockingUpgradeSession={blockingUpgradeSession}
            currentScopeKey={currentScopeKey}
            currentScopeKeyRef={currentScopeKeyRef}
            packageTitle={packageTitle}
            showBanner={showBanner}
            onCleared={(msg) => {
              setBlockingUpgradeSession(null);
              showBanner("success", msg);
            }}
            onBooked={(info) => {
              setBlockingUpgradeSession(null);
              setAlreadyTargetInfo(info);
            }}
            onUpdated={(status) => {
              setBlockingUpgradeSession((prev) => (prev ? { ...prev, status } : null));
            }}
          />
        </Suspense>
      )}

      <motion.div
        variants={itemVariants}
        className="low-perf-surface glass-premium glass-card-surface glass-scroll-lite mt-8 rounded-2xl border border-line-input"
      >
        <div className="p-6 sm:p-7">
          <h3 className="text-[20px] font-bold text-ink">
            {isUpgrade ? "Upgrade Summary" : "Booking Summary"}
          </h3>
          <p className="text-ink-muted text-sm mt-1">
            Please review your {isUpgrade ? "upgrade" : "booking"} details
          </p>

          <div className="mt-2">
            <dl className="divide-y divide-line-input text-left text-sm">
              <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                <dt className="text-ink-muted">Package</dt>
                <dd className="break-words font-semibold text-ink sm:text-right">
                  {packageTitle}
                </dd>
              </div>
              <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                <dt className="text-ink-muted">Date & time</dt>
                <dd className="font-semibold text-ink sm:text-right">
                  {date} · {time}
                  {userTimeZone ? (
                    <span className="font-normal text-ink-muted">
                      {" "}
                      ({userTimeZone})
                    </span>
                  ) : null}
                </dd>
              </div>
              {referralDiscountAmount > 0 && referral && (
                <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                  <dt className="text-ink-muted">Referral</dt>
                  <dd className="font-semibold text-ink sm:text-right">
                    {referral?.code} · −{formatCheckoutAmount(referralDiscountAmount, displayQuoteCurrency, { includeCurrency: displayQuoteCurrency !== "USD" })}
                  </dd>
                </div>
              )}
              {couponDiscountAmount > 0 && coupon && (
                <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                  <dt className="text-ink-muted">Coupon</dt>
                  <dd className="font-semibold text-ink sm:text-right">
                    {coupon.code} · −{formatCheckoutAmount(couponDiscountAmount, displayQuoteCurrency, { includeCurrency: displayQuoteCurrency !== "USD" })}
                  </dd>
                </div>
              )}
              <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:items-baseline">
                <dt className="font-semibold text-ink">{dodoTaxExclusive ? "Subtotal" : "Total"}</dt>
                <dd className="sm:text-right">
                  {(referralDiscountAmount > 0 || couponDiscountAmount > 0) && (
                    <span className="mr-2 text-sm text-ink-secondary line-through">
                      {formatCheckoutAmount(displayBaseAmount, displayQuoteCurrency, { includeCurrency: displayQuoteCurrency !== "USD" })}
                    </span>
                  )}
                  <span className="text-2xl font-extrabold text-accent">
                    {formatCheckoutAmount(finalAmount, displayQuoteCurrency)}
                  </span>
                </dd>
              </div>
            </dl>
            <p className="mt-1 text-xs text-ink-muted sm:text-right">
              {quoteLoading
                ? "Confirming the current price..."
                : quoteFingerprint
                  ? "Price confirmed for this session."
                  : "Price confirmation is unavailable. Payment is disabled."}
            </p>
            <div className="space-y-1">
              {isFree && (
                <p className="text-xs text-success-text mt-2">
                  This booking has a 100% discount applied. No payment is required - just confirm your free booking below.
                </p>
              )}
              {!isFree && preventedFreeReduction && (
                <p className="text-xs text-warning-text mt-2">
                  A minimum charge applies unless you use an approved
                  free-booking code.
                </p>
              )}
              {isUpgrade && (
                <p className="text-xs text-ink-muted mt-2">
                  Upgrade price reflects the difference between the target package and your original payment.
                </p>
              )}
            </div>
          </div>

          <div className="mt-6 h-px w-full bg-line-soft" />


          <>

            <div className="mt-6">
              <label
                htmlFor="payment-referral-code"
                className="block text-sm font-semibold mb-1"
              >
                Referral Code (optional)
              </label>
              <form
                className="flex flex-wrap gap-2 items-center"
                onSubmit={(event) => {
                  event.preventDefault();
                  validateReferral(referralInput);
                }}
              >
                <input
                  id="payment-referral-code"
                  aria-label="Referral Code (optional)"
                  value={referralInput}
                  onChange={(e) => {
                    setReferralInput(e.target.value.trim());
                    if (referralError) setReferralError("");
                  }}
                  disabled={preApplyingCodes || checkingCode || checkoutActionBusy}
                  aria-invalid={referralError ? "true" : "false"}
                  aria-describedby={
                    referralError ? "payment-referral-code-error" : undefined
                  }
                  placeholder="e.g. vouch"
                  className="w-60 bg-surface-input border border-line-input rounded-md px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-border focus-visible:ring-offset-2 focus-visible:ring-offset-surface-card disabled:opacity-60"
                />

                <button
                  type="submit"
                  disabled={preApplyingCodes || checkingCode || checkoutActionBusy}
                  className="glow-button px-3 py-2 rounded-md font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60 text-sm"
                >
                  {validating ? "Checking..." : "Apply"}
                  <GlowLines />
                </button>
                {referral && (
                  <button
                    type="button"
                    onClick={() => handleRemoveDiscount("referral")}
                    disabled={checkingCode || checkoutActionBusy}
                    className="text-xs text-ink-secondary underline underline-offset-2"
                  >
                    Remove referral code
                  </button>
                )}
              </form>
              {referralError && !validating && (
                <p
                  id="payment-referral-code-error"
                  role="alert"
                  className="text-sm text-danger-text mt-2"
                >
                  {referralError}
                </p>
              )}
            </div>


            <div className="mt-5">
              <label
                htmlFor="payment-coupon-code"
                className="block text-sm font-semibold mb-1"
              >
                Coupon Code (optional)
              </label>
              <form
                className="flex flex-wrap gap-2 items-center"
                onSubmit={(event) => {
                  event.preventDefault();
                  validateCoupon(couponInput);
                }}
              >
                <input
                  id="payment-coupon-code"
                  value={couponInput}
                  onChange={(e) => {
                    setCouponInput(e.target.value.trim());
                    if (couponError) setCouponError("");
                  }}
                  disabled={preApplyingCodes || checkingCode || checkoutActionBusy}
                  aria-invalid={couponError ? "true" : "false"}
                  aria-describedby={
                    couponError ? "payment-coupon-code-error" : undefined
                  }
                  placeholder="e.g. BF10"
                  className="w-60 bg-surface-input border border-line-input rounded-md px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-border focus-visible:ring-offset-2 focus-visible:ring-offset-surface-card disabled:opacity-60"
                />

                <button
                  type="submit"
                  disabled={
                    preApplyingCodes || checkingCode || checkoutActionBusy
                  }
                  className="glow-button px-3 py-2 rounded-md font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60 text-sm"
                >
                  {validatingCoupon ? "Checking..." : "Apply"}
                  <GlowLines />
                </button>

                {coupon && (
                  <button
                    type="button"
                    onClick={() => handleRemoveDiscount("coupon")}
                    disabled={checkingCode || checkoutActionBusy}
                    className="text-xs text-ink-secondary underline underline-offset-2"
                  >
                    Remove coupon
                  </button>
                )}
              </form>
              {couponError && !validatingCoupon && (
                <p
                  id="payment-coupon-code-error"
                  role="alert"
                  className="text-sm text-danger-text mt-2"
                >
                  {couponError}
                </p>
              )}
              {coupon &&
                coupon.canCombineWithReferral === false &&
                referral && (
                  <p className="text-xs text-warning-text mt-1">
                    This coupon cannot be clubbed with a referral discount.
                  </p>
                )}
            </div>
            {!!lockedProvider && (
              <div className="mt-4 flex flex-col items-start justify-between gap-3 rounded-lg border border-info-border bg-info-soft px-4 py-3 sm:flex-row sm:items-center">
                <p className="text-xs text-info-text">
                  This checkout is reserved with {lockedProvider === "dodo" ? "your selected payment option" : lockedProvider === "paypal" ? "PayPal" : "Razorpay"}. Pricing and provider selection are locked for this session. Finish it or safely release this payment method before choosing another.
                </p>
                <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                  {lockedProvider !== "dodo" && (
                    <button
                      type="button"
                      onClick={handleCheckPaymentStatus}
                      disabled={paymentStatusBusy || cancellingPayment || pendingStartCount > 0}
                      className="shrink-0 rounded-md border border-info-border bg-surface-input px-3 py-2 text-xs font-semibold text-ink hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-border disabled:cursor-wait disabled:opacity-60"
                    >
                      {paymentStatusBusy ? "Checking payment..." : "Check payment status"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleChangePaymentMethod()}
                    disabled={cancellingPayment || paymentStatusBusy || payingDodo || payingRzp || pendingStartCount > 0}
                    className="shrink-0 rounded-md border border-line-input bg-surface-input px-3 py-2 text-xs font-semibold text-ink hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-border disabled:cursor-wait disabled:opacity-60"
                  >
                    {cancellingPayment ? "Checking payment..." : "Change payment method"}
                  </button>
                </div>
              </div>
            )}
          </>
        </div>
      </motion.div>


      <motion.div
        variants={itemVariants}
        className="low-perf-surface glass-premium glass-card-surface glass-scroll-lite mt-8 rounded-2xl border border-line-input"
      >
        <div className="p-6 sm:p-7">
          <h3 className="text-[20px] font-bold text-ink">
            {isFree ? "Confirm Free Booking" : "Payment Method"}
          </h3>
          <p className="text-ink-muted text-sm mt-1">
            {isFree
              ? "This booking is fully discounted. Confirm below to finalize it."
              : "Available payment options depend on your country and order total."}
          </p>


          {isFree ? (
            <div className="mt-6 flex flex-col gap-4 border border-success-border bg-success-soft rounded-xl px-5 py-4 shadow-[0_0_25px_rgba(16,185,129,0.35)]">
              <p className="text-sm text-success-text">
                No payment is required. Click the button below to confirm your
                free booking.
              </p>
              <button
                onClick={handleFreeBooking}
                disabled={
                  creatingFree || paymentBusy || checkingCode || quoteLoading ||
                  !quoteFingerprint || hasConsentHold || otherCheckoutStarting("free")
                }
                className="glow-button px-4 py-3 rounded-lg text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {creatingFree ? "Confirming..." : "Confirm Free Booking"}
                <GlowLines />
              </button>
            </div>
          ) : (
            <>
              {(providerConfig.dodo?.enabled || lockedProvider === "dodo") && (
                <div>
                <div className="low-perf-surface glass-premium glass-card-surface mt-6 flex flex-col items-center justify-between gap-4 rounded-xl border border-line-input px-4 py-4 md:flex-row">
                  <div className="grid w-full min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-center gap-3">
                    <div className="flex h-8 w-20 items-center justify-center text-ink" aria-hidden="true">
                      <WalletCards size={36} strokeWidth={1.5} />
                    </div>
                    <p className="text-xs font-medium text-ink-secondary sm:text-sm">
                      Payment options shown at checkout.
                    </p>
                  </div>
                  <div className="flex w-full shrink-0 flex-col gap-2 md:w-52">
                    <button type="button" onClick={handleDodoCheckout}
                      disabled={!canSubmitBooking || !providerConfig.dodo?.enabled || payingDodo || paymentStatusBusy || cancellingPayment || quoteLoading || !quoteFingerprint || hasConsentHold || isForeignFingerprint || usingUnresolvedFallback || dodoReopenBlocked || !providerIsAvailableForSession("dodo") || otherCheckoutStarting("dodo")}
                      className="glow-button inline-flex h-11 w-full items-center justify-center whitespace-nowrap rounded-lg px-4 text-sm font-semibold disabled:opacity-60">
                      {payingDodo ? "Opening checkout..." : lockedProvider === "dodo" ? "Resume checkout" : "Pay your way"}
                    </button>
                    {lockedProvider === "dodo" && (
                      <button type="button" disabled={payingDodo || paymentBusy || pendingStartCount > 0}
                        className="rounded-md border border-line-input bg-surface-input px-3 py-2 text-xs font-semibold text-ink hover:bg-surface-hover disabled:opacity-60"
                        onClick={handleCheckPaymentStatus}>
                        {paymentStatusBusy ? "Checking payment..." : "Check payment status"}
                      </button>
                    )}
                  </div>
                </div>
                {dodoTaxExclusive && <p className="mt-2 text-xs text-ink-muted">Applicable tax is added at checkout.</p>}
                </div>
              )}

              <div
                className={`low-perf-surface glass-premium glass-card-surface mt-4 flex flex-col items-center justify-between gap-4 rounded-xl border px-4 py-4 md:flex-row ${
                  razorpayTemporarilyDisabled
                    ? "border-warning-border bg-warning-soft"
                    : "border-line-input"
                }`}
              >
                <div className="grid w-full min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-center gap-3">
                  <img
                    src="https://razorpay.com/assets/razorpay-logo.svg"
                    alt="Razorpay payment logo"
                    width={120}
                    height={24}
                    decoding="async"
                    className="h-8 w-20 object-contain"
                  />
                  <div>
                    <p className="text-xs font-medium text-ink-secondary sm:text-sm">
                      {razorpayTemporarilyDisabled
                        ? "Temporarily unavailable"
                        : "Razorpay"}
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleRazorpayPay}
                  disabled={
                    !rzpReady ||
                    payingRzp ||
                    paymentStatusBusy || cancellingPayment ||
                    quoteLoading ||
                    !quoteFingerprint ||
                    hasConsentHold ||
                    !canUseRazorpay ||
                    !providerIsAvailableForSession("razorpay") ||
                    otherCheckoutStarting("razorpay")
                  }
                  className="glow-button h-11 w-full shrink-0 whitespace-nowrap rounded-lg px-4 text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60 md:w-52"
                >
                  {payingRzp || paymentStatusBusy
                    ? "Processing..."
                    : razorpayTemporarilyDisabled
                      ? "Temporarily unavailable"
                      : !razorpayAvailabilityKnown
                        ? "Checking availability..."
                        : "Pay with Razorpay"}
                  <GlowLines />
                </button>
              </div>
              {onlinePaymentUnavailable ? (
                <p role="status" className="mt-2 rounded-lg border border-warning-border bg-warning-soft px-4 py-3 text-sm font-medium text-warning-text">
                  Online payment is unavailable right now.{" "}
                  <Link to="/contact" className="inline-flex min-h-11 items-center underline underline-offset-4">Contact us</Link>{" "}
                  to finish your booking.
                </p>
              ) : razorpayTemporarilyDisabled ? (
                <p
                  role="status"
                  className="mt-2 rounded-lg border border-warning-border bg-warning-soft px-4 py-3 text-sm font-medium text-warning-text"
                >
                  Razorpay is temporarily unavailable while we update the merchant
                  display name.{(providerConfig.dodo?.enabled || canUsePaypal) && " Please use another payment option."}
                </p>
              ) : (
                razorpayAvailabilityKnown &&
                !canUseRazorpay && (
                  <p className="mt-2 text-xs text-warning-text">
                    Razorpay secure checkout is currently unavailable.
                  </p>
                )
              )}


              {shouldRenderPaypalBlock && (
                <div className="low-perf-surface glass-premium glass-card-surface mt-4 flex flex-col md:flex-row items-center justify-between gap-4 rounded-xl border border-line-input px-4 py-4">
                  <div className="grid w-full min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-center gap-3">
                    <img
                      src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-100px.png"
                      alt="PayPal payment logo"
                      width={100}
                      height={26}
                      decoding="async"
                      className="h-8 w-20 object-contain"
                    />
                    <p className="text-xs font-medium text-ink-secondary sm:text-sm">
                      Secure global payments
                    </p>
                  </div>

                  {/* Clip the SDK’s 40px button at its 4px radius to hide the iframe’s light corners. Use outline-0: Tailwind v3’s outline-none leaves a transparent outline that forced-colors modes can repaint. */}
                  <div className="w-full shrink-0 md:w-52">
                    {canDisplayPaypalMethod ? (
                      <PayPalMethodPanel
                        paypalClientId={paypalClientId}
                        currency={normalizeCurrencyCode(
                          (lockedProvider === "paypal" && (paymentSession?.providerPayload?.currency || serverQuote?.currency)) ||
                            providerConfig?.paypal?.currency || displayQuoteCurrency
                        )}
                      >
                        {(PayPalButtons) => (
                          <PayPalButtons
                          fundingSource="paypal"
                          disabled={
                            paymentBusy ||
                            quoteLoading ||
                            !quoteFingerprint ||
                            hasConsentHold ||
                            !providerIsAvailableForSession("paypal") ||
                            otherCheckoutStarting("paypal")
                          }
                          style={{
                            layout: "horizontal",
                            color: "blue",
                            shape: "rect",
                            label: "pay",
                            height: 44,
                            tagline: false,
                          }}
                          onClick={(data, actions) => {
                            const blocked = !createPaymentOperation().current() ||
                              paymentActionRef.current.cancelling || paymentBusy ||
                              Boolean(quoteHoldRef.current) ||
                              pendingStartsRef.current.length > 0 || !ensureSlotBeforeAction();
                            if (blocked) return actions?.reject ? actions.reject() : false;
                            return actions?.resolve ? actions.resolve() : true;
                          }}
                          createOrder={async () => (await loadCheckoutHold()).runPayPalCreateOrder({
                            paymentActionRef, startSessionCheckout, finalAmount, displayQuoteCurrency, writeStoredPaymentSession, showBanner,
                          })}
                          onApprove={async (data, actions) => (consentModRef.current || await loadConsentPanel()).runPayPalApprove(data, actions, {
                            getActivePaymentSession, currentScopeKeyRef, createPaymentOperation, ensureSlotBeforeAction,
                            paymentActionRef, setPaymentStatusBusy, finalizeSessionCheckout, showBanner,
                          })}
                          onError={() => {
                            if (!createPaymentOperation().current() || paymentActionRef.current.cancelling) return;
                            console.error("PayPal checkout failed");
                            showBanner(
                              "error",
                              "This payment method could not process your payment. Please try again."
                            );
                          }}
                          onCancel={() => {
                            if (!createPaymentOperation().current() || paymentActionRef.current.cancelling) return;
                            showBanner(
                              "info",
                              "Checkout closed. Your payment session is still reserved for PayPal."
                            );
                          }}
                          />
                        )}
                      </PayPalMethodPanel>
                    ) : (
                      <p className="text-xs text-warning-text text-center">
                        This payment method is currently unavailable.
                      </p>
                    )}
                  </div>
                </div>
              )}
              {paymentStatusBusy && (
                <p className="mt-3 text-xs text-info-text">
                  Finalizing your payment and booking. Please keep this window open.
                </p>
              )}
            </>
          )}
        </div>
      </motion.div>


      {(isModalMode || !hideFooter) && (
        <motion.div
          variants={itemVariants}
          className="mt-10 flex justify-center"
        >
          <Link
            to="/booking"
            state={backToBookingState}
            className="glow-button inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold text-white hover:text-white transition-all duration-300"
          >
            <span aria-hidden="true" className="text-lg leading-none">
              ←
            </span>
            <span>Back to Booking</span>
            <GlowLines />
          </Link>
        </motion.div>
      )}
    </motion.section>
  );
}
