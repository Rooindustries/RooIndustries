async function waitForHydrated(page, selector, { timeout = 15000 } = {}) {
  await page.waitForFunction((target) => {
    const element = document.querySelector(target);
    return Boolean(element && Object.keys(element).some((key) => key.startsWith("__reactProps$")));
  }, selector, { timeout });
}

async function waitForRouteCommitted(page, options) {
  await page.waitForFunction(() => {
    const route = document.querySelector("#main-content [data-route-key]");
    return window.history.state?.__rooLegacy === true &&
      Boolean(route && Object.keys(route).some(key => key.startsWith("__reactProps$"))) &&
      route.checkVisibility() &&
      document.body.innerText.trim() !== "Loading..." &&
      document.querySelector("main")?.innerText.trim() !== "Loading...";
  }, null, options);
}

module.exports = { waitForHydrated, waitForRouteCommitted };
