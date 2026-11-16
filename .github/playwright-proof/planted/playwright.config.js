const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  workers: 1,
  projects: [{ name: "planted" }, { name: "idle", testMatch: "no-such.spec.js" }],
});
