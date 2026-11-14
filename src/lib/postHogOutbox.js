import { readConsent } from "./consent";
import { sanitizeAnalyticsEvent } from "./salesPaths";
import { consentChoices } from "./loadPostHog";

const OUTBOX_KEY = "roo-posthog-outbox";
const OUTBOX_LIMIT = 100;
const CAMPAIGN = /^utm_(?:source|medium|campaign|content|term)$/;

let posthog = null;
let outbox = null;
let declines = 0;
let countedPath = null;

const granted = () => readConsent() === "granted";

const queue = () => {
  if (outbox) return outbox;
  try {
    outbox = JSON.parse(sessionStorage.getItem(OUTBOX_KEY));
  } catch {}
  if (!Array.isArray(outbox)) outbox = [];
  return outbox;
};

const save = () => {
  try {
    if (outbox.length) sessionStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
    else sessionStorage.removeItem(OUTBOX_KEY);
  } catch {}
};

const forget = () => {
  declines += 1;
  countedPath = null;
  outbox = [];
  save();
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

export const decide = (moment) => {
  moment.ticket = moment.choices === consentChoices() && granted() ? declines : -1;
};

export const record = (moment, properties) => {
  if (moment.ticket !== declines) return;
  if (!granted()) {
    forget();
    return;
  }
  const url = sanitizeAnalyticsEvent({ url: moment.href, type: "pageview" })?.url;
  if (!url) return;
  const items = queue();
  items.push({ event: moment.event, properties, url, at: moment.at });
  items.splice(0, items.length - OUTBOX_LIMIT);
  save();
  withPostHog(({ sendPostHog }) => sendPostHog(moment.event));
};

export const follow = (moment, change) => {
  const { pathname, search } = new URL(moment.href);
  if (!change) countedPath = null;
  if (moment.ticket !== declines) {
    if (!granted()) forget();
  } else if (countedPath !== pathname) {
    countedPath = pathname;
    record(moment, Object.fromEntries([...new URLSearchParams(search)].filter(([key]) => CAMPAIGN.test(key))));
  }
  withPostHog(({ syncPostHogPage, startPostHogWhenIdle }) => {
    syncPostHogPage();
    startPostHogWhenIdle();
  });
};

export const postHogQueued = () => granted() && queue().length > 0;

export const takePostHogQueue = () => {
  if (!granted()) {
    forget();
    return [];
  }
  const items = queue().splice(0);
  save();
  return items;
};
