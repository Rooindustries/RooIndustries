const CONSENT_KEY = "roo-consent";
const CONSENT_EVENT = "roo-consent-change";
const CONSENT_RESET_EVENT = "roo-consent-reset";

const CHOICES = new Set(["granted", "denied"]);

let pageChoice = null;
let followingOtherTabs = false;

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

const unsavedChoice = () => {
  if (pageChoice && storedChoice("localStorage") !== pageChoice.over) pageChoice = null;
  return pageChoice?.value || "";
};

export const readConsent = () => {
  if (typeof window === "undefined") return "unset";
  return unsavedChoice() || storedChoice("sessionStorage") || storedChoice("localStorage") || "unset";
};

const keepUnsaved = (value) => {
  pageChoice = null;
  if (readConsent() !== value) pageChoice = { value, over: storedChoice("localStorage") };
};

const announce = (value) => {
  window.dispatchEvent(CHOICES.has(value)
    ? new CustomEvent(CONSENT_EVENT, { detail: value })
    : new CustomEvent(CONSENT_RESET_EVENT));
};

const followOtherTab = (event) => {
  if (event.key !== CONSENT_KEY && event.key !== null) return;
  pageChoice = null;
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
