const fs = require("fs");
const path = require("path");
const { INDEXABLE_ROUTES } = require("../src/lib/routes");
const { SITE_URL } = require("../src/lib/seo");

const EXTRA_INDEXABLE_ROUTES = ["/BIOSGuide"];

const escapeXml = (value) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character],
  );

const buildEntry = (route) => {
  const loc = route === "/" ? SITE_URL : `${SITE_URL}${route}`;

  return ["  <url>", `    <loc>${escapeXml(loc)}</loc>`, "  </url>"].join("\n");
};

function run() {
  const routes = [
    ...new Set([...INDEXABLE_ROUTES, ...EXTRA_INDEXABLE_ROUTES]),
  ].sort((a, b) => a.localeCompare(b));
  const urlEntries = routes.map(buildEntry).join("\n");

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

try {
  run();
} catch (error) {
  console.error("[sitemap] Failed to generate sitemap:", error);
  process.exit(1);
}
