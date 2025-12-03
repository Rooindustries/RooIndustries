import React, { useState, useMemo, useEffect } from "react";
import { useLocation, Link, useNavigate } from "react-router-dom";
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

  const [banner, setBanner] = useState(null); // { type: "success" | "error" | "info", text: string }

  const showBanner = (type, text) => {
    setBanner({ type, text });
    setTimeout(() => {
      setBanner((prev) => (prev?.text === text ? null : prev));
    }, 4000);
  };

  const discountPercent = referral?.currentDiscountPercent || 0;
  const commissionPercent = referral?.currentCommissionPercent || 0;

  const discountAmount = +(baseAmount * (discountPercent / 100)).toFixed(2);
  const finalAmount = Math.max(0, +(baseAmount - discountAmount).toFixed(2));

  // Razorpay state
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
      console.log("validateReferral result:", data);

      if (data.ok && data.referral) {
        setReferral(data.referral);

        if (data.referral.code) {
          localStorage.setItem("referral", data.referral.code);
        } else {
          localStorage.removeItem("referral");
        }
      } else {
        setReferral(null);
        localStorage.removeItem("referral");
        showBanner("error", "Invalid or inactive referral code.");
      }
    } catch (e) {
      console.error(e);
      setReferral(null);
      localStorage.removeItem("referral");
      showBanner(
        "error",
        "We couldn’t validate that referral code. Please try again."
      );
    } finally {
      setValidating(false);
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

    try {
      setPayingRzp(true);
      showBanner("info", "Opening Razorpay checkout…");

      // 1) Ask backend to create Razorpay order
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
          },
        }),
      });

      const orderData = await orderRes.json();

      if (!orderRes.ok || !orderData.ok) {
        console.error("Razorpay order error:", orderData);
        showBanner(
          "error",
          orderData.message ||
            "Couldn’t start the payment. Please try again or use PayPal."
        );
        return;
      }

      // 2) Open Razorpay popup
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
            // 3) Verify signature on backend
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

            if (!res.ok) {
              console.error("Booking create error:", await res.text());
              showBanner(
                "error",
                "Payment succeeded but booking could not be saved. Please contact support with your payment ID."
              );
              return;
            }

            // all good -> go to success page
            navigate("/payment-success");
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
            console.log("Razorpay popup closed by user");
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

  return (
    <section className="relative z-10 pt-32 pb-24 px-6 max-w-3xl mx-auto text-white">
      <h2 className="text-4xl sm:text-5xl font-extrabold text-center text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Complete Payment
      </h2>
      <p className="mt-3 text-slate-300/80 text-center text-sm sm:text-base">
        Review your booking details and proceed to payment
      </p>

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
              ? "⚠️"
              : banner.type === "success"
              ? "✅"
              : "💬"}
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

      {/* Booking Summary */}
      <div className="mt-8 rounded-2xl border border-sky-700/40 bg-[#0a1324]/90 shadow-[0_0_35px_rgba(14,165,233,0.15)] backdrop-blur-md">
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
              <p className="text-slate-400 text-xs">Cards / local methods</p>
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

          <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-4 border border-sky-800/30 bg-[#0c162a]/80 rounded-xl px-5 py-4 shadow-[0_0_25px_rgba(14,165,233,0.15)]">
            <div className="flex items-center gap-4">
              <img
                src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-100px.png"
                alt="PayPal"
                className="w-20"
              />
              <p className="text-slate-300 text-sm font-medium hidden sm:block">
                Secure global payment
              </p>
            </div>

            <div className="w-full sm:w-48 relative z-0">
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
                    height: 40,
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

                      navigate("/payment-success");
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
            </div>
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
