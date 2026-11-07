const { evaluateBrowserTask } = require("./browser-task.cjs");
const { waitForHydrated, waitForRouteCommitted } = require("./react-hydration.cjs");

async function clickAtRouteCommit(page, first, second, path) {
  await waitForRouteCommitted(page);
  for (const selector of [first, second]) await waitForHydrated(page, selector);
  return evaluateBrowserTask(page, ({ first, second, path }) => new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector(`#main-content [data-route-key="${path}"]`)) return;
      if (path === "/" && !document.querySelector("#services")) return;
      observer.disconnect();
      clearTimeout(timeout);
      document.querySelector(second).click();
      resolve();
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Missing committed route ${path}`));
    }, 15000);
    observer.observe(document.getElementById("main-content"), { childList: true, subtree: true });
    document.querySelector(first).click();
  }), { first, second, path });
}

module.exports = { clickAtRouteCommit };
