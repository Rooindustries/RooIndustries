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

const expectPackage = async (page, { slug, title, price }, path = `/booking?package=${slug}`) => {
  await expect(page).toHaveURL((url) => url.pathname + url.search === path);
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

const holdPackagesList = async (page) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const list = { held: false, release };
  await page.route("**/api/content/packages-list*", async (route) => {
    list.held = true;
    await gate;
    await route.fallback();
  });
  return list;
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

  const STALE_PRICE = "$5.00";
  const codePriceOf = (pkg) => getPackagePricePresentation(pkg.title).price;
  const paymentTotal = (page) => page.locator("dt", { hasText: /^(Total|Subtotal)$/ }).locator("..").locator("dd");
  const savedDraft = ({ title, price }) => {
    sessionStorage.setItem("booking_draft", JSON.stringify({
      lastTitle: title,
      packages: { [title]: { selectedPackage: { title, price, tag: "" } } },
    }));
  };
  const expectCheckoutPrice = async (page, flow, path, pkg, price) => {
    await flow.review(path);
    await flow.payment();
    const quote = flow.state.calls.filter(({ path: called }) => called === "/api/payment/quote").at(-1);
    expect(JSON.stringify(quote.body)).toContain(pkg.title);
    await expect(paymentTotal(page)).toContainText(`${price} USD`);
  };
  const visibleWithPrice = (page, price) => page.evaluate((text) => [...document.querySelectorAll("body *")]
    .filter((node) => node.childElementCount === 0 && node.textContent.includes(text) &&
      node.checkVisibility({ visibilityProperty: true, opacityProperty: true }))
    .length, price);

  test("the deep link, the package card and the server quote agree on the CMS price", async ({ page, flow }) => {
    const { overhaul: price } = await packagesPagePrices(page);
    expect(price).not.toBe(codePriceOf(bySlug.overhaul));

    await bookFromPackages(page, bySlug.overhaul);
    await page.goto("/booking?package=overhaul");
    await expectPackage(page, { ...bySlug.overhaul, price });
    await expectCheckoutPrice(page, flow, "/booking?package=overhaul", bySlug.overhaul, price);
  });

  test("plain /booking and its payment total show the CMS price of the default package", async ({ page, flow }) => {
    const { overhaul: price } = await packagesPagePrices(page);
    expect(price).not.toBe(codePriceOf(bySlug.overhaul));

    await page.goto("/booking");
    await expectPackage(page, { ...bySlug.overhaul, price }, "/booking");
    expect(await visibleWithPrice(page, codePriceOf(bySlug.overhaul))).toBe(0);
    await expectCheckoutPrice(page, flow, "/booking", bySlug.overhaul, price);
  });

  const openRestoredDraft = async (page, pkg, savedPrice) => {
    const price = (await packagesPagePrices(page))[pkg.slug];
    expect(price).not.toBe(savedPrice);
    await page.evaluate(savedDraft, { title: pkg.title, price: savedPrice });
    await page.goto("/booking");
    await expectPackage(page, { ...pkg, price }, "/booking");
    expect(await visibleWithPrice(page, savedPrice)).toBe(0);
    return price;
  };

  test("a restored draft shows the CMS price instead of the price it was saved with", async ({ page }) => {
    await openRestoredDraft(page, bySlug.essentials, STALE_PRICE);
  });

  test("a draft saved at the code price checks out at the CMS price", async ({ page, flow }) => {
    const pkg = bySlug.overhaul;
    const price = await openRestoredDraft(page, pkg, codePriceOf(pkg));
    await expectCheckoutPrice(page, flow, "/booking", pkg, price);
  });

  const heldLoads = [
    { name: "a deep link", path: "/booking?package=overhaul", pkg: bySlug.overhaul },
    { name: "plain /booking", path: "/booking", pkg: bySlug.overhaul },
    { name: "a restored draft", path: "/booking", pkg: bySlug.essentials, savedPrice: STALE_PRICE },
  ];
  for (const { name, path, pkg, savedPrice } of heldLoads) {
    test(`${name} waits for the CMS price instead of showing an older price`, async ({ page, flow }) => {
      const wrongPrice = savedPrice || codePriceOf(pkg);
      const pricesPage = await page.context().newPage();
      const price = (await packagesPagePrices(pricesPage))[pkg.slug];
      await pricesPage.close();
      expect(price).not.toBe(wrongPrice);
      if (savedPrice) await page.addInitScript(savedDraft, { title: pkg.title, price: savedPrice });
      const listCalls = () => flow.state.calls
        .filter(({ path: called }) => called === "/api/content/packages-list").length;
      const callsBefore = listCalls();
      const list = await holdPackagesList(page);
      await page.goto(path);
      await expect.poll(() => list.held).toBe(true);
      await expect(page.getByRole("dialog")).toBeHidden();
      expect(await visibleWithPrice(page, wrongPrice)).toBe(0);
      list.release();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectPackage(page, { ...pkg, price }, path);
      expect(await visibleWithPrice(page, wrongPrice)).toBe(0);
      expect(listCalls() - callsBefore).toBe(1);
      await page.unrouteAll({ behavior: "wait" });
    });
  }
});

