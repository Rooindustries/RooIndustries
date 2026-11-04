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
  const first = await fetch(sourceUrl, { headers, redirect: "manual" });
  const redirected = REDIRECTS.has(first.status);
  if (!redirected && isFileUrl(sourceUrl, key, workerOrigin)) return first;
  await first.body?.cancel();
  if (!redirected) return null;
  const target = new URL(first.headers.get("Location") ?? "", sourceUrl);
  return isFileUrl(target, key, workerOrigin) ? fetch(target, { headers, redirect: "manual" }) : null;
};

const sliceStream = ({ offset, length }) => {
  let position = 0;
  return new TransformStream({
    transform(chunk, controller) {
      const start = Math.max(offset - position, 0);
      const end = Math.min(offset + length - position, chunk.byteLength);
      position += chunk.byteLength;
      if (start < end) controller.enqueue(chunk.subarray(start, end));
      if (position >= offset + length) controller.terminate();
    },
  });
};

const exactLength = (expected) => {
  let received = 0;
  let lastByte;
  return new TransformStream({
    transform(chunk, controller) {
      if (!chunk.byteLength) return;
      received += chunk.byteLength;
      if (received > expected) throw new RangeError("The source sent more bytes than expected.");
      if (received < expected) {
        controller.enqueue(chunk);
        return;
      }
      controller.enqueue(chunk.subarray(0, -1));
      lastByte = chunk.subarray(-1);
    },
    flush(controller) {
      if (received !== expected) throw new RangeError("The source ended early.");
      controller.enqueue(lastByte);
    },
  });
};

const checkedBody = (body, length) => body.pipeThrough(exactLength(length)).pipeThrough(new FixedLengthStream(length));

const fileBody = (response, file, range) => {
  const contentLength = response.headers.get("Content-Length");
  if (range && response.status === 206) {
    const expected = `bytes ${range.offset}-${lastByte(range)}/${file.size}`;
    return response.headers.get("Content-Range") === expected
      ? checkedBody(response.body, range.length)
      : null;
  }
  if (response.status !== 200 || (contentLength !== null && contentLength !== String(file.size))) return null;
  if (!range) return checkedBody(response.body, file.size);
  return response.body.pipeThrough(sliceStream(range)).pipeThrough(new FixedLengthStream(range.length));
};

export const originStorage = (files, workerOrigin) => ({
  kind: "origin",
  probe: async () => {},
  head: async (key) => {
    const entry = files[key];
    return entry ? { size: entry.size, etag: `"${entry.sha256}"`, uploaded: new Date(entry.lastModified) } : null;
  },
  body: async (key, file, range) => {
    const headers = range ? { Range: `bytes=${range.offset}-${lastByte(range)}` } : {};
    const response = await fetchSource(files[key].source, key, workerOrigin, headers);
    const body = response && fileBody(response, file, range);
    if (!body) await response?.body?.cancel();
    return body;
  },
});
