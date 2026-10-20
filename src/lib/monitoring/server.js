import { captureException, init } from "@sentry/nextjs";
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
  globalThis[Symbol.for("roo.reportServerError")] = (label, error, metadata) => {
    const report = new Error(label);
    report.name = metadata.name;
    const frames = typeof error?.stack === "string" ? error.stack.split("\n").filter((line) => /^\s+at /.test(line)) : [];
    report.stack = [`${report.name}: ${label}`, ...frames].join("\n");
    captureException(report, { tags: { error_code: metadata.code, error_status: String(metadata.status) } });
  };
}
