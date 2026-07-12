const CANONICAL_WEB_HOSTS = new Set([
  "rooindustries.com",
  "www.rooindustries.com",
]);

const isCanonicalWebOriginPair = (left, right) =>
  left.protocol === "https:" &&
  right.protocol === "https:" &&
  CANONICAL_WEB_HOSTS.has(left.hostname) &&
  CANONICAL_WEB_HOSTS.has(right.hostname) &&
  !left.port &&
  !right.port;

const isCanonicalWebOrigin = (url) =>
  url.protocol === "https:" &&
  CANONICAL_WEB_HOSTS.has(url.hostname) &&
  !url.port;

const singleHeaderValue = (value) => {
  const normalized = String(value || "").trim();
  return normalized && !normalized.includes(",") ? normalized : "";
};

const forwardedRequestOrigin = (request, requestUrl) => {
  const forwardedHost = singleHeaderValue(
    request.headers.get("x-forwarded-host") || request.headers.get("host")
  );
  if (!forwardedHost) return null;
  const forwardedProtocol = singleHeaderValue(
    request.headers.get("x-forwarded-proto") || requestUrl.protocol.slice(0, -1)
  ).toLowerCase();
  if (!/^(https?|wss?)$/.test(forwardedProtocol)) return null;
  return new URL(`${forwardedProtocol}://${forwardedHost}`);
};

export const isSameOriginMutation = (request) => {
  try {
    const requestUrl = new URL(request.url);
    if (typeof request?.headers?.get !== "function") return true;
    const suppliedOrigin = String(request.headers.get("origin") || "").trim();
    if (suppliedOrigin) {
      const originUrl = new URL(suppliedOrigin);
      if (
        CANONICAL_WEB_HOSTS.has(originUrl.hostname) &&
        !isCanonicalWebOrigin(originUrl)
      ) {
        return false;
      }
      const forwardedOrigin = forwardedRequestOrigin(request, requestUrl);
      return Boolean(
        originUrl.origin === requestUrl.origin ||
        isCanonicalWebOriginPair(originUrl, requestUrl) ||
        (isCanonicalWebOrigin(originUrl) &&
          forwardedOrigin &&
          isCanonicalWebOrigin(forwardedOrigin))
      );
    }

    const fetchSite = String(
      request.headers.get("sec-fetch-site") || ""
    ).trim().toLowerCase();
    return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
  } catch {
    return false;
  }
};
