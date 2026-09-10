import markdownContent from "@/src/lib/markdownContent";
import sanityServer from "@/src/lib/sanityServer";

const { MARKDOWN_PATHS, MARKDOWN_VARY, NOT_FOUND_MARKDOWN, buildPageMarkdown } = markdownContent;

export async function GET(request) {
  const pathname = new URL(request.url).searchParams.get("path") || "/";
  const headers = {
    "Content-Type": "text/markdown; charset=utf-8",
    "Vary": MARKDOWN_VARY,
    "Cache-Control": "private, no-store",
    "CDN-Cache-Control": "no-store",
    "Vercel-CDN-Cache-Control": "no-store",
  };
  if (!MARKDOWN_PATHS.includes(pathname)) {
    return new Response(NOT_FOUND_MARKDOWN, { status: 404, headers });
  }
  let privacy = null;
  if (pathname === "/privacy") {
    try {
      privacy = await sanityServer.fetchPrivacyPolicy();
    } catch {
      return new Response("# Privacy policy temporarily unavailable\n\nPlease try again or contact serviroo@rooindustries.com.\n", { status: 503, headers });
    }
  }
  const body = buildPageMarkdown(pathname, privacy);
  return new Response(body || "# Content temporarily unavailable\n", {
    status: body ? 200 : 503,
    headers,
  });
}
