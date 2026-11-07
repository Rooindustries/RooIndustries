const { waitForHydrated, waitForRouteCommitted } = require("./react-hydration.cjs");

async function clickAtHomeArrival(page, first, second, painted = false) {
  await waitForRouteCommitted(page);
  for (const selector of [first, second]) await waitForHydrated(page, selector);
  const start = page.url();
  const destination = await page.locator(second).first().evaluate((link) => link.href);
  try {
    await page.evaluate(({ first, second, painted }) => {
      const state = { dispatched: false };
      const observer = new MutationObserver(() => {
        if (!document.querySelector("#services")) return;
        observer.disconnect();
        const click = () => {
          state.dispatched = true;
          document.querySelector(second).click();
        };
        if (painted) {
          state.frame = requestAnimationFrame(() => { state.frame = requestAnimationFrame(click); });
        } else {
          click();
        }
      });
      window.__homeArrivalClick = { state, observer };
      observer.observe(document.getElementById("main-content"), { childList: true, subtree: true });
      document.querySelector(first).click();
    }, { first, second, painted });
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
      const pending = window.__homeArrivalClick;
      pending?.observer.disconnect();
      if (pending) cancelAnimationFrame(pending.state.frame);
      delete window.__homeArrivalClick;
    });
  }
}

module.exports = { clickAtHomeArrival };
