import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { client } from "../sanityClient";
import packageContent from "../lib/packageContent";
import packagePricing from "../lib/packagePricing";

const { normalizePackageText } = packageContent;
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

const UPGRADE_LINK_QUERY = `*[_type == "upgradeLink" && lower(slug.current) == $slug][0]{
  title,
  intro,
  targetPackage->{title, price}
}`;

export default function UpgradeLink() {
  const { slug } = useParams();
  const navigate = useNavigate();

  const [orderId, setOrderId] = useState("");
  const [orderEmail, setOrderEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [upgradeInfo, setUpgradeInfo] = useState(null);
  const [error, setError] = useState(null);

  const [linkInfo, setLinkInfo] = useState(null);
  const [linkLoading, setLinkLoading] = useState(true);
  const [linkError, setLinkError] = useState(null);

  const normalizedSlug = useMemo(
    () => (slug ? String(slug).toLowerCase() : ""),
    [slug]
  );

  useEffect(() => {
    let active = true;
    setLinkLoading(true);
    setLinkError(null);
    setLinkInfo(null);
    setUpgradeInfo(null);
    setError(null);

    if (!normalizedSlug) {
      setLinkLoading(false);
      setLinkError("Missing upgrade link. Please contact support.");
      return () => {
        active = false;
      };
    }

    client
      .fetch(UPGRADE_LINK_QUERY, { slug: normalizedSlug })
      .then((data) => {
        if (!active) return;
        if (!data) {
          setLinkError("Upgrade link not found. Please contact support.");
          return;
        }
        setLinkInfo({
          ...data,
          title: normalizePackageText(data.title || ""),
          intro: normalizePackageText(data.intro || ""),
          targetPackage: applyPackagePricing(data.targetPackage),
        });
      })
      .catch((err) => {
        console.error("Upgrade link load error:", err);
        if (!active) return;
        setLinkError("Could not load this upgrade link. Please try again.");
      })
      .finally(() => {
        if (!active) return;
        setLinkLoading(false);
      });

    return () => {
      active = false;
    };
  }, [normalizedSlug]);

  const headingText =
    linkInfo?.title ||
    (linkInfo?.targetPackage?.title
      ? `Upgrade to ${linkInfo.targetPackage.title}`
      : "Upgrade Package");

  const introText =
    linkInfo?.intro ||
    (linkInfo?.targetPackage?.title
      ? `Enter your Order ID to see the upgrade price for ${linkInfo.targetPackage.title}.`
      : "Enter your Order ID to check your upgrade price.");

  async function handleCheckOrder() {
    setError(null);
    setUpgradeInfo(null);

    const trimmed = orderId.trim();
    if (!trimmed) {
      setError("Please enter the Order ID from your confirmation email.");
      return;
    }
    const trimmedEmail = orderEmail.trim();
    if (!trimmedEmail) {
      setError("Please enter the email used on the original booking.");
      return;
    }

    if (!normalizedSlug) {
      setError("Upgrade link is missing. Please contact support.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(
        `/api/ref/getUpgradeInfo?id=${encodeURIComponent(
          trimmed
        )}&email=${encodeURIComponent(
          trimmedEmail
        )}&slug=${encodeURIComponent(normalizedSlug)}`
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
      if (!linkInfo && data.upgradeLink) {
        setLinkInfo({
          title: normalizePackageText(data.upgradeLink.title),
          intro: normalizePackageText(data.upgradeLink.intro),
          targetPackage: data.targetPackage,
        });
      }
    } catch (err) {
      console.error("Upgrade check error:", err);
      setError("Something went wrong while checking your order. Try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleProceedToPayment() {
    if (!upgradeInfo) return;

    const { booking, targetPackage, upgradePrice } = upgradeInfo;

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

    const bookingData = {
      discord: booking.discord || "",
      email: orderEmail.trim(),
      specs: booking.specs || "",
      mainGame: booking.mainGame || "",
      message: booking.message || "",

      packageTitle: `${targetPackage.title} (Upgrade)`,
      packagePrice: `$${upgradePrice.toFixed(2)}`,
      status: "pending",

      displayDate,
      displayTime,
      localTimeZone: clientTimeZone,
      startTimeUTC: booking.startTimeUTC || "",

      originalOrderId: booking._id,
    };

    const encoded = encodeURIComponent(JSON.stringify(bookingData));
    navigate(`/payment?data=${encoded}`);
  }

  const targetPackage = upgradeInfo?.targetPackage;
  const upgradePrice =
    upgradeInfo && typeof upgradeInfo.upgradePrice === "number"
      ? upgradeInfo.upgradePrice
      : null;

  return (
    <section className="relative z-10 pt-32 pb-24 px-6 max-w-3xl mx-auto text-ink">
      <h2 className="text-4xl sm:text-5xl font-extrabold text-center text-info-text drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        {headingText}
      </h2>
      <p className="mt-3 text-ink-secondary text-center text-sm sm:text-base">
        {introText}
      </p>

      {linkLoading && (
        <p className="mt-4 text-center text-sm text-ink-muted">
          Loading upgrade link...
        </p>
      )}

      {linkError && (
        <div className="mt-6 rounded-xl border border-danger-border bg-danger-soft text-danger-text text-sm px-4 py-3 text-center">
          {linkError}
        </div>
      )}

      {!linkError && (
        <div className="mt-8 rounded-2xl border border-line-input bg-surface-card shadow-[var(--shadow-card-glow-info)] backdrop-blur-md p-6 sm:p-7">
          <label className="block text-sm font-semibold mb-2">
            Enter your Order ID
          </label>
          <p className="text-xs text-ink-muted mb-3">
            You can find this in your Roo Industries booking email (labelled
            "Order ID").
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
              disabled={loading || linkLoading}
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
      )}

      {upgradeInfo && (
        <div className="mt-8 rounded-2xl border border-success-border bg-success-soft shadow-success-soft backdrop-blur-lg p-6 sm:p-7">
          <h3 className="text-[20px] font-bold text-ink">
            Upgrade Summary
          </h3>
          <p className="text-ink-muted text-sm mt-1">
            Here is how your upgrade price is calculated.
          </p>

          <div className="mt-5 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-ink-secondary">Original package</span>
              <span className="font-semibold text-accent text-right">
                {upgradeInfo.booking.packageTitle || "--"}
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
                Full {targetPackage?.title || "package"} price
              </span>
              <span className="font-semibold text-accent text-right">
                {targetPackage?.priceString ||
                  `$${targetPackage?.price?.toFixed(2) || "0.00"}`}
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
            <span className="text-accent">
              {targetPackage?.title || "the new package"}
            </span>
            .
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
