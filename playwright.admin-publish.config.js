const { defineConfig } = require("@playwright/test");
const config = require("./playwright.admin.config");

module.exports = defineConfig({
  ...config,
  testMatch: /content-publish-[^/]+\.spec\.js$/,
  outputDir: "test-results/admin-publish-e2e",
});
