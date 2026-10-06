import { resolveAdminActor } from "./adminSession.js";
import { createSupabaseAdminClient } from "../supabase/adminClient.js";
import { validationError } from "./errors.js";
import { logSafeError } from "../safeErrorLog.js";
import { getClientAddressFromFetchHeaders } from "../request/clientAddress.js";
import { requireRateLimit } from "../api/ref/rateLimit.js";

export const CMS_PRIVATE_HEADERS = Object.freeze({ "Cache-Control": "private, no-store", Pragma: "no-cache", "X-Robots-Tag": "noindex" });
export { assertAdminKey } from "./adminSession.js";
export const readCmsBody = async (request, signal) => {
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
export const handleCmsRequest = async (request, context, handler, { write = false, timeoutMs = 20000, env = process.env, sessionProbe = false } = {}) => {
  let timer;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = AbortSignal.any([controller.signal, request.signal]);
    let client, actor, account;
    try {
      client = createSupabaseAdminClient({ env, signal });
      ({ actor, account } = await resolveAdminActor(request, { env, adminClient: client }));
    } catch (error) {
      if (error.code !== "ADMIN_UNAUTHORIZED") throw error;
      if (sessionProbe && !request.headers.has("x-admin-key")) return Response.json({ ok: true, data: { signedIn: false } }, { headers: CMS_PRIVATE_HEADERS });
      const limited = await limitAdminFailure(request, "admin-content-key");
      if (limited) return limited;
      throw error;
    }
    const params = await context?.params || {};
    const body = write ? await readCmsBody(request, signal) : undefined;
    const headers = { ...CMS_PRIVATE_HEADERS };
    const data = await handler({ request, params, body, client, env, signal, actor, account, headers });
    return Response.json({ ok: true, data }, { headers });
  } catch (error) {
    const known = typeof error?.code === "string" && /^(CMS_|ASSET_|ADMIN_)/.test(error.code);
    const status = known && error.status >= 400 && error.status <= 599 ? error.status : 503;
    if (!known || status >= 500) logSafeError("Admin content request failed", error);
    return Response.json({ ok: false, error: known ? error.message : "Content service is temporarily unavailable.", code: known ? error.code : "CMS_UNAVAILABLE", ...(known && error.details !== undefined ? { details: error.details } : {}) }, { status, headers: CMS_PRIVATE_HEADERS });
  } finally { clearTimeout(timer); }
};

export const limitAdminFailure = async (request, prefix) => {
  let limited;
  const headers = { ...CMS_PRIVATE_HEADERS };
  const response = { setHeader(name, value) { headers[name] = value; }, status(value) { this.statusCode = value; return this; }, json(body) { limited = Response.json({ ...body, code: this.statusCode === 429 ? "ADMIN_RATE_LIMITED" : "ADMIN_PROTECTION_UNAVAILABLE" }, { status: this.statusCode, headers: { ...headers, ...CMS_PRIVATE_HEADERS } }); } };
  if (!await requireRateLimit(response, { key: `${prefix}:${getClientAddressFromFetchHeaders(request.headers)}`, max: 5, windowMs: 60000, message: "Too many admin access attempts. Please try again later." })) return limited;
  return null;
};
