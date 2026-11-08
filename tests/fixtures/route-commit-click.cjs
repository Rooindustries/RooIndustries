const { clickAtCommittedRoute } = require("./browser/arrival-observers.cjs");
const { evaluateBrowserTask } = require("./browser-task.cjs");
const { waitForHydrated, waitForRouteCommitted } = require("./react-hydration.cjs");

async function clickAtRouteCommit(page, first, second, path) {
  await waitForRouteCommitted(page);
  for (const selector of [first, second]) await waitForHydrated(page, selector);
  return evaluateBrowserTask(page, clickAtCommittedRoute, { first, second, path });
}

module.exports = { clickAtRouteCommit };
