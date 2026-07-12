import releaseHoldHandler from "../../../src/server/booking/releaseHold";
import { runLegacyApiHandler } from "../../../src/lib/nextApiAdapter";
import { after } from "next/server";
import { recordCommerceResponseMetric } from "../../../src/server/supabase/commerceMetrics";
import { flushDeferredCommerceMirror } from "../../../src/server/supabase/deferredCommerceMirror";

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
    after(async () => {
      if (response.ok) await flushDeferredCommerceMirror();
    });
  } catch (error) {
    if (process.env.NODE_ENV !== "test") throw error;
  }
  return response;
}

export const GET = (request) => handle(request, "GET");
export const POST = (request) => handle(request, "POST");
