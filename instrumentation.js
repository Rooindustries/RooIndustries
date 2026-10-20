export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PUBLIC_SENTRY_DSN) {
    const { startServerMonitoring } = await import("./src/lib/monitoring/server");
    startServerMonitoring(process.env.NEXT_PUBLIC_SENTRY_DSN);
  }
}

export async function onRequestError(...args) {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PUBLIC_SENTRY_DSN) {
    const { captureRequestError } = await import("@sentry/nextjs");
    captureRequestError(...args);
  }
}
