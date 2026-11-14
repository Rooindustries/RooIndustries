import { SALES_PATHS, salesPath } from "./salesPaths";
import { isRecord, readStoredAttribution, writeStoredAttribution } from "./attributionStore";

export type SalesTouch = {
  capturedAt: string;
  landingPath: string;
  referrerHost?: string;
  creatorCode?: string;
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  fbclid?: string;
  gclid?: string;
};

type SalesLanding = { pathname: string; search: string };

export type SalesAttribution = {
  version: 2;
  journeyId: string;
  firstTouch: SalesTouch;
  lastTouch: SalesTouch;
};

const JOURNEY_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const JOURNEY_ID_CHARS = 36;
const LABEL_CODE_POINTS = 100;
const SCAN_CODE_POINTS = 300;
const REFERRER_HOST_CHARS = 100;
const LANDING_PATH_CHARS = 100;
const CAPTURED_AT_CHARS = 40;
const REFERRAL_CODE_CHARS = 100;
const PHONE_TEXT = /^[\d\s.()-]+$/;
const DASH = String.raw`\p{Pd}\u2212`;
const DATE_PART = String.raw`(\p{Nd}{4}|\p{Nd}{1,2})`;
const DATE = new RegExp(
  String.raw`(?<!\p{Nd})(?=${DATE_PART}([${DASH}./ ])(\p{Nd}{1,2})\2${DATE_PART}(?!\p{Nd}))`, "gu");
