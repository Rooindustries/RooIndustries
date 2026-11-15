import { readConsent, storedDecline } from "./consent";
import { sanitizeAnalyticsEvent } from "./salesPaths";
import { followChoices, lastDecline } from "./consentSignals";

const OUTBOX_KEY = "roo-posthog-outbox";
const COUNTED_KEY = "roo-posthog-counted";
const OUTBOX_LIMIT = 100;

let posthog = null;
let unstored = null;
const countedHere = new Set();

const granted = () => readConsent() === "granted";

const storedList = (key) => {
  try {
    const items = JSON.parse(sessionStorage.getItem(key));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
};

const read = () => unstored || storedList(OUTBOX_KEY);

const firstCount = (mark) => {
  const marks = storedList(COUNTED_KEY);
  if (countedHere.has(mark) || marks.includes(mark)) return false;
  countedHere.add(mark);
  try {
    sessionStorage.setItem(COUNTED_KEY, JSON.stringify([...marks, mark]));
  } catch {}
  return true;
};

const current = (items) => {
  const declined = Math.max(lastDecline(), storedDecline());
  return items.filter(({ at }) => at >= declined);
};

const write = (items) => {
  try {
    if (items.length) sessionStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
    else sessionStorage.removeItem(OUTBOX_KEY);
    unstored = null;
  } catch {
    unstored = items;
  }
};

const followChoice = () => {
  if (granted()) return;
  write([]);
  countedHere.clear();
  try {
    sessionStorage.removeItem(COUNTED_KEY);
  } catch {}
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
  const url = sanitizeAnalyticsEvent({ url: new URL(path, window.location.origin).href, type: "pageview" })?.url;
  return url && new URL(url).pathname;
};

export const store = (entries) => {
  if (!granted()) {
    followChoice();
    return;
  }
  const kept = entries.flatMap(({ path, mark, ...entry }) => {
    const cleaned = cleanPath(path);
    return cleaned && (!mark || firstCount(mark)) ? [{ ...entry, path: cleaned }] : [];
  });
  write(current([...read(), ...kept]).sort((a, b) => a.at - b.at).slice(-OUTBOX_LIMIT));
  if (kept.length) withPostHog(({ sendPostHog }) => sendPostHog(kept.map(({ event }) => event)));
};

export const follow = () => withPostHog(({ syncPostHogPage, startPostHogWhenIdle }) => {
  syncPostHogPage();
  startPostHogWhenIdle();
});

export const postHogQueued = () => granted() && current(read()).length > 0;

export const takePostHogQueue = () => {
  followChoice();
  const items = granted() ? current(read()) : [];
  write([]);
  return items;
};

if (typeof window !== "undefined") {
  followChoice();
  followChoices(followChoice);
}
