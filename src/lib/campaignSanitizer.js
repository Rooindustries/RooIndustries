import { normalizeLinkReferral } from "./refShape.js";
import { SALES_PATHS, salesPath } from "./salesPaths";
const DASH = "\\p{Pd}\\u2212", DATE_PART = "(\\p{Nd}{4}|\\p{Nd}{1,2})", DIGIT = /\p{Nd}/u, DIGIT_GROUP = /\p{Nd}+/gu, UNSAFE = /(?!\p{White_Space})\p{Cc}|[\p{Cs}<>"'`]/gu, HOST_CHAR = "[\\p{L}\\p{M}\\p{N}_-]";
const SEP = `[\\s.()${DASH}]`, NAMED_HOST = `${HOST_CHAR}+(?:\\.${HOST_CHAR}+)*\\.\\p{L}\\p{M}*(?:\\p{L}\\p{M}*)+`, NUMBERED_HOST = `(?<!${HOST_CHAR}|\\.)\\p{Nd}+(?:\\.\\p{Nd}+){3}(?!\\.?\\p{Nd})`;
const DOTTED = `(?:${NAMED_HOST}|${NUMBERED_HOST})`;
const DATE = new RegExp(`(?<!\\p{Nd})(?=${DATE_PART}([${DASH}./ ])(\\p{Nd}{1,2})\\2${DATE_PART}(?!\\p{Nd}))`, "gu");
const DIGIT_RUN = new RegExp(`(?:\\+${SEP}*)?\\p{Nd}+(?:${SEP}+\\p{Nd}+)*`, "gu");
const PRIVATE = new RegExp(`[^\\s@]+@${DOTTED}|//${DOTTED}(?!\\.?${HOST_CHAR})|${DOTTED}(?:[/?#]|:\\d)|[A-Za-z][A-Za-z\\d+.-]*://|(?<!${HOST_CHAR}|\\.)[Ww]{3}\\.`, "u");
const PHONE_TEXT = /^[\d\s.()-]+$/, CLICK_ID = /^[A-Za-z0-9_.-]+$/, HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, JOURNEY_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i, CAPTURED_AT = /^\d{4}-\d{2}-\d{2}T/;
const C_KEYS = "source,medium,campaign,content,term,fbclid,gclid".split(",");
const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const head = (text, max) => [...text].slice(0, max).join("");
const tryJson = (s) => { try { return s ? JSON.parse(String(s)) : null; } catch { return null; } };
const touchTime = (t) => (isObj(t) && typeof t.capturedAt === "string" ? Date.parse(t.capturedAt) : NaN);
const pad = (n, w = 2) => String(n).padStart(w, "0");
const realDate = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().startsWith(`${pad(y, 4)}-${pad(m)}-${pad(d)}`);
const numVal = (digits) => [...digits].reduce((n, ch) => {
  const p = ch.codePointAt(0) ?? 0;
  let z = p;
  while (DIGIT.test(String.fromCodePoint(z - 1))) z -= 1;
  return n * 10 + ((p - z) % 10);
}, 0);
const isDate = (s, m, e) => {
  const a = numVal(s), b = numVal(m), c = numVal(e), sl = [...s].length, el = [...e].length;
  return sl === 4 && el <= 2 ? realDate(a, b, c) : sl <= 2 && el === 4 && (realDate(c, b, a) || realDate(c, a, b));
};
const stripDates = (text) => {
  let out = "", next = 0;
  for (const { index = 0, 1: s, 2: sep, 3: m, 4: e } of text.matchAll(DATE)) {
    if (index < next || !isDate(s, m, e)) continue;
    out += `${text.slice(next, index)}x`;
    next = index + s.length + m.length + e.length + 2 * sep.length;
  }
  return out + text.slice(next);
};
const hasPhone = (text) => [...stripDates(text).matchAll(DIGIT_RUN)].some(([run]) => [...run.matchAll(DIGIT_GROUP)].map(([g]) => [...g].length).some((_, i, groups) => {
  let total = 0;
  return groups.slice(i).some((len, j) => (total += len) >= 7 && total <= 15 && (j > 0 || (i === 0 && run.startsWith("+"))));
}));
const isPrivate = (text) => PRIVATE.test(text) || hasPhone(text);
export const campaignLabel = (value) => {
  if (typeof value !== "string") return "";
  const text = value.replace(UNSAFE, "").replace(/\p{White_Space}+/gu, " ").replace(/^ | $/g, "");
  const kept = head(text, 100).replace(/^ | $/g, "");
  return isPrivate(head(text, 300)) || isPrivate(kept) ? "" : kept;
};
const clickId = (v) => (typeof v === "string" && v.length <= 200 && CLICK_ID.test(v) && !(PHONE_TEXT.test(v) && hasPhone(v)) ? v : "");
export const sanitizeReferrerHost = (v) => (typeof v === "string" && v.length <= 100 && HOST.test(v) ? v.toLowerCase() : "");
export const newJourneyId = () => {
  const c = typeof window !== "undefined" && window.crypto;
  try {
    return !c ? "" : c.randomUUID ? c.randomUUID() : c.getRandomValues ? "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (d) => (Number(d) ^ (c.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(d) / 4)))).toString(16)) : "";
  } catch { return ""; }
};
const cleanInto = (o, get) => {
  for (const k of C_KEYS) {
    const s = k.endsWith("id") ? clickId(get(k)) : campaignLabel(get(k));
    if (s) o[k] = s;
  }
};
const sanitizeTouch = (v) => {
  if (!isObj(v) || typeof v.capturedAt !== "string" || v.capturedAt.length > 40 || !CAPTURED_AT.test(v.capturedAt) || !Number.isFinite(Date.parse(v.capturedAt))) return null;
  const out = { capturedAt: new Date(v.capturedAt).toISOString(), landingPath: SALES_PATHS.has(v.landingPath) || v.landingPath === "/upgrade" ? v.landingPath : "/" };
  const host = sanitizeReferrerHost(v.referrerHost), creator = normalizeLinkReferral(v.creatorCode);
  if (host) out.referrerHost = host;
  if (creator) out.creatorCode = creator;
  cleanInto(out, (k) => v[k]);
  return out;
};
const wrapJourney = (journeyId, firstTouch, lastTouch = firstTouch) => ({ version: 2, journeyId, firstTouch: { ...firstTouch }, lastTouch: { ...lastTouch } });
const sanitizeTouchPair = (v) => {
  const f = sanitizeTouch(v.firstTouch), l = sanitizeTouch(v.lastTouch);
  return f && l && touchTime(f) > touchTime(l) ? null : f || l ? { firstTouch: f || l, lastTouch: l || f } : null;
};
export const sanitizeJourney = (v) => {
  if (!isObj(v) || typeof v.journeyId !== "string" || v.journeyId.length > 36 || !JOURNEY_ID.test(v.journeyId)) return null;
  const journeyId = v.journeyId.toLowerCase();
  const t = v.version === 1 ? sanitizeTouch(v) : null;
  if (t) return wrapJourney(journeyId, t);
  const pair = v.version === 2 ? sanitizeTouchPair(v) : null;
  return pair ? wrapJourney(journeyId, pair.firstTouch, pair.lastTouch) : null;
};
export const mergeJourneyMonotonic = (primary, secondary) => {
  const a = sanitizeJourney(primary), b = sanitizeJourney(secondary);
  if (!a || !b) return a || b;
  const af = touchTime(a.firstTouch), bf = touchTime(b.firstTouch), al = touchTime(a.lastTouch), bl = touchTime(b.lastTouch);
  const pickBf = Number.isFinite(bf) && !(bf >= af), pickBl = Number.isFinite(bl) && !(bl <= al);
  return wrapJourney(pickBf ? b.journeyId : a.journeyId, pickBf ? b.firstTouch : a.firstTouch, pickBl ? b.lastTouch : a.lastTouch);
};
export const sanitizeLandingSnapshot = (raw) => {
  if (!isObj(raw)) return null;
  const landingPath = salesPath(String(raw.landingPath || raw.pathname || "")), ts = typeof raw.capturedAt === "string" ? Date.parse(raw.capturedAt) : NaN;
  if (!landingPath || !Number.isFinite(ts)) return null;
  const src = typeof raw.search === "string" ? new URLSearchParams(raw.search) : null, ignoreUrlReferral = raw.ignoreUrlReferral === true;
  const rawC = !src && isObj(raw.campaign) ? raw.campaign : null, campaign = {}, creator = ignoreUrlReferral ? "" : normalizeLinkReferral(src ? src.get("ref") || "" : rawC?.creatorCode);
  if (creator) campaign.creatorCode = creator;
  cleanInto(campaign, (k) => (src ? src.get(k.endsWith("id") ? k : `utm_${k}`) : rawC?.[k]));
  const out = { landingPath, capturedAt: new Date(ts).toISOString(), referrerHost: sanitizeReferrerHost(raw.referrerHost), campaign, referral: normalizeLinkReferral(raw.referral), ignoreUrlReferral };
  if (raw.revisit === true) out.revisit = true;
  return out;
};
export const touchFromSnap = (raw) => {
  const c = sanitizeLandingSnapshot(raw);
  if (!c) return null;
  const t = { capturedAt: c.capturedAt, landingPath: c.landingPath, ...c.campaign };
  if (c.referrerHost) t.referrerHost = c.referrerHost;
  if (!t.creatorCode && c.referral) t.creatorCode = c.referral;
  return { touch: t, tagged: Object.keys(c.campaign).length > 0, revisit: c.revisit === true };
};
const readCk = (ck, name) => {
  const m = String(ck || "").match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  try { return m ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))) : null; } catch { return null; }
};
export const decodeFrozenPrior = (v, skipPend = false) => {
  if (!isObj(v)) return null;
  if ("version" in v) return sanitizeJourney(v);
  if ("firstTouch" in v || "lastTouch" in v) return sanitizeTouchPair(v);
  const pend = skipPend ? null : touchFromSnap(tryJson(v.p)), f = v.g ? readCk(v.c, "roo_attr") : null, l = isObj(f) ? readCk(v.c, "roo_attr_last") : null;
  let base = mergeJourneyMonotonic(sanitizeJourney(tryJson(v.s)), sanitizeJourney(v.o));
  if (isObj(f)) base = mergeJourneyMonotonic(sanitizeJourney(l && l.journeyId === f.journeyId && isObj(l.lastTouch) ? { ...f, lastTouch: l.lastTouch } : f), base);
  return !pend?.tagged || pend.revisit ? base : base ? mergeJourneyMonotonic(base, wrapJourney(base.journeyId, pend.touch)) : { firstTouch: { ...pend.touch }, lastTouch: { ...pend.touch } };
};
export const resolveFrozenJourney = (stored, arrival, raw, fallbackStored = null, fallbackPend = null, liveRaw = null) => {
  let out = mergeJourneyMonotonic(raw ? decodeFrozenPrior(raw, true) : fallbackStored, sanitizeJourney(stored));
  const hadBase = Boolean(out);
  const step = (item, mk) => {
    const s = touchFromSnap(item);
    if (!s) return;
    if (out && s.tagged && !s.revisit) out = mergeJourneyMonotonic(out, wrapJourney(out.journeyId, s.touch));
    else if (out && mk && touchTime(s.touch) < touchTime(out.firstTouch)) out = wrapJourney(out.journeyId, s.touch, out.lastTouch);
    else if (!out && s.tagged) { const id = decodeFrozenPrior(liveRaw, true)?.journeyId || newJourneyId(); if (id) out = wrapJourney(id, s.touch); }
  };
  step(raw ? tryJson(raw.p) : fallbackPend);
  step(arrival, 1);
  return [out, hadBase];
};
