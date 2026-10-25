import { captureException, init } from "@sentry/nextjs";
import {
  NO_DATA_COLLECTION,
  envelopeHeaderScrubber,
  monitoringDsn,
  monitoringEnvironment,
  scrubBreadcrumb,
  scrubEvent,
} from "./scrub";

export function startBrowserMonitoring(value) {
  if (process.env.NEXT_PUBLIC_ROO_SENTRY_ENABLED !== "1") return null;
  const dsn = monitoringDsn(value);
  if (!dsn) return null;
  const client = init({
    dsn,
    environment: monitoringEnvironment(),
    tunnel: "/api/client-report",
    tracePropagationTargets: [],
    dataCollection: NO_DATA_COLLECTION,
    integrations: (integrations) => integrations.filter((integration) => integration.name !== "BrowserSession"),
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  client?.on("beforeEnvelope", envelopeHeaderScrubber(client.getDsn()?.publicKey, monitoringEnvironment()));
  return { captureException };
}
