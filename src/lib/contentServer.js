const { applyHomePageCopyOverrides, resolveHeroCopy } = require("./homeCopy");
const { buildPackageOffers, normalizeFaqQuestions } = require("./packageContent");
const { normalizeTools } = require("./toolContent");

const { cache } = require("react");

const contentRevisionLedger = cache(() => new Map());
const readContentRevisions = () => Object.fromEntries(contentRevisionLedger());

const createPublicContentFetcher = async () => {
  const [{ fetchPublicContentEntry }, { resolveSupabaseRuntimePolicy }] =
    await Promise.all([
      import("../server/content/publicContent.js"),
      import("../server/supabase/runtime.js"),
    ]);
  const backend = resolveSupabaseRuntimePolicy().primaryBackend;
  return async (resource) => {
    const entry = await fetchPublicContentEntry({
      resource,
      backend,
      searchParams: new URLSearchParams(),
    });
    if (Number.isSafeInteger(entry.revision)) {
      const ledger = contentRevisionLedger();
      const current = ledger.get(resource);
      ledger.set(resource, current === undefined ? entry.revision : Math.min(current, entry.revision));
    }
    return entry.data;
  };
};

async function fetchFaqQuestions() {
  try {
    const fetchContent = await createPublicContentFetcher();
    const rows = await fetchContent("faq-questions");

    if (!Array.isArray(rows)) return [];

    return normalizeFaqQuestions(rows)
      .map((item) => ({
        question: String(item?.question || "").trim(),
        answer: String(item?.answer || "").trim(),
      }))
      .filter((item) => item.question && item.answer);
  } catch {
    console.warn("[content] FAQ fetch failed");
    return [];
  }
}

const refuseContentFallback = async (message, error) => {
  const { logSafeError } = await import("../server/safeErrorLog.js");
  logSafeError(message, error);
  throw error;
};

const refuseHomeFallback = (error) =>
  refuseContentFallback("Home content unavailable; keeping the previous page", error);

async function fetchHomePageData({
  requireContent = false,
  requiredResources = [],
} = {}) {
  let fetchContent;
  try {
    fetchContent = await createPublicContentFetcher();
  } catch (error) {
    if (requireContent) await refuseHomeFallback(error);
    console.warn("[content] home fetch failed");
    fetchContent = async () => null;
  }
  const failed = new Set();
  const safeFetch = async (resource, fallback) => {
    try {
      const data = await fetchContent(resource);
      return data ?? fallback;
    } catch {
      failed.add(resource);
      console.warn("[content] home fetch failed");
      return fallback;
    }
  };

  const [
    hero,
    reviews,
    about,
    services,
    packagesList,
    packagesSettings,
    howItWorks,
    supportedGames,
    faqSettings,
    faqQuestions,
    referralBox,
  ] = await Promise.all([
    safeFetch("hero", null),
    safeFetch("reviews", null),
    safeFetch("about", null),
    safeFetch("services", null),
    safeFetch("packages-list", []),
    safeFetch("packages-settings", null),
    safeFetch("how-it-works", null),
    safeFetch("supported-games", null),
    safeFetch("faq-settings", null),
    safeFetch("faq-questions", []),
    safeFetch("referral-box", null),
  ]);
  if (requireContent && requiredResources.length === 0 && failed.has("hero") && failed.has("packages-list")) {
    await refuseHomeFallback(Object.assign(new Error("Home content is unavailable."), { code: "HOME_CONTENT_UNAVAILABLE" }));
  }
  const missingResources = requiredResources.filter((resource) => failed.has(resource));
  if (requireContent && missingResources.length > 0) {
    await refuseContentFallback(
      "Page content unavailable; keeping the previous page",
      Object.assign(new Error("Page content is unavailable."), { code: "PAGE_CONTENT_UNAVAILABLE", resources: missingResources })
    );
  }

  return applyHomePageCopyOverrides({
    hero: resolveHeroCopy(hero),
    reviews,
    about,
    services,
    packagesList: buildPackageOffers(packagesList),
    packagesSettings,
    howItWorks,
    supportedGames,
    faqSettings,
    faqQuestions: normalizeFaqQuestions(
      Array.isArray(faqQuestions) ? faqQuestions : []
    ),
    referralBox,
  });
}

const PER_REQUEST_CONTENT_WAIT_MS = 1000;

async function withinRequestWait(load, label) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), PER_REQUEST_CONTENT_WAIT_MS);
  });
  try {
    return await Promise.race([
      load().catch(() => {
        console.warn(`[content] ${label} fetch failed`);
        return null;
      }),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const fetchFlowPageHomeData = () => withinRequestWait(() => fetchHomePageData(), "flow page home");

async function fetchDiscordBanner() {
  const banner = await withinRequestWait(() => fetchStaticPageContent("discord-banner"), "discord banner");
  const link = typeof banner?.link === "string" ? banner.link.trim() : "";
  return link ? { link } : null;
}

async function fetchHeroCopy() {
  try {
    const fetchContent = await createPublicContentFetcher();
    return resolveHeroCopy(await fetchContent("hero"));
  } catch {
    console.warn("[content] hero fetch failed");
    return resolveHeroCopy(null);
  }
}

async function fetchPrivacyPolicy() {
  try {
    const fetchContent = await createPublicContentFetcher();
    return await fetchContent("privacy-policy");
  } catch {
    return null;
  }
}

async function fetchStaticPageContent(resource, { requireContent = false } = {}) {
  try {
    const fetchContent = await createPublicContentFetcher();
    const content = await fetchContent(resource);
    if (requireContent && content == null && !["privacy-policy", "terms"].includes(resource)) {
      throw Object.assign(new Error(`No published ${resource} document.`), { code: "PAGE_CONTENT_MISSING" });
    }
    return resource === "tools" && Array.isArray(content) ? normalizeTools(content) : content;
  } catch (error) {
    if (requireContent) await refuseContentFallback("Page content unavailable; keeping the previous page", error);
    return null;
  }
}

async function fetchContentList(resource, label, { requireContent = false } = {}) {
  try {
    const fetchContent = await createPublicContentFetcher();
    const rows = await fetchContent(resource);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    if (requireContent) await refuseContentFallback(`${label} content unavailable; keeping the previous page`, error);
    return null;
  }
}

const fetchBenchmarks = (options) => fetchContentList("benchmarks", "Benchmarks", options);

const fetchReviewsGallery = (options) => fetchContentList("reviews-gallery", "Reviews", options);

async function fetchPackagesPageData({ requireContent = false } = {}) {
  const refuse = (error) =>
    refuseContentFallback("Packages content unavailable; keeping the previous page", error);
  let fetchContent;
  try {
    fetchContent = await createPublicContentFetcher();
  } catch (error) {
    if (requireContent) await refuse(error);
    return { packagesList: null, packagesSettings: null };
  }
  const read = async (resource) => {
    try {
      return await fetchContent(resource);
    } catch (error) {
      if (requireContent) await refuse(error);
      return null;
    }
  };
  const [packagesList, packagesSettings] = await Promise.all([
    read("packages-list"),
    read("packages-settings"),
  ]);
  return { packagesList: packagesList === null ? null : buildPackageOffers(packagesList), packagesSettings };
}

module.exports = {
  readContentRevisions,
  fetchBenchmarks,
  fetchReviewsGallery,
  fetchStaticPageContent,
  fetchPrivacyPolicy,
  fetchFaqQuestions,
  fetchHomePageData,
  fetchFlowPageHomeData,
  fetchDiscordBanner,
  fetchHeroCopy,
  fetchPackagesPageData,
};
