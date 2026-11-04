import { contentTypeFor, fileNameOf, isDownloadKey } from "./keys.js";
import { originStorage, r2Storage } from "./storage.js";

const FILE_CACHE_CONTROL = "public, max-age=86400";
const UNSATISFIABLE = "unsatisfiable";

const commonHeaders = (cacheControl) =>
  new Headers({
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
  });

const jsonResponse = (status, body, extraHeaders = {}) => {
  const headers = commonHeaders("no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(JSON.stringify(body), { status, headers });
};

const health = async (storage) => {
  try {
    await storage.probe();
    return jsonResponse(200, { status: "ok", storage: storage.kind });
  } catch {
    return jsonResponse(503, { status: "unavailable", storage: storage.kind });
  }
};

const keyFromPath = (pathname) => {
  try {
    const key = decodeURIComponent(pathname.slice(1));
    return isDownloadKey(key) ? key : null;
  } catch {
    return null;
  }
};

const toSeconds = (date) => Math.floor(date.getTime() / 1000);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TIME = "(?<hour>\\d{2}):(?<minute>\\d{2}):(?<second>\\d{2})";
const HTTP_DATE_FORMATS = [
  new RegExp(`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?<day>\\d{2}) (?<month>\\w{3}) (?<year>\\d{4}) ${TIME} GMT$`),
  new RegExp(
    `^(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (?<day>\\d{2})-(?<month>\\w{3})-(?<shortYear>\\d{2}) ${TIME} GMT$`,
  ),
  new RegExp(`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?<month>\\w{3}) (?<day>[ \\d]\\d) ${TIME} (?<year>\\d{4})$`),
];

const fullYear = (shortYear) => {
  const thisYear = new Date().getUTCFullYear();
  const year = thisYear - (thisYear % 100) + Number(shortYear);
  return year > thisYear + 50 ? year - 100 : year;
};

const parseHttpDate = (value) => {
  const fields = HTTP_DATE_FORMATS.map((format) => format.exec(value ?? "")).find(Boolean)?.groups;
  if (!fields) return null;
  const year = fields.year ? Number(fields.year) : fullYear(fields.shortYear);
  const month = MONTHS.indexOf(fields.month);
  const [day, hour, minute, second] = [fields.day, fields.hour, fields.minute, fields.second].map(Number);
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  const valid =
    month >= 0 &&
    hour < 24 &&
    minute < 60 &&
    second < 60 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month &&
    date.getUTCDate() === day;
  return valid ? date.getTime() / 1000 : null;
};

const entityTags = (header) => header.split(",").map((tag) => tag.trim());

const opaqueTag = (tag) => tag.replace(/^W\//, "");

const strongMatch = (header, etag) => entityTags(header).some((tag) => tag === "*" || tag === etag);

const weakMatch = (header, etag) =>
  entityTags(header).some((tag) => tag === "*" || opaqueTag(tag) === opaqueTag(etag));

const preconditionFailed = (headers, file) => {
  const ifMatch = headers.get("If-Match");
  if (ifMatch !== null) return !strongMatch(ifMatch, file.etag);
  const unmodifiedSince = parseHttpDate(headers.get("If-Unmodified-Since"));
  return unmodifiedSince !== null && toSeconds(file.uploaded) > unmodifiedSince;
};

const notModified = (headers, file) => {
  const ifNoneMatch = headers.get("If-None-Match");
  if (ifNoneMatch !== null) return weakMatch(ifNoneMatch, file.etag);
  const modifiedSince = parseHttpDate(headers.get("If-Modified-Since"));
  return modifiedSince !== null && toSeconds(file.uploaded) <= modifiedSince;
};

const rangeAllowed = (ifRange, file) => ifRange === null || ifRange === file.etag;

const requestedRange = (headers, file) => {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(headers.get("Range")?.trim() ?? "");
  if (!match || (!match[1] && !match[2]) || !rangeAllowed(headers.get("If-Range"), file)) return null;
  const size = file.size;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return UNSATISFIABLE;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const first = Number(match[1]);
  if (match[2] && Number(match[2]) < first) return null;
  if (first >= size) return UNSATISFIABLE;
  const last = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return { offset: first, length: last - first + 1 };
};

const validatorHeaders = (file) => {
  const headers = commonHeaders(FILE_CACHE_CONTROL);
  headers.set("ETag", file.etag);
  headers.set("Last-Modified", file.uploaded.toUTCString());
  return headers;
};

const serveFile = async (request, storage, key) => {
  const file = await storage.head(key);
  if (!file) return jsonResponse(404, { error: "not_found" });
  if (preconditionFailed(request.headers, file)) {
    return jsonResponse(412, { error: "precondition_failed" });
  }
  if (notModified(request.headers, file)) {
    return new Response(null, { status: 304, headers: validatorHeaders(file) });
  }
  const range = request.method === "GET" ? requestedRange(request.headers, file) : null;
  if (range === UNSATISFIABLE) {
    return jsonResponse(416, { error: "range_not_satisfiable" }, { "Content-Range": `bytes */${file.size}` });
  }

  const headers = validatorHeaders(file);
  headers.set("Content-Type", contentTypeFor(key));
  headers.set("Content-Disposition", `attachment; filename="${fileNameOf(key)}"`);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(range ? range.length : file.size));
  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`);
  }
  const status = range ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });

  const body = await storage.body(key, file, range);
  if (!body) return jsonResponse(503, { error: "file_unavailable" });
  return new Response(body, { status, headers });
};

const storageFor = (env, url) =>
  env.DOWNLOADS ? r2Storage(env.DOWNLOADS) : originStorage(env.ORIGIN_FILES, url.origin);

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
    }
    const url = new URL(request.url);
    const storage = storageFor(env, url);
    if (url.pathname === "/health") return health(storage);
    const key = keyFromPath(url.pathname);
    return key ? serveFile(request, storage, key) : jsonResponse(404, { error: "not_found" });
  },
};
