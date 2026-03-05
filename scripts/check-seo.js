const fs = require("fs");
const path = require("path");
const seo = require("../src/lib/seo");
const { ALL_PUBLIC_ROUTES } = require("../src/lib/routes");

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
const indexHtmlPath = path.join(process.cwd(), "public", "index.html");

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

const indexHtml = fs.readFileSync(indexHtmlPath, "utf8");
if (!/og:image:width"\s+content="500"/.test(indexHtml)) {
  errors.push("public/index.html og:image:width must be 500.");
}
if (!/og:image:height"\s+content="500"/.test(indexHtml)) {
  errors.push("public/index.html og:image:height must be 500.");
}

if (errors.length) {
  console.error("SEO checks failed:\n");
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log("SEO checks passed.");
