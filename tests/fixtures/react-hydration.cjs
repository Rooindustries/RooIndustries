async function waitForHydrated(page, selector) {
  await page.waitForFunction((target) => {
    const element = document.querySelector(target);
    return Boolean(element && Object.keys(element).some((key) => key.startsWith("__reactProps$")));
  }, selector);
}

module.exports = { waitForHydrated };
