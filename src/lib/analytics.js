import { isProductionBrowser } from "./productionBrowser";
import { track } from "@vercel/analytics/react";
import { loadSalesAttribution, withMetaPixel, withSalesAttribution } from "./analyticsModules";
import packagePricing from "./packagePricing";

const { getPackageSlug, toMoney } = packagePricing;
const DEFAULT_CURRENCY = "USD";

const metaTrack = (event, data, options) => withMetaPixel((pixel) => pixel.metaTrack(event, data, options));

const packageFields = (title, price) => {
  const name = String(title || "").trim();
  return name ? { name, slug: getPackageSlug(name), value: toMoney(price) } : null;
};

const ensureAnalyticsQueue = () => {
  if (typeof window === "undefined" || window.va) return;
  window.va = (...args) => {
    window.vaq = window.vaq || [];
    window.vaq.push(args);
  };
};

export const trackEvent = (eventName, data = {}, options = {}) => {
  try {
    if (!isProductionBrowser()) return false;
    ensureAnalyticsQueue();
    const attributed = Object.hasOwn(options, "attribution");
    withSalesAttribution(({ salesEventProperties }) => {
      const attribution = attributed ? salesEventProperties(options.attribution) : salesEventProperties();
      track(eventName, { ...attribution, ...data });
    });
    return true;
  } catch {
    return false;
  }
};

export const trackPageView = (signal) =>
  withMetaPixel((pixel) => pixel.metaTrackWhenGranted("PageView", {}, {}, signal));

export const trackPackageView = ({ title, price, surface } = {}) => {
  try {
    const pkg = packageFields(title, price);
    if (!pkg?.slug) return false;
    trackEvent("view_item", {
      package: pkg.name,
      package_slug: pkg.slug,
      value: pkg.value,
      currency: DEFAULT_CURRENCY,
      surface: String(surface || ""),
    });
    metaTrack("ViewContent", {
      content_name: pkg.name,
      content_ids: [pkg.slug],
      content_type: "product",
      value: pkg.value,
      currency: DEFAULT_CURRENCY,
    });
    return true;
  } catch {
    return false;
  }
};

export const trackCheckoutSessionStarted = ({ packageTitle, price, provider } = {}) => {
  try {
    const pkg = packageFields(packageTitle, price);
    if (!pkg) return false;
    trackEvent("checkout_started", {
      package: pkg.name,
      package_slug: pkg.slug,
      provider: String(provider || ""),
      value: pkg.value,
      currency: DEFAULT_CURRENCY,
    });
    metaTrack("InitiateCheckout", {
      content_name: pkg.name,
      content_ids: pkg.slug ? [pkg.slug] : [],
      content_type: "product",
      num_items: 1,
      value: pkg.value,
      currency: DEFAULT_CURRENCY,
    });
    return true;
  } catch {
    return false;
  }
};

const receipts = new Set();

const sendOnce = (key, send) => {
  try {
    if (receipts.has(key) || sessionStorage.getItem(key)) return;
  } catch {}
  receipts.add(key);
  Promise.resolve().then(send).catch(() => false).then((sent) => {
    if (!sent) {
      receipts.delete(key);
      return;
    }
    try { sessionStorage.setItem(key, "1"); } catch {}
  });
};

const trackPaidPurchaseOnMeta = (receipt) => {
  const pkg = packageFields(receipt.packageTitle, receipt.amount);
  return Boolean(pkg) && withMetaPixel((pixel) => pixel.metaTrackWhenGranted("Purchase", {
    content_name: pkg.name,
    content_ids: pkg.slug ? [pkg.slug] : [],
    content_type: "product",
    value: receipt.amount,
    currency: receipt.currency,
  }, { eventId: receipt.eventId }));
};

const trackCompletedBooking = async (receipt) => Boolean(await loadSalesAttribution()) &&
  trackEvent(receipt.paymentType === "paid" ? "booking_completed" : "free_booking_completed", {
    event_id: receipt.eventId,
    package: receipt.packageTitle,
    payment_type: receipt.paymentType,
    payment_provider: receipt.provider,
    amount: receipt.amount,
    currency: receipt.currency,
    referral_code: receipt.referralCode || "",
  }, { attribution: receipt.attribution ?? null });

const validReceipt = (receipt) => Boolean(receipt) && /^[a-f0-9]{40}$/.test(receipt.eventId || "") &&
  ["paid", "free"].includes(receipt.paymentType) && Number.isFinite(receipt.amount) && receipt.amount >= 0;

export const trackConfirmedPurchase = (receipt) => {
  if (!validReceipt(receipt)) return;
  sendOnce(`booking_completion_tracked:${receipt.eventId}`, () => trackCompletedBooking(receipt));
  if (receipt.paymentType === "paid") {
    sendOnce(`meta_purchase_tracked:${receipt.eventId}`, () => trackPaidPurchaseOnMeta(receipt));
  }
};
