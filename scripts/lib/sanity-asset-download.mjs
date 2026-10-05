export const validatePinnedSanityAssetUrl = (value, { projectId, dataset, allowRaw = false }) => {
  let url;
  try { url = new URL(value); } catch { throw new Error("A Sanity asset URL is invalid."); }
  const segments = url.pathname.split("/").filter(Boolean);
  const query = [...url.searchParams];
  if (
    url.protocol !== "https:" || url.hostname !== "cdn.sanity.io" || url.port ||
    url.username || url.password || url.hash ||
    !["images", "files"].includes(segments[0]) || segments.length !== 4 ||
    segments[1] !== projectId || segments[2] !== dataset ||
    query.length > 0 && !(allowRaw && query.length === 1 && query[0][0] === "dlRaw" && query[0][1] === "true")
  ) {
    throw new Error("A Sanity asset URL is outside the pinned target.");
  }
  return url.toString();
};

export const fetchPinnedSanityAsset = async ({ url, projectId, dataset, allowRaw = false, headers = {}, fetchImpl = fetch }) => {
  const signal = AbortSignal.timeout(60 * 60 * 1000);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    url = validatePinnedSanityAssetUrl(url, { projectId, dataset, allowRaw });
    const response = await fetchImpl(url, { headers: { "Accept-Encoding": "identity", ...headers }, redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      validatePinnedSanityAssetUrl(response.url || url, { projectId, dataset, allowRaw });
      return response;
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error("A Sanity asset redirect is invalid.");
    url = new URL(location, url).toString();
  }
};
