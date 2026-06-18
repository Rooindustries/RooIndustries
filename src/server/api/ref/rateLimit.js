import { getClientAddressFromRequestHeaders } from "../../request/clientAddress.js";

const RATE_LIMIT_BUCKETS =
  globalThis.__rooRateLimitBuckets ||
  (globalThis.__rooRateLimitBuckets = new Map());

const pruneExpiredBuckets = (now) => {
  for (const [key, value] of RATE_LIMIT_BUCKETS.entries()) {
    if (!value || value.resetAt <= now) {
      RATE_LIMIT_BUCKETS.delete(key);
    }
  }
};

export const getClientAddress = (req) =>
  getClientAddressFromRequestHeaders(req?.headers || {});

export const requireRateLimit = (
  res,
  { key, windowMs = 15 * 60 * 1000, max = 10, message }
) => {
  const now = Date.now();
  pruneExpiredBuckets(now);

  const current = RATE_LIMIT_BUCKETS.get(key);
  if (!current || current.resetAt <= now) {
    RATE_LIMIT_BUCKETS.set(key, {
      count: 1,
      resetAt: now + windowMs,
    });
    return true;
  }

  if (current.count >= max) {
    res.status(429).json({
      ok: false,
      error: message || "Too many requests. Please try again later.",
    });
    return false;
  }

  current.count += 1;
  RATE_LIMIT_BUCKETS.set(key, current);
  return true;
};
