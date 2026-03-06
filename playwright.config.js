const { defineConfig } = require("@playwright/test");
const internalPort = Number(process.env.PW_PORT || 4173);
const internalDistDir =
  process.env.NEXT_DIST_DIR ||
  `.next-e2e-${process.env.PW_SERVER_ID || process.pid}`;
const baseURL = process.env.BASE_URL || `http://127.0.0.1:${internalPort}`;
const shouldUseExternalServer = Boolean(process.env.BASE_URL);

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 120000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  webServer: shouldUseExternalServer
    ? undefined
    : {
        command: `sh -c 'TZ=UTC rm -rf ${internalDistDir} && node scripts/validate-runtime-env.js && node scripts/generate-sitemap.js && node scripts/generate-robots.js && NEXT_DIST_DIR=${internalDistDir} next build && NEXT_DIST_DIR=${internalDistDir} next start --hostname 127.0.0.1 --port ${internalPort}'`,
        url: `http://127.0.0.1:${internalPort}`,
        reuseExistingServer: false,
        timeout: 180000,
      },
  use: {
    baseURL,
    javaScriptEnabled: false,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    timezoneId: process.env.PW_TIMEZONE || "UTC",
  },
});
