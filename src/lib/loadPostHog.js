import { isProductionBrowser } from "./productionBrowser";
import { readConsent } from "./consentChoice";
import { withPostHogOutbox } from "./analyticsModules";
import { CONSENT_EVENT, CONSENT_RESET_EVENT, followChoices, lastDecline } from "./consentSignals";

let poppedAt = 0;
let countedPath = null;
const made = [];

const granted = () => readConsent() === "granted";

const newId = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (digit) =>
  (digit ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (digit / 4)))).toString(16));

export const lastPopstate = () => poppedAt;

export const eventMoment = () =>
  isProductionBrowser() && granted() ? { path: window.location.pathname, at: Date.now() } : null;

export const keepPostHogEvent = (event, properties = {}, moment = eventMoment()) => {
  if (!moment || moment.at < lastDecline() || !granted()) return false;
  made.push({ id: newId(), event, properties, ...moment });
  withPostHogOutbox((outbox) => outbox.store(made.splice(0)));
  return true;
};

const follow = (change) => {
  if (!isProductionBrowser()) return;
  if (!change) countedPath = null;
  if (granted() && countedPath !== window.location.pathname) {
    countedPath = window.location.pathname;
    keepPostHogEvent("$pageview");
  }
  withPostHogOutbox((outbox) => outbox.follow());
};

export const loadPostHog = () => follow(false);

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => { poppedAt = Date.now(); });
  followChoices((declined) => {
    if (!declined && granted()) return;
    countedPath = null;
    made.length = 0;
  });
  window.addEventListener("pageshow", ({ persisted }) => persisted && loadPostHog());
  for (const name of [CONSENT_EVENT, CONSENT_RESET_EVENT]) window.addEventListener(name, () => follow(true));
}