test.describe("a held slot on a package link", () => {
  test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", viewport: { width: 390, height: 844 } });

  const email = page => page.getByRole("textbox", { name: "Booking email", exact: true });
  const readHold = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")));
  const calls = (flow, path) => flow.state.calls.filter(({ path: called }) => called === path).length;
  const reloadWithLatePackages = async (page) => {
    await page.evaluate(() => sessionStorage.removeItem("roo-home-data:packages-list"));
    const list = await holdPackagesList(page);
    await page.reload();
    await expect.poll(() => list.held).toBe(true);
    list.release();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.unrouteAll({ behavior: "wait" });
  };
  const expectHeld = async (page, flow, hold, typed) => {
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/booking?package=essentials");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Slot 10:00 AM is reserved");
    await expect(dialog).toContainText(bySlug.essentials.title);
    await expect(dialog).toContainText(hold.price);
    await expect(email(page)).toHaveValue(typed);
    await expect(page.getByRole("button", { name: "Release Slot", exact: true })).toBeVisible();
    expect(await readHold(page)).toMatchObject({ holdId: hold.holdId, holdToken: hold.holdToken,
      startTimeUTC: hold.startTimeUTC, packageTitle: bySlug.essentials.title });
    expect(calls(flow, "/api/holdSlot")).toBe(1);
    expect(calls(flow, "/api/releaseHold")).toBe(0);
  };
  const reserveFromPackages = async (page) => {
    await page.goto("/packages");
    await expect(page.locator(".ri-package-card").first()).toBeVisible();
    const price = await cardPrice(page, bySlug.essentials);
    await bookFromPackages(page, bySlug.essentials);
    await page.getByRole("button", { name: /^Earliest available:/ }).click();
    await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).last().click();
    await expect(email(page)).toBeVisible();
    return { ...await readHold(page), price };
  };

  test("reloading, Back and Forward keep a slot reserved from a package link", async ({ page, flow }) => {
    const hold = await reserveFromPackages(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/packages$/);
    await page.goForward();
    await expectHeld(page, flow, hold, "");
    await page.reload();
    await expectHeld(page, flow, hold, "");
    await reloadWithLatePackages(page);
    await expectHeld(page, flow, hold, "");
  });

  test("reloading a package link keeps the reserved slot and the typed details", async ({ page, flow }) => {
    const hold = await reserveFromPackages(page);
    await flow.details("held@example.invalid");
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("booking_draft")))
      .toContain("held@example.invalid");
    await reloadWithLatePackages(page);
    await expectHeld(page, flow, hold, "held@example.invalid");
    await expect(page.getByRole("textbox", { name: "PC specifications", exact: true }))
      .toHaveValue("Ryzen 7700 / RTX 4070");
  });

  test("a packages list that fails to load shows no price and a retry that keeps the slot and details", async ({
    page, flow,
  }) => {
    const hold = await reserveFromPackages(page);
    await flow.details("held@example.invalid");
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("booking_draft")))
      .toContain("held@example.invalid");
    await page.evaluate(() => sessionStorage.removeItem("roo-home-data:packages-list"));
    const list = { failing: true, requests: 0 };
    await page.route("**/api/content/packages-list*", (route) => {
      list.requests += 1;
      return list.failing ? route.fulfill({ status: 503, json: { ok: false } }) : route.fallback();
    });
    await page.reload();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("We couldn't load package prices.");
    await expect(dialog).not.toContainText(/\$\d/);
    await expect(email(page)).toHaveCount(0);
    expect(await readHold(page)).toMatchObject({ holdId: hold.holdId, holdToken: hold.holdToken });
    const failedRequests = list.requests;
    expect(failedRequests).toBeGreaterThan(0);
    list.failing = false;
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    await expectHeld(page, flow, hold, "held@example.invalid");
    await expect(page.getByRole("textbox", { name: "PC specifications", exact: true }))
      .toHaveValue("Ryzen 7700 / RTX 4070");
    expect(list.requests).toBeGreaterThan(failedRequests);
    await page.unrouteAll({ behavior: "wait" });
  });
});
