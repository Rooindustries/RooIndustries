const path = require("node:path");

if (!process.env.BASE_URL || process.env.TOOLING_NETWORK_GUARD !== "1") {
  throw new Error("Explicit guarded local BASE_URL required for CTA proof.");
}

const inherited = require("../../playwright.config.js");
const phase = process.env.CTA_PHASE || "baseline";
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(phase)) {
  throw new Error("Invalid CTA artifact phase.");
}

module.exports = {
  ...inherited,
  testDir: path.resolve(__dirname, ".."),
  outputDir: path.resolve(__dirname, "../../test-results", `cta-${phase}-playwright`),
  retries: 0,
  globalSetup: path.resolve(__dirname, "home-cta-setup.cjs"),
  reporter: [["list"]],
  use: {
    ...inherited.use,
    browserName: "chromium",
    channel: "chrome",
    headless: false,
    video: "off",
    extraHTTPHeaders: { "x-roo-cta-preserve-home-ssr": "1" },
    launchOptions: { args: ["--ozone-platform=x11"] },
  },
};
