import * as Sentry from "@sentry/nextjs";
import {
  NO_DATA_COLLECTION,
  monitoringEnvironment,
  scrubBreadcrumb,
  scrubEvent,
} from "./src/lib/monitoring/scrub";

export function register() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: monitoringEnvironment(),
    tracesSampleRate: 0.05,
    dataCollection: NO_DATA_COLLECTION,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}

export const onRequestError = Sentry.captureRequestError;
