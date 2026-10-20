const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
let pending = [];
let sentry = null;
let loading = false;

function load() {
  if (loading) return;
  loading = true;
  import("./browser")
    .then(({ startBrowserMonitoring }) => {
      sentry = startBrowserMonitoring(dsn);
      for (const error of pending.splice(0)) sentry.captureException(error);
    })
    .catch(() => {
      pending = null;
    });
}

export function reportClientError(error) {
  if (!dsn || !pending) return;
  if (sentry) {
    sentry.captureException(error);
    return;
  }
  pending.push(error);
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
