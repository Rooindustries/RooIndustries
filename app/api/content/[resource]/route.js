import { fetchPublicContent } from "@/src/server/content/publicContent";
import {
  selectContentBackend,
  serializeContentAssignmentCookie,
} from "@/src/server/supabase/backendSelection";

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
    const selection = selectContentBackend({
      cookieHeader: request.headers.get("cookie") || "",
    });
    const data = await fetchPublicContent({
      resource,
      searchParams: new URL(request.url).searchParams,
      backend: selection.backend,
    });
    const response = Response.json(
      { ok: true, data },
      {
        status: 200,
        headers: {
          "Cache-Control": selection.canaryActive
            ? "private, no-store"
            : PUBLIC_BROWSER_CACHE,
          ...(!selection.canaryActive
            ? { "Vercel-CDN-Cache-Control": PUBLIC_VERCEL_CACHE }
            : {}),
          "X-Content-Type-Options": "nosniff",
          "X-Roo-Content-Backend": selection.backend,
          ...(selection.canaryActive ? { Vary: "Cookie" } : {}),
        },
      }
    );
    const assignmentCookie = serializeContentAssignmentCookie({
      value: selection.assignmentCookie,
    });
    if (assignmentCookie) {
      response.headers.append("Set-Cookie", assignmentCookie);
    }
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
