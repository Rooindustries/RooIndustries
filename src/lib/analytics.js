import { isProductionBrowser } from "./productionBrowser";
import { track } from "@vercel/analytics/react";
import { withMetaPixel, withSalesAttribution } from "./analyticsModules";
import packagePricing from "./packagePricing";
import { keepPostHogEvent } from "./loadPostHog";

export { eventMoment } from "./loadPostHog";

const { getPackageSlug, toMoney } = packagePricing;
export const DEFAULT_CURRENCY = "USD";

export const metaTrack = (event, data, options) => withMetaPixel((pixel) => pixel.metaTrack(event, data, options));

export const packageFields = (title, price) => {
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
    if (options.postHog !== false) keepPostHogEvent(eventName, data, options.moment);
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
