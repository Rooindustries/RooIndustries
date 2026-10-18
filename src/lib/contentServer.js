const { applyHomePageCopyOverrides, resolveHeroCopy } = require("./homeCopy");
const { buildPackageOffers, normalizeFaqQuestions } = require("./packageContent");

const createPublicContentFetcher = async ({ fresh = false } = {}) => {
  const [{ fetchPublicContent }, { resolveSupabaseRuntimePolicy }] =
    await Promise.all([
      import("../server/content/publicContent.js"),
      import("../server/supabase/runtime.js"),
    ]);
  const backend = resolveSupabaseRuntimePolicy().primaryBackend;
  return (resource) =>
    fetchPublicContent({
      resource,
      backend,
      searchParams: new URLSearchParams(),
      fresh,
    });
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

const refuseHomeFallback = async (error) => {
  const { logSafeError } = await import("../server/safeErrorLog.js");
  logSafeError("Home content unavailable; keeping the previous page", error);
  throw error;
};

async function fetchHomePageData({ fresh = false, requireContent = false } = {}) {
  let fetchContent;
  try {
    fetchContent = await createPublicContentFetcher({ fresh });
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
  ]);
  if (requireContent && failed.has("hero") && failed.has("packages-list")) {
    await refuseHomeFallback(Object.assign(new Error("Home content is unavailable."), { code: "HOME_CONTENT_UNAVAILABLE" }));
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
  });
}

const FLOW_PAGE_HOME_DATA_WAIT_MS = 1000;

async function fetchFlowPageHomeData() {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), FLOW_PAGE_HOME_DATA_WAIT_MS);
  });
  try {
    return await Promise.race([
      fetchHomePageData().catch(() => {
        console.warn("[content] flow page home fetch failed");
        return null;
      }),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
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

async function fetchTerms() {
  try {
    const fetchContent = await createPublicContentFetcher();
    return await fetchContent("terms");
  } catch {
    return null;
  }
}

module.exports = {
  fetchTerms,
  fetchPrivacyPolicy,
  fetchFaqQuestions,
  fetchHomePageData,
  fetchFlowPageHomeData,
  fetchHeroCopy,
};
