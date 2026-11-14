export const CONSENT_KEY = "roo-consent";
export const CONSENT_EVENT = "roo-consent-change";
export const CONSENT_RESET_EVENT = "roo-consent-reset";

let declinedAt = 0;

export const lastDecline = () => declinedAt;

export const followChoices = (callback) => {
  for (const name of [CONSENT_EVENT, CONSENT_RESET_EVENT, "storage"]) {
    window.addEventListener(name, ({ key = CONSENT_KEY, newValue, detail }) => {
      if (key !== CONSENT_KEY && key !== null) return;
      const declined = (newValue ?? detail) !== "granted";
      if (declined) declinedAt = Date.now();
      callback(declined);
    });
  }
  window.addEventListener("pageshow", ({ persisted }) => persisted && callback());
};
