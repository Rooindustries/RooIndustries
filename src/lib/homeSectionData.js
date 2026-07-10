import { getPublicContent } from "./publicContentClient";
import homeCopy from "./homeCopy";
import packageContent from "./packageContent";
import packagePricing from "./packagePricing";

const { applyPackagesPricing } = packagePricing;
const { applyPackagesContentOverrides, normalizeFaqQuestions } = packageContent;
const { applyHomeSectionCopyOverride } = homeCopy;

export const HOME_SECTION_DATA_KEYS = Object.freeze({
  reviews: "reviews",
  about: "about",
  services: "services",
  packagesList: "packages-list",
  packagesSettings: "packages-settings",
  howItWorks: "how-it-works",
  supportedGames: "supported-games",
  faqSettings: "faq-settings",
  faqQuestions: "faq-questions",
});

export const HOME_SECTION_PREFETCH_BY_HASH = Object.freeze({
  "#services": [
    HOME_SECTION_DATA_KEYS.reviews,
    HOME_SECTION_DATA_KEYS.about,
    HOME_SECTION_DATA_KEYS.services,
  ],
  "#packages": [
    HOME_SECTION_DATA_KEYS.reviews,
    HOME_SECTION_DATA_KEYS.about,
    HOME_SECTION_DATA_KEYS.services,
    HOME_SECTION_DATA_KEYS.packagesList,
    HOME_SECTION_DATA_KEYS.packagesSettings,
  ],
  "#how-it-works": [
    HOME_SECTION_DATA_KEYS.reviews,
    HOME_SECTION_DATA_KEYS.about,
    HOME_SECTION_DATA_KEYS.services,
    HOME_SECTION_DATA_KEYS.packagesList,
    HOME_SECTION_DATA_KEYS.packagesSettings,
    HOME_SECTION_DATA_KEYS.howItWorks,
  ],
  "#faq": [
    HOME_SECTION_DATA_KEYS.reviews,
    HOME_SECTION_DATA_KEYS.about,
    HOME_SECTION_DATA_KEYS.services,
    HOME_SECTION_DATA_KEYS.packagesList,
    HOME_SECTION_DATA_KEYS.packagesSettings,
    HOME_SECTION_DATA_KEYS.howItWorks,
    HOME_SECTION_DATA_KEYS.supportedGames,
    HOME_SECTION_DATA_KEYS.faqSettings,
    HOME_SECTION_DATA_KEYS.faqQuestions,
  ],
  "#upgrade-path": [
    HOME_SECTION_DATA_KEYS.reviews,
    HOME_SECTION_DATA_KEYS.about,
    HOME_SECTION_DATA_KEYS.services,
    HOME_SECTION_DATA_KEYS.packagesList,
    HOME_SECTION_DATA_KEYS.packagesSettings,
    HOME_SECTION_DATA_KEYS.howItWorks,
    HOME_SECTION_DATA_KEYS.supportedGames,
    HOME_SECTION_DATA_KEYS.faqSettings,
    HOME_SECTION_DATA_KEYS.faqQuestions,
  ],
  "#trust": [
    HOME_SECTION_DATA_KEYS.reviews,
    HOME_SECTION_DATA_KEYS.about,
    HOME_SECTION_DATA_KEYS.services,
    HOME_SECTION_DATA_KEYS.packagesList,
    HOME_SECTION_DATA_KEYS.packagesSettings,
    HOME_SECTION_DATA_KEYS.howItWorks,
    HOME_SECTION_DATA_KEYS.supportedGames,
    HOME_SECTION_DATA_KEYS.faqSettings,
    HOME_SECTION_DATA_KEYS.faqQuestions,
  ],
});

const STORAGE_PREFIX = "roo-home-data:";
const STORAGE_TS_KEY = "roo-home-data:__ts";
const CACHE_TTL_MS = 5 * 60 * 1000;
const memoryCache = new Map();
const inflightCache = new Map();

const homeSectionResources = new Set(Object.values(HOME_SECTION_DATA_KEYS));

const getStorageKey = (key) => `${STORAGE_PREFIX}${key}`;

const normalizeHomeSectionData = (key, value) => {
  const copyValue = applyHomeSectionCopyOverride(key, value);
  if (key === HOME_SECTION_DATA_KEYS.packagesList) {
    return applyPackagesContentOverrides(applyPackagesPricing(copyValue));
  }
  if (key === HOME_SECTION_DATA_KEYS.faqQuestions) {
    return normalizeFaqQuestions(copyValue);
  }
  return copyValue;
};

const isSessionCacheExpired = () => {
  if (typeof window === "undefined") return false;
  try {
    const ts = Number(sessionStorage.getItem(STORAGE_TS_KEY) || 0);
    return Date.now() - ts > CACHE_TTL_MS;
  } catch {
    return true;
  }
};

export const readHomeSectionData = (key) => {
  if (isSessionCacheExpired()) {
    memoryCache.clear();
    try { sessionStorage.removeItem(STORAGE_TS_KEY); } catch {}
    return null;
  }
  if (memoryCache.has(key)) {
    return memoryCache.get(key);
  }
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(getStorageKey(key));
    if (!raw) return null;
    const parsed = normalizeHomeSectionData(key, JSON.parse(raw));
    memoryCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
};

const writeHomeSectionData = (key, value) => {
  const normalizedValue = normalizeHomeSectionData(key, value ?? null);
  memoryCache.set(key, normalizedValue ?? null);
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(
      getStorageKey(key),
      JSON.stringify(normalizedValue ?? null)
    );
    if (!sessionStorage.getItem(STORAGE_TS_KEY)) {
      sessionStorage.setItem(STORAGE_TS_KEY, String(Date.now()));
    }
  } catch {}
};

export const fetchHomeSectionData = (key) => {
  if (!homeSectionResources.has(key)) {
    return Promise.reject(new Error(`Unknown home section key: ${key}`));
  }

  const cached = readHomeSectionData(key);
  if (cached !== null) {
    return Promise.resolve(cached);
  }

  if (inflightCache.has(key)) {
    return inflightCache.get(key);
  }

  const request = getPublicContent(key)
    .then((data) => {
      const normalizedData = normalizeHomeSectionData(key, data);
      writeHomeSectionData(key, normalizedData);
      inflightCache.delete(key);
      return normalizedData;
    })
    .catch((error) => {
      inflightCache.delete(key);
      throw error;
    });

  inflightCache.set(key, request);
  return request;
};

export const prefetchHomeSectionData = (keys = Object.values(HOME_SECTION_DATA_KEYS)) =>
  Promise.allSettled(keys.map((key) => fetchHomeSectionData(key)));
