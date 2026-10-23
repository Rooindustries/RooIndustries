import { monitoringDsn } from "./src/lib/monitoring/scrub";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && monitoringDsn(process.env.NEXT_PUBLIC_SENTRY_DSN)) {
    try {
      const { startServerMonitoring } = await import("./src/lib/monitoring/server");
      startServerMonitoring(process.env.NEXT_PUBLIC_SENTRY_DSN);
    } catch {
      console.error("Server error reporting is unavailable.");
    }
  }
}

export async function onRequestError(...args) {
  if (process.env.NEXT_RUNTIME === "nodejs" && monitoringDsn(process.env.NEXT_PUBLIC_SENTRY_DSN)) {
    const { captureRequestError } = await import("@sentry/nextjs");
    captureRequestError(...args);
  }
}
