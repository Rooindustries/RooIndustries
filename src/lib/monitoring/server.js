import { captureException, httpIntegration, init } from "@sentry/nextjs";
import { isProductionDeployment } from "./deployment";
import {
  NO_DATA_COLLECTION,
  envelopeHeaderScrubber,
  monitoringDsn,
  monitoringEnvironment,
  scrubBreadcrumb,
  scrubEvent,
} from "./scrub";

export function startServerMonitoring(value) {
  if (!isProductionDeployment()) return;
  const dsn = monitoringDsn(value);
  if (!dsn) return;
  const client = init({
    dsn,
    environment: monitoringEnvironment(),
    tracesSampler: () => Math.random() < 0.05,
    traceLifecycle: "static",
    tracePropagationTargets: [],
    dataCollection: NO_DATA_COLLECTION,
    integrations: (integrations) => [
      ...integrations.filter((integration) => integration.name !== "ProcessSession"),
      httpIntegration({ sessions: false, disableIncomingRequestSpans: true }),
    ],
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  client?.on("beforeEnvelope", envelopeHeaderScrubber(client.getDsn()?.publicKey, monitoringEnvironment()));
  globalThis[Symbol.for("roo.reportServerError")] = (label, error, metadata) => {
    try {
      const message = label.split(": ", 1)[0];
      const report = new Error(message);
      report.name = metadata.name;
      const frames = [];
      try {
        const stack = error?.stack;
        const head = Error.prototype.toString.call(error);
        if (typeof stack === "string" && stack.startsWith(`${head}\n`)) {
          for (const line of stack.slice(head.length + 1).split("\n")) {
            if (!/^\s+at /.test(line)) break;
            frames.push(line);
          }
        }
      } catch {}
      report.stack = [`${report.name}: ${message}`, ...frames].join("\n");
      captureException(report, { tags: { error_code: metadata.code, error_status: String(metadata.status) } });
    } catch {}
  };
}
