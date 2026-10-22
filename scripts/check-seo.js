const fs = require("fs");
const path = require("path");
const seo = require("../src/lib/seo");
const { ALL_PUBLIC_ROUTES, INDEXABLE_ROUTES, NOINDEX_ROUTES } = require("../src/lib/routes");

const titleRange = [50, 60];
const descriptionRange = [150, 160];

const strictRoutes = [
  "/reviews",
  "/tools",
  "/referrals/login",
  "/referrals/register",
  "/referrals/dashboard",
  "/referrals/change-password",
  "/referrals/forgot",
  "/referrals/reset",
  "/404",
];

const errors = [];

const metadataRoutes = Array.from(new Set([...ALL_PUBLIC_ROUTES, "/404"]));
metadataRoutes.forEach((route) => {
  if (!seo.routeMeta[route]) {
    errors.push(`[${route}] Missing route metadata.`);
  }
});

for (const route of INDEXABLE_ROUTES) {
  if (seo.routeMeta[route]?.noindex !== false) {
    errors.push(`[${route}] Indexable route has conflicting robots metadata.`);
  }
}
for (const route of NOINDEX_ROUTES) {
  if (seo.routeMeta[route]?.noindex !== true) {
    errors.push(`[${route}] Private route must be marked noindex.`);
  }
}

const checkLength = (label, value, min, max, route) => {
  const len = String(value || "").trim().length;
  if (len < min || len > max) {
    errors.push(
      `[${route}] ${label} length ${len} is out of range ${min}-${max}`
    );
  }
};

for (const route of strictRoutes) {
  const entry = seo.routeMeta[route];
  if (!entry) {
    continue;
  }

  checkLength("title", entry.title, titleRange[0], titleRange[1], route);
  checkLength(
    "description",
    entry.description,
    descriptionRange[0],
    descriptionRange[1],
    route
  );
}

const reviewsPath = path.join(process.cwd(), "src", "legacyPages", "Reviews.jsx");
const seoConfigPath = path.join(process.cwd(), "src", "seoConfig.js");
const seoLibPath = path.join(process.cwd(), "src", "lib", "seo.js");
const biosGuideHtmlPath = path.join(process.cwd(), "public", "BIOSGuide", "index.html");

const reviewsContents = fs.readFileSync(reviewsPath, "utf8");
if (/AggregateRating/i.test(reviewsContents)) {
  errors.push("Reviews page still contains AggregateRating markup.");
}

const seoConfigContents = fs.readFileSync(seoConfigPath, "utf8");
if (/buildAggregateRatingJsonLd/.test(seoConfigContents)) {
  errors.push("seoConfig still exports buildAggregateRatingJsonLd.");
}
const seoLibContents = fs.readFileSync(seoLibPath, "utf8");
if (/"x-default"/.test(seoLibContents)) {
  errors.push("Invalid x-default meta usage is still present.");
}

const biosGuideHtml = fs.readFileSync(biosGuideHtmlPath, "utf8");
if (!/rel="canonical"\s+href="https:\/\/www\.rooindustries\.com\/BIOSGuide"/.test(biosGuideHtml)) {
  errors.push("BIOSGuide must declare a canonical URL.");
}
if (!/meta\s+name="robots"\s+content="index,\s*follow"/i.test(biosGuideHtml)) {
  errors.push("BIOSGuide must declare index, follow robots metadata.");
}
if (!/meta\s+name="description"\s+content="Learn BIOS tuning, performance optimization, and stability fundamentals with Roo Industries' BIOS Mastery Guide for gamers, creators, and PC enthusiasts\."/.test(biosGuideHtml)) {
  errors.push("BIOSGuide must declare the expected meta description.");
}
if (!/"@type":"Article"/.test(biosGuideHtml)) {
  errors.push("BIOSGuide must include Article JSON-LD.");
}

const bodyMatch = biosGuideHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
if (!bodyMatch) {
  errors.push("BIOSGuide body could not be parsed for integrity checks.");
} else {
  const bodyHash = require("crypto")
    .createHash("sha256")
    .update(bodyMatch[1], "utf8")
    .digest("hex");
  if (bodyHash !== "26f492b59d6779c3f71e85ca82b8d9663210b72891d7a030425596a1c909ab55") {
    errors.push("BIOSGuide body content changed unexpectedly.");
  }
}

if (errors.length) {
  console.error("SEO checks failed:\n");
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log("SEO checks passed.");
