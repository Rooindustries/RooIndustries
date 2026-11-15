export const CONSENT_KEY = "roo-consent";
export const CONSENT_EVENT = "roo-consent-change";
export const CONSENT_RESET_EVENT = "roo-consent-reset";
export const DECLINED_KEY = "roo-consent-declined";
export const STORAGES = ["localStorage", "sessionStorage"];

let declinedAt = 0;

const storedDecline = (storage, now) => {
  try {
    const at = Number(window[storage].getItem(DECLINED_KEY)) || 0;
    if (at > now) window[storage].setItem(DECLINED_KEY, String(now));
    return Math.min(at, now);
  } catch {
    return 0;
  }
};

export const declinedSince = () => {
  const now = Date.now();
  return Math.max(declinedAt, ...STORAGES.map((storage) => storedDecline(storage, now)));
};

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
