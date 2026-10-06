import { fetchPublicContent } from "@/src/server/content/publicContent";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_BROWSER_CACHE = "public, max-age=60, stale-while-revalidate=300";
const PUBLIC_VERCEL_CACHE =
  "public, max-age=300, stale-while-revalidate=600, stale-if-error=86400";
const ERROR_CACHE = "no-store, max-age=0";

export async function GET(request, context) {
  try {
    const params = await context.params;
    const resource = String(params?.resource || "").trim();
    const data = await fetchPublicContent({
      resource,
      searchParams: new URL(request.url).searchParams,
    });
    const response = Response.json(
      { ok: true, data },
      {
        status: 200,
        headers: {
          "Cache-Control": PUBLIC_BROWSER_CACHE,
          "Vercel-CDN-Cache-Control": PUBLIC_VERCEL_CACHE,
          "X-Content-Type-Options": "nosniff",
          "X-Roo-Content-Backend": "supabase",
        },
      }
    );
    return response;
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
