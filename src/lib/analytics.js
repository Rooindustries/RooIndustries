import { track } from "@vercel/analytics/react";
import { salesEventProperties, sanitizeSalesAttribution } from "./salesAttribution";

const ensureAnalyticsQueue = () => {
  if (typeof window === "undefined" || window.va) return;
  window.va = (...args) => {
    window.vaq = window.vaq || [];
    window.vaq.push(args);
  };
};

export const trackEvent = (eventName, data = {}, options = {}) => {
  try {
    ensureAnalyticsQueue();
    const attribution = Object.hasOwn(options, "attribution")
      ? salesEventProperties(options.attribution)
      : salesEventProperties();
    track(eventName, { ...attribution, ...data });
    return true;
  } catch {
    return false;
  }
};

const completedPurchases = new Set();

export const trackConfirmedPurchase = (receipt) => {
  if (!receipt || !/^[a-f0-9]{40}$/.test(receipt.eventId || "")) return false;
  if (!["paid", "free"].includes(receipt.paymentType) || !Number.isFinite(receipt.amount) || receipt.amount < 0) return false;
  const key = `booking_completion_tracked:${receipt.eventId}`;
  try {
    if (completedPurchases.has(receipt.eventId) || sessionStorage.getItem(key)) return false;
  } catch {}
  const attribution = sanitizeSalesAttribution(receipt.attribution);
  const tracked = trackEvent("booking_completed", {
    ...salesEventProperties(attribution),
    event_id: receipt.eventId,
    package: receipt.packageTitle,
    payment_type: receipt.paymentType,
    payment_provider: receipt.provider,
    amount: receipt.amount,
    currency: receipt.currency,
    referral_code: receipt.referralCode || "",
  }, { attribution });
  if (tracked) {
    completedPurchases.add(receipt.eventId);
    try { sessionStorage.setItem(key, "1"); } catch {}
  }
  return tracked;
};
