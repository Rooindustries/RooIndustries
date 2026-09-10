import { NextResponse } from "next/server";
import Negotiator from "negotiator";
import markdownContent from "./src/lib/markdownContent";

const { MARKDOWN_PATHS, MARKDOWN_VARY } = markdownContent;
const ASSET_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|webm|mp4|css|js|map|txt|xml|webmanifest)$/;

export function middleware(req) {
  const { pathname } = req.nextUrl;

  if (
    !pathname.startsWith("/api/") &&
    !ASSET_EXTENSION.test(pathname) &&
    pathname !== "/favicon.ico" &&
    pathname !== "/tourney/overlay/caster"
  ) {
    const sensitiveKeys = new Set([
      "data",
      "email",
      "holdtoken",
      "orderid",
      "payment",
      "paymentaccesstoken",
      "paymentflow",
      "paymenttoken",
      "token",
    ]);
    const url = req.nextUrl.clone();
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveKeys.has(String(key).toLowerCase())) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    if (changed) {
      return NextResponse.redirect(url, 307);
    }
  }

  if (pathname.toLowerCase() === "/biosguide" && pathname !== "/BIOSGuide") {
    const url = req.nextUrl.clone();
    url.pathname = "/BIOSGuide";
    return NextResponse.redirect(url, 308);
  }

  if (pathname === "/referrals/Register") {
    const url = req.nextUrl.clone();
    url.pathname = "/referrals/register";
    return NextResponse.redirect(url, 308);
  }

  const headers = new Headers(req.headers);
  headers.delete("x-roo-missing-format");
  const isDocument = ["GET", "HEAD"].includes(req.method) &&
    !pathname.startsWith("/api/") &&
    !req.headers.has("rsc") &&
    !req.headers.has("next-router-state-tree") &&
    !req.headers.has("next-action");
  if (!isDocument) return NextResponse.next({ request: { headers } });

  const negotiator = new Negotiator({ headers: { accept: req.headers.get("accept") ?? undefined } });
  if (MARKDOWN_PATHS.includes(pathname)) {
    const type = negotiator.mediaType(["text/html; charset=utf-8", "text/markdown; charset=utf-8"]);
    if (!type) {
      return new NextResponse(req.method === "HEAD" ? null : "Available representations: text/html, text/markdown.\n", {
        status: 406,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Vary": MARKDOWN_VARY,
          "Cache-Control": "no-store",
          "CDN-Cache-Control": "no-store",
          "Vercel-CDN-Cache-Control": "no-store",
        },
      });
    }
    if (type === "text/markdown; charset=utf-8") {
      const url = req.nextUrl.clone();
      url.pathname = "/content.md";
      url.search = "";
      url.searchParams.set("path", pathname);
      const response = NextResponse.rewrite(url, { request: { headers } });
      response.headers.set("Vary", MARKDOWN_VARY);
      return response;
    }
  }

  if (negotiator.mediaType(["text/markdown; charset=utf-8", "text/html; charset=utf-8"]) === "text/markdown; charset=utf-8") {
    headers.set("x-roo-missing-format", "markdown");
  }
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Vary", MARKDOWN_VARY);
  if (!ASSET_EXTENSION.test(pathname)) {
    response.headers.set("CDN-Cache-Control", "no-store");
    response.headers.set("Vercel-CDN-Cache-Control", "no-store");
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|webm|mp4|css|js|map)$).*)",
  ],
};
