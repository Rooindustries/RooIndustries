const DEFAULT_SANITY_PROJECT_ID =
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ||
  process.env.SANITY_PROJECT_ID ||
  "9g42k3ur";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "origin",
  "referer",
  "content-length",
]);

function resolveSanityOrigin(requestHeaders) {
  const projectId =
    requestHeaders.get("x-sanity-project-id") || DEFAULT_SANITY_PROJECT_ID;
  return `https://${projectId}.apicdn.sanity.io`;
}

function buildUpstreamUrl(requestUrl, pathSegments, requestHeaders) {
  const incoming = new URL(requestUrl);
  const path = Array.isArray(pathSegments) ? pathSegments.join("/") : "";
  const upstream = new URL(`${resolveSanityOrigin(requestHeaders)}/${path}`);
  upstream.search = incoming.search;
  return upstream;
}

function buildForwardHeaders(requestHeaders) {
  const headers = new Headers();

  requestHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    headers.set(key, value);
  });

  return headers;
}

async function proxySanity(request, context) {
  const params = await context?.params;
  const upstreamUrl = buildUpstreamUrl(
    request.url,
    params?.path,
    request.headers
  );
  const method = request.method || "GET";
  const headers = buildForwardHeaders(request.headers);

  const init = {
    method,
    headers,
    redirect: "manual",
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  const upstream = await fetch(upstreamUrl, init);
  const responseHeaders = new Headers(upstream.headers);

  // Upstream responses are transparently decompressed by fetch(). Keep headers consistent.
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("transfer-encoding");
  responseHeaders.set("x-proxied-by", "roo-next-sanity-proxy");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function GET(request, context) {
  return proxySanity(request, context);
}

export async function HEAD(request, context) {
  return proxySanity(request, context);
}

export async function POST(request, context) {
  return proxySanity(request, context);
}
