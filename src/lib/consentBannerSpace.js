export const CONSENT_BANNER_SPACE = "--consent-banner-space";

export const readConsentBannerSpace = () =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue(CONSENT_BANNER_SPACE)) || 0;
