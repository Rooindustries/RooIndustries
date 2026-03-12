export const sanitizeBrowserSearch = (pathname, search) => {
  const params = new URLSearchParams(search || "");
  if (!params.toString()) return "";

  if (pathname !== "/") {
    return `?${params.toString()}`;
  }

  // Keep useful debugging/attribution params, drop junk shell state that can
  // leak into the homepage URL from browser/automation handoff flows.
  const allowedKeys = new Set([
    "perfdebug",
    "gclid",
    "fbclid",
    "msclkid",
    "ttclid",
    "ref",
  ]);

  const nextParams = new URLSearchParams();
  params.forEach((value, key) => {
    const normalizedKey = String(key || "").toLowerCase();
    const keep =
      allowedKeys.has(normalizedKey) ||
      normalizedKey.startsWith("utm_");

    if (keep) {
      nextParams.append(key, value);
    }
  });

  const nextQuery = nextParams.toString();
  return nextQuery ? `?${nextQuery}` : "";
};
