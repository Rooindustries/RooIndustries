import { monitoringDsn } from "./scrub";

const dsn = process.env.NEXT_PUBLIC_ROO_SENTRY_ENABLED === "1"
  ? monitoringDsn(process.env.NEXT_PUBLIC_SENTRY_DSN)
  : undefined;
const MAX_PENDING = 10;
let pending = [];
let sentry = null;
let loading = false;
let retries = 0;

function load() {
  if (loading) return;
  loading = true;
  import("./browser")
    .then(({ startBrowserMonitoring }) => {
      sentry = startBrowserMonitoring(dsn);
      const queued = pending;
      pending = [];
      for (const error of queued) sentry.captureException(error);
    })
    .catch(() => {
      if (pending.length && retries < 2) {
        retries++;
        setTimeout(() => {
          loading = false;
          load();
        }, 500 * retries);
      } else {
        loading = false;
      }
    });
}

export function reportClientError(error) {
  if (!dsn) return;
  if (sentry) {
    sentry.captureException(error);
    return;
  }
  if (pending.length < MAX_PENDING) pending.push(error);
  if (!loading) retries = 0;
  load();
}

export function watchWindowErrors() {
  if (!dsn) return;
  const onError = (error) => {
    if (!sentry) reportClientError(error);
  };
  window.addEventListener("error", (event) => onError(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => onError(event.reason));
}
