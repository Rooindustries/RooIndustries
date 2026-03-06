import path from "node:path";

import {
  loadLegacyApiHandler,
  runLegacyApiHandler,
} from "../../../../src/lib/nextApiAdapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ACTIONS = new Set([
  "cronSyncAll",
  "createBooking",
  "forgot",
  "getData",
  "getUpgradeInfo",
  "hashPassword",
  "login",
  "logout",
  "payouts",
  "register",
  "reset",
  "syncPayouts",
  "updateBookingStatus",
  "updatePayments",
  "updateSplit",
  "validateCoupon",
  "validateReferral",
  "webhookSync",
]);

async function handle(request, context, methodOverride) {
  const { action } = await context.params;

  if (!ALLOWED_ACTIONS.has(action)) {
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const handler = await loadLegacyApiHandler(
    path.join(process.cwd(), "api", "ref", `${action}.js`)
  );

  return runLegacyApiHandler({ request, handler, methodOverride });
}

export const GET = (request, context) => handle(request, context, "GET");
export const POST = (request, context) => handle(request, context, "POST");
