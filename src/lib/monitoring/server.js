import { createHash } from "node:crypto";
import { captureEvent, captureException, flush, httpIntegration, init } from "@sentry/nextjs";
import { deferCommerceError, isReportedCommerceError } from "./commerce.js";
import {
  NO_DATA_COLLECTION,
  envelopeHeaderScrubber,
  serverMonitoringDsn,
  monitoringEnvironment,
  scrubBreadcrumb,
  scrubEvent,
} from "./scrub";

const safeException = (message, error, name = "Error") => {
  const report = new Error(message);
  report.name = name;
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
  return report;
};

export function startServerMonitoring(value) {
  const dsn = serverMonitoringDsn(value);
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
    beforeSend: (event, hint) => isReportedCommerceError(hint?.originalException, event.request?.url) ? null : scrubEvent(event),
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  client?.on("beforeEnvelope", envelopeHeaderScrubber(client.getDsn()?.publicKey, monitoringEnvironment()));
  globalThis[Symbol.for("roo.reportCommerceAlert")] = async (alert) => {
    try {
      if (!serverMonitoringDsn(dsn)) return;
      if (alert.kind === "route") {
        const exception = alert.error ? await client.eventFromException(safeException("Commerce route failed", alert.error), {}) : {};
        captureEvent({
          ...exception,
          level: "error",
          message: "Commerce route failed",
          fingerprint: ["commerce-route", alert.route, String(alert.status)],
          tags: {
            commerce_surface: alert.surface,
            commerce_route: alert.route,
            error_status: String(alert.status),
          },
        });
      } else if (alert.kind === "reconciliation") {
        for (const { key, reason } of alert.items) {
          const identity = createHash("sha256").update(key).digest("hex");
          captureEvent({
            level: "error",
            message: "Payment reconciliation needs attention",
            fingerprint: ["payment-reconciliation", identity, reason],
            tags: { commerce_surface: "reconciliation", reconciliation_reason: reason },
          });
        }
      }
      await flush(2000);
    } catch {}
  };
  globalThis[Symbol.for("roo.reportServerError")] = (label, error, metadata) => {
    const send = () => {
      try {
        if (!serverMonitoringDsn(dsn)) return;
        const report = safeException(label.split(": ", 1)[0], error, metadata.name);
        captureException(report, {
          ...(metadata.level === "warning" ? { level: "warning" } : {}),
          tags: { error_code: metadata.code, error_status: String(metadata.status) },
        });
      } catch {}
    };
    if (!deferCommerceError(send, error)) send();
  };
}
