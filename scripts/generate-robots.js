const fs = require("fs");
const path = require("path");

const siteUrl = (process.env.SITE_URL ||
  process.env.REACT_APP_SITE_URL ||
  "https://www.rooindustries.com").replace(/\/$/, "");

const vercelEnv = process.env.VERCEL_ENV || process.env.REACT_APP_VERCEL_ENV;
const nodeEnv = process.env.NODE_ENV;
const isNonProdEnv =
  vercelEnv && vercelEnv !== "production"
    ? true
    : nodeEnv === "development" || nodeEnv === "test";
const isProduction = !isNonProdEnv;

const lines = isProduction
  ? ["User-agent: *", "Allow: /", `Sitemap: ${siteUrl}/sitemap.xml`, ""]
  : ["User-agent: *", "Disallow: /", ""];

const targetPath = path.join(process.cwd(), "public", "robots.txt");
fs.writeFileSync(targetPath, lines.join("\n"), "utf8");
