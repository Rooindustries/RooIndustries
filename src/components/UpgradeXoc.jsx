import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function UpgradeXoc() {
  const [orderId, setOrderId] = useState("");
  const [loading, setLoading] = useState(false);
  const [upgradeInfo, setUpgradeInfo] = useState(null); // { booking, xoc, upgradePrice, originalPaid }
  const [error, setError] = useState(null);

  const navigate = useNavigate();

  async function handleCheckOrder() {
    setError(null);
    setUpgradeInfo(null);

    const trimmed = orderId.trim();
    if (!trimmed) {
      setError("Please enter the Order ID from your confirmation email. ");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(
        `/api/ref/getUpgradeInfo?id=${encodeURIComponent(trimmed)}`
      );
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setError(
          data.error ||
            "Could not find a matching booking. Double-check your Order ID."
        );
        return;
      }

      setUpgradeInfo(data);
    } catch (err) {
      console.error("Upgrade check error:", err);
      setError("Something went wrong while checking your order. Try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleProceedToPayment() {
    if (!upgradeInfo) return;

    const { booking, xoc, upgradePrice } = upgradeInfo;

    // Safety: if for any reason upgradePrice <= 0, don't let them pay.
    if (!upgradePrice || upgradePrice <= 0) {
      alert(
        "This order does not require an upgrade payment. Please contact support on Discord."
      );
      return;
    }

    // Build bookingData exactly like your normal Booking → Payment flow,
    // but as an upgrade with the new price.
    const bookingData = {
      // original time fields
      date: booking.date || booking.displayDate || booking.hostDate || "",
      time: booking.time || booking.displayTime || booking.hostTime || "",

      discord: booking.discord || "",
      email: booking.email || "",
      specs: booking.specs || "",
      mainGame: booking.mainGame || "",
      message: booking.message || "",

      // UPGRADE package metadata
      packageTitle: `${xoc.title} (Upgrade)`,
      packagePrice: `$${upgradePrice.toFixed(2)}`,
      status: "pending",

      // time metadata for your API (keep as close as possible to original)
      hostDate: booking.hostDate || booking.date || booking.displayDate || "",
      hostTime: booking.hostTime || booking.time || booking.displayTime || "",
      hostTimeZone: booking.hostTimeZone || "Asia/Kolkata",
      localTimeZone: booking.localTimeZone || "",
      localTimeLabel:
        booking.localTimeLabel || booking.displayTime || booking.time || "",
      startTimeUTC: booking.startTimeUTC || "",
      displayDate:
        booking.displayDate || booking.date || booking.hostDate || "",
      displayTime:
        booking.displayTime ||
        booking.localTimeLabel ||
        booking.time ||
        booking.hostTime ||
        "",

      // NEW: link this upgrade back to original booking in emails / DB
      originalOrderId: booking._id,
    };

    const encoded = encodeURIComponent(JSON.stringify(bookingData));
    navigate(`/payment?data=${encoded}`);
  }

  const upgradePrice =
    upgradeInfo && typeof upgradeInfo.upgradePrice === "number"
      ? upgradeInfo.upgradePrice
      : null;

  return (
    <section className="relative z-10 pt-32 pb-24 px-6 max-w-3xl mx-auto text-white">
      <h2 className="text-4xl sm:text-5xl font-extrabold text-center text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Upgrade to XOC / Extreme Overclocking
      </h2>
      <p className="mt-3 text-slate-300/80 text-center text-sm sm:text-base">
        This page is only for existing{" "}
        <span className="font-semibold text-sky-300">
          Performance Vertex Overhaul
        </span>{" "}
        customers who want to upgrade to XOC.
      </p>

      {/* Order ID input */}
      <div className="mt-8 rounded-2xl border border-sky-700/40 bg-[#0a1324]/90 shadow-[0_0_35px_rgba(14,165,233,0.15)] backdrop-blur-md p-6 sm:p-7">
        <label className="block text-sm font-semibold mb-2">
          Enter your Order ID
        </label>
        <p className="text-xs text-slate-400 mb-3">
          You can find this in your Roo Industries booking email (labelled
          &quot;Order ID&quot;).
        </p>
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <input
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            placeholder="e.g. 1a2b3c4d5e6f7g8h9i"
            className="flex-1 bg-[#0c162a] border border-sky-800/40 rounded-md px-3 py-2 outline-none text-sm"
          />
          <button
            onClick={handleCheckOrder}
            disabled={loading}
            className="glow-button px-4 py-2 rounded-md font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60 text-sm"
          >
            {loading ? "Checking..." : "Check eligibility"}
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </button>
        </div>

        {error && (
          <p className="mt-3 text-sm text-red-300 bg-red-500/10 border border-red-500/40 rounded-md px-3 py-2">
            {error}
          </p>
        )}
      </div>

      {/* Upgrade summary */}
      {upgradeInfo && (
        <div className="mt-8 rounded-2xl border border-emerald-600/40 bg-[#04121a]/95 shadow-[0_0_45px_rgba(16,185,129,0.25)] backdrop-blur-lg p-6 sm:p-7">
          <h3 className="text-[20px] font-bold text-white">
            Upgrade Summary (PVO → XOC)
          </h3>
          <p className="text-slate-400 text-sm mt-1">
            Here&apos;s how your upgrade price is calculated.
          </p>

          <div className="mt-5 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-slate-300">Original package</span>
              <span className="font-semibold text-sky-300 text-right">
                {upgradeInfo.booking.packageTitle || "—"}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-slate-300">You already paid</span>
              <span className="font-semibold text-emerald-300 text-right">
                ${upgradeInfo.originalPaid.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-slate-300">Full XOC price</span>
              <span className="font-semibold text-sky-400 text-right">
                {upgradeInfo.xoc.priceString ||
                  `$${upgradeInfo.xoc.price.toFixed(2)}`}
              </span>
            </div>
            <div className="h-px w-full bg-sky-900/60 my-3" />
            <div className="flex justify-between gap-4 items-center">
              <span className="text-slate-100 font-semibold">
                XOC upgrade price
              </span>
              <span className="text-2xl font-extrabold text-emerald-400">
                ${upgradePrice?.toFixed(2)}
              </span>
            </div>
          </div>

          <p className="mt-3 text-xs text-slate-400">
            This is the amount you pay now to upgrade your existing booking to{" "}
            <span className="text-sky-300">XOC / Extreme Overclocking</span>.
          </p>

          <button
            onClick={handleProceedToPayment}
            disabled={!upgradePrice || upgradePrice <= 0}
            className="glow-button mt-6 w-full text-white py-3 rounded-md font-semibold shadow-[0_0_20px_rgba(16,185,129,0.4)] transition-all duration-300 inline-flex items-center justify-center gap-2 disabled:opacity-60"
          >
            Proceed to Payment
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </button>
        </div>
      )}
    </section>
  );
}
