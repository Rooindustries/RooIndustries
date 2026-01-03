import React, { useState, useMemo, useEffect, useRef } from "react";
import { useLocation, Link, useNavigate } from "react-router-dom";
import { PayPalScriptProvider, PayPalButtons } from "@paypal/react-paypal-js";
import { motion } from "framer-motion";
import { deriveSlotLabels, HOST_TZ_NAME } from "../utils/timezone";

export default function Payment({ hideFooter = false }) {
  const location = useLocation();
  const q = new URLSearchParams(location.search);
  const navigate = useNavigate();

  const REFERRAL_STORAGE_KEY = "referral_session";

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

  const bookingData = useMemo(() => {
    try {
      return JSON.parse(q.get("data") || "{}");
    } catch {
      return {};
    }
  }, [q]);

  const isUpgrade = !!bookingData.originalOrderId;
  const navState = location.state || (window.history?.state?.usr ?? {});

  const isModalMode = !!navState.backgroundLocation || navState.modal === true;
  const hideFooterEffective = hideFooter || isModalMode;

  const getModalFlowState = () => {
    if (!isModalMode) return undefined;
    return {
      backgroundLocation:
        navState.backgroundLocation || { pathname: "/", search: "", hash: "" },
      modal: true,
    };
  };

  const backToBookingState = {
    backgroundLocation: navState.backgroundLocation || location,
    modal: true,
    ...navState,
  };

  const hasTimeslot =
    !!bookingData?.hostDate &&
    !!bookingData?.hostTime &&
    !!bookingData?.startTimeUTC &&
    !!bookingData?.displayDate &&
    !!bookingData?.displayTime;
  const holdExpiresAt = bookingData?.slotHoldExpiresAt;
  const holdExpired =
    holdExpiresAt && new Date(holdExpiresAt).getTime() <= Date.now();
  const hasSlotHold = !!bookingData?.slotHoldId && !holdExpired;
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

  const userTimeZone =
    bookingData.localTimeZone ||
    (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      } catch {
        return "UTC";
      }
    })();

  const hostTimeZone = bookingData.hostTimeZone || HOST_TZ_NAME;

  const slotLabels = utcStart
    ? deriveSlotLabels(utcStart, userTimeZone, hostTimeZone)
    : null;

  const date =
    slotLabels?.localDateLabel || bookingData.displayDate || "--";
  const time =
    slotLabels?.localTimeLabel || bookingData.displayTime || "--";
  const hostDate =
    slotLabels?.hostDateLabel ||
    bookingData.hostDate ||
    bookingData.date ||
    bookingData.displayDate ||
    "--";
  const hostTime =
    bookingData.hostTime ||
    slotLabels?.hostTimeLabel ||
    bookingData.time ||
    bookingData.displayTime ||
    "--";
  const crossesDateBoundary =
    slotLabels?.crossesDateBoundary && date !== "--" && hostDate !== "--";
  const baseAmount =
    parseFloat(String(packagePrice).replace(/[^0-9.]/g, "")) || 0;

  // Referral state
  const [referralInput, setReferralInput] = useState("");
  const [referral, setReferral] = useState(null);
  const [validating, setValidating] = useState(false);

  // Coupon state
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState(null);
  const [validatingCoupon, setValidatingCoupon] = useState(false);

  const [banner, setBanner] = useState(null);

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

    if (expiresAtMs <= Date.now()) {
      triggerExpiry();
      return;
    }

    const timeoutId = setTimeout(triggerExpiry, expiresAtMs - Date.now());
    return () => clearTimeout(timeoutId);
  }, [holdExpiresAt, navigate, navState, location]);

  // Referral discount
  const referralPercent = referral?.currentDiscountPercent || 0;
  const commissionPercent = referral?.currentCommissionPercent || 0;

  // Coupon discount
  const couponPercent = coupon?.discountPercent || 0;
  const canStackCouponWithReferral =
    coupon?.canCombineWithReferral === true || false;

  // Compute discount breakdown
  let referralDiscountAmount = 0;
  let couponDiscountAmount = 0;

  if (baseAmount > 0) {
    if (referralPercent > 0) {
      referralDiscountAmount = +(baseAmount * (referralPercent / 100)).toFixed(
        2
      );
    }

    if (couponPercent > 0 && coupon) {
      if (canStackCouponWithReferral && referralPercent > 0) {
        couponDiscountAmount = +(baseAmount * (couponPercent / 100)).toFixed(2);
      } else {
        couponDiscountAmount = +(baseAmount * (couponPercent / 100)).toFixed(2);
      }
    }
  }

  const uncappedTotalDiscount = +(
    (referralDiscountAmount || 0) + (couponDiscountAmount || 0)
  ).toFixed(2);

  const totalDiscountAmount =
    baseAmount > 0 ? Math.min(baseAmount, uncappedTotalDiscount) : 0;

  const rawFinalAmount = Math.max(
    0,
    +(baseAmount - totalDiscountAmount).toFixed(2)
  );

  const hasFreeCoupon = coupon?.discountPercent === 100;
  const isFree = hasFreeCoupon && rawFinalAmount === 0;
  const preventedFreeReduction =
    !isFree && rawFinalAmount === 0 && baseAmount > 0;
  const minPayable = 0.01;

  const finalAmount = isFree ? 0 : Math.max(minPayable, rawFinalAmount);

  const effectiveDiscountAmount = preventedFreeReduction
    ? +(baseAmount - finalAmount).toFixed(2)
    : totalDiscountAmount;

  const discountPercentCombined = preventedFreeReduction
    ? +((effectiveDiscountAmount / baseAmount) * 100 || 0).toFixed(2)
    : baseAmount > 0
    ? +((totalDiscountAmount / baseAmount) * 100 || 0).toFixed(2)
    : 0;

  // Razorpay state
  const [rzpReady, setRzpReady] = useState(false);
  const [payingRzp, setPayingRzp] = useState(false);
  const paypalClientId = process.env.REACT_APP_PAYPAL_CLIENT_ID || "";
  const hasPaypalClientId = !!paypalClientId;

  // Free booking state
  const [creatingFree, setCreatingFree] = useState(false);

  // Auto-load referral
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

  // Load Razorpay checkout script
  useEffect(() => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----------------- REFERRAL VALIDATION -----------------
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
    } catch (e) {
      console.error(e);
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

  // ----------------- COUPON VALIDATION -----------------
  async function validateCoupon(code) {
    if (!code) {
      setCoupon(null);
      return;
    }
    try {
      setValidatingCoupon(true);
      const r = await fetch(
        `/api/ref/validateCoupon?code=${encodeURIComponent(code)}`
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
          `Coupon applied: ${data.coupon.discountPercent}% off`
        );
      } else {
        setCoupon(null);
        showBanner("error", data.error || "Invalid coupon code.");
      }
    } catch (e) {
      console.error(e);
      setCoupon(null);
      showBanner(
        "error",
        "We couldn't validate that coupon code. Please try again."
      );
    } finally {
      setValidatingCoupon(false);
    }
  }

  // ----------------- FREE BOOKING FLOW -----------------
  async function handleFreeBooking() {
    if (!isFree) return;
    if (!ensureSlotBeforeAction()) return;

    try {
      setCreatingFree(true);
      showBanner("info", "Confirming your free booking...");

      const payload = {
        ...bookingData,

        referralCode: referral?.code || referralInput || "",
        referralId: referral?._id || null,

        couponCode: coupon?.code || couponInput || "",
        couponDiscountPercent: couponPercent,
        couponDiscountAmount,

        discountPercent: discountPercentCombined,
        discountAmount: effectiveDiscountAmount,

        grossAmount: baseAmount,
        netAmount: 0,

        commissionPercent,

        status: "captured",
        paymentProvider: "free",
      };

      const res = await fetch("/api/ref/createBooking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const raw = await res.text();
        let errorMessage =
          "Could not save your free booking. Please contact support.";
        try {
          const data = JSON.parse(raw);
          if (data?.error || data?.message) {
            errorMessage = data.error || data.message;
          }
        } catch {
          if (raw) errorMessage = raw;
        }
        if (res.status === 409) {
          errorMessage =
            "Your reserved slot expired. Please select a new time before completing your booking.";
        }
        console.error("Free booking create error:", raw);
        showBanner(
          "error",
          errorMessage
        );
        if (res.status === 409) {
          navigate("/booking", {
            state: backToBookingState,
            replace: true,
          });
        }
        return;
      }

      navigate("/thank-you", {
        state: getModalFlowState(),
        replace: true,
      });
    } catch (err) {
      console.error("Free booking error:", err);
      showBanner(
        "error",
        "Something went wrong saving your free booking. Please contact support."
      );
    } finally {
      setCreatingFree(false);
    }
  }
  // Razorpay payment flow
  async function handleRazorpayPay() {
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
      showBanner("info", "Opening Razorpay checkout...");

      const orderRes = await fetch("/api/razorpay/createOrder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: finalAmount,
          currency: "USD",
          notes: {
            packageTitle,
            date,
            time,
            referralCode: referral?.code || referralInput || "",
            couponCode: coupon?.code || couponInput || "",
          },
        }),
      });

      const orderData = await orderRes.json();

      if (!orderRes.ok || !orderData.ok) {
        console.error("Razorpay order error:", orderData);
        showBanner(
          "error",
          orderData.message ||
            "Couldn't start the payment. Please try again or use PayPal."
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
            const verifyRes = await fetch("/api/razorpay/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(response),
            });

            const verifyData = await verifyRes.json();

            if (!verifyRes.ok || !verifyData.ok) {
              console.error("Razorpay verify failed:", verifyData);
              showBanner(
                "error",
                "Payment verification failed. Please contact support or try another method."
              );
              return;
            }

            const payload = {
              ...bookingData,

              referralCode: referral?.code || referralInput || "",
              referralId: referral?._id || null,

              couponCode: coupon?.code || couponInput || "",
              couponDiscountPercent: couponPercent,
              couponDiscountAmount: couponDiscountAmount,

              discountPercent: discountPercentCombined,
              discountAmount: effectiveDiscountAmount,

              grossAmount: baseAmount,
              netAmount: finalAmount,

              commissionPercent: commissionPercent,

              razorpayOrderId: response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              status: "captured",
              paymentProvider: "razorpay",
            };

            const res = await fetch("/api/ref/createBooking", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });

            if (!res.ok) {
              console.error("Booking create error:", await res.text());
              showBanner(
                "error",
                "Payment succeeded but booking could not be saved. Please contact support with your payment ID."
              );
              return;
            }

            navigate("/payment-success", {
              state: getModalFlowState(),
              replace: true,
            });
          } catch (err) {
            console.error("Razorpay post-payment error:", err);
            showBanner(
              "error",
              "Payment succeeded but something went wrong saving your booking. Please contact support."
            );
          }
        },

        modal: {
          ondismiss: function () {
            showBanner("info", "Payment cancelled before completion.");
          },
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err) {
      console.error("Razorpay error:", err);
      showBanner(
        "error",
        "Payment could not be processed. Please try again or use PayPal."
      );
    } finally {
      setPayingRzp(false);
    }
  }

  // --- ANIMATION CONFIG ---
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1, // Each child appears 0.1s after the prev one
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
    // Converted to motion.section to handle page fade-in
    <motion.section
      className="relative z-10 py-4 md:py-32 px-6 max-w-3xl mx-auto text-white"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <motion.div variants={itemVariants}>
        <h2 className="text-4xl sm:text-5xl font-extrabold text-center text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
          {isUpgrade ? "Complete Upgrade Payment" : "Complete Payment"}
        </h2>
        <p className="mt-3 text-slate-300/80 text-center text-sm sm:text-base">
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
                ? "border-red-500/60 bg-red-500/10 text-red-200"
                : banner.type === "success"
                ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-200"
                : "border-sky-500/60 bg-sky-500/10 text-sky-100"
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

      {/* Booking Summary Card */}
      <motion.div
        variants={itemVariants}
        className="mt-8 rounded-2xl border border-sky-700/40 bg-[#0a1324]/90 shadow-[0_0_35px_rgba(14,165,233,0.15)] backdrop-blur-md"
      >
        <div className="p-6 sm:p-7">
          <h3 className="text-[20px] font-bold text-white">
            {isUpgrade ? "Upgrade Summary" : "Booking Summary"}
          </h3>
          <p className="text-slate-400 text-sm mt-1">
            Please review your {isUpgrade ? "upgrade" : "booking"} details
          </p>

          <div className="mt-6">
            <p className="font-semibold text-lg text-white">{packageTitle}</p>
            <div className="mt-2 space-y-1">
              {(referralPercent > 0 || couponPercent > 0) && (
                <p className="text-xl text-slate-300 line-through">
                  ${baseAmount.toFixed(2)}
                </p>
              )}
              <p className="text-3xl font-extrabold text-sky-400">
                ${finalAmount.toFixed(2)} USD
              </p>

              {referralPercent > 0 && (
                <p className="text-sm text-green-300">
                  Referral: {referralPercent}% ($
                  {referralDiscountAmount.toFixed(2)}
                  {referral?.name ? ` via ${referral.name}` : ""})
                </p>
              )}
              {couponPercent > 0 && coupon && (
                <p className="text-sm text-emerald-300">
                  Coupon "{coupon.code}": {couponPercent}% ($
                  {couponDiscountAmount.toFixed(2)})
                  {canStackCouponWithReferral && referralPercent > 0
                    ? " (stacked with referral)"
                    : ""}
                </p>
              )}
              {effectiveDiscountAmount > 0 && (
                <p className="text-xs text-slate-300">
                  Total savings: {discountPercentCombined}% (${effectiveDiscountAmount.toFixed(2)})
                </p>
              )}

              <p className="text-sm text-slate-400 mt-1">
                Your time: <span className="text-sky-300">{date}</span> at{" "}
                <span className="text-sky-300">{time}</span>
              </p>
              <p className="text-xs text-slate-400">
                Host ({hostTimeZone}):{" "}
                <span className="text-sky-200">{hostDate}</span> at{" "}
                <span className="text-sky-200">{hostTime}</span>
                {crossesDateBoundary
                  ? " • Note: this slot spans different calendar days."
                  : ""}
              </p>

              {isFree && (
                <p className="text-xs text-emerald-300 mt-2">
                  This booking has a 100% discount applied. No payment is required - just confirm your free booking below.
                </p>
              )}
              {!isFree && preventedFreeReduction && (
                <p className="text-xs text-amber-200 mt-2">
                  A minimum charge applies unless you use an approved
                  free-booking code.
                </p>
              )}
              {isUpgrade && (
                <p className="text-xs text-slate-400 mt-2">
                  Upgrade price reflects the difference between the target package and your original payment.
                </p>
              )}
            </div>
          </div>

          <div className="mt-6 h-px w-full bg-sky-800/40" />

          {/* Referral & Coupon inputs */}
          <>
            {/* Referral input */}
            <div className="mt-6">
              <label className="block text-sm font-semibold mb-1">
                Referral Code (optional)
              </label>
              <div className="flex flex-wrap gap-2 items-center">
                <input
                  value={referralInput}
                  onChange={(e) => setReferralInput(e.target.value.trim())}
                  placeholder="e.g. vouch"
                  className="w-60 bg-[#0c162a] border border-sky-800/40 rounded-md px-3 py-2 outline-none text-sm"
                />

                <button
                  onClick={() => validateReferral(referralInput)}
                  disabled={validating}
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
                <p className="text-sm text-red-300 mt-2">
                  Invalid or inactive referral code.
                </p>
              )}
            </div>

            {/* Coupon input */}
            <div className="mt-5">
              <label className="block text-sm font-semibold mb-1">
                Coupon Code (optional)
              </label>
              <div className="flex flex-wrap gap-2 items-center">
                <input
                  value={couponInput}
                  onChange={(e) => setCouponInput(e.target.value.trim())}
                  placeholder="e.g. BF10"
                  className="w-60 bg-[#0c162a] border border-sky-800/40 rounded-md px-3 py-2 outline-none text-sm"
                />

                <button
                  onClick={() => validateCoupon(couponInput)}
                  disabled={validatingCoupon}
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
                    className="text-xs text-slate-300 underline underline-offset-2"
                  >
                    Remove coupon
                  </button>
                )}
              </div>
              {coupon &&
                coupon.canCombineWithReferral === false &&
                referral && (
                  <p className="text-xs text-amber-300 mt-1">
                    This coupon cannot be clubbed with a referral discount.
                  </p>
                )}
            </div>
          </>
        </div>
      </motion.div>

      {/* Payment Method / Free Booking */}
      <motion.div
        variants={itemVariants}
        className="mt-8 rounded-2xl border border-sky-700/40 bg-[#080e1a]/95 shadow-[0_0_45px_rgba(14,165,233,0.25)] backdrop-blur-lg"
      >
        <div className="p-6 sm:p-7">
          <h3 className="text-[20px] font-bold text-white">
            {isFree ? "Confirm Free Booking" : "Payment Method"}
          </h3>
          <p className="text-slate-400 text-sm mt-1">
            {isFree
              ? "This booking is fully discounted. Confirm below to finalize it."
              : "Secure payment via Razorpay or PayPal"}
          </p>

          {/* FREE BOOKING MODE (100% discount) */}
          {isFree ? (
            <div className="mt-6 flex flex-col gap-4 border border-emerald-500/40 bg-emerald-500/10 rounded-xl px-5 py-4 shadow-[0_0_25px_rgba(16,185,129,0.35)]">
              <p className="text-sm text-emerald-100">
                No payment is required. Click the button below to confirm your
                free booking.
              </p>
              <button
                onClick={handleFreeBooking}
                disabled={creatingFree}
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
              {/* Razorpay option */}
              <div className="mt-6 flex items-center justify-between gap-4 border border-sky-800/30 bg-[#0c162a]/80 rounded-xl px-5 py-4 shadow-[0_0_25px_rgba(14,165,233,0.15)]">
                <div>
                  <p className="text-slate-300 text-sm font-medium">
                    Pay with Razorpay
                  </p>
                  <p className="text-slate-400 text-xs">
                    Cards / local methods
                  </p>
                </div>
                <button
                  onClick={handleRazorpayPay}
                  disabled={!rzpReady || payingRzp}
                  className="glow-button px-4 py-2 rounded-lg text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60"
                >
                  {payingRzp ? "Processing..." : "Pay with Razorpay"}
                  <span className="glow-line glow-line-top" />
                  <span className="glow-line glow-line-right" />
                  <span className="glow-line glow-line-bottom" />
                  <span className="glow-line glow-line-left" />
                </button>
              </div>

              {/* PayPal option */}
              <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-4 border border-sky-800/30 bg-[#0c162a]/80 rounded-xl px-5 py-4 shadow-[0_0_25px_rgba(14,165,233,0.15)]">
                <div className="flex items-center gap-4">
                  {/* SEO: add descriptive alt text and intrinsic size for the payment logo. */}
                  <img
                    src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-100px.png"
                    alt="PayPal payment logo"
                    width={100}
                    height={26}
                    decoding="async"
                    className="w-20"
                  />
                  <p className="text-slate-300 text-sm font-medium hidden sm:block">
                    Secure global payment
                  </p>
                </div>

                <div className="w-full sm:w-48 relative z-0">
                  {hasPaypalClientId ? (
                    <PayPalScriptProvider
                      options={{
                        "client-id": paypalClientId,
                        currency: "USD",
                        intent: "capture",
                      }}
                    >
                      <PayPalButtons
                        fundingSource="paypal"
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
                        createOrder={(data, actions) =>
                          actions.order.create({
                            purchase_units: [
                              {
                                description: `${packageTitle} booking`,
                                amount: { value: finalAmount.toFixed(2) },
                              },
                            ],
                          })
                        }
                        onApprove={async (data, actions) => {
                          if (!ensureSlotBeforeAction()) return;
                          const details = await actions.order.capture();

                          try {
                            const payload = {
                              ...bookingData,
                              referralCode: referral?.code || referralInput || "",
                              referralId: referral?._id || null,

                              couponCode: coupon?.code || couponInput || "",
                              couponDiscountPercent: couponPercent,
                              couponDiscountAmount: couponDiscountAmount,

                              discountPercent: discountPercentCombined,
                              discountAmount: effectiveDiscountAmount,
                              grossAmount: baseAmount,
                              netAmount: finalAmount,
                              commissionPercent: commissionPercent,

                              paypalOrderId: details?.id || "",
                              payerEmail: details?.payer?.email_address || "",
                              status: "captured",
                              paymentProvider: "paypal",
                            };
                            const res = await fetch("/api/ref/createBooking", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify(payload),
                            });

                            if (!res.ok) {
                              console.error(
                                "Booking create error:",
                                await res.text()
                              );
                              showBanner(
                                "error",
                                "Payment succeeded but booking could not be saved. Please contact support."
                              );
                              return;
                            }

                            navigate("/payment-success", {
                              state: getModalFlowState(),
                              replace: true,
                            });
                          } catch (err) {
                            console.error("Booking creation error:", err);
                            showBanner(
                              "error",
                              "Payment succeeded but something went wrong saving your booking. Please contact support."
                            );
                          }
                        }}
                        onError={(err) => {
                          console.error(err);
                          showBanner(
                            "error",
                            "PayPal could not process your payment. Please try again."
                          );
                        }}
                      />
                    </PayPalScriptProvider>
                  ) : (
                    <p className="text-xs text-amber-300 text-center">
                      PayPal is unavailable: client ID not configured.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </motion.div>

      {/* Modern Back Button 
         ALWAYS render this if we are in modal mode OR if hideFooter is false. 
         This ensures a navigation method exists inside the popup.
      */}
      {(isModalMode || !hideFooter) && (
        <motion.div
          variants={itemVariants}
          className="mt-10 flex justify-center pb-8"
        >
          <Link
            to="/booking"
            state={backToBookingState}
            className="glow-button inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold text-sky-50 hover:text-white transition-all duration-300"
          >
            <span className="text-lg">&lt;-</span>
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


