import { readConsent } from "./consent";

type StoredAttribution = Record<string, unknown>;

const FIRST_COOKIE = "roo_attr";
const LAST_COOKIE = "roo_attr_last";
const ATTRIBUTION_COOKIES = [FIRST_COOKIE, LAST_COOKIE];
const META_COOKIES = ["_fbp", "_fbc"];
const SESSION_KEY = "sales_attribution";
const MAX_AGE_SECONDS = 7776000;

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

const readCookie = (name: string) => {
  const prefix = `${name}=`;
  const entry = document.cookie.split(/;\s*/).find((part) => part.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : "";
};

const setCookie = (name: string, value: string, maxAge: number, domain = "") => {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  const scope = domain ? `; Domain=${domain}` : "";
  document.cookie = `${name}=${value}; Path=/; Max-Age=${maxAge}${scope}; SameSite=Lax${secure}`;
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

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readCookieValue = (name: string): unknown => {
  try {
    const cookie = readCookie(name);
    return cookie ? decode(cookie) : null;
  } catch {
    return null;
  }
};

const readCookies = () => {
  const first = readCookieValue(FIRST_COOKIE);
  if (!isRecord(first)) return null;
  const last = readCookieValue(LAST_COOKIE);
  return isRecord(last) && last.journeyId === first.journeyId ? { ...first, lastTouch: last.lastTouch } : first;
};

const writeCookies = ({ lastTouch, ...first }: StoredAttribution) => {
  const cookies = [[FIRST_COOKIE, encode(first)], [LAST_COOKIE, encode({ journeyId: first.journeyId, lastTouch })]];
  for (const [name, encoded] of cookies) if (readCookie(name) !== encoded) setCookie(name, encoded, MAX_AGE_SECONDS);
  return cookies.every(([name, encoded]) => readCookie(name) === encoded);
};

const cookieDomains = () => {
  const labels = window.location.hostname.split(".");
  return ["", ...labels.slice(0, -1).map((_, index) => labels.slice(index).join("."))];
};

const removeCookies = (names: string[]) => {
  for (const name of names) {
    if (readCookie(name)) for (const domain of cookieDomains()) setCookie(name, "", 0, domain);
  }
};

export function readStoredAttribution(): unknown {
  return readCookies() || readSession() || memory;
}

export function writeStoredAttribution(value: StoredAttribution) {
  memory = value;
  try {
    if (readConsent() === "granted" && writeCookies(value)) {
      writeSession(null);
      return;
    }
    removeCookies(ATTRIBUTION_COOKIES);
  } catch {}
  writeSession(value);
}

export function storeAttributionForConsent() {
  const stored = readStoredAttribution();
  if (isRecord(stored)) writeStoredAttribution(stored);
  if (readConsent() !== "granted") removeCookies(META_COOKIES);
}
