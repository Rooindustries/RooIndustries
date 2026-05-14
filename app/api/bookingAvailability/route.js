import bookingAvailabilityHandler from "../../../src/server/booking/availability";
import { runLegacyApiHandler } from "../../../src/lib/nextApiAdapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request, methodOverride) {
  return runLegacyApiHandler({
    request,
    handler: bookingAvailabilityHandler,
    methodOverride,
  });
}

export const GET = (request) => handle(request, "GET");
