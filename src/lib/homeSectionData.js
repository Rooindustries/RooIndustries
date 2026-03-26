import { publicClient } from "../sanityClient";

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

const homeSectionQueries = {
  [HOME_SECTION_DATA_KEYS.reviews]: {
    query: `*[_type == "proReviewsCarousel"][0]{
      _id,
      title,
      subtitle,
      reviews[]{
        name,
        profession,
        game,
        optimizationResult,
        text,
        rating,
        pfp,
        isVip
      }
    }`,
  },
  [HOME_SECTION_DATA_KEYS.about]: {
    query: `*[_type == "about"][0]{
      recordTitle,
      recordBadgeText,
      recordSubtitle,
      recordButtonText,
      recordNote,
      recordDetails,
      recordLink
    }`,
  },
  [HOME_SECTION_DATA_KEYS.services]: {
    query: `*[_type == "services"][0]{
      heading,
      subheading,
      cards[]{title, description, iconType, customIcon},
      benchEnabled,
      benchMetricLabel,
      benchBeforeLabel,
      benchAfterLabel,
      benchBadgeSuffix,
      benchPagePrefix,
      benchPages[]{
        games[]{gameTitle, gameLogo, beforeFps, afterFps, gpu, cpu, ram, metricLabel}
      }
    }`,
  },
  [HOME_SECTION_DATA_KEYS.packagesList]: {
    query: `*[_type == "package"] | order(coalesce(order, 999) asc, _createdAt asc) {
      _id,
      title,
      price,
      tag,
      tagGoldGlow,
      description,
      checkedBullets,
      uncheckedBullets,
      features,
      buttonText,
      detailsButtonText,
      isHighlighted,
      order
    }`,
  },
  [HOME_SECTION_DATA_KEYS.packagesSettings]: {
    query: `*[_type == "packagesSettings"][0]{
      heading,
      badgeText,
      subheading,
      dividerText
    }`,
  },
  [HOME_SECTION_DATA_KEYS.howItWorks]: {
    query: `*[_type == "howItWorks"][0]{
      title,
      subtitle,
      steps[]{badge, title, text, iconType}
    }`,
  },
  [HOME_SECTION_DATA_KEYS.supportedGames]: {
    query: `*[_type == "supportedGames"][0]{
      title,
      subtitle,
      showAllLabel,
      showLessLabel,
      featuredGames[]{
        _key,
        title,
        coverImage{
          ...,
          "dimensions": asset->metadata.dimensions
        }
      },
      moreGames[]{
        _key,
        title,
        coverImage{
          ...,
          "dimensions": asset->metadata.dimensions
        }
      }
    }`,
  },
  [HOME_SECTION_DATA_KEYS.faqSettings]: {
    query: `*[_type == "faqSettings"][0]{ eyebrow, title, subtitle }`,
    options: { cache: "no-store" },
  },
  [HOME_SECTION_DATA_KEYS.faqQuestions]: {
    query: `coalesce(
      *[_type == "faqSection" && _id == "faq"][0].questions,
      *[_type == "faqSection"] | order(_createdAt asc) .questions[]
    )`,
    options: { cache: "no-store" },
  },
};

const getStorageKey = (key) => `${STORAGE_PREFIX}${key}`;

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
    const parsed = JSON.parse(raw);
    memoryCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
};

const writeHomeSectionData = (key, value) => {
  memoryCache.set(key, value ?? null);
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(getStorageKey(key), JSON.stringify(value ?? null));
    if (!sessionStorage.getItem(STORAGE_TS_KEY)) {
      sessionStorage.setItem(STORAGE_TS_KEY, String(Date.now()));
    }
  } catch {}
};

export const fetchHomeSectionData = (key) => {
  const config = homeSectionQueries[key];
  if (!config) {
    return Promise.reject(new Error(`Unknown home section key: ${key}`));
  }

  const cached = readHomeSectionData(key);
  if (cached !== null) {
    return Promise.resolve(cached);
  }

  if (inflightCache.has(key)) {
    return inflightCache.get(key);
  }

  const request = publicClient
    .fetch(config.query, {}, config.options || undefined)
    .then((data) => {
      writeHomeSectionData(key, data);
      inflightCache.delete(key);
      return data;
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
