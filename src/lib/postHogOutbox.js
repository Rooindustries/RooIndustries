import { readConsent } from "./consentChoice";
import { sanitizeAnalyticsEvent } from "./salesPaths";
import { declinedSince, followChoices } from "./consentSignals";
import { decodeFrozenPrior, sanitizeJourney, sanitizeLandingSnapshot } from "./campaignSanitizer";
import { sanitizeRefEntry } from "./refEntry.js";

const OUTBOX_KEY = "roo-posthog-outbox";
const LANDINGS_KEY = "roo_posthog_outbox_landings";
const COUNTED_KEY = "roo-posthog-counted";
const OUTBOX_LIMIT = 100;

let posthog = null;
let unstored = null;
let unstoredLandings = null;
let marksHere = {};

const granted = () => readConsent() === "granted";

const stored = (key) => {
  try {
    return JSON.parse(sessionStorage.getItem(key));
  } catch {
    return null;
  }
};

const read = () => {
  const items = unstored || stored(OUTBOX_KEY);
  return Array.isArray(items) ? items : [];
};
const readLandings = () => {
  const map = unstoredLandings || stored(LANDINGS_KEY);
  return map && typeof map === "object" && !Array.isArray(map) ? map : {};
};

const storedMarks = () => {
  const marks = stored(COUNTED_KEY);
  return marks && typeof marks === "object" && !Array.isArray(marks) ? marks : {};
};

const prune = (m, since) => Object.fromEntries(Object.entries(m).filter(([, at]) => at >= since));
const saveMarks = (marks) => {
  try {
    if (Object.keys(marks).length) sessionStorage.setItem(COUNTED_KEY, JSON.stringify(marks));
    else sessionStorage.removeItem(COUNTED_KEY);
  } catch {}
};
const keepMarks = (marks) => {
  marksHere = marks;
  saveMarks(marks);
};
const countOnce = (entries, since) => {
  const marks = prune({ ...storedMarks(), ...marksHere }, since);
  const kept = entries.filter(({ mark, at }) => !mark || (!Object.hasOwn(marks, mark) && Boolean((marks[mark] = at) || true)));
  return [kept, marks];
};

const current = (items, since = declinedSince()) => items.filter(({ at }) => at >= since);

const setOrRemove = (k, v) => (v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v));

const write = (items, landings = {}) => {
  const ids = new Set(items.map((item) => item.id));
  const pruned = Object.fromEntries(Object.entries(landings).filter(([id, snap]) => ids.has(id) && snap));
  let [prevO, prevL, wrote] = [null, null, false];
  try { prevO = sessionStorage.getItem(OUTBOX_KEY); } catch {}
  try { prevL = sessionStorage.getItem(LANDINGS_KEY); } catch {}
  const [nextO, nextL] = [items.length ? JSON.stringify(items) : null, Object.keys(pruned).length ? JSON.stringify(pruned) : null];
  const [k1, v1, p1, k2, v2] = (nextL?.length ?? 0) <= (prevL?.length ?? 0)
    ? [LANDINGS_KEY, nextL, prevL, OUTBOX_KEY, nextO]
    : [OUTBOX_KEY, nextO, prevO, LANDINGS_KEY, nextL];
  try {
    setOrRemove(k1, v1);
    wrote = true;
    setOrRemove(k2, v2);
    [unstored, unstoredLandings] = [null, null];
    return true;
  } catch {
    if (wrote) try { setOrRemove(k1, p1); } catch {}
    [unstored, unstoredLandings] = [items, pruned];
    return false;
  }
};

const followChoice = () => {
  if (granted()) {
    const since = declinedSince();
    marksHere = prune(marksHere, since);
    saveMarks(prune(storedMarks(), since));
    return;
  }
  write([], {});
  keepMarks({});
};

const withPostHog = (action) => {
  if (!posthog && !granted()) return;
  import("./posthog")
    .then((module) => {
      posthog = module;
      action(module);
    })
    .catch(() => {});
};

const cleanPath = (path) => {
  const url = sanitizeAnalyticsEvent({
    url: new URL(path, window.location.origin).href,
    type: "pageview",
  })?.url;
  return url && new URL(url).pathname;
};

const cleanExplicitAttribution = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const [ref, journey] = [sanitizeRefEntry(value.ref, null), sanitizeJourney(value)];
  return !journey ? (ref ? { ref } : null) : ref ? { ...journey, ref } : journey;
};

export const store = (entries) => {
  if (!granted()) return followChoice();
  const [since, nextLandings] = [declinedSince(), { ...readLandings() }];
  const fresh = current(entries, since).flatMap(({ path, landing, attribution, ...entry }) => {
    const cleaned = cleanPath(path);
    if (!cleaned) return [];
    if (entry.explicitAttribution) {
      const safeExplicit = cleanExplicitAttribution(attribution);
      if (safeExplicit && entry.id) nextLandings[entry.id] = { explicit: true, attribution: safeExplicit };
    } else if (landing) {
      const safeLanding = sanitizeLandingSnapshot(landing);
      if (safeLanding && entry.id) nextLandings[entry.id] = Object.hasOwn(landing, "prior") ? { ...safeLanding, prior: decodeFrozenPrior(landing.prior) } : safeLanding;
    }
    return [{ ...entry, path: cleaned }];
  });
  const [keptWithMark, nextMarks] = countOnce(fresh, since);
  const kept = keptWithMark.map(({ mark, ...entry }) => entry);
  const combined = current([...read(), ...kept], since).sort((a, b) => a.at - b.at).slice(-OUTBOX_LIMIT);
  if (write(combined, nextLandings)) keepMarks(nextMarks);
  else marksHere = nextMarks;
  if (kept.length) withPostHog(({ sendPostHog }) => sendPostHog(kept.map(({ event }) => event)));
};

export const follow = () => withPostHog(({ syncPostHogPage, startPostHogWhenIdle }) => { syncPostHogPage(); startPostHogWhenIdle(); });
export const postHogQueued = () => granted() && current(read()).length > 0;
export const takePostHogQueue = () => {
  followChoice();
  const landings = readLandings();
  const items = granted()
    ? current(read()).map((item) => {
        const entry = landings[item.id];
        if (item.explicitAttribution) return { ...item, attribution: entry?.explicit ? entry.attribution : null };
        return entry && !entry.explicit ? { ...item, landing: entry } : item;
      })
    : [];
  write([], {});
  if (granted() && items.length && Object.keys(marksHere).length) keepMarks(prune({ ...storedMarks(), ...marksHere }, declinedSince()));
  return items;
};

if (typeof window !== "undefined") {
  followChoice();
  followChoices(followChoice);
}
