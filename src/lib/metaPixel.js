import { onConsentChange, readConsent } from "./consent";
import { metaPixelId } from "./analyticsModules";

const META_PIXEL_SCRIPT_ID = "roo-meta-pixel";
const META_PIXEL_SRC = "https://connect.facebook.net/en_US/fbevents.js";
const STANDARD_EVENTS = new Set(["PageView", "ViewContent", "InitiateCheckout", "Purchase"]);
const pixelState = { initializedId: "", granted: false };

const metaPixelAllowed = () =>
  typeof window !== "undefined" && typeof document !== "undefined" &&
  metaPixelId() !== "" && readConsent() === "granted";

const ensureFbq = () => {
  if (!window.fbq) {
    const fbq = function fbq(...args) {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue.push(args);
    };
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = "2.0";
    fbq.queue = [];
    fbq.disablePushState = true;
    window.fbq = fbq;
    if (!window._fbq) window._fbq = fbq;
  }
  if (!pixelState.granted) {
    window.fbq("consent", "grant");
    pixelState.granted = true;
  }
  const id = metaPixelId();
  if (pixelState.initializedId !== id) {
    window.fbq("set", "autoConfig", false, id);
    window.fbq("init", id);
    pixelState.initializedId = id;
  }
  return window.fbq;
};

export const loadMetaPixel = () => {
  try {
    if (!metaPixelAllowed()) return false;
    ensureFbq();
    if (document.getElementById(META_PIXEL_SCRIPT_ID)) return true;
    const script = document.createElement("script");
    script.id = META_PIXEL_SCRIPT_ID;
    script.async = true;
    script.src = META_PIXEL_SRC;
    document.head.appendChild(script);
    return true;
  } catch {
    return false;
  }
};

export const revokeMetaPixel = () => {
  try {
    if (typeof window === "undefined" || typeof window.fbq !== "function") return false;
    window.fbq("consent", "revoke");
    pixelState.granted = false;
    return true;
  } catch {
    return false;
  }
};

export const metaTrack = (event, data = {}, { eventId } = {}) => {
  try {
    if (!STANDARD_EVENTS.has(event) || !metaPixelAllowed()) return false;
    const fbq = ensureFbq();
    if (event === "PageView") fbq("track", "PageView");
    else if (eventId) fbq("track", event, data, { eventID: eventId });
    else fbq("track", event, data);
    return true;
  } catch {
    return false;
  }
};

const consentGranted = (signal) => new Promise((resolve) => {
  if (readConsent() === "granted" || signal?.aborted) {
    resolve(!signal?.aborted);
    return;
  }
  const finish = (granted) => {
    stopListening();
    signal?.removeEventListener("abort", cancel);
    resolve(granted);
  };
  const cancel = () => finish(false);
  const stopListening = onConsentChange((value) => {
    if (value === "granted") finish(true);
  });
  signal?.addEventListener("abort", cancel, { once: true });
});

export const metaTrackWhenGranted = async (event, data, options, signal) =>
  (await consentGranted(signal)) && metaTrack(event, data, options);
