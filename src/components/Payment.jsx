import { clearBookingConfirmation, createBookingConfirmation } from "../lib/confirmationReceipt";
import { writeBrowserStorage, removeBrowserStorage } from "../lib/browserStorage";
import React, { useState, useMemo, useEffect, useRef } from "react";
import { useLocation, Link, useNavigate } from "react-router-dom";
import { PayPalScriptProvider, PayPalButtons, usePayPalScriptReducer } from "@paypal/react-paypal-js";
import { motion } from "framer-motion";
import { WalletCards } from "lucide-react";
import packagePricing from "../lib/packagePricing";
import { captureSalesAttribution, sanitizeSalesAttribution } from "../lib/salesAttribution";
import { trackConfirmedPurchase } from "../lib/analytics";
import { preloadConfirmationPage, preloadConfirmationPages } from "../lib/confirmationPages";
import { useBookingDialogPending } from "../lib/bookingDialogHold";
import { beginCheckoutConfirmation } from "../lib/checkoutConfirmation";
import {
  clearReferralDismissal,
  clearStoredReferral,
  dismissReferralCode,
  getReferralCaptureFailure,
  isReferralDismissed,
  recordAutomaticReferral,
  referralScope,
  selectStoredReferral,
  subscribeReferralRestore,
  REFERRAL_STORAGE_ERROR,
} from "../lib/checkoutStorage";
import {
  calculateCheckoutDiscounts,
  formatCouponValue,
  resolveCheckoutCode,
  sanitizeCouponForCheckout,
  sanitizeReferralForCheckout,
  toMoney,
} from "../lib/checkoutCodes";

const { applyPackagePricing } = packagePricing;
const PAYMENT_FETCH_TIMEOUT_MS = 15_000;
const PAYMENT_STATUS_POLL_TIMEOUT_MS = 90_000;
const PAYMENT_STATUS_POLL_INTERVAL_MS = 2_500;
const CONFIRMATION_PRELOAD_WAIT_MS = 2500;

const formatLocalDate = (utcDate, timeZone) => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...(timeZone ? { timeZone } : {}),
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(utcDate);
  } catch {
    return "-";
  }
};

const formatLocalTime = (utcDate, timeZone) => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...(timeZone ? { timeZone } : {}),
      hour: "numeric",
      minute: "2-digit",
    }).format(utcDate);
  } catch {
    return "-";
  }
};

const parseCheckoutFingerprint = (value) => {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
};

const paymentSessionMatchesCheckout = (storedFingerprint, currentFingerprint) => {
  if (storedFingerprint === currentFingerprint) return true;
  const stored = parseCheckoutFingerprint(storedFingerprint);
  const current = parseCheckoutFingerprint(currentFingerprint);
  if (!stored || !current) return false;
  return ["packageTitle", "originalOrderId", "startTimeUTC", "email"].every(
    (key) => String(stored[key] || "") === String(current[key] || "")
  );
};

function PayPalCheckout({ children }) {
  const [{ isResolved, isRejected, options }, dispatch] = usePayPalScriptReducer();

  if (isRejected) {
    return (
      <div className="space-y-2 text-center">
        <p role="alert" className="text-xs text-warning-text">
          PayPal couldn’t load. Please try again.
        </p>
        <button
          type="button"
          className="glow-button h-11 w-full rounded-lg px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-border"
          onClick={() => dispatch({ type: "resetOptions", value: options })}
        >
          Retry PayPal
        </button>
      </div>
    );
  }

  if (!isResolved) {
    return (
      <p role="status" className="flex h-11 items-center justify-center text-xs text-ink-secondary">
        Loading PayPal…
      </p>
    );
  }

  return (
    <div className="paypal-checkout-shell relative z-0 h-11 w-full overflow-hidden rounded-lg bg-transparent [&_iframe]:!rounded-[4px] [&_iframe]:!border-0 [&_iframe]:!bg-transparent [&_iframe]:!outline-0 [&_iframe]:!shadow-none">
      {children}
    </div>
  );
}

