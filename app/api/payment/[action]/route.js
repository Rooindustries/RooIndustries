import { runLegacyApiHandler } from "../../../../src/lib/nextApiAdapter";
import finalize from "../../../../src/server/api/payment/finalize.js";
import providers from "../../../../src/server/api/payment/providers.js";
import quote from "../../../../src/server/api/payment/quote.js";
import reconcile from "../../../../src/server/api/payment/reconcile.js";
import start from "../../../../src/server/api/payment/start.js";
import status from "../../../../src/server/api/payment/status.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION_HANDLERS = {
  finalize,
  providers,
  quote,
  reconcile,
  start,
  status,
};

async function sanitizePublicFinalizeRequest(request) {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return request;
  }

  let body = null;
  try {
    body = await request.json();
  } catch {
    return request;
  }

  if (!body || typeof body !== "object" || Array.isArray(body) || !("source" in body)) {
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(body || {}),
    });
  }

  const { source, ...sanitizedBody } = body;
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(sanitizedBody),
  });
}

async function handle(request, context, methodOverride) {
  const { action } = await context.params;
  const handler = ACTION_HANDLERS[action];
  if (!handler) {
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const sanitizedRequest =
    action === "finalize" && methodOverride === "POST"
      ? await sanitizePublicFinalizeRequest(request)
      : request;

  return runLegacyApiHandler({
    request: sanitizedRequest,
    handler,
    methodOverride,
  });
}

export const GET = (request, context) => handle(request, context, "GET");
export const POST = (request, context) => handle(request, context, "POST");
