import { isProductionBrowser } from "./productionBrowser";
import { withMetaPixel, withSalesAttribution } from "./analyticsModules";
import packagePricing from "./packagePricing";
import { getCurrentArrivalSnapshot, keepPostHogEvent, snapRawAttr } from "./loadPostHog";

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
    const attributed = Object.hasOwn(options, "attribution");
    const rawLanding = attributed ? null : options.landing || getCurrentArrivalSnapshot();
    const prior = attributed ? null : snapRawAttr();
    const landing = rawLanding ? { ...rawLanding, prior } : null;
    if (options.postHog !== false) {
      keepPostHogEvent(
        eventName,
        data,
        attributed ? options : { ...options, prior, ...(rawLanding ? { landing: rawLanding } : {}) },
      );
    }
    ensureAnalyticsQueue();
    withSalesAttribution(({ attributionForLandingSnapshot, salesEventProperties, track }) => {
      const attr = attributed ? (options.attribution ?? null) : landing ? attributionForLandingSnapshot(landing) : undefined;
      track(eventName, { ...salesEventProperties(attr), ...data });
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
