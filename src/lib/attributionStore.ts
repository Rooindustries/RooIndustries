import { onConsentChange, readConsent } from "./consent";

type StoredAttribution = Record<string, unknown> & {
  firstTouch?: Record<string, unknown>;
  lastTouch?: Record<string, unknown>;
};

const COOKIE = "roo_attr";
const SESSION_KEY = "sales_attribution";
const MAX_AGE_SECONDS = 7776000;
const MAX_COOKIE_VALUE = 3800;
const TRIMS: [string, ...string[]][] = [
  ["firstTouch", "fbclid", "gclid"],
  ["firstTouch", "content", "term"],
  ["firstTouch", "referrerHost", "medium"],
  ["lastTouch", "content", "term"],
  ["firstTouch", "source", "campaign", "creatorCode"],
  ["lastTouch", "referrerHost", "medium"],
];

let memory: StoredAttribution | null = null;

const encode = (value: unknown) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const decode = (text: string): unknown => {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
};

const fitCookieValue = (value: StoredAttribution) => {
  let candidate = value;
  let encoded = encode(candidate);
  for (const [touchKey, ...fields] of TRIMS) {
    if (encoded.length <= MAX_COOKIE_VALUE) break;
    const touch = { ...candidate[touchKey] as Record<string, unknown> };
    for (const field of fields) delete touch[field];
    candidate = { ...candidate, [touchKey]: touch };
    encoded = encode(candidate);
  }
  return encoded.length <= MAX_COOKIE_VALUE ? encoded : "";
};

const readCookie = () => {
  const prefix = `${COOKIE}=`;
  const entry = document.cookie.split(/;\s*/).find((part) => part.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : "";
};

const setCookie = (value: string, maxAge: number) => {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
};

const readSession = (): unknown => {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
};

const writeSession = (value: StoredAttribution | null) => {
  try {
    if (!value) sessionStorage.removeItem(SESSION_KEY);
    else if (sessionStorage.getItem(SESSION_KEY) !== JSON.stringify(value)) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
    }
  } catch {}
};

const writeCookie = (value: StoredAttribution) => {
  const encoded = fitCookieValue(value);
  if (!encoded) return false;
  if (readCookie() !== encoded) setCookie(encoded, MAX_AGE_SECONDS);
  return readCookie() === encoded;
};

export function readStoredAttribution(): unknown {
  try {
    const cookie = readCookie();
    if (cookie) return decode(cookie);
  } catch {}
  return readSession() || memory;
}

export function writeStoredAttribution(value: StoredAttribution) {
  memory = value;
  try {
    if (readConsent() === "granted" && writeCookie(value)) {
      writeSession(null);
      return;
    }
    if (readConsent() !== "granted" && readCookie()) setCookie("", 0);
  } catch {}
  writeSession(value);
}

const moveForConsent = () => {
  const stored = readStoredAttribution();
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
  writeStoredAttribution(stored as StoredAttribution);
};

if (typeof window !== "undefined") onConsentChange(moveForConsent);
