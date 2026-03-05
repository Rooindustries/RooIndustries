const { defineConfig } = require("@playwright/test");
const baseURL = process.env.BASE_URL || "http://127.0.0.1:4173";
const shouldUseExternalServer = Boolean(process.env.BASE_URL);

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 45000,
  webServer: shouldUseExternalServer
    ? undefined
    : {
        command:
          "sh -c 'rm -rf .next && npm run build && npm run start -- --port 4173'",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: false,
        timeout: 120000,
      },
  use: {
    baseURL,
    javaScriptEnabled: false,
  },
});
