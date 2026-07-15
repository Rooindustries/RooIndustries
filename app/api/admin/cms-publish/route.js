import { NextResponse } from "next/server";
import { executeGlobalCmsCommand } from "../../../../src/server/cms/publishCommand.js";
import { assertCmsStudioOrigin } from "../../../../src/server/cms/sanityAuthorization.js";
import { assertGlobalCmsWritesAllowed } from "../../../../src/server/cms/writeControl.js";
import { logSafeError } from "../../../../src/server/safeErrorLog.js";
import { createSupabaseAdminClient } from "../../../../src/server/supabase/adminClient.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;

const bodyError = (tooLarge) => {
  const error = new Error(
    tooLarge
      ? "CMS request body limit exceeded."
      : "CMS request body is required.",
  );
  error.status = tooLarge ? 413 : 400;
  error.code = tooLarge ? "CMS_BODY_TOO_LARGE" : "CMS_BODY_REQUIRED";
  return error;
};

const readBoundedBody = async (request) => {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw bodyError(true);
  }
  if (!request.body) throw bodyError(false);
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let rawBody = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw bodyError(true);
    }
    rawBody += decoder.decode(value, { stream: true });
  }
  rawBody += decoder.decode();
  if (!rawBody) throw bodyError(false);
  return rawBody;
};

const corsHeaders = (origin) => ({
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Max-Age": "600",
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Origin",
});

const errorMessage = (status) =>
  ({
    400: "The content command is invalid.",
    401: "Sign in to Sanity Studio again.",
    403: "You do not have permission to publish this content.",
    404: "The content document was not found.",
    409: "The content changed while publishing. Refresh and try again.",
    413: "The content document is too large to publish.",
    503: "Content publishing is temporarily unavailable.",
  })[status] || "Content publishing failed.";

const errorResponse = ({ error, origin = "" }) => {
  const requested = Number(error?.status || error?.statusCode || 0);
  const status = [400, 401, 403, 404, 409, 413].includes(requested)
    ? requested
    : 503;
  return NextResponse.json(
    {
      ok: false,
      error: errorMessage(status),
      code: error?.code || "CMS_FAILED",
    },
    {
      status,
      headers: origin
        ? corsHeaders(origin)
        : { "Cache-Control": "private, no-store", Vary: "Origin" },
    },
  );
};

const resolveOrigin = (request) =>
  assertCmsStudioOrigin({ origin: request.headers.get("origin") || "" });

export async function OPTIONS(request) {
  try {
    const origin = resolveOrigin(request);
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders(origin),
    });
  } catch (error) {
    return errorResponse({ error });
  }
}

export async function POST(request) {
  let origin = "";
  try {
    origin = resolveOrigin(request);
    assertGlobalCmsWritesAllowed(process.env);
    const rawBody = await readBoundedBody(request);
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      const error = new Error("CMS request body is invalid.");
      error.status = 400;
      error.code = "CMS_BODY_INVALID";
      throw error;
    }
    const result = await executeGlobalCmsCommand({
      body,
      authorization: request.headers.get("authorization") || "",
      supabaseClient: createSupabaseAdminClient(),
    });
    return NextResponse.json(
      { ok: true, ...result },
      { status: 200, headers: corsHeaders(origin) },
    );
  } catch (error) {
    logSafeError("CMS publish command failed", error);
    return errorResponse({ error, origin });
  }
}