const DIGIT = /\p{Nd}/u;
const SEPARATOR = String.raw`[\s.()${DASH}]`;
const DIGIT_RUN = new RegExp(String.raw`(?:\+${SEPARATOR}*)?\p{Nd}+(?:${SEPARATOR}+\p{Nd}+)*`, "gu");
const DIGIT_GROUP = /\p{Nd}+/gu;
const UNSAFE = /(?!\p{White_Space})\p{Cc}|[\p{Cs}<>"'`]/gu;
const HOST_CHAR = String.raw`[\p{L}\p{M}\p{N}_-]`;
const NAMED_HOST = String.raw`${HOST_CHAR}+(?:\.${HOST_CHAR}+)*\.\p{L}\p{M}*(?:\p{L}\p{M}*)+`;
const NUMBERED_HOST = String.raw`(?<!${HOST_CHAR}|\.)\p{Nd}+(?:\.\p{Nd}+){3}(?!\.?\p{Nd})`;
const DOTTED_HOST = String.raw`(?:${NAMED_HOST}|${NUMBERED_HOST})`;
const EMAIL = new RegExp(String.raw`[^\s@]+@${DOTTED_HOST}`, "u");
const URL_SCHEME = /[a-z][a-z\d+.-]*:\/\//i;
const WWW_TOKEN = new RegExp(String.raw`(?<!${HOST_CHAR}|\.)www\.`, "iu");
const PROTOCOL_RELATIVE = new RegExp(String.raw`//${DOTTED_HOST}(?!\.?${HOST_CHAR})`, "u");
const HOST_WITH_PATH = new RegExp(String.raw`${DOTTED_HOST}(?:[/?#]|:\d)`, "u");
const PRIVATE_TEXT = [EMAIL, URL_SCHEME, WWW_TOKEN, PROTOCOL_RELATIVE, HOST_WITH_PATH];
const CLICK_ID_CHARS = 200;
const CLICK_ID = /^[A-Za-z0-9_.-]+$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const CAPTURED_AT = /^\d{4}-\d{2}-\d{2}T/;
const REFERRAL_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const bounded = (value: unknown, chars: number): value is string =>
  typeof value === "string" && value.length <= chars;
const head = (text: string, codePoints: number) => {
  let end = 0;
  for (let count = 0; count < codePoints && end < text.length; count += 1) {
    end += (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
  }
  return text.slice(0, end);
};
const realDate = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
const digitValue = (digit: string) => {
  const point = digit.codePointAt(0) ?? 0;
  let zero = point;
  while (DIGIT.test(String.fromCodePoint(zero - 1))) zero -= 1;
  return (point - zero) % 10;
};
const numberValue = (digits: string) => [...digits].reduce((total, digit) => total * 10 + digitValue(digit), 0);
const calendarDate = (start: string, middle: string, end: string) => {
  const [a, b, c] = [start, middle, end].map(numberValue);
  const [startDigits, endDigits] = [start, end].map((part) => [...part].length);
  if (startDigits === 4 && endDigits <= 2) return realDate(a, b, c);
  return startDigits <= 2 && endDigits === 4 && (realDate(c, b, a) || realDate(c, a, b));
};
const withoutDates = (text: string) => {
  let undated = "";
  let next = 0;
  for (const { index = 0, 1: start, 2: separator, 3: middle, 4: end } of text.matchAll(DATE)) {
    if (index < next || !calendarDate(start, middle, end)) continue;
    undated += `${text.slice(next, index)}x`;
    next = index + start.length + middle.length + end.length + 2 * separator.length;
  }
  return undated + text.slice(next);
};
const phoneDigits = (total: number) => total >= 7 && total <= 15;
const phoneRun = (run: string) => {
  const groups = [...run.matchAll(DIGIT_GROUP)].map(([group]) => [...group].length);
  return groups.some((_, first) => {
    let total = 0;
    return groups.slice(first).some((digits, joined) => {
      total += digits;
      return phoneDigits(total) && (joined > 0 || (first === 0 && run.startsWith("+")));
    });
  });
};
const containsPhone = (text: string) => [...withoutDates(text).matchAll(DIGIT_RUN)].some(([run]) => phoneRun(run));

const privateText = (text: string) => PRIVATE_TEXT.some((rule) => rule.test(text)) || containsPhone(text);
const trimSpace = (text: string) => text.replace(/^ | $/g, "");
const label = (value: unknown) => {
  if (typeof value !== "string") return "";
  const text = trimSpace(head(value, SCAN_CODE_POINTS).replace(UNSAFE, "").replace(/\p{White_Space}+/gu, " "));
  const kept = trimSpace(head(text, LABEL_CODE_POINTS));
  return privateText(text) || privateText(kept) ? "" : kept;
};
const referralCode = (value: unknown) =>
  bounded(value, REFERRAL_CODE_CHARS) && REFERRAL_CODE.test(value.trim()) && /[a-z]/i.test(value)
    ? value.trim()
    : "";
const clickId = (value: unknown) =>
  bounded(value, CLICK_ID_CHARS) && CLICK_ID.test(value) && !(PHONE_TEXT.test(value) && containsPhone(value))
    ? value
    : "";

const FIELDS = {
  creatorCode: ["ref", referralCode],
  source: ["utm_source", label],
  medium: ["utm_medium", label],
  campaign: ["utm_campaign", label],
  content: ["utm_content", label],
  term: ["utm_term", label],
  fbclid: ["fbclid", clickId],
  gclid: ["gclid", clickId],
} as const;
type Field = keyof typeof FIELDS;
const FIELD_KEYS = Object.keys(FIELDS) as Field[];

const newJourneyId = () => {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  if (!window.crypto?.getRandomValues) return "";
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};

const sanitizeTouch = (value: unknown): SalesTouch | null => {
  if (!isRecord(value)) return null;
  const { capturedAt, landingPath, referrerHost } = value;
  if (!bounded(capturedAt, CAPTURED_AT_CHARS) || !CAPTURED_AT.test(capturedAt)) return null;
  if (!Number.isFinite(Date.parse(capturedAt))) return null;
  const knownPath =
    bounded(landingPath, LANDING_PATH_CHARS) && (SALES_PATHS.has(landingPath) || landingPath === "/upgrade");
  const touch: SalesTouch = {
    capturedAt: new Date(capturedAt).toISOString(),
    landingPath: knownPath ? landingPath : "/",
  };
  if (bounded(referrerHost, REFERRER_HOST_CHARS) && HOST.test(referrerHost)) {
    touch.referrerHost = referrerHost.toLowerCase();
  }
  for (const key of FIELD_KEYS) {
    const safe = FIELDS[key][1](value[key]);
    if (safe) touch[key] = safe;
  }
  return touch;
};

export function sanitizeSalesAttribution(value: unknown): SalesAttribution | null {
  if (!isRecord(value)) return null;
  if (!bounded(value.journeyId, JOURNEY_ID_CHARS) || !JOURNEY_ID.test(value.journeyId)) return null;
  const journeyId = value.journeyId.toLowerCase();
  if (value.version === 1) {
    const touch = sanitizeTouch(value);
    return touch ? { version: 2, journeyId, firstTouch: touch, lastTouch: { ...touch } } : null;
  }
  if (value.version !== 2) return null;
  const firstTouch = sanitizeTouch(value.firstTouch);
  const lastTouch = sanitizeTouch(value.lastTouch);
  if (!firstTouch && !lastTouch) return null;
  return {
    version: 2,
    journeyId,
    firstTouch: firstTouch || { ...lastTouch! },
    lastTouch: lastTouch || { ...firstTouch! },
  };
}

const landingCampaign = (search: string) => {
  const params = new URLSearchParams(search);
  const campaign: Partial<Record<Field, string>> = {};
  for (const key of FIELD_KEYS) {
    const safe = FIELDS[key][1](params.get(FIELDS[key][0]));
    if (safe) campaign[key] = safe;
  }
  return campaign;
};

const sessionReferral = () => {
  try {
    return referralCode(sessionStorage.getItem("referral_session"));
  } catch {
    return "";
  }
};

const newTouch = (landingPath: string, campaign: Partial<Record<Field, string>>) => {
  let referrerHost = "";
  try {
    const referrer = new URL(document.referrer);
    if (referrer.origin !== window.location.origin) referrerHost = referrer.hostname;
  } catch {}
  return { capturedAt: new Date().toISOString(), landingPath, referrerHost, ...campaign };
};

export function captureSalesAttribution(landing?: SalesLanding): SalesAttribution | null {
  try {
    if (typeof window === "undefined") return null;
    const { pathname, search } = landing || window.location;
    const landingPath = salesPath(pathname);
    if (!landingPath) return null;
    const stored = sanitizeSalesAttribution(readStoredAttribution());
    const campaign = landingCampaign(search);
    const referral = campaign.creatorCode || sessionReferral();
    const fields = referral ? { ...campaign, creatorCode: referral } : campaign;
    const tagged = Object.keys(campaign).length > 0;
    const changed = tagged && FIELD_KEYS.some((key) => fields[key] !== stored?.lastTouch[key]);
    let current = stored;
    if (!stored || changed) {
      const journeyId = stored?.journeyId || newJourneyId();
      if (!journeyId) return null;
      const touch = newTouch(landingPath, fields);
      const firstTouch = stored?.firstTouch || touch;
      current = sanitizeSalesAttribution({ version: 2, journeyId, firstTouch, lastTouch: touch });
    }
    if (current) writeStoredAttribution(current);
    return current;
  } catch {
    return null;
  }
}

export function salesEventProperties(attribution: unknown = captureSalesAttribution()) {
  const value = sanitizeSalesAttribution(attribution);
  if (!value) return {};
  const { firstTouch: first, lastTouch: last } = value;
  const properties: Record<string, string | boolean> = { journey_id: value.journeyId, landing_path: last.landingPath };
  const optional: [string, string | undefined][] = [
    ["creator_code", last.creatorCode], ["campaign_source", last.source], ["campaign_medium", last.medium],
    ["campaign", last.campaign], ["campaign_content", last.content], ["campaign_term", last.term],
    ["referrer_host", last.referrerHost], ["first_source", first.source], ["first_campaign", first.campaign],
  ];
  for (const [key, text] of optional) if (text) properties[key] = text;
  properties.has_fbclid = Boolean(last.fbclid || first.fbclid);
  properties.has_gclid = Boolean(last.gclid || first.gclid);
  return properties;
}
