const { test, expect } = require("@playwright/test");
const { HOME_COPY } = require("../src/lib/homeCopy");

const CHAMPAGNE = "rgb(255, 240, 166)";
const CHAMPAGNE_LIGHT = "rgb(255, 246, 201)";
const CHAMPAGNE_GOLD = "rgb(236, 211, 137)";

const luminance = (color) =>
  color
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map((value) => Number(value) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);

const contrast = (first, second) => {
  const [dark, light] = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (light + 0.05) / (dark + 0.05);
};

const paint = (locator) =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, image: style.backgroundImage };
  });

test.use({ reducedMotion: "reduce" });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

for (const [width, height] of [[1440, 900], [390, 844]]) {
  test(`home gold buttons are champagne with readable text at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");

    const buttons = {
      hero: page.locator("#top .book-optimization-button").first(),
      nav: page.locator("header .nav-cta:visible").first(),
      package: page.locator(".ri-package-book-button").first(),
    };

    for (const [name, button] of Object.entries(buttons)) {
      await button.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      const rest = await paint(button);
      expect(rest.image, `${name} at rest`).toContain(CHAMPAGNE);

      await button.hover();
      await expect.poll(async () => (await paint(button)).image, `${name} on hover`).toContain(CHAMPAGNE_LIGHT);
      const hover = await paint(button);

      for (const [state, { color, image }] of [["rest", rest], ["hover", hover]]) {
        const stops = image.match(/rgba?\([^)]+\)/g) || [];
        expect(stops.length, `${name} ${state} stops`).toBeGreaterThan(2);
        for (const stop of stops) {
          expect(contrast(color, stop), `${name} ${state} text on ${stop}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }

    const pill = page.locator(".ri-package-tag-gold.gold-flair-pill").first();
    if (await pill.count()) {
      expect((await paint(pill)).image).toContain(CHAMPAGNE);
    }
  });

  test(`home benefit cards center icon, title and description at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");

    const cards = page.locator(".ri-service-card");
    await expect(cards).toHaveCount(HOME_COPY.services.cards.length);
    await cards.first().scrollIntoViewIfNeeded();

    for (const [index, copy] of HOME_COPY.services.cards.entries()) {
      const card = cards.nth(index);
      await expect(card.locator("h3")).toHaveText(copy.title);
      await expect(card.locator("p")).toHaveText(copy.description);

      const layout = await card.evaluate((element) => {
        const middle = (node) => {
          const box = node.getBoundingClientRect();
          return box.left + box.width / 2;
        };
        const textMiddles = (node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return [...range.getClientRects()].map((rect) => rect.left + rect.width / 2);
        };
        const icon = element.querySelector(".ri-service-icon");
        return {
          card: middle(element),
          tile: middle(icon.parentElement),
          icon: middle(icon),
          lines: [...element.querySelectorAll("h3, p")].flatMap(textMiddles),
          iconColor: getComputedStyle(icon).color,
        };
      });

      for (const [part, center] of [["tile", layout.tile], ["icon", layout.icon]]) {
        expect(Math.abs(center - layout.card), `${copy.title} ${part}`).toBeLessThanOrEqual(1);
      }
      expect(layout.lines.length).toBeGreaterThan(1);
      for (const center of layout.lines) {
        expect(Math.abs(center - layout.card), `${copy.title} text line`).toBeLessThanOrEqual(1.5);
      }
      expect(layout.iconColor, `${copy.title} icon`).toBe(CHAMPAGNE_GOLD);
    }

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    ).toBeLessThanOrEqual(0);
  });
}
