import { captureException, init } from "@sentry/nextjs";
import {
  NO_DATA_COLLECTION,
  envelopeHeaderScrubber,
  monitoringEnvironment,
  scrubBreadcrumb,
  scrubEvent,
} from "./scrub";

export function startBrowserMonitoring(dsn) {
  const client = init({
    dsn,
    environment: monitoringEnvironment(),
    tunnel: "/api/client-report",
    tracePropagationTargets: [],
    dataCollection: NO_DATA_COLLECTION,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  client?.on("beforeEnvelope", envelopeHeaderScrubber(dsn, monitoringEnvironment()));
  return { captureException };
}
