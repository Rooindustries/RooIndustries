export const isSameOriginMutation = (request) => {
  try {
    const requestOrigin = new URL(request.url).origin;
    if (typeof request?.headers?.get !== "function") return true;
    const suppliedOrigin = String(request.headers.get("origin") || "").trim();
    if (suppliedOrigin) {
      return new URL(suppliedOrigin).origin === requestOrigin;
    }

    const fetchSite = String(
      request.headers.get("sec-fetch-site") || ""
    ).trim().toLowerCase();
    return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
  } catch {
    return false;
  }
};
