import { readConsent } from "./consent";
import { cleanOutsideValue } from "./outsideValue.cjs";
import { postHogQueued, takePostHogQueue } from "./postHogOutbox";

const DEFAULT_KEY = "phc_AqgCN7TfCu5fVECnkPCVjWAStC3grX4MmA3AmKXWu9qe";
const PROXY_PATH = "/ingest";
const COMPLETED_BOOKING = /^(?:free_)?booking_completed$/;
const INTERNAL_ID = /^[a-f0-9]{40}$/;
const JOURNEY_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

let client = null;
let loading = null;

const granted = () => readConsent() === "granted";

const projectKey = () => cleanOutsideValue(process.env.NEXT_PUBLIC_POSTHOG_KEY || DEFAULT_KEY);

const deliver = ({ event, properties, url, at }) => {
  if (JOURNEY_ID.test(properties.journey_id || "")) client.useJourney(properties.journey_id);
  if (COMPLETED_BOOKING.test(event) && INTERNAL_ID.test(properties.event_id || "")) {
    client.identify(properties.event_id);
  }
  const page = { $current_url: url, $pathname: new URL(url).pathname };
  client.capture(event, { ...properties, ...page }, { timestamp: new Date(at), transport: "sendBeacon" });
};

const flush = () => {
  if (client) takePostHogQueue().forEach(deliver);
};

export const startPostHog = () => {
  if (client || loading || !projectKey() || !granted()) return;
  loading = Promise.all([import("./posthogClient"), import("./salesAttribution")])
    .then(([{ createPostHog }, sales]) => {
      if (!granted()) return;
      client = createPostHog(projectKey(), PROXY_PATH, postHogQueued(), sales);
      flush();
    })
    .catch(() => {})
    .finally(() => {
      loading = null;
    });
};

export const startPostHogWhenIdle = () => {
  if ("requestIdleCallback" in window) window.requestIdleCallback(startPostHog, { timeout: 4000 });
  else window.setTimeout(startPostHog, 1200);
};

export const syncPostHogPage = () => client?.syncPage();

export const sendPostHog = (event) => {
  if (client) flush();
  else if (COMPLETED_BOOKING.test(event)) startPostHog();
};
