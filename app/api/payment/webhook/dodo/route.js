import { runLegacyApiHandler } from "../../../../../src/lib/nextApiAdapter";
import webhookDodo from "../../../../../src/server/api/payment/webhookDodo.js";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = async (request) => {
  const response = await runLegacyApiHandler({
    request,
    handler: webhookDodo,
    methodOverride: "POST",
  });

  return response;
};
