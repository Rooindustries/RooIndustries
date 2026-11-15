const { defineConfig } = require('@playwright/test');
const admin = require('./playwright.admin.config');

module.exports = defineConfig({
  ...admin,
  testMatch: /write-conflict-admin\.e2e\.js$/,
  projects: [{
    name: 'chromium',
    use: {
      browserName: 'chromium',
      launchOptions: { args: ['--ozone-platform=x11'] },
    },
  }],
});
