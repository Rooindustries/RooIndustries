const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true });

const themes = { light: "default", dark: "dark" };
const properties = ["background-color", "background-image", "border-color", "box-shadow", "color", "transform", "translate", "scale", "rotate", "filter", "backdrop-filter", "opacity", "outline-color", "outline-style", "outline-width"];

const settledLook = (node, properties) => {
  const read = () => {
    const style = getComputedStyle(node);
    return Object.fromEntries(properties.map((name) => [name, style.getPropertyValue(name)]));
  };
  read();
  return Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => null))).then(read);
};

const useTheme = async (page, theme) => {
  await page.addInitScript((value) => localStorage.setItem("roo-theme", value), theme);
};

const restingPoint = (page) => page.mouse.move(1, 1);

async function expectHoverKeepsLook(page, card, label) {
  await card.scrollIntoViewIfNeeded();
  await restingPoint(page);
  const resting = await card.evaluate(settledLook, properties);
  await card.locator("h3").first().hover();
  expect(await card.evaluate((node) => node.matches(":hover"))).toBe(true);
  const hovered = await card.evaluate(settledLook, properties);
  expect(hovered, label).toEqual(resting);
  await restingPoint(page);
}

for (const [themeName, theme] of Object.entries(themes)) {
  for (const route of ["/", "/packages"]) {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      test(`${route} package cards look the same when hovered in the ${themeName} theme at ${width}px`, async ({ page }) => {
        await useTheme(page, theme);
        await page.setViewportSize({ width, height });
        await page.goto(route);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const cards = page.locator(".ri-package-card");
        await expect(cards.first()).toBeVisible();
        const count = await cards.count();
        expect(count).toBeGreaterThan(0);
        for (let index = 0; index < count; index += 1) {
          await expectHoverKeepsLook(page, cards.nth(index), `card ${index + 1}`);
        }
      });
    }
  }

  test(`booking dialog package card looks the same when hovered in the ${themeName} theme`, async ({ page }) => {
    await useTheme(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/packages");
    await page.locator(".ri-package-card .ri-package-book-button").first().click();
    const card = page.locator(".ri-booking div:has(> .ri-booking-package-title)").first();
    await expect(card).toBeVisible();
    await expectHoverKeepsLook(page, card, "booking package card");
  });

  test(`featured and highlighted package cards look the same when hovered in the ${themeName} theme`, async ({ page }) => {
    await useTheme(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/packages");
    const card = page.locator(".ri-package-card").first();
    await expect(card).toBeVisible();
    const variants = [
      ["ri-package-card-featured", "ri-package-card-highlighted border-line-accent"],
      ["ri-package-card-featured", "ri-package-card-standard border-line-input"],
      ["ri-package-card-secondary", "ri-package-card-highlighted border-line-accent"],
      ["ri-package-card-secondary", "ri-package-card-standard border-line-input"],
    ];
    for (const [tier, emphasis] of variants) {
      await card.evaluate((node, classes) => {
        const swapped = ["ri-package-card-featured", "ri-package-card-secondary", "ri-package-card-highlighted", "ri-package-card-standard", "border-line-accent", "border-line-input"];
        node.classList.remove(...swapped);
        node.classList.add(...classes.split(" "));
      }, `${tier} ${emphasis}`);
      await expectHoverKeepsLook(page, card, `${tier} ${emphasis}`);
    }
  });

  test(`package card buttons still react to hover in the ${themeName} theme`, async ({ page }) => {
    await useTheme(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/packages");
    const button = page.locator(".ri-package-card .ri-package-details-button").first();
    await button.scrollIntoViewIfNeeded();
    await restingPoint(page);
    const resting = await button.evaluate(settledLook, ["background-color", "color"]);
    await button.hover();
    const hovered = await button.evaluate(settledLook, ["background-color", "color"]);
    expect(hovered).not.toEqual(resting);
  });
}
