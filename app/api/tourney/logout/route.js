import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  getClearTourneyCookieOptions,
} from "../../../../src/server/tourney/auth";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import { clearNextSupabaseSession } from "../../../../src/server/supabase/serverSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ ok: false, error: "Cross-origin request rejected." }, { status: 403 });
  }
  const response = NextResponse.redirect(new URL("/tourney", request.url), {
    status: 303,
  });
  response.cookies.set({
    name: TOURNEY_SESSION_COOKIE,
    value: "",
    ...getClearTourneyCookieOptions(),
  });
  await clearNextSupabaseSession({ request, response }).catch(() => {});
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
