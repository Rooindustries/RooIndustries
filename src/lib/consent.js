import { CONSENT_EVENT, CONSENT_KEY, CONSENT_RESET_EVENT } from "./consentSignals";
import { CHOICES, keepUnsaved, readConsent } from "./consentChoice";

export { readConsent };

let followingOtherTabs = false;

const forgetChoice = (storage) => {
  try {
    window[storage].removeItem(CONSENT_KEY);
  } catch {}
};

const announce = (value) => {
  window.dispatchEvent(CHOICES.has(value)
    ? new CustomEvent(CONSENT_EVENT, { detail: value })
    : new CustomEvent(CONSENT_RESET_EVENT));
};

const followOtherTab = (event) => {
  if (event.key !== CONSENT_KEY && event.key !== null) return;
  keepUnsaved("");
  forgetChoice("sessionStorage");
  announce(readConsent());
};

const followOtherTabs = () => {
  if (followingOtherTabs) return;
  followingOtherTabs = true;
  window.addEventListener("storage", followOtherTab);
};

export const writeConsent = (value) => {
  if (!CHOICES.has(value) || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
    forgetChoice("sessionStorage");
  } catch {
    forgetChoice("localStorage");
    try {
      window.sessionStorage.setItem(CONSENT_KEY, value);
    } catch {}
  }
  keepUnsaved(value);
  announce(value);
};

export const resetConsent = () => {
  if (typeof window === "undefined") return;
  forgetChoice("localStorage");
  forgetChoice("sessionStorage");
  keepUnsaved("unset");
  announce("unset");
};

export const onConsentChange = (callback) => {
  if (typeof window === "undefined") return () => {};
  followOtherTabs();
  const listener = (event) => callback(event.detail);
  window.addEventListener(CONSENT_EVENT, listener);
  return () => window.removeEventListener(CONSENT_EVENT, listener);
};

export const onConsentReset = (callback) => {
  if (typeof window === "undefined") return () => {};
  followOtherTabs();
  window.addEventListener(CONSENT_RESET_EVENT, callback);
  return () => window.removeEventListener(CONSENT_RESET_EVENT, callback);
};
