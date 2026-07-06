import { getClientAddressFromFetchHeaders } from "@/src/server/request/clientAddress";
import { requireRateLimit } from "@/src/server/api/ref/rateLimit";
import {
  createDownloadSanityClient,
  validateDownloadAccess,
} from "@/src/server/downloads/downloadAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};

const readJsonBody = async (request) => {
  try {
    return await request.json();
  } catch {
    return {};
  }
};

const enforceRateLimit = ({ request, body }) => {
  const clientAddress = getClientAddressFromFetchHeaders(request.headers);
  const key = `download-validate:${clientAddress}:${String(
    body?.slug || ""
  ).trim().toLowerCase()}:${String(body?.orderId || "")
    .trim()
    .toLowerCase()}:${String(body?.email || "").trim().toLowerCase()}`;

  let response = null;
  let statusCode = 200;
  const res = {
    status(code) {
      statusCode = Number(code) || 429;
      return res;
    },
    json(payload) {
      response = Response.json(payload, {
        status: statusCode,
        headers: noStoreHeaders,
      });
      return res;
    },
  };

  requireRateLimit(res, {
    key,
    max: 12,
    message: "Too many download lookup requests. Please try again later.",
  });

  return response;
};

export async function POST(request) {
  const body = await readJsonBody(request);
  const rateLimitResponse = enforceRateLimit({ request, body });
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const result = await validateDownloadAccess({
      slug: body?.slug,
      orderId: body?.orderId,
      email: body?.email,
      client: createDownloadSanityClient(),
    });

    return Response.json(result.body, {
      status: result.status,
      headers: noStoreHeaders,
    });
  } catch (error) {
    console.error("[downloads] validate error:", error);
    return Response.json(
      {
        ok: false,
        error: "Server error while validating this download.",
      },
      { status: 500, headers: noStoreHeaders }
    );
  }
}
