const fs = require("fs");
const path = require("path");

const siteUrl = (process.env.SITE_URL ||
  process.env.REACT_APP_SITE_URL ||
  "https://www.rooindustries.com").replace(/\/$/, "");

const routes = [
  "/",
  "/packages",
  "/benchmarks",
  "/reviews",
  "/faq",
  "/contact",
  "/terms",
  "/privacy",
  "/meet-the-team",
];

const now = new Date().toISOString();

const urlEntries = routes
  .map((route) => {
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
  })
  .join("\n");

const sitemap = [
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">",
  urlEntries,
  "</urlset>",
  "",
].join("\n");

const targetPath = path.join(process.cwd(), "public", "sitemap.xml");
fs.writeFileSync(targetPath, sitemap, "utf8");
