import bookingAvailabilityHandler from "../../../src/server/booking/availability";
import { runLegacyApiHandler } from "../../../src/lib/nextApiAdapter";
import { after } from "next/server";
import { recordCommerceResponseMetric } from "../../../src/server/supabase/commerceMetrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request, methodOverride) {
  const startedAt = performance.now();
  const response = await runLegacyApiHandler({
    request,
    handler: bookingAvailabilityHandler,
    methodOverride,
  });
  const metricResponse = response.clone();
  try {
    after(() => recordCommerceResponseMetric({
      route: "booking/availability",
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
