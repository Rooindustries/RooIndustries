const { applyHomePageCopyOverrides, resolveHeroCopy } = require("./homeCopy");
const { buildPackageOffers, normalizeFaqQuestions } = require("./packageContent");

const createPublicContentFetcher = async ({ confirmed = false } = {}) => {
  const [{ fetchPublicContent, fetchPublicContentEntry }, { resolveSupabaseRuntimePolicy }] =
    await Promise.all([
      import("../server/content/publicContent.js"),
      import("../server/supabase/runtime.js"),
    ]);
  const backend = resolveSupabaseRuntimePolicy().primaryBackend;
  if (!confirmed) {
    return (resource) =>
      fetchPublicContent({
        resource,
        backend,
        searchParams: new URLSearchParams(),
      });
  }
  return async (resource) => {
    const entry = await fetchPublicContentEntry({ resource, backend, searchParams: new URLSearchParams() });
    if (!entry.confirmed) {
      throw Object.assign(new Error("Public content was not confirmed at the current revision."), { code: "PUBLIC_CONTENT_UNCONFIRMED" });
    }
    return entry.data;
  };
};

let refusalReported = false;
let refusalGeneration = 0;
const contentConfirmed = (value, generation) => {
  if (generation === refusalGeneration) refusalReported = false;
  return value;
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

const refuseContentFallback = async (error) => {
  if (!refusalReported) {
    refusalReported = true;
    refusalGeneration += 1;
    const { logSafeError } = await import("../server/safeErrorLog.js");
    logSafeError("Page content unavailable; keeping the previous page", error);
  }
  throw error;
};

async function fetchHomePageData({
  requireContent = false,
} = {}) {
  const generation = refusalGeneration;
  let fetchContent;
  try {
    fetchContent = await createPublicContentFetcher({ confirmed: requireContent });
  } catch (error) {
    if (requireContent) await refuseContentFallback(error);
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
  if (requireContent && failed.size > 0) {
    await refuseContentFallback(
      Object.assign(new Error("Page content is unavailable."), { code: "PAGE_CONTENT_UNAVAILABLE", resources: [...failed] })
    );
  }
  if (requireContent) contentConfirmed(undefined, generation);

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
  const banner = await withinRequestWait(() => fetchStaticPageContent("discord-banner", { confirmed: true }), "discord banner");
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

async function fetchStaticPageContent(resource, { requireContent = false, confirmed = requireContent } = {}) {
  const generation = refusalGeneration;
  try {
    const fetchContent = await createPublicContentFetcher({ confirmed });
    const content = await fetchContent(resource);
    if (requireContent && content == null) {
      throw Object.assign(new Error(`No published ${resource} document.`), { code: "PAGE_CONTENT_MISSING" });
    }
    return requireContent ? contentConfirmed(content, generation) : content;
  } catch (error) {
    if (requireContent) await refuseContentFallback(error);
    return null;
  }
}

async function fetchContentList(resource, { requireContent = false } = {}) {
  const generation = refusalGeneration;
  try {
    const fetchContent = await createPublicContentFetcher({ confirmed: requireContent });
    const rows = await fetchContent(resource);
    const content = Array.isArray(rows) ? rows : [];
    return requireContent ? contentConfirmed(content, generation) : content;
  } catch (error) {
    if (requireContent) await refuseContentFallback(error);
    return null;
  }
}

const fetchBenchmarks = (options) => fetchContentList("benchmarks", options);

const fetchReviewsGallery = (options) => fetchContentList("reviews-gallery", options);

async function fetchPackagesPageData({ requireContent = false } = {}) {
  const generation = refusalGeneration;
  let fetchContent;
  try {
    fetchContent = await createPublicContentFetcher({ confirmed: requireContent });
  } catch (error) {
    if (requireContent) await refuseContentFallback(error);
    return { packagesList: null, packagesSettings: null };
  }
  const read = async (resource) => {
    try {
      return await fetchContent(resource);
    } catch (error) {
      if (requireContent) await refuseContentFallback(error);
      return null;
    }
  };
  const [packagesList, packagesSettings] = await Promise.all([
    read("packages-list"),
    read("packages-settings"),
  ]);
  if (requireContent) contentConfirmed(undefined, generation);
  return { packagesList, packagesSettings };
}

module.exports = {
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
