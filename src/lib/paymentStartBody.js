import { lazyModule, loadSalesAttribution } from "./analyticsModules";
import { reportRequestError } from "./clientRequest";
import { normalizeLinkReferral } from "./refShape.js";

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

const cleanTouch = (t) => {
  if (!t || typeof t !== "object" || Array.isArray(t) || !Object.hasOwn(t, "creatorCode")) return t;
  const safe = normalizeLinkReferral(t.creatorCode);
  const { creatorCode: _i, ...rest } = t;
  return safe ? { ...rest, creatorCode: safe } : rest;
};
const fallbackBookingAttribution = (stored) => {
  const obj = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : null;
  let ref = null;
  try {
    ref = window.__rooChooseRef?.(obj?.ref) || null;
  } catch {}
  if (!obj?.journeyId) return ref ? { ref } : null;
  const { ref: _i, ...rest } = obj;
  const cleaned = cleanTouch({
    ...rest, ...(rest.firstTouch ? { firstTouch: cleanTouch(rest.firstTouch) } : {}),
    ...(rest.lastTouch ? { lastTouch: cleanTouch(rest.lastTouch) } : {}),
  });
  return ref ? { ...cleaned, ref } : cleaned;
};
const bookingSalesAttribution = async (stored) => {
  try {
    const module = await withinAnalyticsWait(loadSalesAttribution(), null);
    if (module) {
      const fromMod = await Promise.resolve().then(() => module.bookingSalesAttribution(stored)).catch(() => undefined);
      if (fromMod !== undefined) return fromMod;
    }
    return fallbackBookingAttribution(stored);
  } catch {
    return null;
  }
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
