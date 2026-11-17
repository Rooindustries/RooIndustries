const { defineConfig } = require("@playwright/test");
const config = require("./playwright.admin.config");

module.exports = defineConfig({
  ...config,
  testIgnore: /(content-publish-[^/]+|image-size-fill)\.spec\.js$/,
});
