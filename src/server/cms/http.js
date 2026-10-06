import crypto from "node:crypto";
import { createSupabaseAdminClient } from "../supabase/adminClient.js";
import { cmsError, validationError } from "./errors.js";
import { logSafeError } from "../safeErrorLog.js";
import { getClientAddressFromFetchHeaders } from "../request/clientAddress.js";
import { requireRateLimit } from "../api/ref/rateLimit.js";

export const CMS_PRIVATE_HEADERS = Object.freeze({ "Cache-Control": "private, no-store", Pragma: "no-cache", "X-Robots-Tag": "noindex" });
export const assertAdminKey = (request, env = process.env) => {
  const expected = env.REF_ADMIN_KEY;
  if (typeof expected !== "string" || !expected.length) throw cmsError("Admin access is not configured.", 503, "ADMIN_NOT_CONFIGURED");
  const provided = request.headers.get("x-admin-key") || "";
  const digest = value => crypto.createHash("sha256").update(value).digest();
  if (!crypto.timingSafeEqual(digest(expected), digest(provided)) || !provided.length) throw cmsError("Admin access is required.", 401, "ADMIN_UNAUTHORIZED");
  return "admin:key";
};
const readBody = async (request, signal) => {
  if (!request.body) throw validationError("$", "A JSON body is required.");
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 1024 * 1024) { await reader.cancel(); throw validationError("$", "JSON content exceeds 1 MiB."); }
      chunks.push(Buffer.from(part.value));
    }
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, length).toString("utf8")); } catch { throw validationError("$", "A valid JSON body is required."); }
};
export const handleCmsRequest = async (request, context, handler, { write = false, timeoutMs = 20000, env = process.env } = {}) => {
  let timer;
  try {
    try { assertAdminKey(request, env); }
    catch (error) {
      if (error.code !== "ADMIN_UNAUTHORIZED") throw error;
      let limited;
      const headers = { ...CMS_PRIVATE_HEADERS };
      const response = { setHeader(name, value) { headers[name] = value; }, status(value) { this.statusCode = value; return this; }, json(body) { limited = Response.json({ ...body, code: this.statusCode === 429 ? "ADMIN_RATE_LIMITED" : "ADMIN_PROTECTION_UNAVAILABLE" }, { status: this.statusCode, headers: { ...headers, ...CMS_PRIVATE_HEADERS } }); } };
      if (!await requireRateLimit(response, { key: `admin-content-key:${getClientAddressFromFetchHeaders(request.headers)}`, max: 5, windowMs: 60000, message: "Too many admin access attempts. Please try again later." })) return limited;
      throw error;
    }
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = AbortSignal.any([controller.signal, request.signal]);
    const client = createSupabaseAdminClient({ env, signal });
    const params = await context?.params || {};
    const body = write ? await readBody(request, signal) : undefined;
    const data = await handler({ request, params, body, client, env, signal });
    return Response.json({ ok: true, data }, { headers: CMS_PRIVATE_HEADERS });
  } catch (error) {
    const known = typeof error?.code === "string" && /^(CMS_|ASSET_|ADMIN_)/.test(error.code);
    const status = known && error.status >= 400 && error.status <= 599 ? error.status : 503;
    if (!known || status >= 500) logSafeError("Admin content request failed", error);
    return Response.json({ ok: false, error: known ? error.message : "Content service is temporarily unavailable.", code: known ? error.code : "CMS_UNAVAILABLE", ...(known && error.details !== undefined ? { details: error.details } : {}) }, { status, headers: CMS_PRIVATE_HEADERS });
  } finally { clearTimeout(timer); }
};
