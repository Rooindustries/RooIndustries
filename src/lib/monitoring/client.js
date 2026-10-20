const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const MAX_PENDING = 10;
let pending = [];
let sentry = null;
let loading = false;

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
      loading = false;
    });
}

export function reportClientError(error) {
  if (!dsn) return;
  if (sentry) {
    sentry.captureException(error);
    return;
  }
  if (pending.length < MAX_PENDING) pending.push(error);
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
