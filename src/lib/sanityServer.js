const { createClient } = require("@sanity/client");

const sanity = createClient({
  projectId: process.env.SANITY_PROJECT_ID || "9g42k3ur",
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  useCdn: true,
  token: process.env.SANITY_READ_TOKEN || undefined,
});

async function safeFetch(query, fallback, label = "query") {
  try {
    const data = await sanity.fetch(query);
    return data ?? fallback;
  } catch (error) {
    console.warn(`[sanity] ${label} fetch failed:`, error.message);
    return fallback;
  }
}

async function fetchFaqQuestions() {
  const rows = await safeFetch(
    `coalesce(
      *[_type == "faqSection" && _id == "faq"][0].questions,
      *[_type == "faqSection"] | order(_createdAt asc) .questions[]
    )`,
    [],
    "faq"
  );

  if (!Array.isArray(rows)) return [];

  return rows
    .map((item) => ({
      question: String(item?.question || "").trim(),
      answer: String(item?.answer || "").trim(),
    }))
    .filter((item) => item.question && item.answer);
}

async function fetchHomePageData() {
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

async function fetchFaqPageData() {
  const [faqSettings, faqQuestions] = await Promise.all([
    safeFetch(
      `*[_type == "faqSettings"][0]{ eyebrow, title, subtitle }`,
      null,
      "faq-settings"
    ),
    safeFetch(
      `coalesce(
        *[_type == "faqSection" && _id == "faq"][0].questions,
        *[_type == "faqSection"] | order(_createdAt asc) .questions[]
      )`,
      [],
      "faq-questions"
    ),
  ]);

  return {
    faqSettings,
    faqQuestions: Array.isArray(faqQuestions) ? faqQuestions : [],
  };
}

async function fetchPackagesPageData() {
  const [packagesList, packagesSettings] = await Promise.all([
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
      [],
      "packages-list"
    ),
    safeFetch(
      `*[_type == "packagesSettings"][0]{
        heading,
        badgeText,
        subheading,
        dividerText
      }`,
      null,
      "packages-settings"
    ),
  ]);

  return {
    packagesList: Array.isArray(packagesList) ? packagesList : [],
    packagesSettings,
  };
}

async function fetchMeetTheTeamPageData() {
  return safeFetch(
    `*[_type == "meetTheTeam"][0]{
      seoTitle,
      seoDescription,
      heroTitle,
      heroSubtitle,
      showFounder,
      founder{
        badgeText,
        name,
        title,
        bio,
        avatar,
        stats[]{_key, value, label},
        tags,
        socialLinks[]{_key, label, url, icon}
      },
      sections[]{
        _key,
        title,
        variant,
        cards[]{
          _key,
          name,
          title,
          bio,
          avatar,
          initials,
          tags,
          platformBadge,
          ctaLabel,
          ctaUrl
        }
      },
      footer{
        note,
        buttonText,
        buttonUrl,
        showDiscordIcon
      }
    }`,
    null,
    "meet-the-team"
  );
}

async function fetchBenchmarksPageData() {
  const benchmarks = await safeFetch(
    `*[_type == "benchmark"] 
      | order(coalesce(sortOrder, 9999) asc, _createdAt asc) {
        title,
        subtitle,
        beforeImage{
          ...,
          "dimensions": asset->metadata.dimensions
        },
        afterImage{
          ...,
          "dimensions": asset->metadata.dimensions
        },
        reviewImage{
          ...,
          "dimensions": asset->metadata.dimensions
        }
      }`,
    [],
    "benchmarks"
  );

  return Array.isArray(benchmarks) ? benchmarks : [];
}

async function fetchReviewsPageData() {
  const reviews = await safeFetch(
    `*[_type == "review"] | order(_createdAt asc){
      image{
        ...,
        "dimensions": asset->metadata.dimensions
      },
      alt
    }`,
    [],
    "reviews"
  );

  return Array.isArray(reviews) ? reviews : [];
}

async function fetchContactPageData() {
  return safeFetch(
    `*[_type == "contact"][0]{
      title,
      subtitle,
      email,
      formId
    }`,
    null,
    "contact"
  );
}

async function fetchTermsPageData() {
  return safeFetch(
    `*[_type == "terms"][0]{
      title,
      lastUpdated,
      sections[]{heading, content}
    }`,
    null,
    "terms"
  );
}

async function fetchPrivacyPolicyPageData() {
  return safeFetch(
    `*[_type == "privacyPolicy"][0]{
      title,
      sections[]{heading, content},
      lastUpdated
    }`,
    null,
    "privacy-policy"
  );
}

async function fetchToolsPageData() {
  const tools = await safeFetch(
    `*[_type == "tool"] | order(sortOrder asc, title asc) {
      _id,
      title,
      category,
      shortDescription,
      downloadMode,
      downloadUrl,
      officialSite,
      downloadNote,
      "iconUrl": icon.asset->url,
      "fileUrl": downloadFile.asset->url
    }`,
    [],
    "tools"
  );

  return Array.isArray(tools) ? tools : [];
}

module.exports = {
  fetchBenchmarksPageData,
  fetchContactPageData,
  fetchFaqQuestions,
  fetchFaqPageData,
  fetchHomePageData,
  fetchMeetTheTeamPageData,
  fetchPackagesPageData,
  fetchPrivacyPolicyPageData,
  fetchReviewsPageData,
  fetchTermsPageData,
  fetchToolsPageData,
};
