async function waitForHydrated(page, selector, { timeout = 15000 } = {}) {
  await page.waitForFunction((target) => {
    const element = document.querySelector(target);
    return Boolean(element && Object.keys(element).some((key) => key.startsWith("__reactProps$")));
  }, selector, { timeout });
}

module.exports = { waitForHydrated };
