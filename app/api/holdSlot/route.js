import holdSlotHandler from "../../../src/server/booking/holdSlot";
import { runLegacyApiHandler } from "../../../src/lib/nextApiAdapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request, methodOverride) {
  return runLegacyApiHandler({
    request,
    handler: holdSlotHandler,
    methodOverride,
  });
}

export const GET = (request) => handle(request, "GET");
export const POST = (request) => handle(request, "POST");
