import { lazyModule, loadSalesAttribution } from "./analyticsModules";
import { reportRequestError } from "./clientRequest";

const ANALYTICS_WAIT_LIMIT_MS = 300;

const checkoutStartCount = lazyModule(() => import("./checkoutStartCount"));

const withinAnalyticsWait = (pending, fallback) => Promise.race([
  pending,
  new Promise((resolve) => { setTimeout(resolve, ANALYTICS_WAIT_LIMIT_MS, fallback); }),
]);

export const preloadCheckoutStart = () => {
  checkoutStartCount.load().catch(reportRequestError);
  loadSalesAttribution();
};

const bookingSalesAttribution = async (stored) => {
  const module = await withinAnalyticsWait(loadSalesAttribution(), null);
  if (!module) return stored || null;
  return module.sanitizeSalesAttribution(stored) || module.captureSalesAttribution();
};

export const paymentStartBody = async ({ operation, provider, quoteFingerprint, salesAttribution, buildPayload }) => {
  const attribution = await bookingSalesAttribution(salesAttribution);
  if (!operation.current()) return "";
  return JSON.stringify({ provider, quoteFingerprint, bookingPayload: buildPayload(attribution) });
};

export const countCheckoutStartOnce = (data, provider, track) => withinAnalyticsWait(checkoutStartCount.load()
  .then(({ countCheckoutStart }) => countCheckoutStart(data, provider))
  .catch((error) => {
    reportRequestError(error);
    return data?.checkoutCreated === true;
  })
  .then((counted) => {
    if (counted) track();
  }));
