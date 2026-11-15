import { readConsent } from "./consent";
import { cleanOutsideValue } from "./outsideValue.cjs";
import { postHogQueued, takePostHogQueue } from "./postHogOutbox";

const DEFAULT_KEY = "phc_AqgCN7TfCu5fVECnkPCVjWAStC3grX4MmA3AmKXWu9qe";
const PROXY_PATH = "/ingest";
const COMPLETED_BOOKING = /^(?:free_)?booking_completed$/;
const INTERNAL_ID = /^[a-f0-9]{40}$/;

let client = null;
let sales = null;
let loading = null;

const granted = () => readConsent() === "granted";

const projectKey = () => cleanOutsideValue(process.env.NEXT_PUBLIC_POSTHOG_KEY || DEFAULT_KEY);

const deliver = (attribution) => ({ id, event, properties, path, at }) => {
  const booking = COMPLETED_BOOKING.test(event);
  if (booking && INTERNAL_ID.test(properties.event_id || "")) client.identify(properties.event_id);
  const page = { $current_url: `${window.location.origin}${path}`, $pathname: path };
  const options = { uuid: id, timestamp: new Date(at), transport: "sendBeacon" };
  client.capture(event, { ...attribution, ...properties, ...page }, options);
};

const flush = () => {
  if (!client) return;
  const items = takePostHogQueue();
  if (!items.length) return;
  const attribution = sales.salesEventProperties(sales.journeySalesAttribution());
  if (attribution.journey_id) client.useJourney(attribution.journey_id);
  items.forEach(deliver(attribution));
};

export const startPostHog = () => {
  if (client || loading || !projectKey() || !granted()) return;
  loading = Promise.all([import("./posthogClient"), import("./salesTracking")])
    .then(([{ createPostHog }, salesAttribution]) => {
      if (!granted()) return;
      client = createPostHog(projectKey(), PROXY_PATH, postHogQueued(), salesAttribution);
      sales = salesAttribution;
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

export const sendPostHog = (events) => {
  if (client) flush();
  else if (events.some((event) => COMPLETED_BOOKING.test(event))) startPostHog();
};
