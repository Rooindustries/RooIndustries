import { loadContent } from "./contentCache";
import { contentEntries } from "./contentEntries";

export { HOME_SECTION_DATA_KEYS } from "./homeSectionKeys";
import { HOME_SECTION_DATA_KEYS, homeSectionResources } from "./homeSectionKeys";

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

export const readHomeSectionData = (key) => contentEntries.get(key)?.data ?? null;

export const fetchHomeSectionData = (key) => {
  if (!homeSectionResources.has(key)) {
    return Promise.reject(new Error(`Unknown home section key: ${key}`));
  }
  return loadContent(key);
};

export const prefetchHomeSectionData = (keys = Object.values(HOME_SECTION_DATA_KEYS)) =>
  Promise.allSettled(keys.map((key) => fetchHomeSectionData(key)));
