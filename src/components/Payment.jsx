import React, { useState, useMemo, useEffect, useRef } from "react";
import { useLocation, Link, useNavigate } from "react-router-dom";
import { PayPalScriptProvider, PayPalButtons } from "@paypal/react-paypal-js";
import { motion } from "framer-motion";
import packagePricing from "../lib/packagePricing";

const { applyPackagePricing } = packagePricing;
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
    return "--";
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
    return "--";
  }
};

const toMoney = (value) => {
  const parsed = Number(
    typeof value === "string" ? value.replace(/[^0-9.]/g, "") : value
  );
  if (!Number.isFinite(parsed)) return 0;
  return +parsed.toFixed(2);
};

const getCouponDiscountType = (coupon) =>
  String(coupon?.discountType || "").trim().toLowerCase() === "fixed"
    ? "fixed"
    : "percent";

const getCouponDiscountValue = (coupon) =>
  getCouponDiscountType(coupon) === "fixed"
    ? toMoney(coupon?.discountAmount || 0)
    : toMoney(coupon?.discountPercent || 0);

const getCouponDiscountAmount = (coupon, baseAmount) => {
  if (!coupon || baseAmount <= 0) return 0;
  const discountType = getCouponDiscountType(coupon);
  const rawAmount =
    discountType === "fixed"
      ? getCouponDiscountValue(coupon)
      : baseAmount * (getCouponDiscountValue(coupon) / 100);
  return Math.min(baseAmount, toMoney(rawAmount));
};

