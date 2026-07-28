import { NextResponse } from "next/server";

export const PUBLIC_API_CACHE_CONTROL =
  "public, max-age=0, s-maxage=5, stale-while-revalidate=25";

const PUBLIC_CORS_HEADERS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Max-Age": "86400",
});

export const publicApiJson = (body, { status = 200 } = {}) =>
  NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": status === 200 ? PUBLIC_API_CACHE_CONTROL : "no-store",
      ...PUBLIC_CORS_HEADERS,
    },
  });

export const publicApiOptions = () =>
  new NextResponse(null, {
    status: 204,
    headers: {
      "Cache-Control": "public, max-age=86400",
      ...PUBLIC_CORS_HEADERS,
    },
  });

export const publicApiError = (message, status = 500) =>
  publicApiJson({ ok: false, apiVersion: "1", error: message }, { status });
