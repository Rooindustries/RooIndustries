import React, { useState, useMemo, useEffect } from "react";
import { useLocation, Link, Navigate, useNavigate } from "react-router-dom";
import { PayPalScriptProvider, PayPalButtons } from "@paypal/react-paypal-js";

export default function Payment() {
  const location = useLocation();
  const q = new URLSearchParams(location.search);
  const navigate = useNavigate();
  const bookingData = useMemo(() => {
    try {
      return JSON.parse(q.get("data") || "{}");
    } catch {
      return {};
    }
  }, [q]);

  const packageTitle = bookingData.packageTitle || "—";
  const packagePrice = bookingData.packagePrice || "$0";
  const date = bookingData.displayDate || "--";
  const time = bookingData.displayTime || "--";
  const baseAmount = parseFloat(packagePrice.replace(/[^0-9.]/g, "")) || 0;

  const [referralInput, setReferralInput] = useState("");
  const [referral, setReferral] = useState(null);
  const [validating, setValidating] = useState(false);

  const discountPercent = referral?.isFirstTime
    ? 0
    : referral?.currentDiscountPercent || 0;

  const commissionPercent = referral?.currentCommissionPercent || 0;

  const discountAmount = +(baseAmount * (discountPercent / 100)).toFixed(2);
  const finalAmount = Math.max(0, +(baseAmount - discountAmount).toFixed(2));

  //Razorpay state
  const [rzpReady, setRzpReady] = useState(false);
  const [payingRzp, setPayingRzp] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get("ref");

    let stored = fromUrl;
    if (!stored) {
      try {
        stored = localStorage.getItem("referral");
      } catch (e) {
        console.error("Failed to read referral from localStorage:", e);
      }
    }

    if (stored) {
      setReferralInput(stored);
      validateReferral(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  //Load Razorpay checkout script
  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => setRzpReady(true);
    script.onerror = () => {
      console.error("Failed to load Razorpay SDK");
      setRzpReady(false);
    };
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, []);

  async function validateReferral(code) {
    if (!code) {
      setReferral(null);
      localStorage.removeItem("referral");
      return;
    }
    try {
      setValidating(true);
      const r = await fetch(
        `/api/ref/validateReferral?code=${encodeURIComponent(code)}`
      );
      const data = await r.json();
      if (data.ok) {
        setReferral(data.referral);
        localStorage.setItem("referral", data.referral.code);
      } else {
        setReferral(null);
        localStorage.removeItem("referral");
      }
    } catch (e) {
      console.error(e);
      setReferral(null);
      localStorage.removeItem("referral");
    } finally {
      setValidating(false);
    }
  }

  //Razorpay payment flow
  async function handleRazorpayPay() {
    if (!rzpReady || !window.Razorpay) {
      alert("Payment system is still loading. Please try again in a moment.");
      return;
    }

    try {
      setPayingRzp(true);

      // 1) Ask backend to create Razorpay order
      const orderRes = await fetch("/api/razorpay/createOrder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: finalAmount, // normal amount, backend converts to subunits
          currency: "USD", // or "INR" if you want rupees
          notes: {
            packageTitle,
            date,
            time,
            referralCode: referral?.code || referralInput || "",
          },
        }),
      });

      const orderData = await orderRes.json();

      if (!orderRes.ok || !orderData.ok) {
        throw new Error(orderData.message || "Failed to create Razorpay order");
      }

      // 2) Open Razorpay popup
      const options = {
        key: orderData.key,
        amount: orderData.amount,
        currency: orderData.currency,
        name: "Roo Industries",
        description: `${packageTitle} booking`,
        order_id: orderData.orderId,
        prefill: {
          name: bookingData.fullName || "",
          email: bookingData.email || "",
          contact: bookingData.phone || "",
        },
        theme: {
          color: "#0ea5e9",
        },
        handler: async function (response) {
          // response = { razorpay_payment_id, razorpay_order_id, razorpay_signature }
          try {
            // 3) Verify signature on backend
            const verifyRes = await fetch("/api/razorpay/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(response),
            });

            const verifyData = await verifyRes.json();

            if (!verifyRes.ok || !verifyData.ok) {
              alert("Payment verification failed. Please contact support.");
              return;
            }

            const payload = {
              ...bookingData,
              referralCode: referral?.code || referralInput || "",
              referralId: referral?._id || null,
              discountPercent,
              discountAmount,
              grossAmount: baseAmount,
              netAmount: finalAmount,
              commissionPercent,
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

            if (!res.ok) throw new Error("Failed to create booking in Sanity");

            const { bookingId } = await res.json();

            alert(
              `Payment successful via Razorpay! Booking confirmed (${bookingId})`
            );
            navigate("/payment-success");
          } catch (err) {
            console.error("Razorpay post-payment error:", err);
            alert(
              "Payment succeeded but booking could not be saved. Contact support."
            );
          }
        },
        modal: {
          ondismiss: function () {
            console.log("Razorpay popup closed by user");
          },
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err) {
      console.error("Razorpay error:", err);
      alert("Payment could not be processed. Please try again.");
    } finally {
      setPayingRzp(false);
    }
  }

  return (
    <section className="relative z-10 pt-32 pb-24 px-6 max-w-3xl mx-auto text-white">
      <h2 className="text-4xl sm:text-5xl font-extrabold text-center text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Complete Payment
      </h2>
      <p className="mt-3 text-slate-300/80 text-center text-sm sm:text-base">
        Review your booking details and proceed to payment
      </p>

      {/* Booking Summary */}
      <div className="mt-10 rounded-2xl border border-sky-700/40 bg-[#0a1324]/90 shadow-[0_0_35px_rgba(14,165,233,0.15)] backdrop-blur-md">
        <div className="p-6 sm:p-7">
          <h3 className="text-[20px] font-bold text-white">Booking Summary</h3>
          <p className="text-slate-400 text-sm mt-1">
            Please review your booking details
          </p>

          <div className="mt-6">
            <p className="font-semibold text-lg text-white">{packageTitle}</p>
            <div className="mt-2 space-y-1">
              {discountPercent > 0 && (
                <p className="text-xl text-slate-300 line-through">
                  ${baseAmount.toFixed(2)}
                </p>
              )}
              <p className="text-3xl font-extrabold text-sky-400">
                ${finalAmount.toFixed(2)} USD
              </p>
              {discountPercent > 0 && (
                <p className="text-sm text-green-300">
                  You saved {discountPercent}% (−${discountAmount.toFixed(2)})
                  via {referral?.name}
                </p>
              )}
              <p className="text-sm text-slate-400 mt-1">
                Date: <span className="text-sky-300">{date}</span> — Time:{" "}
                <span className="text-sky-300">{time}</span>
              </p>
            </div>
          </div>

          <div className="mt-6 h-px w-full bg-sky-800/40" />

          {/* Referral input */}
          <div className="mt-6">
            <label className="block text-sm font-semibold mb-1">
              Referral Code (optional)
            </label>
            <div className="flex gap-2 items-center">
              <input
                value={referralInput}
                onChange={(e) => setReferralInput(e.target.value.trim())}
                placeholder="e.g. vouch"
                className="w-60 bg-[#0c162a] border border-sky-800/40 rounded-md px-3 py-2 outline-none"
              />

              <button
                onClick={() => validateReferral(referralInput)}
                disabled={validating}
                className="glow-button px-3 py-2 rounded-md font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60"
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
        </div>
      </div>

      {/* Payment Method */}
      <div className="mt-8 rounded-2xl border border-sky-700/40 bg-[#080e1a]/95 shadow-[0_0_45px_rgba(14,165,233,0.25)] backdrop-blur-lg">
        <div className="p-6 sm:p-7">
          <h3 className="text-[20px] font-bold text-white">Payment Method</h3>
          <p className="text-slate-400 text-sm mt-1">
            Secure payment via Razorpay or PayPal
          </p>

          {/* Razorpay option */}
          <div className="mt-6 flex items-center justify-between gap-4 border border-sky-800/30 bg-[#0c162a]/80 rounded-xl px-5 py-4 shadow-[0_0_25px_rgba(14,165,233,0.15)]">
            <div>
              <p className="text-slate-300 text-sm font-medium">
                Pay with Razorpay
              </p>
              <p className="text-slate-400 text-xs">
                Cards / UPI / Netbanking (if enabled)
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
          <div className="mt-4 flex items-center justify-start gap-4 border border-sky-800/30 bg-[#0c162a]/80 rounded-xl px-5 py-4 shadow-[0_0_25px_rgba(14,165,233,0.15)]">
            <img
              src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-100px.png"
              alt="PayPal"
              className="w-24 sm:w-28"
            />
            <p className="text-slate-300 text-sm font-medium">
              Secure payment processing
            </p>
          </div>

          <div className="mt-6 w-full sm:w-[400px]">
            <PayPalScriptProvider
              options={{
                "client-id": process.env.REACT_APP_PAYPAL_CLIENT_ID || "test",
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
                  height: 50,
                  tagline: false,
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
                  const details = await actions.order.capture();

                  try {
                    const payload = {
                      ...bookingData,
                      referralCode: referral?.code || referralInput || "",
                      referralId: referral?._id || null,
                      discountPercent,
                      discountAmount,
                      grossAmount: baseAmount,
                      netAmount: finalAmount,
                      commissionPercent,
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

                    if (!res.ok)
                      throw new Error("Failed to create booking in Sanity");

                    const { bookingId } = await res.json();

                    alert(
                      `Payment successful! Booking confirmed (${bookingId})`
                    );
                    navigate("/payment-success");
                  } catch (err) {
                    console.error("Booking creation error:", err);
                    alert(
                      "Payment succeeded but booking could not be saved. Contact support."
                    );
                  }
                }}
                onError={(err) => {
                  console.error(err);
                  alert("Payment could not be processed. Please try again.");
                }}
              />
            </PayPalScriptProvider>
          </div>
        </div>
      </div>

      <div className="mt-8 text-center">
        <Link
          to="/booking"
          className="text-sky-400 hover:text-sky-300 transition-colors duration-300 text-sm"
        >
          ← Back to Booking
        </Link>
      </div>
    </section>
  );
}
