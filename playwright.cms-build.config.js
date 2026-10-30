const { defineConfig } = require("@playwright/test");

for (const key of Object.keys(process.env)) {
  if (/SENTRY.*DSN/i.test(key)) delete process.env[key];
}
process.env.NEXT_PUBLIC_SENTRY_DSN = "";

module.exports = defineConfig({
  testDir: "./tests",
  testMatch: /cms-snapshot-build\.spec\.js$/,
  outputDir: process.env.CMS_BUILD_TEST_OUTPUT || "test-results/cms-snapshot-build",
  timeout: 20 * 60 * 1000,
  globalTimeout: 25 * 60 * 1000,
  workers: 1,
  retries: 0,
  fullyParallel: false,
  metadata: { toolingDistDir: process.env.NEXT_DIST_DIR || `.next-e2e-cms-snapshot-${process.pid}` },
  use: { browserName: "chromium", headless: true, trace: "retain-on-failure", video: "off" },
});
