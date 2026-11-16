const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  metadata: { proofLeg: process.env.PW_LEG },
  workers: 1,
  projects: [{ name: "planted" }, { name: "idle", testMatch: "no-such.spec.js" }],
});
