const config = require("./playwright.config.js");

module.exports = {
  ...config,
  testMatch: "**/booking-recovery.spec.js",
  workers: 1,
  webServer: undefined,
  metadata: { ...config.metadata, ownsToolingServer: false },
  use: { ...config.use, headless: true },
};
