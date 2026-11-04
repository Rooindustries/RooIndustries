import { contentTypeFor, fileNameOf, isDownloadKey } from "./keys.js";

const FILE_CACHE_CONTROL = "public, max-age=86400";
const HEALTH_PROBE_KEY = "health";
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

const health = async (env) => {
  try {
    await env.DOWNLOADS.head(HEALTH_PROBE_KEY);
    return jsonResponse(200, { status: "ok" });
  } catch {
    return jsonResponse(503, { status: "unavailable" });
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

const preconditionFailed = (headers, object) => {
  const ifMatch = headers.get("If-Match");
  if (ifMatch !== null) return !strongMatch(ifMatch, object.httpEtag);
  const unmodifiedSince = parseHttpDate(headers.get("If-Unmodified-Since"));
  return unmodifiedSince !== null && toSeconds(object.uploaded) > unmodifiedSince;
};

const notModified = (headers, object) => {
  const ifNoneMatch = headers.get("If-None-Match");
  if (ifNoneMatch !== null) return weakMatch(ifNoneMatch, object.httpEtag);
  const modifiedSince = parseHttpDate(headers.get("If-Modified-Since"));
  return modifiedSince !== null && toSeconds(object.uploaded) <= modifiedSince;
};

const rangeAllowed = (ifRange, object) => ifRange === null || ifRange === object.httpEtag;

const requestedRange = (headers, object) => {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(headers.get("Range")?.trim() ?? "");
  if (!match || (!match[1] && !match[2]) || !rangeAllowed(headers.get("If-Range"), object)) return null;
  const size = object.size;
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

const validatorHeaders = (object) => {
  const headers = commonHeaders(FILE_CACHE_CONTROL);
  headers.set("ETag", object.httpEtag);
  headers.set("Last-Modified", object.uploaded.toUTCString());
  return headers;
};

const serveFile = async (request, env, key) => {
  const object = await env.DOWNLOADS.head(key);
  if (!object) return jsonResponse(404, { error: "not_found" });
  if (preconditionFailed(request.headers, object)) {
    return jsonResponse(412, { error: "precondition_failed" });
  }
  if (notModified(request.headers, object)) {
    return new Response(null, { status: 304, headers: validatorHeaders(object) });
  }
  const range = request.method === "GET" ? requestedRange(request.headers, object) : null;
  if (range === UNSATISFIABLE) {
    return jsonResponse(416, { error: "range_not_satisfiable" }, { "Content-Range": `bytes */${object.size}` });
  }

  const headers = validatorHeaders(object);
  headers.set("Content-Type", contentTypeFor(key));
  headers.set("Content-Disposition", `attachment; filename="${fileNameOf(key)}"`);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(range ? range.length : object.size));
  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  }
  const status = range ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });

  const onlyIf = { etagMatches: object.etag };
  const file = await env.DOWNLOADS.get(key, range ? { range, onlyIf } : { onlyIf });
  if (!file?.body) return jsonResponse(503, { error: "file_changed" });
  return new Response(file.body, { status, headers });
};

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
    }
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return health(env);
    const key = keyFromPath(pathname);
    return key ? serveFile(request, env, key) : jsonResponse(404, { error: "not_found" });
  },
};
