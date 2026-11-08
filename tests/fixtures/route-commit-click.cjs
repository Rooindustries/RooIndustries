const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { evaluateBrowserTask } = require("./browser-task.cjs");
const { waitForHydrated, waitForRouteCommitted } = require("./react-hydration.cjs");

const pageScript = (name) => readFileSync(join(__dirname, "browser", name), "utf8").trim();
const clickAtCommittedRoute = pageScript("click-at-committed-route.js");

async function clickAtRouteCommit(page, first, second, path) {
  await waitForRouteCommitted(page);
  for (const selector of [first, second]) await waitForHydrated(page, selector);
  return evaluateBrowserTask(page, clickAtCommittedRoute, { first, second, path });
}

module.exports = { clickAtRouteCommit };
