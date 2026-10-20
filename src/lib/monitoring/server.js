import { init } from "@sentry/nextjs";
import {
  NO_DATA_COLLECTION,
  monitoringEnvironment,
  scrubBreadcrumb,
  scrubEvent,
} from "./scrub";

export function startServerMonitoring(dsn) {
  init({
    dsn,
    environment: monitoringEnvironment(),
    tracesSampleRate: 0.05,
    traceLifecycle: "static",
    dataCollection: NO_DATA_COLLECTION,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}
