const { createClient } = require("@sanity/client");

const INDEXABLE_ROUTES = [
  "/",
  "/packages",
  "/benchmarks",
  "/reviews",
  "/faq",
  "/contact",
  "/terms",
  "/privacy",
  "/meet-the-team",
  "/tools",
  "/referrals/login",
  "/referrals/register",
];

const NOINDEX_ROUTES = [
  "/booking",
  "/payment",
  "/payment-success",
  "/thank-you",
  "/upgrade-xoc",
  "/referrals/dashboard",
  "/referrals/change-password",
  "/referrals/forgot",
  "/referrals/reset",
];

const STATIC_ROUTES = INDEXABLE_ROUTES;
const ALL_PUBLIC_ROUTES = [...INDEXABLE_ROUTES, ...NOINDEX_ROUTES];

const sanitizeSlug = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\s+/g, "-");

async function getUpgradeRoutes() {
  const projectId = process.env.SANITY_PROJECT_ID || "9g42k3ur";
  const dataset = process.env.SANITY_DATASET || "production";

  const client = createClient({
    projectId,
    dataset,
    apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
    useCdn: true,
    token: process.env.SANITY_READ_TOKEN || undefined,
  });

  try {
    const docs = await client.fetch(
      `*[_type == "upgradeLink" && defined(slug.current)]{ "slug": slug.current }`
    );

    const routes = Array.from(
      new Set(
        (docs || [])
          .map((entry) => sanitizeSlug(entry?.slug))
          .filter(Boolean)
          .map((slug) => `/upgrade/${slug}`)
      )
    );

    return routes;
  } catch (error) {
    console.warn("[routes] Failed to resolve upgrade slugs for sitemap:", error.message);
    return [];
  }
}

module.exports = {
  INDEXABLE_ROUTES,
  STATIC_ROUTES,
  NOINDEX_ROUTES,
  ALL_PUBLIC_ROUTES,
  getUpgradeRoutes,
};
