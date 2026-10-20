export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENVELOPE_LIMIT = 256 * 1024;

const empty = (status) => new Response(null, { status });

export async function POST(request) {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return empty(404);
  if (request.headers.get("origin") !== new URL(request.url).origin) return empty(403);
  if (Number(request.headers.get("content-length") || 0) > ENVELOPE_LIMIT) return empty(413);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > ENVELOPE_LIMIT) return empty(413);
  const end = body.indexOf(10);
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(end === -1 ? body : body.subarray(0, end)));
  } catch {
    return empty(400);
  }
  if (header?.dsn !== dsn) return empty(400);
  const url = new URL(dsn);
  const project = url.pathname.match(/^(.*)\/(\d+)$/);
  if (!project) return empty(400);
  try {
    const response = await fetch(`${url.origin}${project[1]}/api/${project[2]}/envelope/`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-sentry-envelope" },
      signal: AbortSignal.timeout(10000),
    });
    return empty(response.ok ? 200 : 502);
  } catch {
    return empty(502);
  }
}
