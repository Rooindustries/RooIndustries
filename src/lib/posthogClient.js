import posthog from "posthog-js";
import { captureSalesAttribution } from "./salesAttribution";
import { sanitizeAnalyticsEvent } from "./salesPaths";
import { lastPopstate } from "./loadPostHog";

const UI_HOST = "https://us.posthog.com";

const cleanUrl = (value) => {
  try {
    return sanitizeAnalyticsEvent({ url: new URL(value, window.location.origin).href, type: "pageview" })?.url;
  } catch {
    return undefined;
  }
};

const cleanReferrer = (value) => {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
};

const cleanProperties = (properties) => {
  const output = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value !== "string") output[key] = value;
    else if (/referrer$/i.test(key)) output[key] = cleanReferrer(value);
    else if (/(url|href)$/i.test(key)) {
      const url = cleanUrl(value);
      if (url) output[key] = url;
    } else if (/pathname$/i.test(key)) {
      const url = cleanUrl(value);
      if (url) output[key] = new URL(url).pathname;
    } else output[key] = value;
  }
  return output;
};

const privateSpans = [];
let navigatedAt = 0;

const noteHistoryChanges = () => {
  for (const method of ["pushState", "replaceState"]) {
    const original = window.history[method];
    window.history[method] = function (...args) {
      const at = Date.now();
      const before = window.location.pathname;
      const result = original.apply(this, args);
      if (window.location.pathname !== before) navigatedAt = at;
      return result;
    };
  }
};

const markPage = (publicPage) => {
  const open = privateSpans.at(-1);
  const now = Date.now();
  const changedAt = Math.max(navigatedAt, lastPopstate());
  if (!publicPage && (!open || open.end)) privateSpans.push({ start: changedAt > (open?.end || 0) ? changedAt : now });
  if (publicPage && open && !open.end) open.end = now;
};

const recordedOnPrivatePage = (timestamp) =>
  privateSpans.some(({ start, end }) => timestamp >= start && (!end || timestamp < end));

const scrubSnapshot = (event) => {
  const privateSince = cleanUrl(window.location.href) ? Infinity : Math.max(navigatedAt, lastPopstate());
  const items = (event.properties?.$snapshot_data || [])
    .filter((item) => item.timestamp < privateSince && !recordedOnPrivatePage(item.timestamp));
  return items.length ? { ...event, properties: { ...cleanProperties(event.properties), $snapshot_data: items } } : null;
};

const scrubEvent = (event) => {
  if (!event) return null;
  if (event.event === "$snapshot") return scrubSnapshot(event);
  const publicPage = Boolean(cleanUrl(event.properties?.$current_url || window.location.href));
  if (event.event === "$pageview") markPage(publicPage);
  if (!publicPage) return null;
  return {
    ...event,
    properties: cleanProperties(event.properties || {}),
    ...(event.$set ? { $set: cleanProperties(event.$set) } : {}),
    ...(event.$set_once ? { $set_once: cleanProperties(event.$set_once) } : {}),
  };
};

const LINK_TAGS = new Set(["A", "AREA", "FORM"]);

const maskAttribute = (name, value, element) => {
  if (!["href", "action"].includes(name) || !LINK_TAGS.has(element?.tagName)) return value;
  try {
    const url = new URL(value, window.location.href);
    if (url.origin !== window.location.origin) return value;
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
};

const maskNetworkRequest = (request) => {
  const url = cleanUrl(request.name);
  if (!url) return null;
  return { ...request, name: url, requestHeaders: undefined, responseHeaders: undefined, requestBody: undefined, responseBody: undefined };
};

const journeyIdentity = (journeyId) => ({ distinctID: journeyId, isIdentifiedID: false });

export const createPostHog = (key, apiHost, queued) => {
  const publicPage = Boolean(cleanUrl(window.location.href));
  if (!publicPage && !queued) return null;
  markPage(publicPage);
  const journeyId = captureSalesAttribution()?.journeyId;
  posthog.init(key, {
    api_host: apiHost,
    ui_host: UI_HOST,
    persistence: "memory",
    person_profiles: "identified_only",
    ...(journeyId ? { bootstrap: journeyIdentity(journeyId) } : {}),
    capture_pageview: "history_change",
    capture_pageleave: "if_capture_pageview",
    autocapture: false,
    rageclick: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_exceptions: false,
    capture_performance: false,
    disable_surveys: true,
    disable_product_tours: true,
    disable_web_experiments: true,
    disable_conversations: true,
    advanced_disable_feature_flags: true,
    mask_personal_data_properties: true,
    disable_session_recording: !publicPage,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
      recordHeaders: false,
      recordBody: false,
      captureJsonLd: false,
      maskAttributeFn: maskAttribute,
      maskCapturedNetworkRequestFn: maskNetworkRequest,
    },
    before_send: scrubEvent,
  });
  noteHistoryChanges();
  let recording = publicPage;
  return {
    syncPage: () => {
      const publicPage = Boolean(cleanUrl(window.location.href));
      if (publicPage === recording) return;
      recording = publicPage;
      if (publicPage) posthog.startSessionRecording();
      else posthog.stopSessionRecording();
    },
    capture: (...args) => posthog.capture(...args),
    identify: (id) => posthog.identify(id),
    useJourney: (journeyId) => {
      if (posthog.get_distinct_id() === journeyId || posthog.get_property("$user_state") === "identified") return;
      posthog.reset({ bootstrap: journeyIdentity(journeyId) });
    },
  };
};
