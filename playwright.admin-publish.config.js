const { defineConfig } = require("@playwright/test");
const config = require("./playwright.admin.config");

module.exports = defineConfig({
  ...config,
  testMatch: /content-publish-[^/]+\.spec\.js$/,
  outputDir: "test-results/admin-publish-e2e",
  webServer: config.webServer && { ...config.webServer, url: `${config.use.baseURL}/__content-test-ready` },
  projects: [
    { ...config.projects[0], name: "forcing", testMatch: /content-publish-rebuild\.spec\.js$/ },
    { ...config.projects[0], name: "publish", testIgnore: /content-publish-rebuild\.spec\.js$/, dependencies: ["forcing"] },
  ],
});
