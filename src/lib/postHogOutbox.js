import { readConsent } from "./consent";
import { sanitizeAnalyticsEvent } from "./salesPaths";
import { followChoices } from "./consentSignals";

const OUTBOX_KEY = "roo-posthog-outbox";
const OUTBOX_LIMIT = 100;

let posthog = null;
let unstored = null;

const granted = () => readConsent() === "granted";

const read = () => {
  if (unstored) return unstored;
  try {
    const items = JSON.parse(sessionStorage.getItem(OUTBOX_KEY));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
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
  if (!granted()) write([]);
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
    write([]);
    return;
  }
  const kept = entries.flatMap(({ path, ...entry }) => {
    const cleaned = cleanPath(path);
    return cleaned ? [{ ...entry, path: cleaned }] : [];
  });
  if (!kept.length) return;
  write([...read(), ...kept].slice(-OUTBOX_LIMIT));
  withPostHog(({ sendPostHog }) => sendPostHog(kept.map(({ event }) => event)));
};

export const follow = () => withPostHog(({ syncPostHogPage, startPostHogWhenIdle }) => {
  syncPostHogPage();
  startPostHogWhenIdle();
});

export const postHogQueued = () => granted() && read().length > 0;

export const takePostHogQueue = () => {
  followChoice();
  const items = granted() ? read() : [];
  if (items.length) write([]);
  return items;
};

if (typeof window !== "undefined") {
  followChoice();
  followChoices(followChoice);
}
