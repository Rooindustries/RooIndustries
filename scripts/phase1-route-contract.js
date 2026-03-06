/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error("[phase1-route-contract] BASE_URL is required");
  process.exit(1);
}

const routes = [
  "/",
  "/packages",
  "/reviews",
  "/tools",
  "/faq",
  "/benchmarks",
  "/booking",
  "/payment",
  "/meet-the-team",
  "/referrals/login",
  "/referrals/register",
  "/referrals/forgot",
  "/referrals/reset",
  "/upgrade-xoc",
  "/upgrade/example",
  "/definitely-not-a-real-route",
];

const csvEscape = (value) => {
  const raw = String(value ?? "");
  if (raw.includes(",") || raw.includes("\"") || raw.includes("\n")) {
    return `"${raw.replace(/"/g, "\"\"")}"`;
  }
  return raw;
};

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const rows = [];

  for (const route of routes) {
    const response = await page.goto(`${BASE_URL}${route}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    const finalUrl = page.url();
    const status = response?.status() ?? 0;
    const title = await page.title();
    const mainCount = await page.locator("main").count();
    const bodyText = await page.locator("body").innerText();
    const styleLoaded = await page.evaluate(() => {
      const cssLinks = Array.from(
        document.querySelectorAll('link[rel="stylesheet"]')
      );
      const hasStylesheet = cssLinks.length > 0;
      const bodyBg = window.getComputedStyle(document.body).backgroundImage;
      return hasStylesheet && bodyBg && bodyBg !== "none";
    });
    const isNotFound = /not found|404/i.test(bodyText);
    const hostDrift = !finalUrl.startsWith(BASE_URL);
    rows.push({
      route,
      status,
      final_url: finalUrl,
      host_drift: hostDrift,
      main_count: mainCount,
      style_loaded: styleLoaded,
      title_length: title.length,
      not_found_text: isNotFound,
      pass:
        route === "/definitely-not-a-real-route"
          ? isNotFound && !hostDrift
          : status < 400 && mainCount === 1 && styleLoaded && !hostDrift,
    });
  }

  await browser.close();

  const auditDir = path.join(process.cwd(), "audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const out = path.join(auditDir, "phase1-route-contract.csv");

  const headers = [
    "route",
    "status",
    "final_url",
    "host_drift",
    "main_count",
    "style_loaded",
    "title_length",
    "not_found_text",
    "pass",
  ];

  const lines = [headers.join(",")];
  rows.forEach((row) => {
    lines.push(
      headers.map((key) => csvEscape(row[key])).join(",")
    );
  });

  fs.writeFileSync(out, `${lines.join("\n")}\n`);
  const failures = rows.filter((row) => !row.pass);
  if (failures.length) {
    console.error(
      `[phase1-route-contract] failures: ${failures
        .map((f) => `${f.route}:${f.status}`)
        .join(", ")}`
    );
    process.exit(1);
  }
  console.log(`[phase1-route-contract] wrote ${out}`);
}

run().catch((err) => {
  console.error("[phase1-route-contract] failed:", err);
  process.exit(1);
});
