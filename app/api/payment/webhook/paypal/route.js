import { runLegacyApiHandler } from "../../../../../src/lib/nextApiAdapter";
import webhookPayPal from "../../../../../src/server/api/payment/webhookPayPal.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request) =>
  runLegacyApiHandler({ request, handler: webhookPayPal, methodOverride: "POST" });
