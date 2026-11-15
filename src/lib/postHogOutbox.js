import { readConsent } from "./consent";
import { sanitizeAnalyticsEvent } from "./salesPaths";
import { declinedSince, followChoices } from "./consentSignals";

const OUTBOX_KEY = "roo-posthog-outbox";
const COUNTED_KEY = "roo-posthog-counted";
const OUTBOX_LIMIT = 100;

let posthog = null;
let unstored = null;
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

const storedMarks = () => {
  const marks = stored(COUNTED_KEY);
  return marks && typeof marks === "object" && !Array.isArray(marks) ? marks : {};
};

const keepMarks = (marks) => {
  marksHere = marks;
  try {
    if (Object.keys(marks).length) sessionStorage.setItem(COUNTED_KEY, JSON.stringify(marks));
    else sessionStorage.removeItem(COUNTED_KEY);
  } catch {}
};

const countOnce = (entries, since) => {
  const marks = Object.fromEntries(Object.entries({ ...storedMarks(), ...marksHere }).filter(([, at]) => at >= since));
  const kept = entries.filter(({ mark, at }) => {
    if (!mark) return true;
    if (Object.hasOwn(marks, mark)) return false;
    marks[mark] = at;
    return true;
  });
  keepMarks(marks);
  return kept;
};

const current = (items, since = declinedSince()) => items.filter(({ at }) => at >= since);

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
  if (granted()) {
    countOnce([], declinedSince());
    return;
  }
  write([]);
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
  const url = sanitizeAnalyticsEvent({ url: new URL(path, window.location.origin).href, type: "pageview" })?.url;
  return url && new URL(url).pathname;
};

export const store = (entries) => {
  if (!granted()) {
    followChoice();
    return;
  }
  const since = declinedSince();
  const fresh = current(entries, since).flatMap(({ path, ...entry }) => {
    const cleaned = cleanPath(path);
    return cleaned ? [{ ...entry, path: cleaned }] : [];
  });
  const kept = countOnce(fresh, since).map(({ mark, ...entry }) => entry);
  write(current([...read(), ...kept], since).sort((a, b) => a.at - b.at).slice(-OUTBOX_LIMIT));
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
