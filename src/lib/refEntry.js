import { normalizeRef } from "./refShape.js";
export const REF_COOKIE_NAME = "roo_ref";
export const REF_MAX_AGE_SECONDS = 30 * 86400;
export const REF_MAX_AGE_MS = REF_MAX_AGE_SECONDS * 1000;
export const REF_FUTURE_SKEW_MS = 60 * 60 * 1000;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
export const parseRefTimestamp = (value) => {
  const match = typeof value === "string" ? ISO_UTC.exec(value) : null;
  if (!match) return NaN;
  const [y, mo, da, h, mi, s] = match.slice(1, 7).map(Number);
  const ms = match[7] ? Number(match[7].padEnd(3, "0")) : 0;
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59 || s > 59) return NaN;
  const t = Date.UTC(y, mo - 1, da, h, mi, s, ms), d = new Date(t);
  const exact = d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1 && d.getUTCDate() === da &&
    d.getUTCHours() === h && d.getUTCMinutes() === mi && d.getUTCSeconds() === s && d.getUTCMilliseconds() === ms;
  return exact ? t : NaN;
};
export const sanitizeRefEntry = (value, now = Date.now()) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = normalizeRef(value.source);
  const ts = source ? parseRefTimestamp(value.capturedAt) : NaN;
  const expired = now !== null && (ts > now + REF_FUTURE_SKEW_MS || now - ts >= REF_MAX_AGE_MS);
  return Number.isFinite(ts) && !expired ? { source, capturedAt: new Date(ts).toISOString() } : null;
};
export const chooseFirstTouchRef = (candidates = [], now = Date.now()) => candidates.reduce((best, item) => {
  const clean = sanitizeRefEntry(item, now);
  const ts = clean ? parseRefTimestamp(clean.capturedAt) : Infinity;
  return clean && ts < best.ts ? { entry: clean, ts } : best;
}, { entry: null, ts: Infinity }).entry;
export const parseRefCookieHeader = (cookieHeader, now = Date.now()) => {
  const prefix = `${REF_COOKIE_NAME}=`;
  const part = typeof cookieHeader === "string"
    ? cookieHeader.split(/;\s*/).find((p) => p.startsWith(prefix)) : "";
  try {
    return part ? sanitizeRefEntry(JSON.parse(decodeURIComponent(part.slice(prefix.length))), now) : null;
  } catch {
    return null;
  }
};
