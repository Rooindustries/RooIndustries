import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

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
    return "";
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
    return "";
  }
};

export default function UpgradeXoc() {
  const [orderId, setOrderId] = useState("");
  const [orderEmail, setOrderEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [upgradeInfo, setUpgradeInfo] = useState(null);
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
    const trimmedEmail = orderEmail.trim();
    if (!trimmedEmail) {
      setError("Please enter the email used on the original booking.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(
        `/api/ref/getUpgradeInfo?id=${encodeURIComponent(
          trimmed
        )}&email=${encodeURIComponent(trimmedEmail)}`
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

    const utcStart = booking.startTimeUTC
      ? new Date(booking.startTimeUTC)
      : null;
    const clientTimeZone = booking.localTimeZone || "";
    const displayDate =
      booking.displayDate ||
      (utcStart ? formatLocalDate(utcStart, clientTimeZone) : "");
    const displayTime =
      booking.displayTime ||
      (utcStart ? formatLocalTime(utcStart, clientTimeZone) : "");

    // Build bookingData exactly like your normal Booking → Payment flow,
    // but as an upgrade with the new price.
      const bookingData = {
        discord: booking.discord || "",
        email: orderEmail.trim(),
        specs: booking.specs || "",
        mainGame: booking.mainGame || "",
        message: booking.message || "",

      // UPGRADE package metadata
      packageTitle: `${xoc.title} (Upgrade)`,
      packagePrice: `$${upgradePrice.toFixed(2)}`,
      status: "pending",

      displayDate,
      displayTime,
      localTimeZone: clientTimeZone,
      startTimeUTC: booking.startTimeUTC || "",

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
    <section className="relative z-10 pt-32 pb-24 px-6 max-w-3xl mx-auto text-ink">
      <h2 className="text-4xl sm:text-5xl font-extrabold text-center text-info-text drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Upgrade to Performance Vertex Max
      </h2>
      <p className="mt-3 text-ink-secondary text-center text-sm sm:text-base">
        This page is only for existing{" "}
        <span className="font-semibold text-accent">
          Performance Vertex Overhaul
        </span>{" "}
        customers who want to upgrade to Performance Vertex Max.
      </p>

      {/* Order ID input */}
      <div className="mt-8 rounded-2xl border border-line-input bg-surface-card shadow-[var(--shadow-card-glow-info)] backdrop-blur-md p-6 sm:p-7">
        <label className="block text-sm font-semibold mb-2">
          Enter your Order ID
        </label>
        <p className="text-xs text-ink-muted mb-3">
          You can find this in your Roo Industries booking email (labelled
          &quot;Order ID&quot;).
        </p>
        <div className="mb-3">
          <label className="block text-sm font-semibold mb-2">
            Booking email
          </label>
          <input
            value={orderEmail}
            onChange={(e) => setOrderEmail(e.target.value)}
            placeholder="Email used on the original booking"
            className="w-full bg-surface-input border border-line-input rounded-md px-3 py-2 outline-none text-sm"
            type="email"
            autoComplete="email"
          />
        </div>
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <input
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            placeholder="e.g. 1a2b3c4d5e6f7g8h9i"
            className="flex-1 bg-surface-input border border-line-input rounded-md px-3 py-2 outline-none text-sm"
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
          <p className="mt-3 text-sm text-danger-text bg-danger-soft border border-danger-border rounded-md px-3 py-2">
            {error}
          </p>
        )}
      </div>

      {/* Upgrade summary */}
      {upgradeInfo && (
        <div className="mt-8 rounded-2xl border border-success-border bg-success-soft shadow-success-soft backdrop-blur-lg p-6 sm:p-7">
          <h3 className="text-[20px] font-bold text-ink">
            Upgrade Summary
          </h3>
          <p className="text-ink-muted text-sm mt-1">
            Here&apos;s how your upgrade price is calculated.
          </p>

          <div className="mt-5 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-ink-secondary">Original package</span>
              <span className="font-semibold text-accent text-right">
                {upgradeInfo.booking.packageTitle || "—"}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-ink-secondary">You already paid</span>
              <span className="font-semibold text-success-text text-right">
                ${upgradeInfo.originalPaid.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-ink-secondary">
                Full Performance Vertex Max price
              </span>
              <span className="font-semibold text-accent text-right">
                {upgradeInfo.xoc.priceString ||
                  `$${upgradeInfo.xoc.price.toFixed(2)}`}
              </span>
            </div>
            <div className="h-px w-full bg-line-soft my-3" />
            <div className="flex justify-between gap-4 items-center">
              <span className="text-ink font-semibold">
                Upgrade price
              </span>
              <span className="text-2xl font-extrabold text-success-text">
                ${upgradePrice?.toFixed(2)}
              </span>
            </div>
          </div>

          <p className="mt-3 text-xs text-ink-muted">
            This is the amount you pay now to upgrade your existing booking to{" "}
            <span className="text-accent">Performance Vertex Max</span>.
          </p>

          <button
            onClick={handleProceedToPayment}
            disabled={!upgradePrice || upgradePrice <= 0}
            className="glow-button mt-6 w-full text-white py-3 rounded-md font-semibold shadow-[var(--shadow-cta-success)] transition-all duration-300 inline-flex items-center justify-center gap-2 disabled:opacity-60"
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
