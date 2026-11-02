import { fetchPublicContent } from "@/src/server/content/publicContent";
import { revalidatePath } from "next/cache";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_BROWSER_CACHE = "no-store, max-age=0";
const PUBLIC_VERCEL_CACHE = "no-store";
const ERROR_CACHE = "no-store, max-age=0";
let lastPublication = 0n;

export async function GET(request, context) {
  try {
    const params = await context.params;
    const resource = String(params?.resource || "").trim();
    const data = await fetchPublicContent({
      resource,
      searchParams: new URL(request.url).searchParams,
      onPublication: generation => {
        if (generation > lastPublication) {
          revalidatePath("/", "layout");
          lastPublication = generation;
        }
      },
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
