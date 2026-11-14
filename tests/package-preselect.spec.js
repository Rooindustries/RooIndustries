const { test, expect } = require("./fixtures/booking-flow.cjs");
const { getPackagePricePresentation } = require("../src/lib/packagePricing.js");

const packages = [
  { slug: "essentials", title: "Vertex Essentials" },
  { slug: "overhaul", title: "Performance Vertex Overhaul" },
  { slug: "max", title: "Performance Vertex Max" },
];
const bySlug = Object.fromEntries(packages.map((pkg) => [pkg.slug, pkg]));
const bookingCard = (page) => page.locator(".ri-booking-package-title").locator("..");
const packageCard = (page, pkg) => page.locator(".ri-package-card").filter({
  has: page.getByRole("heading", { name: pkg.title, exact: true }),
});
const cardPrice = async (page, pkg) =>
  (await packageCard(page, pkg).locator(".ri-price-current").first().textContent()).trim();

const expectPackage = async (page, { slug, title, price }) => {
  await expect(page).toHaveURL(new RegExp(`/booking\\?package=${slug}$`));
  await expect(bookingCard(page).locator(".ri-booking-package-title")).toHaveText(title);
  await expect(bookingCard(page)).toContainText(price);
};

const packagesPagePrices = async (page) => {
  await page.goto("/packages");
  await expect(page.locator(".ri-package-card").first()).toBeVisible();
  const prices = {};
  for (const pkg of packages) prices[pkg.slug] = await cardPrice(page, pkg);
  return prices;
};

const bookFromPackages = async (page, pkg) => {
  const price = await cardPrice(page, pkg);
  await packageCard(page, pkg).locator(".ri-package-book-button").click();
  await expectPackage(page, { ...pkg, price });
};

for (const width of [360, 390, 1280]) {
  test.describe(`package links at ${width}px`, () => {
    test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", viewport: { width, height: 900 } });
    test.beforeEach(({ flow }) => expect(flow.state.calls).toEqual([]));

    test("a full load of each package link shows the packages page price", async ({ page }) => {
      const prices = await packagesPagePrices(page);
      for (const pkg of packages) {
        await page.goto(`/booking?package=${pkg.slug}`);
        await expectPackage(page, { ...pkg, price: prices[pkg.slug] });
      }
    });

    test("each package card's Book button opens booking with that package", async ({ page }) => {
      for (const pkg of packages) {
        await page.goto("/packages");
        await expect(page.locator(".ri-package-card").first()).toBeVisible();
        await bookFromPackages(page, pkg);
      }
    });

    test("Back and Forward keep the package each booking was opened with", async ({ page }) => {
      const prices = await packagesPagePrices(page);
      const shown = (slug) => ({ ...bySlug[slug], price: prices[slug] });
      await bookFromPackages(page, bySlug.essentials);
      await page.goBack();
      await expect(page).toHaveURL(/\/packages$/);
      await page.goForward();
      await expectPackage(page, shown("essentials"));
      await page.goBack();
      await bookFromPackages(page, bySlug.max);
      await page.goto("/booking?package=essentials");
      await expectPackage(page, shown("essentials"));
      await page.goto("/booking?package=max");
      await expectPackage(page, shown("max"));
      await page.goBack();
      await expectPackage(page, shown("essentials"));
      await page.goForward();
      await expectPackage(page, shown("max"));
    });

    test("an unknown package falls back to the default package", async ({ page }) => {
      await page.goto("/booking?package=not-a-package");
      await expect(page.locator(".ri-booking-package-title")).toHaveText(bySlug.overhaul.title);
    });
  });
}

test("a package link keeps the booking page canonical and out of search", async ({ page }) => {
  const html = await (await page.request.get("/booking?package=overhaul")).text();
  expect(html).toMatch(/<link rel="canonical" href="https?:\/\/[^"]+\/booking"/);
  expect(html).toMatch(/<meta name="robots" content="[^"]*noindex/);
});

test.describe("package prices", () => {
  test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", viewport: { width: 1280, height: 900 } });

  test("the deep link, the package card and the server quote agree on the CMS price", async ({ page, flow }) => {
    const codePrice = getPackagePricePresentation(bySlug.overhaul.title).price;
    const { overhaul: price } = await packagesPagePrices(page);
    expect(price).not.toBe(codePrice);

    await bookFromPackages(page, bySlug.overhaul);
    await page.goto("/booking?package=overhaul");
    await expectPackage(page, { ...bySlug.overhaul, price });

    await flow.review("/booking?package=overhaul");
    await flow.payment();
    const quote = flow.state.calls.filter(({ path }) => path === "/api/payment/quote").at(-1);
    expect(JSON.stringify(quote.body)).toContain(bySlug.overhaul.title);
    const total = page.locator("dt", { hasText: /^(Total|Subtotal)$/ }).locator("..").locator("dd");
    await expect(total).toContainText(`${price} USD`);
  });

  test("a deep link waits for the CMS price instead of showing the code price", async ({ page, flow }) => {
    const codePrice = getPackagePricePresentation(bySlug.overhaul.title).price;
    const pricesPage = await page.context().newPage();
    const { overhaul: price } = await packagesPagePrices(pricesPage);
    await pricesPage.close();
    const listCalls = () => flow.state.calls.filter(({ path }) => path === "/api/content/packages-list").length;
    const callsBefore = listCalls();
    let release;
    let held = false;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/content/packages-list*", async (route) => {
      held = true;
      await gate;
      await route.fallback();
    });
    await page.goto("/booking?package=overhaul");
    await expect.poll(() => held).toBe(true);
    await expect(page.getByRole("dialog")).toBeHidden();
    const visibleWithCodePrice = () => page.evaluate((text) => [...document.querySelectorAll("body *")]
      .filter((node) => node.childElementCount === 0 && node.textContent.includes(text) &&
        node.checkVisibility({ visibilityProperty: true, opacityProperty: true }))
      .length, codePrice);
    expect(await visibleWithCodePrice()).toBe(0);
    release();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectPackage(page, { ...bySlug.overhaul, price });
    expect(await visibleWithCodePrice()).toBe(0);
    expect(listCalls() - callsBefore).toBe(1);
    await page.unrouteAll({ behavior: "wait" });
  });
});
