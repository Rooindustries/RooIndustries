import { runLegacyApiHandler } from "../../../../../src/lib/nextApiAdapter";
import webhookPayPal from "../../../../../src/server/api/payment/webhookPayPal.js";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = async (request) => {
  const response = await runLegacyApiHandler({
    request,
    handler: webhookPayPal,
    methodOverride: "POST",
  });

  return response;
};
