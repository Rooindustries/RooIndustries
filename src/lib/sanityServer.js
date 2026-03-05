const { createClient } = require("@sanity/client");

const sanity = createClient({
  projectId: process.env.SANITY_PROJECT_ID || "9g42k3ur",
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  useCdn: true,
  token: process.env.SANITY_READ_TOKEN || undefined,
});

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

module.exports = {
  fetchFaqQuestions,
};
