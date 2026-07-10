import { NextResponse } from "next/server";

export function middleware(req) {
  const { pathname } = req.nextUrl;

  if (!pathname.startsWith("/api/")) {
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

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
