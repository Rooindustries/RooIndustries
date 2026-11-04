import { createHash } from "node:crypto";
import { fetchPublicContentEntry, PUBLIC_CONTENT_CACHE_TAG } from "@/src/server/content/publicContent";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_BROWSER_CACHE = "public, max-age=0, must-revalidate, s-maxage=300";
const PUBLIC_VERCEL_CACHE =
  "public, max-age=300, stale-while-revalidate=600, stale-if-error=86400";
const ERROR_CACHE = "no-store, max-age=0";
const BASE_HEADERS = {
  "Content-Type": "application/json",
  "X-Content-Type-Options": "nosniff",
  "X-Roo-Content-Backend": "supabase",
};

const entityTag = (body) => `"${createHash("sha256").update(body).digest("base64url")}"`;

const matchesEntityTag = (header, tag) =>
  String(header || "")
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""))
    .some((value) => value === "*" || value === tag);

export async function GET(request, context) {
  try {
    const params = await context.params;
    const resource = String(params?.resource || "").trim();
    const { data, revision, cacheable } = await fetchPublicContentEntry({
      resource,
      searchParams: new URL(request.url).searchParams,
    });
    const body = JSON.stringify({ ok: true, data, revision });
    if (!cacheable) {
      return new Response(body, { status: 200, headers: { ...BASE_HEADERS, "Cache-Control": ERROR_CACHE } });
    }
    const tag = entityTag(body);
    const headers = {
      ...BASE_HEADERS,
      "Cache-Control": PUBLIC_BROWSER_CACHE,
      "Vercel-CDN-Cache-Control": PUBLIC_VERCEL_CACHE,
      "Vercel-Cache-Tag": PUBLIC_CONTENT_CACHE_TAG,
      ETag: tag,
    };
    if (matchesEntityTag(request.headers.get("if-none-match"), tag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(body, { status: 200, headers });
  } catch (error) {
    const requestedStatus = Number(error?.status || error?.statusCode || 0);
    const status = [400, 404].includes(requestedStatus) ? requestedStatus : 503;
    return Response.json(
      {
        ok: false,
        error:
          status === 404
            ? error.message
            : status === 400
              ? "Invalid content request."
              : "Public content is temporarily unavailable.",
      },
      { status, headers: { "Cache-Control": ERROR_CACHE } }
    );
  }
}
