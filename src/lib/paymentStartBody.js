import { lazyModule, loadSalesAttribution } from "./analyticsModules";
import { reportRequestError } from "./clientRequest";
import { chooseFirstTouchRef } from "./refEntry.js";
import { getCurrentArrivalSnapshot, snapRawAttr } from "./loadPostHog";
import { mergeJourneyMonotonic, resolveFrozenJourney } from "./campaignSanitizer";

const checkoutStartCount = lazyModule(() => import("./bookingAnalytics"));
export const snapPaymentStart = () => {
  const raw = snapRawAttr();
  try { raw.r = window.__rooReadRef?.() ?? null; } catch { raw.r = null; }
  return [getCurrentArrivalSnapshot(), raw];
};
const wait = (p, fb) => Promise.race([p, new Promise((r) => setTimeout(r, 300, fb))]);
const fallback = (stored, arrival, raw, attrPromise, op) => {
  let ref = null;
  try { ref = chooseFirstTouchRef([raw?.r, stored?.ref]); } catch {}
  const res = resolveFrozenJourney(stored, arrival, raw, null, null, snapRawAttr());
  const base = res[0];
  if (!res[1] && base) {
    window.__rooAttrOverlay = mergeJourneyMonotonic(base, window.__rooAttrOverlay) || base;
    attrPromise.then((m) => op.current() && m?.writeStoredAttribution?.(base)).catch(() => {});
  }
  return !base ? (ref ? { ref } : null) : ref ? { ...base, ref } : base;
};
export const preloadCheckoutStart = () => {
  checkoutStartCount.load().catch(reportRequestError);
  loadSalesAttribution();
};
export const paymentStartBody = async ({ operation, provider, quoteFingerprint, salesAttribution, startSnap, buildPayload }) => {
  const snap = startSnap || snapPaymentStart();
  const attrPromise = loadSalesAttribution();
  let mod = null;
  try { mod = await wait(attrPromise, null); } catch {}
  if (!operation.current()) return "";
  const attr = mod?.resolveBookingAttribution
    ? mod.resolveBookingAttribution(salesAttribution, snap[0], snap[1])
    : fallback(salesAttribution, snap[0], snap[1], attrPromise, operation);
  return JSON.stringify({ provider, quoteFingerprint, bookingPayload: buildPayload(attr) });
};
export const countCheckoutStartOnce = (data, provider, track) =>
  wait(
    checkoutStartCount.load()
      .then(({ countCheckoutStart }) => countCheckoutStart(data, provider))
      .catch((error) => { reportRequestError(error); return data?.checkoutCreated === true; })
      .then((counted) => { if (counted) track(); }),
  );
