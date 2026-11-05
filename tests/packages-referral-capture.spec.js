const { test, expect } = require("@playwright/test");
const { buildPackageOffers } = require("../src/lib/packageContent");
const { getPackagePricePresentation } = require("../src/lib/packagePricing");

test.use({ javaScriptEnabled: true, reducedMotion: "reduce" });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

const storedReferral = (page) => page.evaluate(() => sessionStorage.getItem("referral_session"));
const storeReferral = (page, code) => page.evaluate((value) => sessionStorage.setItem("referral_session", value), code);
const hydrated = (page) => page.waitForFunction(() => window.history.state?.__rooLegacy === true);
const footerLink = (page, href) => page.locator(`footer a[href="${href}"]`).first();
const pageLink = (page, href) => page.locator(`#main-content a[href="${href}"]`).first();
const shownPrices = (page) => page.locator("#main-content .ri-price-current");

const cmsPrices = async (request) => {
  const rows = (await (await request.get("/api/content/packages-list")).json()).data;
  return buildPackageOffers(rows).map((offer) =>
    getPackagePricePresentation(offer.title, offer.price || offer.compareAtPrice || offer.originalPrice).price || offer.price
  );
};

const expectCmsPrices = async (page, request) => {
  const expected = await cmsPrices(request);
  expect(expected.length).toBeGreaterThan(0);
  await shownPrices(page).first().scrollIntoViewIfNeeded();
  await expect(shownPrices(page)).toHaveText(expected);
};

test("a full load of /packages with ?ref stores the code and shows the CMS prices", async ({ page, request }) => {
  await page.goto("/packages?ref=alpha", { waitUntil: "networkidle" });
  await hydrated(page);
  await expect.poll(() => storedReferral(page)).toBe("alpha");
  await expectCmsPrices(page, request);
});

test("a ?ref landing is captured once and an in-app move to packages keeps the current code", async ({ page, request }) => {
  await page.goto("/?ref=alpha", { waitUntil: "networkidle" });
  await hydrated(page);
  await expect.poll(() => storedReferral(page)).toBe("alpha");
  await expectCmsPrices(page, request);
  await storeReferral(page, "beta");

  await footerLink(page, "/about").click();
  await expect(page).toHaveURL(/\/about$/);
  await pageLink(page, "/packages").click();
  await expect(page).toHaveURL(/\/packages$/);
  await expectCmsPrices(page, request);
  expect(await storedReferral(page)).toBe("beta");
});

test("Back to a ?ref entry captures that code again and Forward keeps it", async ({ page, request }) => {
  await page.goto("/?ref=alpha", { waitUntil: "networkidle" });
  await hydrated(page);
  await expect.poll(() => storedReferral(page)).toBe("alpha");
  await page.evaluate(() => { window.__referralDocument = true; });

  await footerLink(page, "/about").click();
  await expect(page).toHaveURL(/\/about$/);
  await pageLink(page, "/packages").click();
  await expect(page).toHaveURL(/\/packages$/);
  await storeReferral(page, "beta");

  await page.goBack();
  await expect(page).toHaveURL(/\/about$/);
  expect(await storedReferral(page)).toBe("beta");
  await page.goBack();
  await expect(page).toHaveURL(/\/\?ref=alpha$/);
  await expectCmsPrices(page, request);
  await expect.poll(() => storedReferral(page)).toBe("alpha");

  await page.goForward();
  await expect(page).toHaveURL(/\/about$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/packages$/);
  await expectCmsPrices(page, request);
  expect(await storedReferral(page)).toBe("alpha");
  expect(await page.evaluate(() => window.__referralDocument)).toBe(true);
});

test("a second tab starts without the first tab's code and keeps its own", async ({ page, context, request }) => {
  await page.goto("/packages?ref=alpha", { waitUntil: "networkidle" });
  await hydrated(page);
  await expect.poll(() => storedReferral(page)).toBe("alpha");

  const second = await context.newPage();
  await second.goto("/packages", { waitUntil: "networkidle" });
  await hydrated(second);
  await expectCmsPrices(second, request);
  expect(await storedReferral(second)).toBeNull();
  await second.goto("/packages?ref=gamma", { waitUntil: "networkidle" });
  await hydrated(second);
  await expect.poll(() => storedReferral(second)).toBe("gamma");
  expect(await storedReferral(page)).toBe("alpha");
  await second.close();
});
