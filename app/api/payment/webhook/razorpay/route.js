import { runLegacyApiHandler } from "../../../../../src/lib/nextApiAdapter";
import webhookRazorpay from "../../../../../src/server/api/payment/webhookRazorpay.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request) =>
  runLegacyApiHandler({
    request,
    handler: webhookRazorpay,
    methodOverride: "POST",
  });
