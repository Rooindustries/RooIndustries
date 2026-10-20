import { captureException, init } from "@sentry/nextjs";
import {
  NO_DATA_COLLECTION,
  monitoringEnvironment,
  scrubBreadcrumb,
  scrubEvent,
} from "./scrub";

export function startBrowserMonitoring(dsn) {
  init({
    dsn,
    environment: monitoringEnvironment(),
    dataCollection: NO_DATA_COLLECTION,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  return { captureException };
}
