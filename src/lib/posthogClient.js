import posthog from "posthog-js";
import { captureSalesAttribution, sanitizeAnalyticsEvent } from "./salesAttribution";

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

const scrubEvent = (event) => {
  if (!event || !cleanUrl(event.properties?.$current_url || window.location.href)) return null;
  return {
    ...event,
    properties: cleanProperties(event.properties || {}),
    ...(event.$set ? { $set: cleanProperties(event.$set) } : {}),
    ...(event.$set_once ? { $set_once: cleanProperties(event.$set_once) } : {}),
  };
};

const maskNetworkRequest = (request) => {
  const url = cleanUrl(request.name);
  if (!url) return null;
  return { ...request, name: url, requestHeaders: undefined, responseHeaders: undefined, requestBody: undefined, responseBody: undefined };
};

export const createPostHog = (key, apiHost) => {
  const journeyId = captureSalesAttribution()?.journeyId;
  if (!journeyId) return null;
  posthog.init(key, {
    api_host: apiHost,
    ui_host: UI_HOST,
    persistence: "memory",
    person_profiles: "identified_only",
    bootstrap: { distinctID: journeyId, isIdentifiedID: false },
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
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
      recordHeaders: false,
      recordBody: false,
      captureJsonLd: false,
      maskCapturedNetworkRequestFn: maskNetworkRequest,
    },
    before_send: scrubEvent,
  });
  return posthog;
};
