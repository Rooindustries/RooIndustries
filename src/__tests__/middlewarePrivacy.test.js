/** @jest-environment node */

import { NextRequest } from "next/server";
import { middleware } from "../../middleware";

describe("URL privacy middleware", () => {
  test("isolates a read-only preview from mutation and recovery endpoints", () => {
    const previousRuntime = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "preview";
    process.env.SALES_PREVIEW_READ_ONLY = "1";
    try {
      for (const path of ["/api/holdSlot", "/api/payment/start", "/api/payment/status", "/api/ref/login", "/api/reconcile-payments"]) {
        expect(middleware(new NextRequest(`https://preview.example.invalid${path}`)).status).toBe(503);
      }
      expect(middleware(new NextRequest("https://preview.example.invalid/api/content/packages-list", { method: "POST" })).status).toBe(503);
      expect(middleware(new NextRequest("https://preview.example.invalid/api/content/packages-list")).headers.get("x-middleware-next")).toBe("1");
      process.env.VERCEL_ENV = "production";
      expect(middleware(new NextRequest("https://www.rooindustries.com/api/holdSlot", { method: "POST" })).headers.get("x-middleware-next")).toBe("1");
    } finally {
      if (previousRuntime === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = previousRuntime;
      delete process.env.SALES_PREVIEW_READ_ONLY;
    }
  });

  test("redirects browser pages after removing sensitive query values", () => {
    const request = new NextRequest(
      "https://www.rooindustries.com/payment?data=private&paymentAccessToken=secret&ref=servi"
    );
    const response = middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://www.rooindustries.com/payment?ref=servi"
    );
  });

  test("does not strip temporary compatibility tokens from API routes", () => {
    const request = new NextRequest(
      "https://www.rooindustries.com/api/downloads/file?token=temporary"
    );
    const response = middleware(request);

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });

  test.each(["/image.png", "/logo.svg", "/styles.css", "/script.js", "/robots.txt", "/sitemap.xml", "/favicon.ico"])("removes sensitive parameters from %s", (pathname) => {
    const response = middleware(new NextRequest(
      `https://www.rooindustries.com${pathname}?paymenttoken=private&EMAIL=private&v=1`
    ));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`https://www.rooindustries.com${pathname}?v=1`);
    const clean = middleware(new NextRequest(`https://www.rooindustries.com${pathname}?v=1`));
    expect(clean.headers.get("x-middleware-next")).toBe("1");
    expect(clean.headers.get("vary")).toBeNull();
    expect(clean.headers.get("cdn-cache-control")).toBeNull();
  });

  test("preserves signed caster overlay tokens", () => {
    const request = new NextRequest(
      "https://www.rooindustries.com/tourney/overlay/caster?token=signed-match-token&theme=dark"
    );
    const response = middleware(request);

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });
});
