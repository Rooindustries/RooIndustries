import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = (response) => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};

export async function GET(request) {
  return noStore(
    NextResponse.redirect(new URL("/tourney/discord", request.url), { status: 303 })
  );
}

export async function POST() {
  return noStore(
    NextResponse.json(
      {
        ok: false,
        error: "Use the signed-in Discord connection page.",
        signInUrl: "/tourney/login?next=/tourney/discord",
      },
      { status: 410 }
    )
  );
}
