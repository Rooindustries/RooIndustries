import holdSlotHandler from "../../../src/server/booking/holdSlot";
import { runLegacyApiHandler } from "../../../src/lib/nextApiAdapter";
import { after } from "next/server";
import { recordCommerceResponseMetric } from "../../../src/server/supabase/commerceMetrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "dub1";

async function handle(request, methodOverride) {
  const startedAt = performance.now();
  const response = await runLegacyApiHandler({
    request,
    handler: holdSlotHandler,
    methodOverride,
  });
  const metricResponse = response.clone();
  try {
    after(() => recordCommerceResponseMetric({
      route: "booking/hold",
      durationMs: performance.now() - startedAt,
      statusCode: response.status,
      response: metricResponse,
    }));
  } catch (error) {
    if (process.env.NODE_ENV !== "test") throw error;
  }
  return response;
}

export const GET = (request) => handle(request, "GET");
export const POST = (request) => handle(request, "POST");
