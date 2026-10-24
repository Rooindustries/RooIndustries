import { AsyncLocalStorage } from "node:async_hooks";
import { serverMonitoringDsn } from "./scrub.js";

const stateKey = Symbol.for("roo.commerceRequestState");
const state = globalThis[stateKey] ||= { requests: new AsyncLocalStorage(), errors: new WeakMap() };

const routes = new Map([
  ...["cancel", "finalize", "providers", "quote", "reconcile", "report", "start", "status"].map(
    (action) => [`/api/payment/${action}`, "checkout"]
  ),
  ...["dodo", "paypal", "razorpay"].map(
    (provider) => [`/api/payment/webhook/${provider}`, "webhook"]
  ),
  ...["/api/razorpay/createOrder", "/api/razorpay/verify", "/api/ref/getUpgradeInfo",
    "/api/ref/validateCoupon", "/api/ref/validateReferral"].map(
    (route) => [route, "checkout"]
  ),
  ...["/api/ref/createBooking", "/api/ref/sendBookingEmails", "/api/ref/updateBookingStatus",
    "/api/holdSlot", "/api/releaseHold", "/api/bookingAvailability"].map(
    (route) => [route, "booking"]
  ),
]);

export async function runCommerceRequest(url, handler) {
  let monitored = false;
  try { monitored = routes.has(new URL(url).pathname); } catch {}
  if (!monitored) return handler();
  const context = { deferred: [], reported: false, closed: false };
  return state.requests.run(context, async () => {
    try {
      return await handler();
    } finally {
      context.closed = true;
      if (!context.reported) for (const report of context.deferred) {
        try { report(); } catch {}
      }
      context.deferred.length = 0;
      context.error = undefined;
    }
  });
}

export function deferCommerceError(report, error) {
  const context = state.requests.getStore();
  if (!context) return false;
  if (context.reported) return true;
  if (context.closed) return false;
  context.error ||= error;
  context.deferred.push(report);
  return true;
}

export function isReportedCommerceError(error, url) {
  try {
    if (!url) return false;
    const route = new URL(url, "http://commerce.invalid").pathname;
    for (let depth = 0; error && typeof error === "object" && depth < 5; depth++, error = error.cause) {
      if (state.errors.get(error)?.has(route)) return true;
    }
  } catch {}
  return false;
}

export async function reportCommerceFailure(url, status, error) {
  try {
    if (!serverMonitoringDsn(process.env.NEXT_PUBLIC_SENTRY_DSN)) return;
    const route = new URL(url).pathname;
    const surface = routes.get(route);
    if (!surface || status < 500 || status > 599) return;
    const context = state.requests.getStore();
    if (context?.reported) return;
    if (context) context.reported = true;
    if (error && typeof error === "object") {
      const reportedRoutes = state.errors.get(error) || new Set();
      reportedRoutes.add(route);
      state.errors.set(error, reportedRoutes);
    }
    await globalThis[Symbol.for("roo.reportCommerceAlert")]?.({
      kind: "route",
      route,
      surface,
      status,
      error: error || context?.error,
    });
  } catch {}
}

export async function reportPaymentMismatches(report) {
  try {
    if (!serverMonitoringDsn(process.env.NEXT_PUBLIC_SENTRY_DSN)) return;
    const items = report.items.map(({ key, reason }) => ({ key, reason }));
    if (items.length) {
      await globalThis[Symbol.for("roo.reportCommerceAlert")]?.({ kind: "reconciliation", items });
    }
  } catch {}
}