const formatCouponValue = (coupon) => {
  if (getCouponDiscountType(coupon) === "fixed") {
    return `$${getCouponDiscountValue(coupon).toFixed(2)} off`;
  }
  return `${getCouponDiscountValue(coupon)}% off`;
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

export default function Payment({ hideFooter = false }) {
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

  const REFERRAL_STORAGE_KEY = "referral_session";
  const FLOW_BACKGROUND_KEY = "flow_background_location";
  const BOOKING_CONFIRMATION_STORAGE_KEY = "booking_confirmation_state";
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

  const readStoredReferral = () => {
    try {
      return sessionStorage.getItem(REFERRAL_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  };

  const writeStoredReferral = (code) => {
    try {
      if (code) {
        sessionStorage.setItem(REFERRAL_STORAGE_KEY, code);
      } else {
        sessionStorage.removeItem(REFERRAL_STORAGE_KEY);
      }
    } catch {}
  };

  const writeStoredBookingConfirmation = (confirmation) => {
    try {
      if (!confirmation?.bookingId || !confirmation?.emailDispatchToken) {
        sessionStorage.removeItem(BOOKING_CONFIRMATION_STORAGE_KEY);
        return;
      }

      sessionStorage.setItem(
        BOOKING_CONFIRMATION_STORAGE_KEY,
        JSON.stringify({
          bookingId: confirmation.bookingId,
          emailDispatchToken: confirmation.emailDispatchToken,
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
    try {
      if (!session?.paymentAccessToken || !session?.provider || !session?.fingerprint) {
        sessionStorage.removeItem(PAYMENT_SESSION_STORAGE_KEY);
        return;
      }
      sessionStorage.setItem(PAYMENT_SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {}
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
    const baseState = getModalFlowState();
    const bookingId = String(responseBody?.bookingId || "").trim();
    const emailDispatchToken = String(
      responseBody?.emailDispatchToken || ""
    ).trim();

    writeStoredCheckout(null);
    try {
      sessionStorage.removeItem("my_slot_hold");
      window.dispatchEvent(new CustomEvent("hold-state", { detail: null }));
    } catch {}

    if (!bookingId || !emailDispatchToken) {
      writeStoredBookingConfirmation(null);
      return baseState;
    }

    const bookingConfirmation = {
      bookingId,
      emailDispatchToken,
    };

    writeStoredBookingConfirmation(bookingConfirmation);
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
    backgroundLocation: modalBackground || location,
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
  const hasSlotHold =
    !!(sessionHold?.slotHoldId || bookingData?.slotHoldId) &&
    !!(sessionHold?.slotHoldToken || bookingData?.slotHoldToken) &&
    !holdExpired;
  const canSubmitBooking = isUpgrade ? hasTimeslot : hasTimeslot && hasSlotHold;
  const holdExpiryHandledRef = useRef(false);

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
  const packagePrice = bookingData.packagePrice || "$0";
  const parsedUtc = bookingData.startTimeUTC
    ? new Date(bookingData.startTimeUTC)
    : null;

  const utcStart =
    parsedUtc && !isNaN(parsedUtc.getTime()) ? parsedUtc : null;

  const userTimeZone = bookingData.localTimeZone || browserTimeZone;

  const date =
    bookingData.displayDate ||
    (utcStart ? formatLocalDate(utcStart, userTimeZone) : "--");
  const time =
    bookingData.displayTime ||
    (utcStart ? formatLocalTime(utcStart, userTimeZone) : "--");
  const baseAmount =
    parseFloat(String(packagePrice).replace(/[^0-9.]/g, "")) || 0;

  const [referralInput, setReferralInput] = useState("");
  const [referral, setReferral] = useState(null);
  const [validating, setValidating] = useState(false);

  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState(null);
  const [validatingCoupon, setValidatingCoupon] = useState(false);

  const [banner, setBanner] = useState(null);
  const [serverQuote, setServerQuote] = useState(null);
  const [quoteFingerprint, setQuoteFingerprint] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);

  const showBanner = (type, text) => {
    setBanner({ type, text });
    setTimeout(() => {
      setBanner((prev) => (prev?.text === text ? null : prev));
    }, 4000);
  };

  useEffect(() => {
    if (!holdExpiresAt) return;
    const expiresAtMs = new Date(holdExpiresAt).getTime();
    if (!Number.isFinite(expiresAtMs)) return;

    const triggerExpiry = () => {
      if (holdExpiryHandledRef.current) return;
      holdExpiryHandledRef.current = true;
      showBanner(
        "error",
        "Your reserved slot expired. Please select a new time before completing your booking."
      );
      navigate("/booking", {
        state: {
          backgroundLocation: navState.backgroundLocation || location,
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
  }, [holdExpiresAt, navigate, navState, location]);

  const referralPercent = referral?.currentDiscountPercent || 0;
  const couponDiscountAmount = getCouponDiscountAmount(coupon, baseAmount);
  const canStackCouponWithReferral =
    coupon?.canCombineWithReferral === true || false;

  let referralDiscountAmount = 0;

  if (baseAmount > 0) {
    if (referralPercent > 0) {
      const referralBase =
        coupon && canStackCouponWithReferral
          ? Math.max(0, baseAmount - couponDiscountAmount)
          : baseAmount;
      referralDiscountAmount = +(
        referralBase *
        (referralPercent / 100)
      ).toFixed(2);
    }
  }

  const canApplyCouponWithReferral =
    !(coupon && referral && !canStackCouponWithReferral);
  const uncappedTotalDiscount = canApplyCouponWithReferral
    ? +((referralDiscountAmount || 0) + (couponDiscountAmount || 0)).toFixed(2)
    : Math.max(referralDiscountAmount || 0, couponDiscountAmount || 0);

  const totalDiscountAmount =
    baseAmount > 0 ? Math.min(baseAmount, uncappedTotalDiscount) : 0;

  const rawFinalAmount = Math.max(
    0,
    +(baseAmount - totalDiscountAmount).toFixed(2)
  );

  const hasFreeCoupon = !!coupon && couponDiscountAmount >= baseAmount;
  const clientIsFree = hasFreeCoupon && rawFinalAmount === 0;
  const isFree =
    typeof serverQuote?.isFree === "boolean"
      ? serverQuote.isFree
      : clientIsFree;
  const preventedFreeReduction =
    !clientIsFree && rawFinalAmount === 0 && baseAmount > 0;
  const minPayable = 0.01;

  const quotedNetAmount = Number(serverQuote?.netAmount);
  const finalAmount = Number.isFinite(quotedNetAmount)
    ? Math.max(0, quotedNetAmount)
    : isFree
      ? 0
      : Math.max(minPayable, rawFinalAmount);

  const effectiveDiscountAmount = preventedFreeReduction
    ? +(baseAmount - finalAmount).toFixed(2)
    : totalDiscountAmount;

  const discountPercentCombined = preventedFreeReduction
    ? +((effectiveDiscountAmount / baseAmount) * 100 || 0).toFixed(2)
    : baseAmount > 0
    ? +((totalDiscountAmount / baseAmount) * 100 || 0).toFixed(2)
    : 0;

  const [rzpReady, setRzpReady] = useState(false);
  const [payingRzp, setPayingRzp] = useState(false);
  const [providerConfig, setProviderConfig] = useState({
    razorpay: { enabled: false, mode: "unknown", disabledReason: "" },
    paypal: { enabled: false, mode: "unknown", clientId: "" },
  });
  const [showInternalPayments, setShowInternalPayments] = useState(false);
  const [paymentSession, setPaymentSession] = useState(null);
  const [paymentStatusBusy, setPaymentStatusBusy] = useState(false);
  const [cancellingPayment, setCancellingPayment] = useState(false);
  const sessionStartRef = useRef(null);
  const lockedProvider = String(paymentSession?.provider || "").trim();
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
  const shouldRenderPaypalBlock =
    !!providerConfig?.paypal?.enabled || showInternalPayments;
  const canDisplayPaypalMethod = shouldRenderPaypalBlock && canUsePaypal;

  const [creatingFree, setCreatingFree] = useState(false);

  const buildCheckoutPayload = () => ({
    ...bookingData,
    packageTitle,
    packagePrice,
    email: bookingData.email || "",
    localTimeZone: userTimeZone,
    displayDate: date,
    displayTime: time,
    referralCode: referral?.code || referralInput || "",
    referralId: referral?._id || "",
    couponCode: coupon?.code || couponInput || "",
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
        referralCode: referral?.code || referralInput || "",
        couponCode: coupon?.code || couponInput || "",
      }),
    [
      packageTitle,
      bookingData.originalOrderId,
      bookingData.startTimeUTC,
      bookingData.email,
      referral?.code,
      referralInput,
      coupon?.code,
      couponInput,
    ]
  );

  useEffect(() => {
    if (!packageTitle) {
      setServerQuote(null);
      setQuoteFingerprint("");
      return;
    }

    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
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
        referralId: referral?._id || "",
        referralCode: referral?.code || referralInput || "",
        couponCode: coupon?.code || couponInput || "",
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
          setProviderConfig((current) => ({ ...current, ...data.providers }));
        }
      })
      .catch((error) => {
        if (!active || error?.name === "AbortError") return;
        setServerQuote(null);
        setQuoteFingerprint("");
        showBanner("error", error?.message || "Unable to confirm checkout price.");
      })
      .finally(() => {
        if (active) setQuoteLoading(false);
      });

    return () => {
      active = false;
      controller?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    packageTitle,
    bookingData.originalOrderId,
    bookingData.upgradeIntentToken,
    referral?._id,
    referral?.code,
    referralInput,
    coupon?.code,
    couponInput,
  ]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get("ref");

    if (fromUrl) {
      writeStoredReferral(fromUrl);
      setReferralInput(fromUrl);
      validateReferral(fromUrl);
      return;
    }

    const stored = readStoredReferral();
    if (stored) {
      setReferralInput(stored);
      validateReferral(stored);
    } else {
      writeStoredReferral("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

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
        setProviderConfig({
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

  const clearPaymentSession = () => {
    sessionStartRef.current = null;
    setPaymentSession(null);
    clearStoredPaymentSession();
  };

  const handleChangePaymentMethod = async () => {
    const activeSession = paymentSession || readStoredPaymentSession();
    const paymentAccessToken = String(activeSession?.paymentAccessToken || "").trim();
    if (!paymentAccessToken || cancellingPayment) return;

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
      if (data?.captured) {
        if (["booked", "email_partial"].includes(String(data.status || "").toLowerCase())) {
          navigate("/payment-success", {
            state: buildFinalizeNavigation(data),
            replace: true,
          });
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
        sessionStorage.setItem("my_slot_hold", JSON.stringify(holdState));
        window.dispatchEvent(new CustomEvent("hold-state", { detail: holdState }));
      }
      clearPaymentSession();
      showBanner("success", "Payment method released. Choose PayPal or Razorpay below.");
    } catch (error) {
      showBanner("error", error.message || "The payment method could not be changed.");
    } finally {
      setCancellingPayment(false);
    }
  };

  const buildFinalizeNavigation = (responseBody = {}) => {
    clearPaymentSession();
    return buildConfirmationNavigationState(responseBody);
  };

  const fetchJson = async (url, options = {}) => {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };

  const pollPaymentUntilTerminal = async (paymentAccessToken) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 90000) {
      const { response, data } = await fetchJson(
        "/api/payment/status",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paymentAccessToken}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        }
      );

      if (!response.ok) {
        throw new Error(data?.error || "Unable to load payment status.");
      }

      const nextStatus = String(data?.status || "").trim().toLowerCase();
      if (
        nextStatus === "booked" ||
        nextStatus === "email_partial" ||
        nextStatus === "refunded" ||
        nextStatus === "failed" ||
        nextStatus === "abandoned"
      ) {
        return data;
      }

      await new Promise((resolve) => setTimeout(resolve, 2500));
    }

    throw new Error("Timed out waiting for payment confirmation.");
  };

  const startSessionCheckout = async (provider) => {
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
      const resumedStatus = String(data?.status || "").trim().toLowerCase();
      if (
        response.ok &&
        (resumedStatus === "booked" || resumedStatus === "email_partial")
      ) {
        navigate("/payment-success", {
          state: buildFinalizeNavigation(data),
          replace: true,
        });
        return { ...paymentSession, result: data, terminal: true };
      }
      if (
        response.ok &&
        ["refunded", "failed", "abandoned"].includes(resumedStatus)
      ) {
        clearPaymentSession();
        throw new Error(
          data?.recoveryReason || "This payment session is no longer payable."
        );
      }
      return paymentSession;
    }

    if (sessionStartRef.current?.provider === provider) {
      return sessionStartRef.current.promise;
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
          sessionStorage.setItem("my_slot_hold", JSON.stringify(holdState));
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
        navigate("/payment-success", {
          state: buildFinalizeNavigation(data),
          replace: true,
        });
        return { ...nextSession, terminal: true };
      }
      if (provider !== "free") persistPaymentSession(nextSession);
      return nextSession;
    })();

    sessionStartRef.current = { provider, promise };

    try {
      return await promise;
    } finally {
      sessionStartRef.current = null;
    }
  };

  const finalizeSessionCheckout = async ({ paymentAccessToken, providerData }) => {
    setPaymentStatusBusy(true);
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

      const status = String(data?.status || "").trim().toLowerCase();
      const isFinalizedStatus = status === "booked" || status === "email_partial";

      if (!response.ok && response.status !== 202 && !isFinalizedStatus) {
        throw new Error(data?.error || "Unable to finalize payment.");
      }

      if (isFinalizedStatus) {
        navigate("/payment-success", {
          state: buildFinalizeNavigation(data),
          replace: true,
        });
        return data;
      }

      if (
        status === "needs_recovery" ||
        status === "finalizing" ||
        status === "started"
      ) {
        showBanner("info", "Finalizing your payment and booking...");
        const settled = await pollPaymentUntilTerminal(paymentAccessToken);
        const settledStatus = String(settled?.status || "").trim().toLowerCase();
        if (settledStatus === "booked" || settledStatus === "email_partial") {
          navigate("/payment-success", {
            state: buildFinalizeNavigation(settled),
            replace: true,
          });
          return settled;
        }

        clearPaymentSession();
        throw new Error(
          settled?.recoveryReason ||
            settled?.error ||
            "Payment could not be finalized."
        );
      }

      clearPaymentSession();
      throw new Error(
        data?.recoveryReason || data?.error || "Payment finalization failed."
      );
    } finally {
      setPaymentStatusBusy(false);
    }
  };

  async function validateReferral(code) {
    if (!code) {
      setReferral(null);

      return;
    }
    try {
      setValidating(true);
      const r = await fetch(
        `/api/ref/validateReferral?code=${encodeURIComponent(code)}`
      );
      const data = await r.json();
      if (data.ok && data.referral) {
        setReferral(data.referral);

        writeStoredReferral(data.referral.code || "");

        if (
          coupon &&
          coupon.canCombineWithReferral === false &&
          data.referral
        ) {
          setCoupon(null);
          setCouponInput("");
          showBanner(
            "info",
            "Current coupon can't be combined with referrals and was removed."
          );
        }
      } else {
        setReferral(null);
        writeStoredReferral("");
        showBanner("error", "Invalid or inactive referral code.");
      }
    } catch {
      console.error("Referral validation failed");
      setReferral(null);
      writeStoredReferral("");
      showBanner(
        "error",
        "We couldn't validate that referral code. Please try again."
      );
    } finally {
      setValidating(false);
    }
  }

  async function validateCoupon(code) {
    if (!code) {
      setCoupon(null);
      return;
    }
    try {
      setValidatingCoupon(true);
      const r = await fetch(
        `/api/ref/validateCoupon?code=${encodeURIComponent(
          code
        )}&packageTitle=${encodeURIComponent(packageTitle)}`
      );
      const data = await r.json();
      if (data.ok && data.coupon) {
        if (data.coupon.canCombineWithReferral === false && referral) {
          setCoupon(null);
          showBanner(
            "error",
            "This coupon can't be used together with a referral discount. Remove the referral or use a different coupon."
          );
          return;
        }

        setCoupon(data.coupon);
        showBanner(
          "success",
          `Coupon applied: ${formatCouponValue(data.coupon)}`
        );
      } else {
        setCoupon(null);
        showBanner("error", data.error || "Invalid coupon code.");
      }
    } catch {
      console.error("Coupon validation failed");
      setCoupon(null);
      showBanner(
        "error",
        "We couldn't validate that coupon code. Please try again."
      );
    } finally {
      setValidatingCoupon(false);
    }
  }

  async function handleFreeBooking() {
    if (!isFree) return;
    if (!ensureSlotBeforeAction()) return;

    try {
      setCreatingFree(true);
      showBanner("info", "Confirming your free booking...");
      const session = await startSessionCheckout("free");
      const data = session?.result || {};
      const status = String(data.status || "").trim().toLowerCase();
      if (!data.bookingId || (status !== "booked" && status !== "email_partial")) {
        throw new Error(data.error || "Could not save your free booking.");
      }

      navigate("/thank-you", {
        state: buildConfirmationNavigationState(data),
        replace: true,
      });
    } catch (err) {
      console.error("Free booking failed");
      showBanner(
        "error",
        err?.message ||
          "Something went wrong saving your free booking. Please contact support."
      );
    } finally {
      setCreatingFree(false);
    }
  }
  async function handleRazorpayPay() {
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

      const razorpaySession = await startSessionCheckout("razorpay");
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
          try {
            await finalizeSessionCheckout({
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
            console.error("Razorpay booking finalization failed");
            showBanner(
              "error",
              "Payment succeeded but something went wrong saving your booking. Please contact support."
            );
          }
        },

        modal: {
          ondismiss: function () {
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
      console.error("Razorpay checkout failed");
      showBanner(
        "error",
        err?.message || "Payment could not be processed. Please try again."
      );
    } finally {
      setPayingRzp(false);
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
      className="relative z-10 py-4 md:py-32 px-6 max-w-3xl mx-auto text-ink"
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
            className={`mt-6 rounded-xl border px-4 py-3 text-sm flex items-center gap-3 shadow-[0_0_25px_rgba(15,23,42,0.8)] ${
              banner.type === "error"
                ? "border-danger-border bg-danger-soft text-danger-text"
                : banner.type === "success"
                ? "border-success-border bg-success-soft text-success-text"
                : "border-info-border bg-info-soft text-info-text"
            }`}
          >
            <span className="text-lg">
              {banner.type === "error"
                ? "!"
                : banner.type === "success"
                ? "OK"
                : "i"}
            </span>
            <p className="flex-1">{banner.text}</p>
            <button
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

          <div className="mt-6">
            <p className="font-semibold text-lg text-ink">{packageTitle}</p>
            <div className="mt-2 space-y-1">
              {(referralPercent > 0 || couponDiscountAmount > 0) && (
                <p className="text-xl text-ink-secondary line-through">
                  ${baseAmount.toFixed(2)}
                </p>
              )}
              <p className="text-3xl font-extrabold text-accent">
                ${finalAmount.toFixed(2)} USD
              </p>
              <p className="text-xs text-ink-muted">
                {quoteLoading
                  ? "Confirming the current price..."
                  : quoteFingerprint
                    ? "Current total confirmed securely by Roo Industries."
                    : "Price confirmation is unavailable. Payment is disabled."}
              </p>

              {referralPercent > 0 && (
                <p className="text-sm text-success-text">
                  Referral: {referralPercent}% ($
                  {referralDiscountAmount.toFixed(2)}
                  {referral?.name ? ` via ${referral.name}` : ""})
                </p>
              )}
              {couponDiscountAmount > 0 && coupon && (
                <p className="text-sm text-success-text">
                  Coupon "{coupon.code}": {formatCouponValue(coupon)} ($
                  {couponDiscountAmount.toFixed(2)})
                  {canStackCouponWithReferral && referralPercent > 0
                    ? " (stacked with referral)"
                    : ""}
                </p>
              )}
              {effectiveDiscountAmount > 0 && (
                <p className="text-xs text-ink-secondary">
                  Total savings: {discountPercentCombined}% (${effectiveDiscountAmount.toFixed(2)})
                </p>
              )}

              <p className="text-sm text-ink-muted mt-1">
                Your time: <span className="text-accent">{date}</span> at{" "}
                <span className="text-accent">{time}</span>
              </p>
              {userTimeZone && (
                <p className="text-xs text-ink-muted">
                  Time zone:{" "}
                  <span className="text-ink-secondary">{userTimeZone}</span>
                </p>
              )}

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
              <label className="block text-sm font-semibold mb-1">
                Referral Code (optional)
              </label>
              <div className="flex flex-wrap gap-2 items-center">
                <input
                  value={referralInput}
                  onChange={(e) => setReferralInput(e.target.value.trim())}
                  disabled={!!lockedProvider}
                  placeholder="e.g. vouch"
                  className="w-60 bg-surface-input border border-line-input rounded-md px-3 py-2 outline-none text-sm disabled:opacity-60"
                />

                <button
                  onClick={() => validateReferral(referralInput)}
                  disabled={validating || !!lockedProvider}
                  className="glow-button px-3 py-2 rounded-md font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60 text-sm"
                >
                  {validating ? "Checking..." : "Apply"}
                  <span className="glow-line glow-line-top" />
                  <span className="glow-line glow-line-right" />
                  <span className="glow-line glow-line-bottom" />
                  <span className="glow-line glow-line-left" />
                </button>
              </div>
              {referralInput && !referral && !validating && (
                <p className="text-sm text-danger-text mt-2">
                  Invalid or inactive referral code.
                </p>
              )}
            </div>


            <div className="mt-5">
              <label className="block text-sm font-semibold mb-1">
                Coupon Code (optional)
              </label>
              <div className="flex flex-wrap gap-2 items-center">
                <input
                  value={couponInput}
                  onChange={(e) => setCouponInput(e.target.value.trim())}
                  disabled={!!lockedProvider}
                  placeholder="e.g. BF10"
                  className="w-60 bg-surface-input border border-line-input rounded-md px-3 py-2 outline-none text-sm disabled:opacity-60"
                />

                <button
                  onClick={() => validateCoupon(couponInput)}
                  disabled={validatingCoupon || !!lockedProvider}
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
                      setCoupon(null);
                      setCouponInput("");
                    }}
                    disabled={!!lockedProvider}
                    className="text-xs text-ink-secondary underline underline-offset-2"
                  >
                    Remove coupon
                  </button>
                )}
              </div>
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
                  This checkout is reserved with {lockedProvider === "paypal" ? "PayPal" : "Razorpay"}. Pricing and provider selection are locked for this session. Finish it or safely release this payment method before choosing another.
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
              : "Secure online payment checkout"}
          </p>


          {isFree ? (
            <div className="mt-6 flex flex-col gap-4 border border-success-border bg-success-soft rounded-xl px-5 py-4 shadow-[0_0_25px_rgba(16,185,129,0.35)]">
              <p className="text-sm text-success-text">
                No payment is required. Click the button below to confirm your
                free booking.
              </p>
              <button
                onClick={handleFreeBooking}
                disabled={creatingFree || quoteLoading || !quoteFingerprint}
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

              <div
                className={`low-perf-surface glass-premium glass-card-surface mt-6 flex flex-col items-center justify-between gap-4 rounded-xl border px-5 py-4 sm:flex-row ${
                  razorpayTemporarilyDisabled
                    ? "border-warning-border bg-warning-soft"
                    : "border-line-input"
                }`}
              >
                <div className="flex items-center gap-4">
                  <img
                    src="https://razorpay.com/assets/razorpay-logo.svg"
                    alt="Razorpay payment logo"
                    width={120}
                    height={24}
                    decoding="async"
                    className="h-5 w-auto"
                  />
                  <div>
                    <p className="text-ink-secondary text-sm font-medium">
                      {razorpayTemporarilyDisabled
                        ? "Razorpay temporarily unavailable"
                        : "Razorpay Secure Checkout"}
                    </p>
                    <p className="text-ink-muted text-xs">
                      {razorpayTemporarilyDisabled
                        ? "Please use PayPal while we update the merchant display name."
                        : "Cards, UPI, wallets, and local methods"}
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
                    !providerIsAvailableForSession("razorpay")
                  }
                  className="glow-button px-4 py-2 rounded-lg text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60"
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
              {razorpayTemporarilyDisabled ? (
                <p
                  role="status"
                  className="mt-2 rounded-lg border border-warning-border bg-warning-soft px-4 py-3 text-sm font-medium text-warning-text"
                >
                  Razorpay is temporarily unavailable while we update the merchant
                  display name. Please use PayPal for now.
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
                <div className="low-perf-surface glass-premium glass-card-surface mt-4 flex flex-col sm:flex-row items-center justify-between gap-4 rounded-xl border border-line-input px-5 py-4">
                  <div className="flex items-center gap-4">
                    <img
                      src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-100px.png"
                      alt="PayPal payment logo"
                      width={100}
                      height={26}
                      decoding="async"
                      className="w-20"
                    />
                    <p className="text-ink-secondary text-sm font-medium hidden sm:block">
                      Secure global payment
                    </p>
                  </div>

                  <div className="paypal-checkout-shell relative z-0 w-full overflow-hidden rounded-lg bg-transparent sm:w-48 [&_iframe]:!border-0 [&_iframe]:!bg-transparent [&_iframe]:!outline-none [&_iframe]:!shadow-none">
                    {canDisplayPaypalMethod ? (
                      <PayPalScriptProvider
                        options={{
                          "client-id": paypalClientId,
                          currency: "USD",
                          intent: "capture",
                        }}
                      >
                        <PayPalButtons
                          fundingSource="paypal"
                          disabled={
                            paymentStatusBusy ||
                            quoteLoading ||
                            !quoteFingerprint ||
                            !providerIsAvailableForSession("paypal")
                          }
                          style={{
                            layout: "horizontal",
                            color: "blue",
                            shape: "rect",
                            label: "pay",
                            height: 40,
                            tagline: false,
                          }}
                          onClick={(data, actions) => {
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
                            if (!ensureSlotBeforeAction()) return;
                            const details = await actions.order.capture();

                            try {
                              const activeSession =
                                getActivePaymentSession("paypal");
                              await finalizeSessionCheckout({
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
                              console.error("PayPal booking finalization failed");
                              showBanner(
                                "error",
                                "Payment succeeded but something went wrong saving your booking. Please contact support."
                              );
                            }
                          }}
                          onError={() => {
                            console.error("PayPal checkout failed");
                            showBanner(
                              "error",
                              "This payment method could not process your payment. Please try again."
                            );
                          }}
                          onCancel={() => {
                            showBanner(
                              "info",
                              "Checkout closed. Your payment session is still reserved for PayPal."
                            );
                          }}
                        />
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
          className="mt-10 flex justify-center pb-36 sm:pb-40"
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
