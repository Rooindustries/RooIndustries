const CONSENT_KEY = "roo-consent";
const CONSENT_EVENT = "roo-consent-change";
const CONSENT_RESET_EVENT = "roo-consent-reset";

const CHOICES = new Set(["granted", "denied"]);

let pageChoice = null;

const storedChoice = (storage) => {
  try {
    const value = window[storage].getItem(CONSENT_KEY);
    return CHOICES.has(value) ? value : "";
  } catch {
    return "";
  }
};

const forgetChoice = (storage) => {
  try {
    window[storage].removeItem(CONSENT_KEY);
  } catch {}
};

export const readConsent = () => {
  if (typeof window === "undefined") return "unset";
  return pageChoice || storedChoice("sessionStorage") || storedChoice("localStorage") || "unset";
};

export const writeConsent = (value) => {
  if (!CHOICES.has(value) || typeof window === "undefined") return;
  pageChoice = value;
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
    forgetChoice("sessionStorage");
  } catch {
    forgetChoice("localStorage");
    try {
      window.sessionStorage.setItem(CONSENT_KEY, value);
    } catch {}
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: value }));
};

export const resetConsent = () => {
  if (typeof window === "undefined") return;
  pageChoice = "unset";
  forgetChoice("localStorage");
  forgetChoice("sessionStorage");
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
