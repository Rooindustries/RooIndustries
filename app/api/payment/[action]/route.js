import { runLegacyApiHandler } from "../../../../src/lib/nextApiAdapter";
import finalize from "../../../../src/server/api/payment/finalize.js";
import providers from "../../../../src/server/api/payment/providers.js";
import quote from "../../../../src/server/api/payment/quote.js";
import reconcile from "../../../../src/server/api/payment/reconcile.js";
import start from "../../../../src/server/api/payment/start.js";
import status from "../../../../src/server/api/payment/status.js";
import cancel from "../../../../src/server/api/payment/cancel.js";
import { after } from "next/server";
import { recordCommerceResponseMetric } from "../../../../src/server/supabase/commerceMetrics";
import {
  flushDeferredCommerceMirror,
  isDeferredCommerceMirrorEnabled,
} from "../../../../src/server/supabase/deferredCommerceMirror";
import { logSanityMirrorEvent } from "../../../../src/server/supabase/mirrorObservability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ACTION_HANDLERS = {
  cancel,
  finalize,
  providers,
  quote,
  reconcile,
  start,
  status,
};
const MUTATING_ACTIONS = new Set(["cancel", "finalize", "start"]);

async function handle(request, context, methodOverride) {
  const startedAt = performance.now();
  const { action } = await context.params;
  const handler = ACTION_HANDLERS[action];
  if (!handler) {
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const publicHandler =
    action === "finalize" && methodOverride === "POST"
      ? (req, res) => {
          const { source, ...body } = req.body || {};
          req.body = body;
          return handler(req, res);
        }
      : handler;

  const response = await runLegacyApiHandler({
    request,
    handler: publicHandler,
    methodOverride,
  });
  if (action !== "reconcile") {
    const metricResponse = response.clone();
    try {
      after(() =>
        recordCommerceResponseMetric({
          route: `payment/${action}`,
          durationMs: performance.now() - startedAt,
          statusCode: response.status,
          response: metricResponse,
        })
      );
    } catch {}
    if (
      response.ok &&
      MUTATING_ACTIONS.has(action) &&
      isDeferredCommerceMirrorEnabled()
    ) {
      try {
        after(() => flushDeferredCommerceMirror());
      } catch {
        logSanityMirrorEvent({
          event: "sanity_mirror_lag",
          reason: "deferred_schedule_failed",
          domain: "commerce",
        });
      }
    }
  }
  if (action === "cancel" || action === "finalize" || action === "status") {
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("pragma", "no-cache");
  }
  return response;
}

export const GET = (request, context) => handle(request, context, "GET");
export const POST = (request, context) => handle(request, context, "POST");
