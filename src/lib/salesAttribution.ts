export type SalesAttribution = {
  version: 1;
  journeyId: string;
  capturedAt: string;
  landingPath: string;
  referrerHost?: string;
  creatorCode?: string;
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
};

const STORAGE_KEY = "sales_attribution";
const JOURNEY_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PUBLIC_PATHS = new Set(["/", "/packages", "/booking", "/payment", "/payment-success", "/thank-you", "/reviews", "/benchmarks", "/about", "/faq", "/contact", "/tools", "/terms", "/privacy"]);
const label = (value: unknown) => typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.trim()) && /[a-z]/i.test(value) ? value.trim() : "";
let fallback: SalesAttribution | null = null;

const newJourneyId = () => {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  if (!window.crypto?.getRandomValues) return "";
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};

export const salesPath = (pathname: string) => PUBLIC_PATHS.has(pathname) ? pathname : pathname === "/upgrade-xoc" || pathname.startsWith("/upgrade/") ? "/upgrade" : "";

export function sanitizeSalesAttribution(value: unknown): SalesAttribution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || typeof input.journeyId !== "string" || !JOURNEY_ID.test(input.journeyId)) return null;
  if (typeof input.capturedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(input.capturedAt) || !Number.isFinite(Date.parse(input.capturedAt))) return null;
  const landingPath = typeof input.landingPath === "string" && (PUBLIC_PATHS.has(input.landingPath) || input.landingPath === "/upgrade") ? input.landingPath : "/";
  const output: SalesAttribution = { version: 1, journeyId: input.journeyId.toLowerCase(), capturedAt: new Date(input.capturedAt).toISOString(), landingPath };
  for (const key of ["creatorCode", "source", "medium", "campaign", "content"] as const) {
    const safe = label(input[key]);
    if (safe) output[key] = safe;
  }
  if (typeof input.referrerHost === "string" && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(input.referrerHost) && input.referrerHost.length <= 253) output.referrerHost = input.referrerHost.toLowerCase();
  return output;
}

export function captureSalesAttribution(): SalesAttribution | null {
  try {
    if (typeof window === "undefined" || !salesPath(window.location.pathname)) return null;
    let current = fallback;
    try { current = sanitizeSalesAttribution(JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null")) || current; } catch {}
    const params = new URLSearchParams(window.location.search);
    const campaign = { creatorCode: label(params.get("ref")), source: label(params.get("utm_source")), medium: label(params.get("utm_medium")), campaign: label(params.get("utm_campaign")), content: label(params.get("utm_content")) };
    const explicit = Object.values(campaign).some(Boolean);
    const changed = current && explicit && Object.entries(campaign).some(([key,value]) => value && value !== (current?.[key as keyof SalesAttribution] || ""));
    if (!current || changed) {
      const journeyId = newJourneyId();
      if (!journeyId) return null;
      let referrerHost = "";
      try { const referrer = new URL(document.referrer); if (referrer.origin !== window.location.origin) referrerHost = referrer.hostname; } catch {}
      let creatorCode = campaign.creatorCode;
      if (!creatorCode) { try { creatorCode = label(sessionStorage.getItem("referral_session")); } catch {} }
      current = sanitizeSalesAttribution({ version: 1, journeyId, capturedAt: new Date().toISOString(), landingPath: salesPath(window.location.pathname), referrerHost, ...campaign, creatorCode });
    }
    fallback = current;
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch {}
    return current;
  } catch {
    return null;
  }
}

export function salesEventProperties(attribution: unknown = captureSalesAttribution()) {
  const value = sanitizeSalesAttribution(attribution);
  if (!value) return {};
  return { journey_id: value.journeyId, landing_path: value.landingPath, ...(value.creatorCode ? { creator_code: value.creatorCode } : {}), ...(value.source ? { campaign_source: value.source } : {}), ...(value.medium ? { campaign_medium: value.medium } : {}), ...(value.campaign ? { campaign: value.campaign } : {}), ...(value.content ? { campaign_content: value.content } : {}), ...(value.referrerHost ? { referrer_host: value.referrerHost } : {}) };
}

export function sanitizeAnalyticsEvent<T extends { url: string; type: string }>(event: T): T | null {
  try {
    const url = new URL(event.url);
    const path = salesPath(url.pathname);
    if (!path) return null;
    return { ...event, url: `${url.origin}${path}` };
  } catch { return null; }
}
