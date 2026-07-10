import crypto from "crypto";
import { getClientAddressFromRequestHeaders } from "../../request/clientAddress.js";
import { logSafeError } from "../../safeErrorLog.js";

const TEST_BUCKETS =
  globalThis.__rooRateLimitBuckets ||
  (globalThis.__rooRateLimitBuckets = new Map());
const MAX_RETRIES = 5;

const loadWriteClient = async () => {
  const { createRefWriteClient } = await import("./sanity.js");
  return createRefWriteClient();
};

const getHashSecret = () =>
  String(
    process.env.RATE_LIMIT_HASH_SECRET ||
      (process.env.NODE_ENV === "test" ? "test-rate-limit-secret" : "")
  ).trim();

const buildBucketId = ({ key, windowStart }) => {
  const secret = getHashSecret();
  if (!secret) throw new Error("RATE_LIMIT_HASH_SECRET is required.");
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${windowStart}:${String(key || "")}`)
    .digest("hex");
  return `rateLimitBucket.${digest}`;
};

const sendLimitResponse = ({ res, status, retryAfter, message }) => {
  res.setHeader?.("Retry-After", String(Math.max(1, retryAfter)));
  res.setHeader?.("Cache-Control", "no-store, max-age=0");
  res.status(status).json({
    ok: false,
    error:
      message ||
      (status === 429
        ? "Too many requests. Please try again later."
        : "Request protection is temporarily unavailable."),
  });
  return false;
};

const useTestBucket = ({ res, key, windowMs, max, message, now }) => {
  const current = TEST_BUCKETS.get(key);
  if (!current || current.resetAt <= now) {
    TEST_BUCKETS.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= max) {
    return sendLimitResponse({
      res,
      status: 429,
      retryAfter: Math.ceil((current.resetAt - now) / 1000),
      message,
    });
  }
  current.count += 1;
  return true;
};

export const getClientAddress = (req) =>
  getClientAddressFromRequestHeaders(req?.headers || {});

export const requireRateLimit = async (
  res,
  {
    key,
    windowMs = 15 * 60 * 1000,
    max = 10,
    message,
    client = null,
    failClosed = true,
    now = Date.now(),
  }
) => {
  if (process.env.NODE_ENV === "test" && !client) {
    return useTestBucket({ res, key, windowMs, max, message, now });
  }

  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAtMs = windowStart + windowMs;
  const retryAfter = Math.ceil((resetAtMs - now) / 1000);

  try {
    const writeClient = client || (await loadWriteClient());
    const bucketId = buildBucketId({ key, windowStart });
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const bucket = await writeClient.fetch(
        `*[_type == "rateLimitBucket" && _id == $id][0]{_id,_rev,count,resetAt}`,
        { id: bucketId }
      );
      if (!bucket?._id) {
        try {
          await writeClient.create({
            _id: bucketId,
            _type: "rateLimitBucket",
            count: 1,
            resetAt: new Date(resetAtMs).toISOString(),
            createdAt: new Date(now).toISOString(),
          });
          return true;
        } catch (error) {
          if (Number(error?.statusCode || error?.status || 0) === 409) continue;
          throw error;
        }
      }

      if (Number(bucket.count || 0) >= max) {
        return sendLimitResponse({ res, status: 429, retryAfter, message });
      }
      try {
        await writeClient
          .patch(bucket._id)
          .ifRevisionId(bucket._rev)
          .inc({ count: 1 })
          .commit();
        return true;
      } catch (error) {
        if (Number(error?.statusCode || error?.status || 0) === 409) continue;
        throw error;
      }
    }
    throw new Error("Rate limit state changed too frequently.");
  } catch (error) {
    logSafeError("Durable rate limiter unavailable", error);
    if (!failClosed) return true;
    return sendLimitResponse({ res, status: 503, retryAfter: 30 });
  }
};

export const cleanupExpiredRateLimitBuckets = async ({
  client = null,
  now = new Date().toISOString(),
} = {}) => {
  const writeClient = client || (await loadWriteClient());
  const ids = await writeClient.fetch(
    `*[_type == "rateLimitBucket" && resetAt < $now][0...500]._id`,
    { now }
  );
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const transaction = writeClient.transaction();
  ids.forEach((id) => transaction.delete(id));
  await transaction.commit();
  return ids.length;
};
