import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  getClearTourneyCookieOptions,
} from "../../../../src/server/tourney/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const response = NextResponse.redirect(new URL("/tourney", request.url), {
    status: 303,
  });
  response.cookies.set({
    name: TOURNEY_SESSION_COOKIE,
    value: "",
    ...getClearTourneyCookieOptions(),
  });
  return response;
}
