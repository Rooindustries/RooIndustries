const { evaluateBrowserTask, pageScript } = require("./browser-task.cjs");
const { waitForHydrated, waitForRouteCommitted } = require("./react-hydration.cjs");

const clickAtCommittedRoute = pageScript("click-at-committed-route.js");

async function clickAtRouteCommit(page, first, second, path) {
  await waitForRouteCommitted(page);
  for (const selector of [first, second]) await waitForHydrated(page, selector);
  return evaluateBrowserTask(page, clickAtCommittedRoute, { first, second, path });
}

module.exports = { clickAtRouteCommit };
