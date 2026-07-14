import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = (response) => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};

export async function GET(request) {
  const target = new URL("/tourney/discord", request.url);
  target.searchParams.set("discord", "retired");
  return noStore(NextResponse.redirect(target, { status: 303 }));
}
