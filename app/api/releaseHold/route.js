import releaseHoldHandler from "../../../src/server/booking/releaseHold";
import { runLegacyApiHandler } from "../../../src/lib/nextApiAdapter";
import { after } from "next/server";
import { recordCommerceResponseMetric } from "../../../src/server/supabase/commerceMetrics";
import {
  flushDeferredCommerceMirror,
  isDeferredCommerceMirrorEnabled,
} from "../../../src/server/supabase/deferredCommerceMirror";
import { logSanityMirrorEvent } from "../../../src/server/supabase/mirrorObservability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request, methodOverride) {
  const startedAt = performance.now();
  const response = await runLegacyApiHandler({
    request,
    handler: releaseHoldHandler,
    methodOverride,
  });
  const metricResponse = response.clone();
  try {
    after(() => recordCommerceResponseMetric({
      route: "booking/release-hold",
      durationMs: performance.now() - startedAt,
      statusCode: response.status,
      response: metricResponse,
    }));
  } catch {}
  if (response.ok && isDeferredCommerceMirrorEnabled()) {
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
  return response;
}

export const GET = (request) => handle(request, "GET");
export const POST = (request) => handle(request, "POST");
