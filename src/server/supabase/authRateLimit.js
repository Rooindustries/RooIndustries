import crypto from "node:crypto";
import { createSupabaseAdminClient } from "./adminClient.js";

const hashIdentity = (value, env = process.env) => {
  const secret = String(env.RATE_LIMIT_HASH_SECRET || "").trim();
  if (!secret) throw new Error("RATE_LIMIT_HASH_SECRET is required.");
  return crypto
    .createHmac("sha256", secret)
    .update(String(value || "unknown"))
    .digest("hex");
};

export const consumeAuthRateLimit = async ({
  identity,
  max,
  windowMs = 15 * 60 * 1000,
  now = Date.now(),
  client = createSupabaseAdminClient(),
} = {}) => {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;
  const result = await client.rpc("roo_consume_rate_limit", {
    p_bucket_key_hmac: hashIdentity(`${windowStart}:${identity}`),
    p_window_started_at: new Date(windowStart).toISOString(),
    p_reset_at: new Date(resetAt).toISOString(),
    p_max: Math.max(1, Number(max) || 1),
  });
  if (result.error) throw new Error("Authentication rate limiting failed.");
  return {
    allowed: result.data?.allowed !== false,
    retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)),
  };
};
