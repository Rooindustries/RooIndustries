import { isProductionBrowser } from "./productionBrowser";
import { withPostHogOutbox } from "./analyticsModules";
import { CONSENT_EVENT, CONSENT_KEY, CONSENT_RESET_EVENT } from "./consentSignals";

let poppedAt = 0;
let choices = 0;
const chosen = () => { choices += 1; };
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => { poppedAt = Date.now(); });
  window.addEventListener(CONSENT_EVENT, chosen);
  window.addEventListener(CONSENT_RESET_EVENT, chosen);
  window.addEventListener("storage", ({ key }) => (key === CONSENT_KEY || key === null) && chosen());
}

export const lastPopstate = () => poppedAt;

export const consentChoices = () => choices;

export const postHogMoment = (event) => {
  const moment = { event, href: window.location.href, at: Date.now(), choices };
  withPostHogOutbox((outbox) => outbox.decide(moment));
  return moment;
};

const follow = (change) => {
  if (!isProductionBrowser()) return;
  const moment = postHogMoment("$pageview");
  withPostHogOutbox((outbox) => outbox.follow(moment, change));
};

export const loadPostHog = () => follow(false);

export const followPostHogChoice = () => follow(true);