export default function Payment({ hideFooter = false }) {
  useEffect(() => { clearBookingConfirmation(); }, []);
  useEffect(() => {
    preloadConfirmationPages().catch(() => {});
  }, []);
  const location = useLocation();
  const navigate = useNavigate();
  const [hydrated, setHydrated] = useState(false);
  const [browserTimeZone, setBrowserTimeZone] = useState("UTC");

  useEffect(() => {
    setHydrated(true);
    try {
      setBrowserTimeZone(
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      );
    } catch {
      setBrowserTimeZone("UTC");
    }
  }, []);

  const FLOW_BACKGROUND_KEY = "flow_background_location";
  const PAYMENT_SESSION_STORAGE_KEY = "payment_session_state";
  const CHECKOUT_BOOKING_STORAGE_KEY = "checkout_booking_state";
  const INTERNAL_PAYMENTS_KEY = "roo_internal_payments";

  const readStoredBackground = () => {
    try {
      const raw = sessionStorage.getItem(FLOW_BACKGROUND_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.pathname) {
        return parsed;
      }
    } catch {}
    return null;
  };

  const writeStoredBackground = (loc) => {
    try {
      if (!loc || !loc.pathname) return;
      sessionStorage.setItem(
        FLOW_BACKGROUND_KEY,
        JSON.stringify({
          pathname: loc.pathname,
          search: loc.search || "",
          hash: loc.hash || "",
        })
      );
    } catch {}
  };

  const readStoredPaymentSession = () => {
    try {
      const raw = sessionStorage.getItem(PAYMENT_SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (
        parsed?.paymentAccessToken &&
        parsed?.provider &&
        parsed?.fingerprint &&
        parsed?.providerPayload
      ) {
        return parsed;
      }
    } catch {}
    return null;
  };

  const writeStoredPaymentSession = (session) => {
    if (!session?.paymentAccessToken || !session?.provider || !session?.fingerprint || !session?.providerPayload) return false;
    return writeBrowserStorage("sessionStorage", PAYMENT_SESSION_STORAGE_KEY, JSON.stringify(session));
  };

  const clearStoredPaymentSession = () => {
    try {
      sessionStorage.removeItem(PAYMENT_SESSION_STORAGE_KEY);
    } catch {}
  };

  const readStoredCheckout = () => {
    try {
      const raw = sessionStorage.getItem(CHECKOUT_BOOKING_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  const writeStoredCheckout = (value) => {
    try {
      if (!value || typeof value !== "object") {
        sessionStorage.removeItem(CHECKOUT_BOOKING_STORAGE_KEY);
        return;
      }
      sessionStorage.setItem(CHECKOUT_BOOKING_STORAGE_KEY, JSON.stringify(value));
    } catch {}
  };

  const buildConfirmationNavigationState = (responseBody = {}) => {
    trackConfirmedPurchase(responseBody.analyticsReceipt);
    const baseState = getModalFlowState();
    const bookingId = String(responseBody?.bookingId || "").trim();

    writeStoredCheckout(null);
    try {
      removeBrowserStorage("sessionStorage", "my_slot_hold");
      window.dispatchEvent(new CustomEvent("hold-state", { detail: null }));
    } catch {}

    if (!bookingId) {
      clearBookingConfirmation();
      return baseState;
    }

    const bookingConfirmation = createBookingConfirmation(responseBody);

    return {
      ...(baseState || {}),
      bookingConfirmation,
    };
  };

  const historyUsrState =
    hydrated && typeof window !== "undefined"
      ? window.history?.state?.usr
      : null;
  const navState = useMemo(
    () => location.state || historyUsrState || {},
    [historyUsrState, location.state]
  );

  const bookingData = useMemo(() => {
    try {
      const parsed =
        navState.bookingData ||
        (hydrated ? readStoredCheckout() : null) ||
        {};
      const pricedPackage = applyPackagePricing({
        title: parsed.packageTitle,
        price: parsed.packagePrice,
      });
      return {
        ...parsed,
        packageTitle: pricedPackage?.title || parsed.packageTitle,
        packagePrice: pricedPackage?.price || parsed.packagePrice,
      };
    } catch {
      return {};
    }
    // sessionStorage is intentionally a reload fallback, not a reactive source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, location.search, navState.bookingData]);
  useEffect(() => {
    if (navState.bookingData) {
      writeStoredCheckout(navState.bookingData);
    }

    const params = new URLSearchParams(location.search);
    const sensitiveKeys = ["data", "paymentAccessToken", "payment", "paymentFlow"];
    const shouldScrub = sensitiveKeys.some((key) => params.has(key));
    if (!shouldScrub) return;

    sensitiveKeys.forEach((key) => params.delete(key));
    navigate(
      {
        pathname: location.pathname,
        search: params.toString() ? `?${params.toString()}` : "",
        hash: location.hash,
      },
      { replace: true, state: navState }
    );
  }, [location.hash, location.pathname, location.search, navState, navigate]);

  const isUpgrade = !!bookingData.originalOrderId;
  const [sessionHold, setSessionHold] = useState(null);
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

  const getModalFlowState = () => {
    if (!isModalMode) return undefined;
    return {
      backgroundLocation:
        modalBackground || { pathname: "/", search: "", hash: "" },
      modal: true,
    };
  };

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
  const dodoRedirect = new URLSearchParams(location.search);
  const dodoReturnHandled = useRef("");
  const storedDodoReturn = dodoRedirect.has("dodo_return") || dodoRedirect.has("dodo_cancel")
    ? readStoredPaymentSession() : null;
  const processingDodoReturn = (dodoRedirect.has("dodo_return") || dodoRedirect.has("dodo_cancel")) &&
    ((storedDodoReturn?.provider === "dodo" && !!storedDodoReturn.paymentAccessToken) || !!dodoReturnHandled.current);
  const hasSlotHold =
    !!(sessionHold?.slotHoldId || bookingData?.slotHoldId) &&
    !!(sessionHold?.slotHoldToken || bookingData?.slotHoldToken) &&
    !holdExpired;
  const canSubmitBooking = isUpgrade ? hasTimeslot : hasTimeslot && hasSlotHold;
  const holdExpiryHandledRef = useRef(false);
  const codeApplicationAllowedRef = useRef(canSubmitBooking);
  codeApplicationAllowedRef.current = canSubmitBooking;

  const ensureSlotBeforeAction = () => {
    if (canSubmitBooking) return true;
    if (isUpgrade) {
      showBanner(
        "error",
        "Missing time details for this upgrade. Please contact support."
      );
      return false;
    }
    showBanner(
      "error",
      holdExpired
        ? "Your reserved slot expired. Please select a new time before completing your booking."
        : "Please select a time slot before completing your booking."
    );
    navigate("/booking", {
      state: backToBookingState,
      replace: true,
    });
    return false;
  };

  const packageTitle = bookingData.packageTitle || "";
  const scope = referralScope(packageTitle, bookingData.originalOrderId);
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
  const manualValidationAttemptRef = useRef(0);
  const [referralError, setReferralError] = useState("");

  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState(null);
  const [validatingCoupon, setValidatingCoupon] = useState(false);
  const checkingCode = validating || validatingCoupon;
  const [couponError, setCouponError] = useState("");
  const [preApplyingCodes, setPreApplyingCodes] = useState(true);
  const [referralRestoreCount, setReferralRestoreCount] = useState(0);

  const [banner, setBanner] = useState(null);
  const bannerRef = useRef(null);
  const [creatingFree, setCreatingFree] = useState(false);
  const [serverQuote, setServerQuote] = useState(null);
  const [quoteFingerprint, setQuoteFingerprint] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteSettled, setQuoteSettled] = useState(false);
  const [quoteRetryCount, setQuoteRetryCount] = useState(0);

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
    if (!holdExpiresAt || processingDodoReturn || creatingFree) return;
    const expiresAtMs = new Date(holdExpiresAt).getTime();
    if (!Number.isFinite(expiresAtMs)) return;

    const triggerExpiry = () => {
      if (holdExpiryHandledRef.current) return;
      holdExpiryHandledRef.current = true;
      codeApplicationAllowedRef.current = false;
      showBanner(
        "error",
        "Your reserved slot expired. Please select a new time before completing your booking."
      );
      const background = navState.backgroundLocation || readStoredBackground();
      navigate("/booking", {
        state: {
          ...(background ? { backgroundLocation: background } : {}),
          modal: true,
          ...navState,
        },
        replace: true,
      });
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
  }, [holdExpiresAt, processingDodoReturn, creatingFree, navigate, navState, location]);

  const {
    referralPercent,
    couponDiscountAmount,
    canStackCouponWithReferral,
    referralDiscountAmount,
    isFree,
    preventedFreeReduction,
    finalAmount,
    effectiveDiscountAmount,
    discountPercentCombined,
  } = calculateCheckoutDiscounts({
    baseAmount,
    referral,
    coupon,
    serverQuote,
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
  useBookingDialogPending(!hydrated || !providersSettled || (Boolean(packageTitle) && !quoteSettled));
  const [showInternalPayments, setShowInternalPayments] = useState(false);
  const [paymentSession, setPaymentSession] = useState(null);
  const [paymentStatusBusy, setPaymentStatusBusy] = useState(false);
  const [cancellingPayment, setCancellingPayment] = useState(false);
  const sessionStartRef = useRef(null);
  const pendingStartsRef = useRef([]);
  const [, setPendingStartCount] = useState(0);
  const setPendingStarts = (next) => {
    pendingStartsRef.current = next;
    setPendingStartCount(next.length);
  };
  const otherCheckoutStarting = (provider) =>
    pendingStartsRef.current.some((start) => start.provider !== provider);
  const lockedProvider = String(paymentSession?.provider || "").trim();
  const dodoTaxExclusive = lockedProvider === "dodo"
    ? paymentSession?.providerPayload?.taxInclusive === false
    : !lockedProvider && providerConfig.dodo?.enabled;
  const providerIsAvailableForSession = (provider) =>
    !lockedProvider || lockedProvider === provider;
  const paypalClientIdFromEnv = (
    process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ||
    process.env.REACT_APP_PAYPAL_CLIENT_ID ||
    ""
  ).trim();
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

  const buildCheckoutPayload = () => ({
    ...bookingData,
    salesAttribution: sanitizeSalesAttribution(bookingData.salesAttribution) || captureSalesAttribution(),
    packageTitle,
    packagePrice,
    email: bookingData.email || "",
    localTimeZone: userTimeZone,
    displayDate: date,
    displayTime: time,
    referralCode: referral?.code || "",
    couponCode: coupon?.code || "",
    slotHoldId: sessionHold?.slotHoldId || bookingData.slotHoldId || "",
    slotHoldToken: sessionHold?.slotHoldToken || bookingData.slotHoldToken || "",
    slotHoldExpiresAt:
      sessionHold?.slotHoldExpiresAt ||
      sessionHold?.expiresAt ||
      bookingData.slotHoldExpiresAt ||
      "",
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

  const paymentMountedRef = useRef(true);
  const paymentViewRef = useRef(null);
  if (paymentViewRef.current?.key !== location.key ||
      paymentViewRef.current?.fingerprint !== checkoutFingerprint) {
    paymentViewRef.current = { key: location.key, fingerprint: checkoutFingerprint, session: paymentSession };
  }
  const paymentView = paymentViewRef.current;
  paymentView.session = paymentSession;
  useEffect(() => {
    paymentMountedRef.current = true;
    return () => { paymentMountedRef.current = false; };
  }, []);
  useEffect(() => {
    manualValidationAttemptRef.current += 1;
    setValidating(false);
    setValidatingCoupon(false);
    setPaymentStatusBusy(false);
    setCancellingPayment(false);
    setPayingDodo(false);
    setPayingRzp(false);
    setCreatingFree(false);
    if (sessionStartRef.current && !sessionStartRef.current.operation.current()) sessionStartRef.current = null;
  }, [paymentView, paymentSession?.paymentAccessToken]);

  const createPaymentOperation = (expectedToken) => {
    const activeSession = readStoredPaymentSession() || paymentView.session;
    const operation = {
      token: String(expectedToken ?? activeSession?.paymentAccessToken ?? "").trim(),
      current: () => {
        const view = paymentViewRef.current;
        if (!paymentMountedRef.current || !view) return false;
        if (view !== paymentView && !(operation.token && view.key === paymentView.key)) return false;
        const session = readStoredPaymentSession() || view.session;
        return String(session?.paymentAccessToken || "").trim() === operation.token &&
          (!operation.token || paymentSessionMatchesCheckout(session?.fingerprint, view.fingerprint));
      },
    };
    return operation;
  };

  useEffect(() => subscribeReferralRestore(() => {
    if (!codeApplicationAllowedRef.current) return;
    manualValidationAttemptRef.current += 1;
    setValidating(false);
    setValidatingCoupon(false);
    setPreApplyingCodes(true);
    setReferral(null);
    setServerQuote(null);
    setQuoteFingerprint("");
    setReferralRestoreCount(current => current + 1);
  }), []);

  useEffect(() => {
    if (!packageTitle || preApplyingCodes) {
      setServerQuote(null);
      setQuoteFingerprint("");
      setQuoteLoading(false);
      return;
    }

    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), PAYMENT_FETCH_TIMEOUT_MS)
      : null;
    let active = true;
    setQuoteLoading(true);

    fetch("/api/payment/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packageTitle,
        originalOrderId: bookingData.originalOrderId || "",
        startTimeUTC: bookingData.startTimeUTC || "",
        email: bookingData.email || "",
        referralCode: referral?.code || "",
        couponCode: coupon?.code || "",
        upgradeIntentToken: bookingData.upgradeIntentToken || "",
      }),
      signal: controller?.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.ok) {
          throw new Error(data?.error || "Unable to confirm checkout price.");
        }
        if (!active) return;
        setServerQuote(data.quote || null);
        setQuoteFingerprint(
          String(data.quoteFingerprint || data.fingerprint || "").trim()
        );
        if (data.providers) {
          setProviderAvailabilityKnown(["dodo", "razorpay", "paypal"].every(
            (provider) => typeof data.providers[provider]?.enabled === "boolean"
          ));
          setProviderConfig((current) => ({ ...current, ...data.providers }));
        }
      })
      .catch((error) => {
        if (!active) return;
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
    bookingData.originalOrderId,
    bookingData.upgradeIntentToken,
    referral?.code,
    coupon?.code,
    preApplyingCodes,
    quoteRetryCount,
  ]);

  useEffect(() => {
    if (!hydrated || !packageTitle) return;

    const params = new URLSearchParams(location.search);
    const candidates = [params.get("ref"), bookingData.referralCode];
    const referralCode = selectStoredReferral(scope, candidates);
    const captureFailure = getReferralCaptureFailure();
    const couponCode = String(bookingData.couponCode || "").trim();
    let active = true;
    setPreApplyingCodes(true);
    setCoupon(null);
    setReferralError("");
    setCouponError("");

    const preApplyCodes = async () => {
      let nextReferral = null;
      let nextCoupon = null;
      let nextReferralInput = captureFailure?.code || "";
      let nextCouponInput = couponCode;
      let referralUnavailable = false;
      let referralMessage = captureFailure ? REFERRAL_STORAGE_ERROR : "";
      let couponMessage = "";
      let infoMessage = "";
      let referralOrigin = referralCode;
      let referralCandidates = candidates;
      const stillSelected = (input, canonical = "", origins = candidates) => {
        const current = selectStoredReferral(scope, origins);
        return current === input.toLowerCase() || (canonical && current === canonical.toLowerCase());
      };

      const applyResolved = (result, source, input, origins) => {
        if (!result?.ok) {
          if (source === "referral") {
            if (result?.unavailable) {
              referralUnavailable = true;
              nextReferral = referral;
              nextReferralInput = referral?.code || input;
              referralMessage = result.error;
            } else {
              clearStoredReferral(input);
              referralMessage = "Invalid or inactive referral code.";
            }
          } else {
            nextCouponInput = "";
            couponMessage = result?.error || "Invalid coupon code.";
          }
          return;
        }

        if (result.type === "referral") {
          const safeReferral = sanitizeReferralForCheckout(result.value);
          if (!safeReferral || !stillSelected(input, safeReferral.code, origins) ||
            isReferralDismissed(safeReferral.code)) {
            if (source === "coupon") nextCouponInput = "";
            return;
          }
          nextReferral = safeReferral;
          nextReferralInput = safeReferral.code;
          referralOrigin = input;
          referralCandidates = origins;
          if (source === "coupon") {
            nextCouponInput = "";
            infoMessage = "This code is a referral, so it was applied as a referral.";
          }
          if (nextCoupon?.canCombineWithReferral === false) {
            nextCoupon = null;
            nextCouponInput = "";
          }
          return;
        }

        const safeCoupon = sanitizeCouponForCheckout(result.value);
        if (!safeCoupon) return;
        if (safeCoupon.canCombineWithReferral === false && nextReferral) {
          nextCouponInput = "";
          couponMessage = "This coupon can't be used together with a referral discount.";
          return;
        }
        nextCoupon = safeCoupon;
        nextCouponInput = safeCoupon.code;
        if (source === "referral") infoMessage = "This code is a coupon, so it was applied as a coupon.";
      };

      if (referralCode) {
        const result = await resolveCheckoutCode(referralCode, packageTitle);
        if (!active || !codeApplicationAllowedRef.current) return;
        const canonical = result?.ok && result.type === "referral" ? result.value?.code || "" : "";
        if (!stillSelected(referralCode, canonical)) return;
        applyResolved(result, "referral", referralCode, candidates);
      }
      if (couponCode && couponCode.toLowerCase() !== referralCode.toLowerCase()) {
        const origins = [...candidates, couponCode];
        const result = await resolveCheckoutCode(couponCode, packageTitle);
        if (!active || !codeApplicationAllowedRef.current) return;
        applyResolved(result, "coupon", couponCode, origins);
      } else if (couponCode && nextReferral) {
        nextCouponInput = "";
      }

      if (!active || !codeApplicationAllowedRef.current) return;
      if (nextReferral) {
        if (!stillSelected(referralOrigin, nextReferral.code, referralCandidates) || isReferralDismissed(nextReferral.code)) return;
        if (!referralUnavailable && !recordAutomaticReferral(nextReferral.code, scope)) {
          nextReferral = null;
          nextReferralInput = "";
          referralMessage = REFERRAL_STORAGE_ERROR;
        }
      }
      setReferral(nextReferral);
      setCoupon(nextCoupon);
      setReferralInput(nextReferralInput);
      setCouponInput(nextCouponInput);
      setReferralError(referralMessage);
      setCouponError(couponMessage);
      if (infoMessage) showBanner("info", infoMessage);
    };

    preApplyCodes().finally(() => {
      if (active) setPreApplyingCodes(false);
    });

    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bookingData.couponCode,
    bookingData.referralCode,
    hydrated,
    location.key,
    location.search,
    packageTitle,
    referralRestoreCount,
    scope,
  ]);

  useEffect(() => {
    if (!canUseRazorpay) {
      setRzpReady(false);
      return undefined;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => setRzpReady(true);
    script.onerror = () => {
      console.error("Failed to load Razorpay SDK");
      setRzpReady(false);
      showBanner(
        "error",
        "Payment system failed to load. Please refresh the page and try again."
      );
    };
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, [canUseRazorpay]);

  useEffect(() => {
    let active = true;

    fetch("/api/payment/providers")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad_status"))))
      .then((data) => {
        if (!active || !data?.ok || !data?.providers) return;
        setProviderAvailabilityKnown(["dodo", "razorpay", "paypal"].every(
          (provider) => typeof data.providers[provider]?.enabled === "boolean"
        ));
        setProviderConfig({
          dodo: { enabled: !!data.providers?.dodo?.enabled, mode: data.providers?.dodo?.mode || "missing" },
          razorpay: {
            enabled: !!data.providers?.razorpay?.enabled,
            mode: data.providers?.razorpay?.mode || "unknown",
            disabledReason: String(
              data.providers?.razorpay?.disabledReason || ""
            ).trim(),
          },
          paypal: {
            enabled: !!data.providers?.paypal?.enabled,
            mode: data.providers?.paypal?.mode || "unknown",
            clientId: String(data.providers?.paypal?.clientId || "").trim(),
          },
        });
      })
      .catch(() => {
        if (typeof window === "undefined") return;
        const host = String(window.location.hostname || "").toLowerCase();
        const isLocalHost = host === "localhost" || host === "127.0.0.1";
        if (isLocalHost && hasPaypalClientId) {
          setProviderConfig((prev) => ({
            ...prev,
            paypal: {
              enabled: true,
              mode: "sandbox",
              clientId: prev?.paypal?.clientId || paypalClientIdFromEnv,
            },
          }));
        }
      })
      .finally(() => {
        if (active) setProvidersSettled(true);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(location.search);
    const internalToggle = params.get("internalPayments");

    try {
      if (internalToggle === "1") {
        sessionStorage.setItem(INTERNAL_PAYMENTS_KEY, "1");
      } else if (internalToggle === "0") {
        sessionStorage.removeItem(INTERNAL_PAYMENTS_KEY);
      }

      const host = String(window.location.hostname || "").toLowerCase();
      const isLocalHost = host === "localhost" || host === "127.0.0.1";
      const hasInternalSession =
        sessionStorage.getItem(INTERNAL_PAYMENTS_KEY) === "1";

      setShowInternalPayments(isLocalHost || hasInternalSession);
    } catch {
      setShowInternalPayments(false);
    }
  }, [location.search]);

  useEffect(() => {
    if (!hydrated || !packageTitle) return;
    const stored = readStoredPaymentSession();
    if (
      stored?.fingerprint &&
      paymentSessionMatchesCheckout(stored.fingerprint, checkoutFingerprint)
    ) {
      const storedFingerprint = parseCheckoutFingerprint(stored.fingerprint);
      const storedReferralCode = String(
        storedFingerprint?.referralCode || ""
      ).trim();
      const storedCouponCode = String(storedFingerprint?.couponCode || "").trim();
      if (storedReferralCode !== referralInput) {
        setReferralInput(storedReferralCode);
      }
      if (storedCouponCode !== couponInput) {
        setCouponInput(storedCouponCode);
      }
      setPaymentSession(stored);
      return;
    }

    if (stored) {
      clearStoredPaymentSession();
    }
    setPaymentSession(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutFingerprint, couponInput, hydrated, packageTitle, referralInput]);

  const persistPaymentSession = (nextSession) => {
    paymentView.session = nextSession;
    setPaymentSession(nextSession);
    writeStoredPaymentSession(nextSession);
  };

  const getActivePaymentSession = (provider) => {
    const stored = readStoredPaymentSession();
    if (
      stored?.provider === provider &&
      paymentSessionMatchesCheckout(stored?.fingerprint, checkoutFingerprint) &&
      stored?.paymentAccessToken
    ) {
      return stored;
    }

    if (
      paymentSession?.provider === provider &&
      paymentSessionMatchesCheckout(
        paymentSession?.fingerprint,
        checkoutFingerprint
      ) &&
      paymentSession?.paymentAccessToken
    ) {
      return paymentSession;
    }

    return null;
  };

  const paymentSessionOwnsCurrentHold = (session) => {
    const sessionHoldToken = String(
      session?.result?.refreshedHold?.slotHoldToken || session?.result?.hold?.slotHoldToken || ""
    ).trim();
    if (!sessionHoldToken) return true;
    let storedHoldToken = "";
    try {
      storedHoldToken = JSON.parse(sessionStorage.getItem("my_slot_hold") || "null")?.holdToken;
    } catch {}
    const currentHoldTokens = [
      sessionHold?.slotHoldToken,
      storedHoldToken,
      readStoredCheckout()?.slotHoldToken,
      bookingData?.slotHoldToken,
    ].map((token) => String(token || "").trim()).filter(Boolean);
    return !currentHoldTokens.length || currentHoldTokens.includes(sessionHoldToken);
  };

  const clearPaymentSession = (terminalStatus = "", expectedToken = "") => {
    const storedSession = readStoredPaymentSession();
    const activeSession = storedSession || paymentSession;
    if (expectedToken && activeSession?.paymentAccessToken !== expectedToken) return true;
    sessionStartRef.current = null;
    setPaymentSession(null);
    paymentView.session = null;
    clearStoredPaymentSession();
    if (activeSession?.provider !== "dodo" || isUpgrade ||
        !["failed", "abandoned", "refunded"].includes(terminalStatus) ||
        !paymentSessionOwnsCurrentHold(activeSession)) return false;
    const nextCheckout = {
      ...bookingData,
      slotHoldId: "",
      slotHoldToken: "",
      slotHoldExpiresAt: "",
    };
    setSessionHold(null);
    writeStoredCheckout(nextCheckout);
    removeBrowserStorage("sessionStorage", "my_slot_hold");
    window.dispatchEvent(new CustomEvent("hold-state", { detail: null }));
    dodoReturnHandled.current = "";
    const query = new URLSearchParams(location.search);
    query.delete("dodo_return");
    query.delete("dodo_cancel");
    navigate({ pathname: location.pathname, search: query.toString(), hash: location.hash }, {
      replace: true, state: { ...navState, bookingData: nextCheckout },
    });
    showBanner("error", terminalStatus === "refunded"
      ? "This payment was refunded. Go back to booking to choose a time."
      : "Payment was not completed and the slot was released. Go back to booking to choose a time.",
    { persistent: true });
    return true;
  };

  const handleChangePaymentMethod = async () => {
    const activeSession = readStoredPaymentSession() || paymentSession;
    const paymentAccessToken = String(activeSession?.paymentAccessToken || "").trim();
    if (!paymentAccessToken || cancellingPayment) return;
    const operation = createPaymentOperation(paymentAccessToken);
    if (!operation.current()) return;

    setCancellingPayment(true);
    try {
      const { response, data } = await fetchJson("/api/payment/cancel", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paymentAccessToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      if (!operation.current()) return;
      if (data?.captured) {
        if (["booked", "email_partial"].includes(String(data.status || "").toLowerCase())) {
          await navigateToConfirmation("paid", data, operation);
          return;
        }
        showBanner("info", "Your payment was received and is being finalized.");
        return;
      }
      if (!response.ok || data?.cancelled !== true) {
        throw new Error(data?.error || "The payment method could not be changed.");
      }

      const refreshedHold = data.refreshedHold || null;
      if (refreshedHold?.slotHoldId && refreshedHold?.slotHoldToken) {
        setSessionHold(refreshedHold);
        const nextCheckout = {
          ...bookingData,
          slotHoldId: refreshedHold.slotHoldId,
          slotHoldToken: refreshedHold.slotHoldToken,
          slotHoldExpiresAt: refreshedHold.slotHoldExpiresAt,
        };
        writeStoredCheckout(nextCheckout);
        const holdState = {
          holdId: refreshedHold.slotHoldId,
          holdToken: refreshedHold.slotHoldToken,
          expiresAt: refreshedHold.slotHoldExpiresAt,
          startTimeUTC: bookingData.startTimeUTC || "",
          packageTitle,
          packagePrice,
          phase: "holding",
        };
        writeBrowserStorage("sessionStorage", "my_slot_hold", JSON.stringify(holdState));
        window.dispatchEvent(new CustomEvent("hold-state", { detail: holdState }));
      }
      clearPaymentSession("", operation.token);
      operation.token = "";
      if (activeSession.provider === "dodo") {
        dodoReturnHandled.current = "";
        const query = new URLSearchParams(location.search);
        query.delete("dodo_return");
        query.delete("dodo_cancel");
        navigate({ pathname: location.pathname, search: query.toString(), hash: location.hash }, {
          replace: true, state: location.state,
        });
      }
      showBanner("success", "Payment method released. Choose a payment method below.");
    } catch (error) {
      if (!operation.current()) return;
      showBanner("error", error.message || "The payment method could not be changed.");
    } finally {
      if (operation.current()) setCancellingPayment(false);
    }
  };

  const buildFinalizeNavigation = (responseBody, operation) => {
    if (!operation.current()) return null;
    clearPaymentSession("", operation.token);
    operation.token = "";
    return buildConfirmationNavigationState(responseBody);
  };

  const navigateToConfirmation = async (kind, responseBody, operation) => {
    await Promise.race([
      preloadConfirmationPage(kind).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, CONFIRMATION_PRELOAD_WAIT_MS)),
    ]);
    if (!operation.current()) return;
    const state = kind === "paid"
      ? buildFinalizeNavigation(responseBody, operation)
      : buildConfirmationNavigationState(responseBody);
    navigate(kind === "paid" ? "/payment-success" : "/thank-you", { state, replace: true });
  };

  const fetchJson = async (
    url,
    options = {},
    timeoutMs = PAYMENT_FETCH_TIMEOUT_MS
  ) => {
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller?.signal || options.signal,
      });
      const data = await response.json().catch((error) => {
        if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
        return {};
      });
      return { response, data };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  const pollPaymentUntilTerminal = async (paymentAccessToken, operation) => {
    const startedAt = Date.now();
    const deadline = startedAt + PAYMENT_STATUS_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!operation.current()) return null;
      let response;
      let data;
      try {
        const result = await fetchJson(
          "/api/payment/status",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${paymentAccessToken}`,
              "Content-Type": "application/json",
            },
            body: "{}",
          },
          Math.min(PAYMENT_FETCH_TIMEOUT_MS, deadline - Date.now())
        );
        response = result.response;
        data = result.data;
      } catch (error) {
        if (!operation.current()) return null;
        if (error?.name === "AbortError") continue;
        throw error;
      }

      if (!operation.current()) return null;
      if (!response.ok) {
        throw new Error(data?.error || "Unable to load payment status.");
      }

      const nextStatus = String(data?.status || "").trim().toLowerCase();
      if (data?.manualReviewRequired === true) return data;
      if (
        nextStatus === "booked" ||
        nextStatus === "email_partial" ||
        nextStatus === "refunded" ||
        nextStatus === "failed" ||
        nextStatus === "abandoned"
      ) {
        return data;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(PAYMENT_STATUS_POLL_INTERVAL_MS, remainingMs)
          )
        );
      }
    }

    throw new Error("Timed out waiting for payment confirmation.");
  };

  const startSessionCheckout = async (provider, operation = createPaymentOperation()) => {
    if (!operation.current()) return { terminal: true, stale: true };
    if (
      paymentSession?.provider === provider &&
      paymentSessionMatchesCheckout(
        paymentSession?.fingerprint,
        checkoutFingerprint
      ) &&
      paymentSession?.paymentAccessToken &&
      paymentSession?.providerPayload
    ) {
      const { response, data } = await fetchJson("/api/payment/status", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paymentSession.paymentAccessToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      if (!operation.current()) return { terminal: true, stale: true };
      const resumedStatus = String(data?.status || "").trim().toLowerCase();
      if (response.ok && data?.manualReviewRequired === true) {
        showBanner("info", data.recoveryReason, { persistent: true });
        return { ...paymentSession, result: data, terminal: true };
      }
      if (
        response.ok &&
        (resumedStatus === "booked" || resumedStatus === "email_partial")
      ) {
        await navigateToConfirmation("paid", data, operation);
        return { ...paymentSession, result: data, terminal: true };
      }
      if (
        !response.ok ||
        !["refunded", "failed", "abandoned"].includes(resumedStatus)
      ) {
        return paymentSession;
      }
      if (paymentSessionOwnsCurrentHold(paymentSession)) {
        const handled = clearPaymentSession(resumedStatus, paymentSession.paymentAccessToken);
        operation.token = "";
        if (handled) {
          return { ...paymentSession, result: data, terminal: true };
        }
        throw new Error(
          data?.recoveryReason || "This payment session is no longer payable."
        );
      }
      clearPaymentSession("", paymentSession.paymentAccessToken);
      operation.token = "";
    }

    if (sessionStartRef.current?.provider === provider && sessionStartRef.current.operation.current()) {
      return sessionStartRef.current.promise;
    }
    if (otherCheckoutStarting(provider)) {
      throw new Error("Another payment method is still starting. Please wait a moment and try again.");
    }

    const promise = (async () => {
      if (quoteLoading || !quoteFingerprint) {
        throw new Error("Checkout price is still being confirmed. Please try again.");
      }

      const { response, data } = await fetchJson("/api/payment/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          quoteFingerprint,
          bookingPayload: buildCheckoutPayload(),
        }),
      });

      if (!operation.current()) return { terminal: true, stale: true };

      if (!response.ok || !data?.ok) {
        if (data?.quote) setServerQuote(data.quote);
        if (data?.quoteFingerprint || data?.fingerprint) {
          setQuoteFingerprint(
            String(data.quoteFingerprint || data.fingerprint || "").trim()
          );
        }
        if (
          response.status === 409 &&
          [
            "quote_changed",
            "quote_fingerprint_mismatch",
            "quote_fingerprint_required",
          ].includes(String(data?.code || ""))
        ) {
          throw new Error("The price changed. Review the updated total and click again.");
        }
        throw new Error(data?.error || "Unable to start payment.");
      }

      if (data.quote) setServerQuote(data.quote);
      if (data.quoteFingerprint || data.fingerprint) {
        setQuoteFingerprint(
          String(data.quoteFingerprint || data.fingerprint || "").trim()
        );
      }

      const refreshedHold = data.refreshedHold || data.hold || null;
      if (refreshedHold?.slotHoldId && refreshedHold?.slotHoldToken) {
        setSessionHold(refreshedHold);
        const nextCheckout = {
          ...bookingData,
          slotHoldId: refreshedHold.slotHoldId,
          slotHoldToken: refreshedHold.slotHoldToken,
          slotHoldExpiresAt:
            refreshedHold.slotHoldExpiresAt || refreshedHold.expiresAt || "",
        };
        writeStoredCheckout(nextCheckout);
        try {
          const holdState = {
            holdId: refreshedHold.slotHoldId,
            holdToken: refreshedHold.slotHoldToken,
            expiresAt:
              refreshedHold.slotHoldExpiresAt || refreshedHold.expiresAt || "",
            startTimeUTC: bookingData.startTimeUTC || "",
            packageTitle,
            phase: refreshedHold.phase || "payment_pending",
          };
          writeBrowserStorage("sessionStorage", "my_slot_hold", JSON.stringify(holdState));
          window.dispatchEvent(new CustomEvent("hold-state", { detail: holdState }));
        } catch {}
      }

      const nextSession = {
        provider,
        fingerprint: checkoutFingerprint,
        paymentAccessToken: String(data.paymentAccessToken || "").trim(),
        providerPayload: data.providerPayload || {},
        sessionExpiresAt: String(data.sessionExpiresAt || "").trim(),
        result: data,
      };
      const returnedStatus = String(data.status || "").trim().toLowerCase();
      if (
        provider !== "free" &&
        (returnedStatus === "booked" || returnedStatus === "email_partial")
      ) {
        await navigateToConfirmation("paid", data, operation);
        return { ...nextSession, terminal: true };
      }
      if (provider !== "free") {
        operation.token = nextSession.paymentAccessToken;
        persistPaymentSession(nextSession);
      }
      return nextSession;
    })();

    sessionStartRef.current = { provider, promise, operation };
    setPendingStarts([...pendingStartsRef.current, { provider, promise }]);

    try {
      return await promise;
    } catch (error) {
      if (!operation.current()) return { terminal: true, stale: true };
      throw error;
    } finally {
      if (sessionStartRef.current?.promise === promise) sessionStartRef.current = null;
      setPendingStarts(pendingStartsRef.current.filter((start) => start.promise !== promise));
    }
  };

  const finalizeSessionCheckout = async ({ paymentAccessToken, providerData, operation = createPaymentOperation(paymentAccessToken), captured = false }) => {
    if (!captured && !operation.current()) return null;
    if (operation.current()) setPaymentStatusBusy(true);
    try {
      const { response, data } = await fetchJson("/api/payment/finalize", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paymentAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          providerData,
        }),
      });

      if (!operation.current()) return null;

      const status = String(data?.status || "").trim().toLowerCase();
      const isFinalizedStatus = status === "booked" || status === "email_partial";
      if (response.ok && data?.manualReviewRequired === true) {
        showBanner("info", data.recoveryReason, { persistent: true });
        return data;
      }

      if (!response.ok && response.status !== 202 && !isFinalizedStatus) {
        throw new Error(data?.error || "Unable to finalize payment.");
      }

      if (isFinalizedStatus) {
        await navigateToConfirmation("paid", data, operation);
        return data;
      }

      if (
        status === "needs_recovery" ||
        status === "finalizing" ||
        status === "started"
      ) {
        showBanner("info", "Finalizing your payment and booking...");
        const settled = await pollPaymentUntilTerminal(paymentAccessToken, operation);
        if (!operation.current()) return null;
        const settledStatus = String(settled?.status || "").trim().toLowerCase();
        if (settled?.manualReviewRequired === true) {
          showBanner("info", settled.recoveryReason, { persistent: true });
          return settled;
        }
        if (settledStatus === "booked" || settledStatus === "email_partial") {
          await navigateToConfirmation("paid", settled, operation);
          return settled;
        }

        const handled = clearPaymentSession(settledStatus, paymentAccessToken);
        operation.token = "";
        if (handled) {
          return settled;
        }
        throw new Error(
          settled?.recoveryReason ||
            settled?.error ||
            "Payment could not be finalized."
        );
      }

      const handled = clearPaymentSession(status, paymentAccessToken);
      operation.token = "";
      if (handled) {
        return data;
      }
      throw new Error(
        data?.recoveryReason || data?.error || "Payment finalization failed."
      );
    } catch (error) {
      if (!operation.current()) return null;
      throw error;
    } finally {
      if (operation.current()) setPaymentStatusBusy(false);
    }
  };

  const handleDodoCheckout = async () => {
    const operation = createPaymentOperation();
    if (!operation.current()) return;
    if (payingDodo || paymentStatusBusy || otherCheckoutStarting("dodo")) return;
    if (!ensureSlotBeforeAction()) return;
    setPayingDodo(true);
    try {
      const session = await startSessionCheckout("dodo", operation);
      if (!operation.current()) return;
      if (session?.terminal) return;
      if (!session?.providerPayload?.checkoutUrl) throw new Error("Checkout is being recovered. Check the payment status shortly.");
      const refreshedHold = session.result?.refreshedHold || session.result?.hold || sessionHold;
      const returnCheckout = {
        ...bookingData,
        ...(refreshedHold?.slotHoldId && refreshedHold?.slotHoldToken ? {
          slotHoldId: refreshedHold.slotHoldId,
          slotHoldToken: refreshedHold.slotHoldToken,
          slotHoldExpiresAt: refreshedHold.slotHoldExpiresAt || refreshedHold.expiresAt || "",
        } : {}),
      };
      if (!writeBrowserStorage("sessionStorage", CHECKOUT_BOOKING_STORAGE_KEY, JSON.stringify(returnCheckout)) ||
          !writeStoredPaymentSession(session)) {
        showBanner("error", "Your browser could not save this payment session. Checkout has stayed here so you can check its status or change payment method. Allow browser storage and try again to open checkout.", { persistent: true });
        return;
      }
      window.location.assign(session.providerPayload.checkoutUrl);
    } catch (error) {
      if (!operation.current()) return;
      const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
      showBanner(
        "error",
        timedOut ? "Checkout timed out. Please try again." : error.message || "Unable to open checkout.",
        { persistent: true }
      );
    } finally {
      if (operation.current()) setPayingDodo(false);
    }
  };

  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const session = readStoredPaymentSession();
    if (!hydrated || session?.provider !== "dodo" || !session.paymentAccessToken ||
        (!query.has("dodo_return") && !query.has("dodo_cancel")) ||
        dodoReturnHandled.current === session.paymentAccessToken) return;
    dodoReturnHandled.current = session.paymentAccessToken;
    const action = query.has("dodo_cancel") ? handleChangePaymentMethod()
      : finalizeSessionCheckout({ paymentAccessToken: session.paymentAccessToken, providerData: {} });
    Promise.resolve(action).catch((error) => showBanner("error", error.message || "Payment confirmation is pending. Check again shortly."));
  }, [hydrated, location.search, paymentSession]);

  async function validateReferral(code) {
    if (creatingFree || validating || validatingCoupon) return;
    const normalizedCode = String(code || "").trim();
    if (!normalizedCode) {
      if (referral?.code && !dismissReferralCode(referral.code)) {
        setReferralError(REFERRAL_STORAGE_ERROR);
        return;
      }
      setReferral(null);
      setReferralError("");
      return;
    }
    const operation = createPaymentOperation();
    const validationView = paymentView;
    const attempt = ++manualValidationAttemptRef.current;
    const isCurrent = () => operation.current() &&
      paymentViewRef.current === validationView && codeApplicationAllowedRef.current;
    try {
      setValidating(true);
      setReferralError("");
      const result = await resolveCheckoutCode(normalizedCode, packageTitle);
      if (!isCurrent()) return;
      if (!result.ok) {
        if (!result.unavailable) {
          const currentMatches = String(referral?.code || "").toLowerCase() === normalizedCode.toLowerCase();
          if (currentMatches) setReferral(null);
          if (!clearStoredReferral(normalizedCode)) {
            setReferralError(REFERRAL_STORAGE_ERROR);
            return;
          }
        }
        setReferralError(result.unavailable ? result.error : "Invalid or inactive referral code.");
        return;
      }

      if (result.type === "coupon") {
        const safeCoupon = sanitizeCouponForCheckout(result.value);
        if (!safeCoupon) {
          setReferralError("Invalid or inactive referral code.");
          return;
        }
        if (safeCoupon.canCombineWithReferral === false && referral) {
          setCouponError(
            "This coupon can't be used together with a referral discount."
          );
          return;
        }
        setCoupon(safeCoupon);
        setCouponInput(safeCoupon.code);
        setReferralInput(referral?.code || "");
        showBanner("info", "This code is a coupon, so it was applied as a coupon.");
        return;
      }

      const safeReferral = sanitizeReferralForCheckout(result.value);
      if (!safeReferral) {
        setReferralError("Invalid or inactive referral code.");
        return;
      }
      if (!clearReferralDismissal(safeReferral.code, scope)) {
        setReferralInput(referral?.code || "");
        setReferralError(REFERRAL_STORAGE_ERROR);
        return;
      }
      setReferral(safeReferral);
      setReferralInput(safeReferral.code);
      if (coupon?.canCombineWithReferral === false) {
        setCoupon(null);
        setCouponInput("");
        showBanner(
          "info",
          "Current coupon can't be combined with referrals and was removed."
        );
      }
    } catch {
      if (!isCurrent()) return;
      console.error("Referral validation failed");
      setReferralError(
        "We couldn't validate that referral code. Please try again."
      );
    } finally {
      if (paymentMountedRef.current && manualValidationAttemptRef.current === attempt) setValidating(false);
    }
  }

  async function validateCoupon(code) {
    if (creatingFree || validating || validatingCoupon) return;
    const normalizedCode = String(code || "").trim();
    if (!normalizedCode) {
      setCoupon(null);
      setCouponError("");
      return;
    }
    const operation = createPaymentOperation();
    const validationView = paymentView;
    const attempt = ++manualValidationAttemptRef.current;
    const isCurrent = () => operation.current() &&
      paymentViewRef.current === validationView && codeApplicationAllowedRef.current;
    try {
      setValidatingCoupon(true);
      setCouponError("");
      const result = await resolveCheckoutCode(normalizedCode, packageTitle);
      if (!isCurrent()) return;
      if (!result.ok) {
        setCoupon(null);
        setCouponError(result.error || "Invalid coupon code.");
        return;
      }

      if (result.type === "referral") {
        const safeReferral = sanitizeReferralForCheckout(result.value);
        if (!safeReferral) {
          setCouponError("Invalid coupon code.");
          return;
        }
        if (!clearReferralDismissal(safeReferral.code, scope)) {
          setCouponInput(coupon?.code || "");
          setCouponError(REFERRAL_STORAGE_ERROR);
          return;
        }
        setReferral(safeReferral);
        setReferralInput(safeReferral.code);
        setCoupon(null);
        setCouponInput("");
        showBanner(
          "info",
          "This code is a referral, so it was applied as a referral."
        );
        return;
      }

      const safeCoupon = sanitizeCouponForCheckout(result.value);
      if (!safeCoupon) {
        setCouponError("Invalid coupon code.");
        return;
      }
      if (safeCoupon.canCombineWithReferral === false && referral) {
        setCoupon(null);
        setCouponError(
          "This coupon can't be used together with a referral discount. Remove the referral or use a different coupon."
        );
        return;
      }

      setCoupon(safeCoupon);
      setCouponInput(safeCoupon.code);
      showBanner("success", `Coupon applied: ${formatCouponValue(safeCoupon)}`);
    } catch {
      if (!isCurrent()) return;
      console.error("Coupon validation failed");
      setCoupon(null);
      setCouponError(
        "We couldn't validate that coupon code. Please try again."
      );
    } finally {
      if (paymentMountedRef.current && manualValidationAttemptRef.current === attempt) setValidatingCoupon(false);
    }
  }

  async function handleFreeBooking() {
    const operation = createPaymentOperation();
    if (!operation.current()) return;
    if (!isFree) return;
    if (validating || validatingCoupon) return;
    if (otherCheckoutStarting("free")) return;
    if (!ensureSlotBeforeAction()) return;

    setCreatingFree(true);
    const endConfirmation = beginCheckoutConfirmation();
    try {
      showBanner("info", "Confirming your free booking...");
      const session = await startSessionCheckout("free", operation);
      if (!operation.current() || session?.stale) return;
      const data = session?.result || {};
      const status = String(data.status || "").trim().toLowerCase();
      if (!data.bookingId || (status !== "booked" && status !== "email_partial")) {
        throw new Error(data.error || "Could not save your free booking.");
      }

      await navigateToConfirmation("free", data, operation);
    } catch (err) {
      if (!operation.current()) return;
      console.error("Free booking failed");
      showBanner(
        "error",
        err?.message ||
          "Something went wrong saving your free booking. Please contact support."
      );
      if (holdExpiresAt && new Date(holdExpiresAt).getTime() <= Date.now()) {
        holdExpiryHandledRef.current = true;
        navigate("/", { replace: true });
      }
    } finally {
      endConfirmation();
      if (operation.current()) setCreatingFree(false);
    }
  }
  async function handleRazorpayPay() {
    const operation = createPaymentOperation();
    if (!operation.current()) return;
    if (otherCheckoutStarting("razorpay")) return;
    if (!canUseRazorpay) {
      showBanner(
        "error",
        "Razorpay secure checkout is currently unavailable. Please try again shortly."
      );
      return;
    }

    if (!rzpReady || !window.Razorpay) {
      showBanner(
        "error",
        "Payment system is still loading. Please wait a few seconds and try again."
      );
      return;
    }

    if (!ensureSlotBeforeAction()) return;

    if (isFree) {
      showBanner(
        "error",
        "This booking is fully discounted. Use the 'Confirm Free Booking' button instead."
      );
      return;
    }

    try {
      if (finalAmount <= 0) {
        showBanner(
          "error",
          "Final amount is zero or negative. Please contact support."
        );
        return;
      }

      setPayingRzp(true);
      showBanner("info", "Opening secure checkout...");

      const razorpaySession = await startSessionCheckout("razorpay", operation);
      if (!operation.current()) return;
      if (razorpaySession?.terminal) return;
      const orderData = {
          ok: true,
          orderId: razorpaySession.providerPayload.orderId,
          amount: razorpaySession.providerPayload.amount,
          currency: razorpaySession.providerPayload.currency,
          key: razorpaySession.providerPayload.key,
          paymentAccessToken: razorpaySession.paymentAccessToken,
        };

      if (!orderData.ok) {
        console.error("Razorpay order creation failed");
        showBanner(
          "error",
          orderData.message || "Couldn't start the payment. Please try again."
        );
        return;
      }

      const options = {
        key: orderData.key,
        amount: orderData.amount,
        currency: orderData.currency,
        name: "Roo Industries",
        description: `${packageTitle} booking`,
        order_id: orderData.orderId,

        method: {
          card: true,
          netbanking: true,
          upi: true,
          wallet: true,
        },

        theme: {
          color: "#0ea5e9",
        },

        handler: async function (response) {
          if (!operation.current()) return;
          try {
            await finalizeSessionCheckout({
              operation,
              paymentAccessToken: String(
                orderData.paymentAccessToken || paymentSession?.paymentAccessToken || ""
              ).trim(),
              providerData: {
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              },
            });
          } catch {
            if (!operation.current()) return;
            console.error("Razorpay booking finalization failed");
            showBanner(
              "error",
              "Payment succeeded but something went wrong saving your booking. Please contact support."
            );
          }
        },

        modal: {
          ondismiss: function () {
            if (!operation.current()) return;
            showBanner(
              "info",
              "Checkout closed. Your payment session is still reserved for this method."
            );
          },
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err) {
      if (!operation.current()) return;
      console.error("Razorpay checkout failed");
      showBanner(
        "error",
        err?.message || "Payment could not be processed. Please try again."
      );
    } finally {
      if (operation.current()) setPayingRzp(false);
    }
  }

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
        delayChildren: 0.1,
      },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { type: "spring", stiffness: 260, damping: 30 },
    },
  };

  return (
    <motion.section
      className="booking-payment relative z-10 max-w-3xl mx-auto text-ink"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <motion.div variants={itemVariants}>
        <h2 className="text-4xl sm:text-5xl font-extrabold text-center text-info-text drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
          {isUpgrade ? "Complete Upgrade Payment" : "Complete Payment"}
        </h2>
        <p className="mt-3 text-ink-secondary text-center text-sm sm:text-base">
          {isUpgrade
            ? "Review your upgrade details and proceed to payment"
            : "Review your booking details and proceed to payment"}
        </p>
      </motion.div>

      <motion.div variants={itemVariants}>
        {banner && banner.text && (
          <div
            ref={bannerRef}
            role={banner.type === "error" ? "alert" : "status"}
            aria-live={banner.type === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            className={`mt-6 scroll-mt-6 rounded-xl border px-4 py-3 text-sm flex items-center gap-3 shadow-[0_0_25px_rgba(15,23,42,0.8)] ${
              banner.type === "error"
                ? "border-danger-border bg-danger-soft text-danger-text"
                : banner.type === "success"
                ? "border-success-border bg-success-soft text-success-text"
                : "border-info-border bg-info-soft text-info-text"
            }`}
          >
            <span className="text-lg" aria-hidden="true">
              {banner.type === "error"
                ? "!"
                : banner.type === "success"
                ? "OK"
                : "i"}
            </span>
            <p className="flex-1">{banner.text}</p>
            {banner.retryQuote && (
              <button
                type="button"
                onClick={() => {
                  setBanner(null);
                  setQuoteRetryCount((count) => count + 1);
                }}
                className="rounded-md border border-current px-2 py-1 text-xs font-semibold uppercase tracking-wide hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-border"
              >
                Retry price check
              </button>
            )}
            <button
              type="button"
              onClick={() => setBanner(null)}
              className="text-xs uppercase tracking-wide opacity-70 hover:opacity-100"
            >
              Close
            </button>
          </div>
        )}
      </motion.div>


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
              {referralPercent > 0 && (
                <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                  <dt className="text-ink-muted">Referral</dt>
                  <dd className="font-semibold text-ink sm:text-right">
                    {referral?.code} · −${referralDiscountAmount.toFixed(2)}
                  </dd>
                </div>
              )}
              {couponDiscountAmount > 0 && coupon && (
                <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                  <dt className="text-ink-muted">Coupon</dt>
                  <dd className="font-semibold text-ink sm:text-right">
                    {coupon.code} · −${couponDiscountAmount.toFixed(2)}
                  </dd>
                </div>
              )}
              <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:items-baseline">
                <dt className="font-semibold text-ink">{dodoTaxExclusive ? "Subtotal" : "Total"}</dt>
                <dd className="sm:text-right">
                  {(referralPercent > 0 || couponDiscountAmount > 0) && (
                    <span className="mr-2 text-sm text-ink-secondary line-through">
                      ${baseAmount.toFixed(2)}
                    </span>
                  )}
                  <span className="text-2xl font-extrabold text-accent">
                    ${finalAmount.toFixed(2)} USD
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
              <div className="flex flex-wrap gap-2 items-center">
                <input
                  id="payment-referral-code"
                  value={referralInput}
                  onChange={(e) => {
                    setReferralInput(e.target.value.trim());
                    if (referralError) setReferralError("");
                  }}
                  disabled={creatingFree || preApplyingCodes || checkingCode || !!lockedProvider}
                  aria-invalid={referralError ? "true" : "false"}
                  aria-describedby={
                    referralError ? "payment-referral-code-error" : undefined
                  }
                  placeholder="e.g. vouch"
                  className="w-60 bg-surface-input border border-line-input rounded-md px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-border focus-visible:ring-offset-2 focus-visible:ring-offset-surface-card disabled:opacity-60"
                />

                <button
                  onClick={() => validateReferral(referralInput)}
                  disabled={creatingFree || preApplyingCodes || checkingCode || !!lockedProvider}
                  className="glow-button px-3 py-2 rounded-md font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60 text-sm"
                >
                  {validating ? "Checking..." : "Apply"}
                  <span className="glow-line glow-line-top" />
                  <span className="glow-line glow-line-right" />
                  <span className="glow-line glow-line-bottom" />
                  <span className="glow-line glow-line-left" />
                </button>
              </div>
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
              <div className="flex flex-wrap gap-2 items-center">
                <input
                  id="payment-coupon-code"
                  value={couponInput}
                  onChange={(e) => {
                    setCouponInput(e.target.value.trim());
                    if (couponError) setCouponError("");
                  }}
                  disabled={creatingFree || preApplyingCodes || checkingCode || !!lockedProvider}
                  aria-invalid={couponError ? "true" : "false"}
                  aria-describedby={
                    couponError ? "payment-coupon-code-error" : undefined
                  }
                  placeholder="e.g. BF10"
                  className="w-60 bg-surface-input border border-line-input rounded-md px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-border focus-visible:ring-offset-2 focus-visible:ring-offset-surface-card disabled:opacity-60"
                />

                <button
                  onClick={() => validateCoupon(couponInput)}
                  disabled={
                    creatingFree || preApplyingCodes || checkingCode || !!lockedProvider
                  }
                  className="glow-button px-3 py-2 rounded-md font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60 text-sm"
                >
                  {validatingCoupon ? "Checking..." : "Apply"}
                  <span className="glow-line glow-line-top" />
                  <span className="glow-line glow-line-right" />
                  <span className="glow-line glow-line-bottom" />
                  <span className="glow-line glow-line-left" />
                </button>

                {coupon && (
                  <button
                    onClick={() => {
                      if (creatingFree || validating || validatingCoupon) return;
                      setCoupon(null);
                      setCouponInput("");
                      setCouponError("");
                    }}
                    disabled={creatingFree || checkingCode || !!lockedProvider}
                    className="text-xs text-ink-secondary underline underline-offset-2"
                  >
                    Remove coupon
                  </button>
                )}
              </div>
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
                <button
                  type="button"
                  onClick={handleChangePaymentMethod}
                  disabled={cancellingPayment || paymentStatusBusy}
                  className="shrink-0 rounded-md border border-line-input bg-surface-input px-3 py-2 text-xs font-semibold text-ink hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-border disabled:cursor-wait disabled:opacity-60"
                >
                  {cancellingPayment ? "Checking payment..." : "Change payment method"}
                </button>
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
                disabled={creatingFree || validating || validatingCoupon || quoteLoading || !quoteFingerprint || otherCheckoutStarting("free")}
                className="glow-button px-4 py-3 rounded-lg text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {creatingFree ? "Confirming..." : "Confirm Free Booking"}
                <span className="glow-line glow-line-top" />
                <span className="glow-line glow-line-right" />
                <span className="glow-line glow-line-bottom" />
                <span className="glow-line glow-line-left" />
              </button>
            </div>
          ) : (
            <>
              {providerConfig.dodo?.enabled && (
                <div>
                <div className="low-perf-surface glass-premium glass-card-surface mt-6 flex flex-col items-center justify-between gap-4 rounded-xl border border-line-input px-4 py-4 md:flex-row">
                  <div className="grid w-full min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-center gap-3">
                    <div className="flex h-8 w-20 items-center justify-center text-ink" aria-hidden="true">
                      <WalletCards size={36} strokeWidth={1.5} />
                    </div>
                    <p className="text-xs font-medium text-ink-secondary sm:text-sm">
                      {finalAmount >= 50.01 ? "Cards, crypto & Klarna" : "Cards & crypto"}
                    </p>
                  </div>
                  <div className="flex w-full shrink-0 flex-col gap-2 md:w-52">
                    <button type="button" onClick={handleDodoCheckout}
                      disabled={!canSubmitBooking || payingDodo || paymentStatusBusy || cancellingPayment || quoteLoading || !quoteFingerprint || !providerIsAvailableForSession("dodo") || otherCheckoutStarting("dodo")}
                      className="glow-button inline-flex h-11 w-full items-center justify-center whitespace-nowrap rounded-lg px-4 text-sm font-semibold disabled:opacity-60">
                      {payingDodo ? "Opening checkout..." : lockedProvider === "dodo" ? "Resume checkout" : "Pay your way"}
                    </button>
                    {lockedProvider === "dodo" && (
                      <button type="button" disabled={paymentStatusBusy || cancellingPayment}
                        className="rounded-md px-3 py-2 text-xs font-semibold text-ink-muted hover:text-ink disabled:opacity-60"
                        onClick={() => finalizeSessionCheckout({ paymentAccessToken: paymentSession.paymentAccessToken, providerData: {} }).catch((error) => showBanner("error", error?.message || "Unable to load payment status. Please try again."))}>
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
                    paymentStatusBusy ||
                    quoteLoading ||
                    !quoteFingerprint ||
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
                  <span className="glow-line glow-line-top" />
                  <span className="glow-line glow-line-right" />
                  <span className="glow-line glow-line-bottom" />
                  <span className="glow-line glow-line-left" />
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
                      <PayPalScriptProvider
                        options={{
                          "client-id": paypalClientId,
                          currency: "USD",
                          intent: "capture",
                        }}
                      >
                        <PayPalCheckout>
                          <PayPalButtons
                          fundingSource="paypal"
                          disabled={
                            paymentStatusBusy ||
                            quoteLoading ||
                            !quoteFingerprint ||
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
                            if (!createPaymentOperation().current()) return actions?.reject ? actions.reject() : false;
                            if (otherCheckoutStarting("paypal")) return actions?.reject ? actions.reject() : false;
                            if (!ensureSlotBeforeAction()) {
                              return actions?.reject ? actions.reject() : false;
                            }
                            return actions?.resolve ? actions.resolve() : true;
                          }}
                          createOrder={async () => {
                            const session = await startSessionCheckout("paypal");
                            if (session?.terminal) {
                              throw new Error("This payment is already complete.");
                            }
                            return session?.providerPayload?.orderId || "";
                          }}
                          onApprove={async (data, actions) => {
                            const activeSession = getActivePaymentSession("paypal");
                            const operation = createPaymentOperation(activeSession?.paymentAccessToken);
                            if (!operation.current()) return;
                            if (!ensureSlotBeforeAction()) return;
                            try {
                              const details = await actions.order.capture();
                              await finalizeSessionCheckout({
                                operation,
                                captured: true,
                                paymentAccessToken: String(
                                  activeSession?.paymentAccessToken || ""
                                ).trim(),
                                providerData: {
                                  paypalOrderId:
                                    details?.id || data?.orderID || "",
                                  payerEmail:
                                    details?.payer?.email_address || "",
                                },
                              });
                            } catch {
                              if (!operation.current()) return;
                              console.error("PayPal booking finalization failed");
                              showBanner(
                                "error",
                                "Payment succeeded but something went wrong saving your booking. Please contact support."
                              );
                            }
                          }}
                          onError={() => {
                            if (!createPaymentOperation().current()) return;
                            console.error("PayPal checkout failed");
                            showBanner(
                              "error",
                              "This payment method could not process your payment. Please try again."
                            );
                          }}
                          onCancel={() => {
                            if (!createPaymentOperation().current()) return;
                            showBanner(
                              "info",
                              "Checkout closed. Your payment session is still reserved for PayPal."
                            );
                          }}
                          />
                        </PayPalCheckout>
                      </PayPalScriptProvider>
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
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>
        </motion.div>
      )}
    </motion.section>
  );
}
