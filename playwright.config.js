const { defineConfig } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { webkit } = require("playwright");
const webkitLaunchOptions = {};
if (process.platform === "linux" && process.env.LD_LIBRARY_PATH) {
  const bundle = path.join(path.dirname(webkit.executablePath()), "minibrowser-gtk");
  const executablePath = path.join(bundle, "bin", "MiniBrowser");
  if (!fs.existsSync(executablePath)) throw new Error("Native headed WebKit binary is missing.");
  webkitLaunchOptions.executablePath = executablePath;
  webkitLaunchOptions.env = {
    ...process.env,
    WEBKIT_EXEC_PATH: path.join(bundle, "bin"),
    WEBKIT_INJECTED_BUNDLE_PATH: path.join(bundle, "lib"),
    LD_LIBRARY_PATH: `${bundle}/lib:${bundle}/sys/lib:${process.env.LD_LIBRARY_PATH}`,
  };
}
const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
const internalPort = Number(process.env.PW_PORT || 4173);
if (!Number.isInteger(internalPort) || internalPort < 1024 || internalPort > 65535) throw new Error("Invalid Playwright port.");
const serverId = process.env.PW_SERVER_ID || String(process.pid);
if (!/^[a-zA-Z0-9_-]+$/.test(serverId)) throw new Error("Invalid Playwright server ID.");
const internalDistDir = process.env.NEXT_DIST_DIR || `.next-e2e-${serverId}`;
if (!/^\.next(?:-[a-zA-Z0-9_-]+)?$/.test(internalDistDir) ||
    (fs.lstatSync(internalDistDir, { throwIfNoEntry: false })?.isSymbolicLink())) throw new Error("Invalid Playwright build directory.");
const baseURL = process.env.BASE_URL || `http://${testHost}:${internalPort}`;
const target = new URL(baseURL);
if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", new URL(`http://${testHost}`).hostname].includes(target.hostname) ||
    !target.port || target.username || target.password || target.pathname !== "/" || target.search || target.hash ||
    ![target.origin, `${target.origin}/`].includes(baseURL)) throw new Error("Explicit canonical local BASE_URL required.");
const shouldUseExternalServer = Boolean(process.env.BASE_URL);
if (!shouldUseExternalServer && !internalDistDir.startsWith(".next-e2e-")) throw new Error("Isolated Playwright build directory required.");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 120000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  projects: [
    { name: "chromium", testIgnore: /home-cta-mobile\.spec\.js$/, use: { browserName: "chromium", launchOptions: { args: ["--ozone-platform=x11"] } } },
    { name: "mobile-webkit", testMatch: /home-cta-mobile\.spec\.js$/, use: { browserName: "webkit", launchOptions: webkitLaunchOptions } },
  ],
  webServer: shouldUseExternalServer
    ? undefined
    : {
        command: "node scripts/test-tooling-sweep-server.mjs",
        url: baseURL,
        env: { ROO_TEST_HOST: testHost, BASE_URL: baseURL, NEXT_DIST_DIR: internalDistDir, PW_PORT: String(internalPort) },
        reuseExistingServer: false,
        timeout: 180000,
      },
  use: {
    baseURL,
    headless: false,
    javaScriptEnabled: false,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    timezoneId: process.env.PW_TIMEZONE || "UTC",
  },
});
