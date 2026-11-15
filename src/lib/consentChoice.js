import { CONSENT_KEY } from "./consentSignals";

export const CHOICES = new Set(["granted", "denied"]);

let pageChoice = null;

const storedChoice = (storage) => {
  try {
    const value = window[storage].getItem(CONSENT_KEY);
    return CHOICES.has(value) ? value : "";
  } catch {
    return "";
  }
};

export const readConsent = () => {
  if (typeof window === "undefined") return "unset";
  if (pageChoice && storedChoice("localStorage") !== pageChoice.over) pageChoice = null;
  return pageChoice?.value || storedChoice("sessionStorage") || storedChoice("localStorage") || "unset";
};

export const keepUnsaved = (value) => {
  pageChoice = null;
  if (value && readConsent() !== value) pageChoice = { value, over: storedChoice("localStorage") };
};
