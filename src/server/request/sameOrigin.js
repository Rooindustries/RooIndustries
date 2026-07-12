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

export const isSameOriginMutation = (request) => {
  try {
    const requestUrl = new URL(request.url);
    if (typeof request?.headers?.get !== "function") return true;
    const suppliedOrigin = String(request.headers.get("origin") || "").trim();
    if (suppliedOrigin) {
      const originUrl = new URL(suppliedOrigin);
      return (
        originUrl.origin === requestUrl.origin ||
        isCanonicalWebOrigin(originUrl) ||
        isCanonicalWebOriginPair(originUrl, requestUrl)
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
