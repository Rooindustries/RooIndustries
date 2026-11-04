const HEALTH_PROBE_KEY = "health";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const lastByte = (range) => range.offset + range.length - 1;

export const r2Storage = (bucket) => ({
  kind: "r2",
  probe: () => bucket.head(HEALTH_PROBE_KEY),
  head: async (key) => {
    const object = await bucket.head(key);
    return object && { size: object.size, etag: object.httpEtag, uploaded: object.uploaded, version: object.etag };
  },
  body: async (key, file, range) => {
    const onlyIf = { etagMatches: file.version };
    const object = await bucket.get(key, range ? { range, onlyIf } : { onlyIf });
    return object?.body ?? null;
  },
});

const isFileUrl = (url, key, workerOrigin) =>
  url.origin !== workerOrigin && decodeURIComponent(url.pathname).endsWith(`/${key}`);

const fetchSource = async (source, key, workerOrigin, headers) => {
  const sourceUrl = new URL(source);
  if (sourceUrl.origin === workerOrigin) return null;
  const init = { headers, cache: "no-store", redirect: "manual" };
  const first = await fetch(sourceUrl, init);
  const redirected = REDIRECTS.has(first.status);
  if (!redirected && isFileUrl(sourceUrl, key, workerOrigin)) return first;
  await first.body?.cancel();
  if (!redirected) return null;
  const target = new URL(first.headers.get("Location") ?? "", sourceUrl);
  return isFileUrl(target, key, workerOrigin) ? fetch(target, init) : null;
};

const isExactPart = (response, file, part) =>
  response.status === 206 &&
  response.headers.get("Content-Range") === `bytes ${part.offset}-${lastByte(part)}/${file.size}` &&
  response.headers.get("Content-Length") === String(part.length);

export const originStorage = (files, workerOrigin) => ({
  kind: "origin",
  probe: async () => {},
  head: async (key) => {
    const entry = files[key];
    return entry ? { size: entry.size, etag: `"${entry.sha256}"`, uploaded: new Date(entry.lastModified) } : null;
  },
  body: async (key, file, range) => {
    const part = range ?? { offset: 0, length: file.size };
    const headers = { Range: `bytes=${part.offset}-${lastByte(part)}` };
    const response = await fetchSource(files[key].source, key, workerOrigin, headers);
    if (response && isExactPart(response, file, part)) return response.body;
    await response?.body?.cancel();
    return null;
  },
});
