import { SALES_PATHS, salesPath } from "./salesPaths";
import { readStoredAttribution, writeStoredAttribution } from "./attributionStore";

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
const LABEL = /^[\p{L}\p{M}\p{N} ._\-+:/|()@!~]{1,100}$/u;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const CLICK_ID = /^[A-Za-z0-9_.-]{1,200}$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const CAPTURED_AT = /^\d{4}-\d{2}-\d{2}T/;
const REFERRAL_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const label = (value: unknown) => {
  if (typeof value !== "string") return "";
  const text = value.normalize("NFKC").replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}<>"'`\\]/gu, "")
    .replace(/ {2,}/g, " ").trim();
  return LABEL.test(text) && !EMAIL.test(text) ? text : "";
};
const referralCode = (value: unknown) =>
  typeof value === "string" && REFERRAL_CODE.test(value.trim()) && /[a-z]/i.test(value) ? value.trim() : "";
const clickId = (value: unknown) => typeof value === "string" && CLICK_ID.test(value) ? value : "";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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
  if (typeof capturedAt !== "string" || !CAPTURED_AT.test(capturedAt)) return null;
  if (!Number.isFinite(Date.parse(capturedAt))) return null;
  const knownPath = typeof landingPath === "string" && (SALES_PATHS.has(landingPath) || landingPath === "/upgrade");
  const touch: SalesTouch = {
    capturedAt: new Date(capturedAt).toISOString(),
    landingPath: knownPath ? landingPath : "/",
  };
  if (typeof referrerHost === "string" && referrerHost.length <= 253 && HOST.test(referrerHost)) {
    touch.referrerHost = referrerHost.toLowerCase();
  }
  for (const key of FIELD_KEYS) {
    const safe = FIELDS[key][1](value[key]);
    if (safe) touch[key] = safe;
  }
  return touch;
};

export function sanitizeSalesAttribution(value: unknown): SalesAttribution | null {
  if (!isRecord(value) || typeof value.journeyId !== "string" || !JOURNEY_ID.test(value.journeyId)) return null;
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
