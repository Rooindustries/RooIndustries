const { defineConfig } = require("@playwright/test");
const config = require("./playwright.config");

module.exports = defineConfig({
  ...config,
  testMatch: /admin-cms\.spec\.js$/,
  outputDir: "test-results/admin-e2e",
  retries: 0,
  projects: [{ name: "chromium", use: { browserName: "chromium", launchOptions: { args: ["--ozone-platform=x11", "--disable-renderer-accessibility", "--disable-gpu", `--unsafely-treat-insecure-origin-as-secure=${config.use.baseURL}`] } } }],
  use: { ...config.use, javaScriptEnabled: true, actionTimeout: 10000, navigationTimeout: 20000, video: "off", trace: "off" },
  webServer: config.webServer ? {
    ...config.webServer,
    timeout: 240000,
    env: { ...config.webServer.env, ROO_ADMIN_FIXTURE: "1" },
  } : undefined,
});
