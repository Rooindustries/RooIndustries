const { defineConfig } = require("@playwright/test");
for (const key of Object.keys(process.env)) {
  if (/SENTRY.*DSN/i.test(key)) delete process.env[key];
}
process.env.NEXT_PUBLIC_SENTRY_DSN = "";
const config = require("./playwright.config");
process.env.TOOLING_CMS_RESILIENCE = "1";

module.exports = defineConfig({
  ...config,
  testMatch: /cms-resilience\.spec\.js$/,
  outputDir: process.env.CMS_TEST_OUTPUT || "test-results/cms-resilience",
  workers: 1,
  retries: 0,
  timeout: 600000,
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  use: { ...config.use, headless: true, javaScriptEnabled: true, video: "off" },
  webServer: config.webServer ? {
    ...config.webServer,
    timeout: 600000,
    env: { ...config.webServer.env, TOOLING_CMS_RESILIENCE: "1", TOOLING_API_ROUTES: "1", TOOLING_CLS_CONTENT: "1" },
  } : undefined,
});
