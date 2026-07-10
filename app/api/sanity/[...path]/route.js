export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const retired = () =>
  Response.json(
    { ok: false, error: "This endpoint has been retired." },
    {
      status: 410,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    }
  );

export const GET = retired;
export const HEAD = retired;
export const POST = retired;
