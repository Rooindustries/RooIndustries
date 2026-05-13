const { createClient } = require("@sanity/client");
const { resolveMarketSanityDataset } = require("./market.js");
const { normalizeSiteSettings } = require("./siteMode.js");

const sanity = createClient({
  projectId: process.env.SANITY_PROJECT_ID || "9g42k3ur",
  dataset: resolveMarketSanityDataset(),
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  useCdn: true,
  token: process.env.SANITY_READ_TOKEN || undefined,
});

const freshSanity = sanity.withConfig({ useCdn: false });

async function fetchSiteSettings() {
  try {
    const settings = await freshSanity.fetch(
      `*[_type == "siteSettings" && _id == "site-settings"][0]{
        siteMode
      }`
    );
    return normalizeSiteSettings(settings);
  } catch (error) {
    console.warn("[sanity] site settings fetch failed:", error.message);
    return normalizeSiteSettings();
  }
}

async function fetchFaqQuestions() {
  try {
    const rows = await sanity.fetch(
      `coalesce(
        *[_type == "faqSection" && _id == "faq"][0].questions,
        *[_type == "faqSection"] | order(_createdAt asc) .questions[]
      )`
    );

    if (!Array.isArray(rows)) return [];

    return rows
      .map((item) => ({
        question: String(item?.question || "").trim(),
        answer: String(item?.answer || "").trim(),
      }))
      .filter((item) => item.question && item.answer);
  } catch (error) {
    console.warn("[sanity] FAQ fetch failed:", error.message);
    return [];
  }
}

async function fetchHomePageData() {
  const safeFetch = async (query, fallback) => {
    try {
      const data = await sanity.fetch(query);
      return data ?? fallback;
    } catch (error) {
      console.warn("[sanity] home fetch failed:", error.message);
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
    safeFetch(
      `*[_type == "proReviewsCarousel"][0]{
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
      null
    ),
    safeFetch(
      `*[_type == "about"][0]{
        recordTitle,
        recordBadgeText,
        recordSubtitle,
        recordButtonText,
        recordNote,
        recordDetails,
        recordLink
      }`,
      null
    ),
    safeFetch(
      `*[_type == "services"][0]{
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
      null
    ),
    safeFetch(
      `*[_type == "package"] | order(coalesce(order, 999) asc, _createdAt asc) {
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
      []
    ),
    safeFetch(
      `*[_type == "packagesSettings"][0]{
        heading,
        badgeText,
        subheading,
        dividerText
      }`,
      null
    ),
    safeFetch(
      `*[_type == "howItWorks"][0]{
        title,
        subtitle,
        steps[]{badge, title, text, iconType}
      }`,
      null
    ),
    safeFetch(
      `*[_type == "supportedGames"][0]{
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
      null
    ),
    safeFetch(
      `*[_type == "faqSettings"][0]{ eyebrow, title, subtitle }`,
      null
    ),
    safeFetch(
      `coalesce(
        *[_type == "faqSection" && _id == "faq"][0].questions,
        *[_type == "faqSection"] | order(_createdAt asc) .questions[]
      )`,
      []
    ),
  ]);

  return {
    reviews,
    about,
    services,
    packagesList: Array.isArray(packagesList) ? packagesList : [],
    packagesSettings,
    howItWorks,
    supportedGames,
    faqSettings,
    faqQuestions: Array.isArray(faqQuestions) ? faqQuestions : [],
  };
}

module.exports = {
  fetchFaqQuestions,
  fetchHomePageData,
  fetchSiteSettings,
};
