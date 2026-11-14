const CONSENT_KEY = "roo-consent";
const CONSENT_EVENT = "roo-consent-change";
const CONSENT_RESET_EVENT = "roo-consent-reset";

const CHOICES = new Set(["granted", "denied"]);

export const readConsent = () => {
  try {
    if (typeof window === "undefined") return "unset";
    const value = window.localStorage.getItem(CONSENT_KEY);
    return CHOICES.has(value) ? value : "unset";
  } catch {
    return "unset";
  }
};

export const writeConsent = (value) => {
  if (!CHOICES.has(value) || typeof window === "undefined") return false;
  let saved = false;
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
    saved = true;
  } catch {}
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: value }));
  return saved;
};

export const resetConsent = () => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CONSENT_KEY);
  } catch {}
  window.dispatchEvent(new CustomEvent(CONSENT_RESET_EVENT));
};

export const onConsentChange = (callback) => {
  if (typeof window === "undefined" || typeof callback !== "function") return () => {};
  const listener = (event) => callback(event.detail);
  window.addEventListener(CONSENT_EVENT, listener);
  return () => window.removeEventListener(CONSENT_EVENT, listener);
};

export const onConsentReset = (callback) => {
  if (typeof window === "undefined" || typeof callback !== "function") return () => {};
  window.addEventListener(CONSENT_RESET_EVENT, callback);
  return () => window.removeEventListener(CONSENT_RESET_EVENT, callback);
};
