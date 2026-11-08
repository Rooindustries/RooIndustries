const { pageScript } = require("./browser-task.cjs");
const { waitForHydrated, waitForRouteCommitted } = require("./react-hydration.cjs");

const watchHomeArrival = pageScript("watch-home-arrival.js");

async function clickAtHomeArrival(page, first, second, painted = false) {
  await waitForRouteCommitted(page);
  for (const selector of [first, second]) await waitForHydrated(page, selector);
  const start = page.url();
  const destination = await page.locator(second).first().evaluate((link) => link.href);
  try {
    await page.evaluate(`(${watchHomeArrival})(${JSON.stringify({ first, second, painted })})`);
    await page.waitForFunction(({ destination, start }) => {
      if (location.href !== destination) return false;
      if (destination === start && !window.__homeArrivalClick?.state.dispatched) return false;
      const route = document.querySelector("#main-content [data-route-key]");
      const target = new URL(destination);
      return window.history.state?.__rooLegacy === true &&
        route?.dataset.routeKey === `${target.pathname}${target.search}` &&
        Object.keys(route).some((key) => key.startsWith("__reactProps$")) &&
        route.checkVisibility() && document.querySelector("main")?.innerText.trim() !== "Loading...";
    }, { destination, start }, { timeout: 15000 });
  } finally {
    await page.evaluate(() => {
      window.__homeArrivalClick?.stop();
      delete window.__homeArrivalClick;
    });
  }
}

module.exports = { clickAtHomeArrival };
