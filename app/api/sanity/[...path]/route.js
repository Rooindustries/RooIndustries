const DEFAULT_SANITY_PROJECT_ID =
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ||
  process.env.SANITY_PROJECT_ID ||
  "9g42k3ur";
const DEFAULT_SANITY_DATASET =
  process.env.NEXT_PUBLIC_SANITY_DATASET ||
  process.env.SANITY_DATASET ||
  ((process.env.NEXT_PUBLIC_SITE_MARKET === "india" ||
    process.env.SITE_MARKET === "india")
    ? "production-in"
    : "production");

const FORWARD_HEADER_ALLOWLIST = new Set([
  "accept",
  "accept-language",
  "content-type",
  "sanity-client",
  "x-sanity-api-version",
  "x-sanity-perspective",
]);

function resolveSanityOrigin() {
  return `https://${DEFAULT_SANITY_PROJECT_ID}.apicdn.sanity.io`;
}

function assertAllowedDataset(pathSegments) {
  const segments = Array.isArray(pathSegments) ? pathSegments : [];
  const dataIndex = segments.indexOf("data");
  if (dataIndex === -1) return null;

  const dataset = segments[dataIndex + 2] || "";
  if (!dataset || dataset === DEFAULT_SANITY_DATASET) return null;

  return new Response(
    JSON.stringify({ ok: false, error: "Sanity dataset is not allowed." }),
    {
      status: 403,
      headers: { "content-type": "application/json" },
    }
  );
}

function buildUpstreamUrl(requestUrl, pathSegments) {
  const incoming = new URL(requestUrl);
  const path = Array.isArray(pathSegments) ? pathSegments.join("/") : "";
  const upstream = new URL(`${resolveSanityOrigin()}/${path}`);
  upstream.search = incoming.search;
  return upstream;
}

function buildForwardHeaders(requestHeaders) {
  const headers = new Headers();

  requestHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!FORWARD_HEADER_ALLOWLIST.has(lower)) return;
    headers.set(key, value);
  });

  return headers;
}

async function proxySanity(request, context) {
  const params = await context?.params;
  const datasetError = assertAllowedDataset(params?.path);
  if (datasetError) return datasetError;

  const upstreamUrl = buildUpstreamUrl(request.url, params?.path);
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
