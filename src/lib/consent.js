import { CONSENT_EVENT, CONSENT_KEY, CONSENT_RESET_EVENT } from "./consentSignals";
import { CHOICES, keepUnsaved, readConsent } from "./consentChoice";

export { readConsent };

const DECLINED_KEY = "roo-consent-declined";
const STORAGES = ["localStorage", "sessionStorage"];

let followingOtherTabs = false;

const keep = (key, value) => STORAGES.find((storage) => {
  try {
    window[storage].setItem(key, value);
    return true;
  } catch {
    return false;
  }
});

const keepDecline = () => keep(DECLINED_KEY, String(Date.now()));

export const storedDecline = () => Math.max(...STORAGES.map((storage) => {
  try {
    return Number(window[storage].getItem(DECLINED_KEY)) || 0;
  } catch {
    return 0;
  }
}));

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
  if (value !== "granted") keepDecline();
  const kept = keep(CONSENT_KEY, value);
  STORAGES.filter((storage) => storage !== kept).forEach(forgetChoice);
  keepUnsaved(value);
  announce(value);
};

export const resetConsent = () => {
  if (typeof window === "undefined") return;
  keepDecline();
  STORAGES.forEach(forgetChoice);
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
