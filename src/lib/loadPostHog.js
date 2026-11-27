import { isProductionBrowser } from "./productionBrowser";
import { readConsent, readSharedConsent } from "./consentChoice";
import { withPostHogOutbox } from "./analyticsModules";
import { CONSENT_EVENT, CONSENT_RESET_EVENT, declinedSince, followChoices } from "./consentSignals";
import { salesPath } from "./salesPaths";

let poppedAt = 0;
let countedPath = null;
let currentArrival = null;
const made = [];

const granted = () => readConsent() === "granted";

export const snapRawAttr = () => {
  const r = { g: granted() && readSharedConsent() === "granted", s: "", p: "", c: "", o: window.__rooAttrOverlay || null };
  try { r.s = sessionStorage.getItem("sales_attribution") || ""; } catch {}
  try { r.p = sessionStorage.getItem("roo_pending_arrival_touch") || ""; } catch {}
  try { r.c = document.cookie || ""; } catch {}
  return r;
};

const newId = () => crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export const lastPopstate = () => poppedAt;
export const setCurrentArrivalSnapshot = (snap) => {
  currentArrival = snap || null;
};
export const getCurrentArrivalSnapshot = () => currentArrival;

export const eventMoment = () =>
  isProductionBrowser() && granted()
    ? { path: window.location.pathname, at: Math.max(Date.now(), declinedSince()) }
    : null;

const arrivalForPath = (p) =>
  currentArrival && currentArrival.landingPath === salesPath(p || "") ? currentArrival : null;

export const keepPostHogEvent = (event, properties, options) => {
  try {
    const o = options || {};
    const { moment = eventMoment(), mark, landing } = o;
    if (!moment || moment.at < declinedSince() || !granted()) return false;
    const exp = "attribution" in o;
    const base = exp ? null : landing || arrivalForPath(moment.path);
    const prior = base ? ("prior" in o ? o.prior : snapRawAttr()) : null;
    made.push({
      id: newId(), event, properties, mark, ...moment,
      ...(exp ? { explicitAttribution: true, attribution: o.attribution ?? null } : base ? { landing: { ...base, prior } } : {}),
    });
    withPostHogOutbox((outbox) => outbox.store(made.splice(0)));
    return true;
  } catch { return false; }
};

const follow = (change) => {
  if (!isProductionBrowser()) return;
  if (!change) countedPath = null;
  const p = window.location.pathname;
  if (granted() && countedPath !== p) {
    countedPath = p;
    const landing = arrivalForPath(p);
    keepPostHogEvent("$pageview", undefined, landing ? { landing } : undefined);
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
