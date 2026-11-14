export const CONSENT_KEY = "roo-consent";
export const CONSENT_EVENT = "roo-consent-change";
export const CONSENT_RESET_EVENT = "roo-consent-reset";

export const followChoices = (callback) => {
  for (const name of [CONSENT_EVENT, CONSENT_RESET_EVENT, "storage"]) {
    window.addEventListener(name, ({ key = CONSENT_KEY }) => (key === CONSENT_KEY || key === null) && callback());
  }
};
