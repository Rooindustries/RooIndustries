import { monitoringDsn } from "../../../src/lib/monitoring/scrub";
import { isProductionDeployment } from "../../../src/lib/monitoring/deployment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENVELOPE_LIMIT = 256 * 1024;

const empty = (status) => new Response(null, { status });

async function readEnvelope(request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ENVELOPE_LIMIT) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(request) {
  if (!isProductionDeployment()) return empty(404);
  const dsn = monitoringDsn(process.env.NEXT_PUBLIC_SENTRY_DSN);
  if (!dsn) return empty(404);
  if (request.headers.get("origin") !== new URL(request.url).origin) return empty(403);
  if (Number(request.headers.get("content-length") || 0) > ENVELOPE_LIMIT) return empty(413);
  const body = await readEnvelope(request);
  if (!body) return empty(413);
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
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const headers = new Headers();
    for (const name of ["x-sentry-rate-limits", "retry-after"]) {
      const value = response.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    await response.body?.cancel().catch(() => {});
    return new Response(null, { status: response.status, headers });
  } catch {
    return empty(502);
  }
}
