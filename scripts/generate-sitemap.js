const fs = require("fs");
const path = require("path");
const { INDEXABLE_ROUTES } = require("../src/lib/routes");

const siteUrl = (process.env.SITE_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.REACT_APP_SITE_URL ||
  "https://www.rooindustries.com").replace(/\/$/, "");

const buildEntry = (route, now) => {
  const loc = route === "/" ? siteUrl : `${siteUrl}${route}`;
  const isHome = route === "/";

  return [
    "  <url>",
    `    <loc>${loc}</loc>`,
    `    <lastmod>${now}</lastmod>`,
    `    <changefreq>${isHome ? "daily" : "weekly"}</changefreq>`,
    `    <priority>${isHome ? "1.0" : "0.7"}</priority>`,
    "  </url>",
  ].join("\n");
};

async function run() {
  const routes = Array.from(new Set(INDEXABLE_ROUTES)).sort((a, b) =>
    a.localeCompare(b)
  );

  const now = new Date().toISOString();
  const urlEntries = routes.map((route) => buildEntry(route, now)).join("\n");

  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urlEntries,
    "</urlset>",
    "",
  ].join("\n");

  const targetPath = path.join(process.cwd(), "public", "sitemap.xml");
  fs.writeFileSync(targetPath, sitemap, "utf8");

  console.log(`[sitemap] Generated ${routes.length} routes.`);
}

run().catch((error) => {
  console.error("[sitemap] Failed to generate sitemap:", error);
  process.exit(1);
});
