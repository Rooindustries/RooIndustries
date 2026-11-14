const DEFAULT_KEY = "phc_AqgCN7TfCu5fVECnkPCVjWAStC3grX4MmA3AmKXWu9qe";
const PROXY_PATH = "/ingest";
const COMPLETED_BOOKING = /^(?:free_)?booking_completed$/;
const INTERNAL_ID = /^[a-f0-9]{40}$/;
const JOURNEY_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const QUEUE_LIMIT = 100;

let client = null;
let loading = null;
const pending = [];

const projectKey = () => String(process.env.NEXT_PUBLIC_POSTHOG_KEY || DEFAULT_KEY).trim();

const flush = () => {
  while (client && pending.length) {
    const [method, ...args] = pending.shift();
    client[method](...args);
  }
};

const call = (method, ...args) => {
  if (pending.length >= QUEUE_LIMIT) pending.shift();
  pending.push([method, ...args]);
  flush();
};

export const startPostHog = () => {
  if (client || loading || !projectKey()) return;
  loading = import("./posthogClient")
    .then(({ createPostHog }) => {
      client = createPostHog(projectKey(), PROXY_PATH, pending.length > 0);
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

export const syncPostHogPage = () => {
  client?.syncPage();
};

export const capturePostHog = (eventName, properties = {}, { url = window.location.href, timestamp = new Date() } = {}) => {
  if (JOURNEY_ID.test(properties.journey_id || "")) call("useJourney", properties.journey_id);
  if (COMPLETED_BOOKING.test(eventName) && INTERNAL_ID.test(properties.event_id || "")) {
    call("identify", properties.event_id);
  }
  call("capture", eventName, { ...properties, $current_url: url, $pathname: new URL(url).pathname }, { timestamp });
  if (COMPLETED_BOOKING.test(eventName)) startPostHog();
};
