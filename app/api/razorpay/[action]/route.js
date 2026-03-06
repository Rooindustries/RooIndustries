import createOrder from "../../../../src/server/api/razorpay/createOrder";
import verify from "../../../../src/server/api/razorpay/verify";
import { runLegacyApiHandler } from "../../../../src/lib/nextApiAdapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION_HANDLERS = {
  createOrder,
  verify,
};

async function handle(request, context, methodOverride) {
  const { action } = await context.params;
  const handler = ACTION_HANDLERS[action];

  if (!handler) {
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  return runLegacyApiHandler({ request, handler, methodOverride });
}

export const GET = (request, context) => handle(request, context, "GET");
export const POST = (request, context) => handle(request, context, "POST");
