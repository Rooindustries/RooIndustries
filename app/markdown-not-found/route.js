import markdownContent from "@/src/lib/markdownContent";

export function GET() {
  return new Response(markdownContent.NOT_FOUND_MARKDOWN, {
    status: 404,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Vary": markdownContent.MARKDOWN_VARY,
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
