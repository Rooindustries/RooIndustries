import { captureSalesAttribution, publicAnalyticsPath } from "./salesAttribution";

export const POSTHOG_DEFAULT_KEY = "phc_AqgCN7TfCu5fVECnkPCVjWAStC3grX4MmA3AmKXWu9qe";
export const POSTHOG_PROXY_PATH = "/ingest";
const POSTHOG_UI_HOST = "https://us.posthog.com";
const BOOKING_ID = /^[A-Za-z0-9._:-]{1,128}$/;

let client = null;
let loading = null;
const pending = [];

const projectKey = () => (process.env.NEXT_PUBLIC_POSTHOG_KEY || POSTHOG_DEFAULT_KEY).trim();

const cleanUrl = (value) => {
  try {
    const url = new URL(value, window.location.origin);
    const path = publicAnalyticsPath(url.pathname);
    return path ? `${url.origin}${path}` : undefined;
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
  if (!properties || typeof properties !== "object") return properties;
  const output = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value !== "string") output[key] = value;
    else if (/referrer$/i.test(key)) output[key] = cleanReferrer(value);
    else if (/(url|href)$/i.test(key)) {
      const url = cleanUrl(value);
      if (url) output[key] = url;
    } else if (/pathname$/i.test(key)) {
      const path = publicAnalyticsPath(value);
      if (path) output[key] = path;
    } else output[key] = value;
  }
  return output;
};

export const scrubPostHogEvent = (event) => {
  if (!event) return null;
  const properties = event.properties || {};
  if (!cleanUrl(properties.$current_url || window.location.href)) return null;
  return {
    ...event,
    properties: cleanProperties(properties),
    ...(event.$set ? { $set: cleanProperties(event.$set) } : {}),
    ...(event.$set_once ? { $set_once: cleanProperties(event.$set_once) } : {}),
  };
};

const maskNetworkRequest = (request) => {
  const url = cleanUrl(request.name);
  if (!url) return null;
  return { ...request, name: url, requestHeaders: undefined, responseHeaders: undefined, requestBody: undefined, responseBody: undefined };
};

export const posthogConfig = (journeyId) => ({
  api_host: POSTHOG_PROXY_PATH,
  ui_host: POSTHOG_UI_HOST,
  persistence: "memory",
  person_profiles: "identified_only",
  ...(journeyId ? { bootstrap: { distinctID: journeyId, isIdentifiedID: false } } : {}),
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
  save_referrer: true,
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: "*",
    recordHeaders: false,
    recordBody: false,
    captureJsonLd: false,
    maskCapturedNetworkRequestFn: maskNetworkRequest,
  },
  before_send: scrubPostHogEvent,
});

const flush = () => {
  while (client && pending.length) {
    const [method, ...args] = pending.shift();
    client[method](...args);
  }
};

const call = (method, ...args) => {
  if (pending.length >= 100) pending.shift();
  pending.push([method, ...args]);
  flush();
};

export const startPostHog = () => {
  if (loading || typeof window === "undefined") return loading;
  if (!projectKey() || !cleanUrl(window.location.href)) return null;
  loading = import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(projectKey(), posthogConfig(captureSalesAttribution()?.journeyId));
      client = posthog;
      flush();
      return posthog;
    })
    .catch(() => {
      loading = null;
      return null;
    });
  return loading;
};

export const capturePostHog = (eventName, properties = {}) => {
  call("capture", eventName, properties, { timestamp: new Date() });
};

export const identifyPostHogBooking = (bookingId) => {
  const id = String(bookingId || "").trim();
  if (!BOOKING_ID.test(id)) return false;
  call("identify", id);
  return true;
};
