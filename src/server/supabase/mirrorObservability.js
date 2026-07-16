const DEFAULT_INTERVAL_MS = 60_000;
const lastLoggedAt = new Map();

const cleanField = (value, fallback) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, "_")
    .slice(0, 80);
  return normalized || fallback;
};

export const logSanityMirrorEvent = ({
  event,
  reason,
  domain = "global",
  intervalMs = DEFAULT_INTERVAL_MS,
} = {}) => {
  const fields = {
    event: cleanField(event, "sanity_mirror_lag"),
    reason: cleanField(reason, "unknown"),
    domain: cleanField(domain, "global"),
  };
  const key = `${fields.event}:${fields.reason}:${fields.domain}`;
  const now = Date.now();
  if (now - Number(lastLoggedAt.get(key) || 0) < intervalMs) return false;
  lastLoggedAt.set(key, now);
  console.warn(
    `event=${fields.event} reason=${fields.reason} domain=${fields.domain}`
  );
  return true;
};

export const resetSanityMirrorEventRateLimitForTests = () => lastLoggedAt.clear();
