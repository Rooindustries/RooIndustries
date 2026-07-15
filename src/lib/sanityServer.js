const { applyHomePageCopyOverrides } = require("./homeCopy");
const {
  applyPackagesContentOverrides,
  normalizeFaqQuestions,
} = require("./packageContent");
const { applyPackagesPricing } = require("./packagePricing");

const createPublicContentFetcher = async () => {
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

async function fetchHomePageData() {
  let fetchContent;
  try {
    fetchContent = await createPublicContentFetcher();
  } catch {
    console.warn("[content] home fetch failed");
    fetchContent = async () => null;
  }
  const safeFetch = async (resource, fallback) => {
    try {
      const data = await fetchContent(resource);
      return data ?? fallback;
    } catch {
      console.warn("[content] home fetch failed");
      return fallback;
    }
  };

  const [
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

  return applyHomePageCopyOverrides({
    reviews,
    about,
    services,
    packagesList: applyPackagesContentOverrides(
      applyPackagesPricing(Array.isArray(packagesList) ? packagesList : [])
    ),
    packagesSettings,
    howItWorks,
    supportedGames,
    faqSettings,
    faqQuestions: normalizeFaqQuestions(
      Array.isArray(faqQuestions) ? faqQuestions : []
    ),
  });
}

module.exports = {
  fetchFaqQuestions,
  fetchHomePageData,
};
