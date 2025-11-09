import React, { useState, useMemo } from "react";
import { useLocation, Link } from "react-router-dom";
import { PayPalScriptProvider, PayPalButtons } from "@paypal/react-paypal-js";

export default function Payment() {
  const location = useLocation();
  const q = new URLSearchParams(location.search);

  const bookingData = useMemo(() => {
    try {
      return JSON.parse(q.get("data") || "{}");
    } catch {
      return {};
    }
  }, [q]);

  //values from bookingData
  const packageTitle = bookingData.packageTitle || "—";
  const packagePrice = bookingData.packagePrice || "$0";
  const date = bookingData.date || "—";
  const time = bookingData.time || "—";
  const amount = parseFloat(packagePrice.replace(/[^0-9.]/g, "")) || 0;

  return (
    <section className="relative z-10 pt-32 pb-24 px-6 max-w-3xl mx-auto text-white">
      {/* Heading */}
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
            <p className="text-3xl font-extrabold text-sky-400 mt-1">
              {packagePrice} USD
            </p>
          </div>

          <div className="mt-6 h-px w-full bg-sky-800/40" />

          <div className="mt-6 grid gap-3 text-slate-300 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-sky-400">📅</span>
              <span>{date}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sky-400">⏰</span>
              <span>{time}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Payment Method */}
      <div className="mt-8 rounded-2xl border border-sky-700/40 bg-[#080e1a]/95 shadow-[0_0_45px_rgba(14,165,233,0.25)] backdrop-blur-lg">
        <div className="p-6 sm:p-7">
          <h3 className="text-[20px] font-bold text-white">Payment Method</h3>
          <p className="text-slate-400 text-sm mt-1">
            Secure payment via PayPal
          </p>

          {/* PayPal header row */}
          <div className="mt-6 flex items-center justify-start gap-4 border border-sky-800/30 bg-[#0c162a]/80 rounded-xl px-5 py-4 shadow-[0_0_25px_rgba(14,165,233,0.15)]">
            <img
              src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-100px.png"
              alt="PayPal"
              className="w-24 sm:w-28"
            />
            <p className="text-slate-300 text-sm font-medium">
              Secure payment processing
            </p>
          </div>

          {/* PayPal Button */}
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
                        amount: { value: amount.toFixed(2) },
                      },
                    ],
                  })
                }
                onApprove={async (data, actions) => {
                  const details = await actions.order.capture();
                  try {
                    const res = await fetch("/api/createBooking", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(bookingData),
                    });

                    if (!res.ok)
                      throw new Error("Failed to create booking in Sanity");
                    const { bookingId } = await res.json();

                    alert(
                      `✅ Payment successful! Booking confirmed (${bookingId})`
                    );
                    window.location.href = "/payment-success";
                  } catch (err) {
                    console.error("Booking creation error:", err);
                    alert(
                      "Payment succeeded but booking could not be saved. Contact support."
                    );
                  }
                }}
                onError={(err) => {
                  console.error(err);
                  alert("❌ Payment could not be processed. Please try again.");
                }}
              />
            </PayPalScriptProvider>
          </div>
        </div>
      </div>

      {/* Back Link */}
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
