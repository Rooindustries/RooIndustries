const { test, expect } = require("@playwright/test");
const { fixturePort } = require("./fixtures/fixture-ports.cjs");

const longReview = `${"A complete review with every word kept visible. ".repeat(18)}${"LongUnbrokenWord".repeat(8)}`;
const reviews = [
  { _id: "ordinary", name: "Ordinary Player", text: "A short review.", game: "Game", isVip: false },
  { _id: "creator-one", name: "Creator One", text: "The first creator review.", game: "Game", isVip: true },
  { _id: "longest", name: "The Longest Review Name Without Truncation", text: longReview, game: "Game", isVip: false },
  { _id: "creator-two", name: "Creator Two", text: "The second creator review.", game: "Game", isVip: true },
];

const contentControl = async (request, baseURL, data) => {
  const origin = new URL(baseURL);
  origin.port = String(fixturePort("TOOLING_CONTENT_PORT"));
  const response = await request.post(new URL("/__content", origin).href, { data });
  expect(response.ok()).toBe(true);
};

test.use({ javaScriptEnabled: true });

test.beforeAll(async ({ request, baseURL }) => {
  test.setTimeout(120000);
  await contentControl(request, baseURL, { patch: { _id: "tooling-proReviewsCarousel", reviews } });
  await expect.poll(async () => (await (await request.get("/")).text()).includes("The Longest Review Name Without Truncation"),
    { timeout: 85000, intervals: [1000, 3000] }).toBe(true);
});

test.afterAll(async ({ request, baseURL }) => {
  await contentControl(request, baseURL, { reset: true });
});

for (const width of [280, 320, 390, 639, 640, 1024, 1440]) {
  test(`review cards fit their complete content at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const region = page.getByRole("region", { name: "Player reviews" });
    await region.scrollIntoViewIfNeeded();
    await expect.poll(() => region.evaluate(el => el.firstElementChild.children.length)).toBeGreaterThanOrEqual(3);
    const cards = region.locator('[data-group-index="0"]');
    await expect(cards).toHaveCount(reviews.length);
    await expect(cards.first()).toHaveAttribute("data-review-id", "Creator One");
    await expect(cards.nth(1)).toHaveAttribute("data-review-id", "Creator Two");
    await expect(cards.last().locator("blockquote p")).toHaveText(`“${longReview}”`);
    const layout = await region.evaluate(el => {
      const viewport = el.getBoundingClientRect();
      const visible = [...el.querySelectorAll("article")].filter(card => {
        const rect = card.getBoundingClientRect();
        const overlap = Math.max(0, Math.min(rect.right, viewport.right) - Math.max(rect.left, viewport.left));
        return overlap >= rect.width / 4;
      });
      const first = [...el.querySelectorAll('[data-group-index="0"]')];
      return {
        firstVisibleCreator: visible[0]?.classList.contains("ri-review-card-creator"),
        cardWidth: first[0].getBoundingClientRect().width,
        heights: first.map(card => card.getBoundingClientRect().height),
        overflow: first.flatMap(card => [...card.querySelectorAll("p:not(.sr-only)")]
          .filter(node => node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)
          .map(node => node.textContent)),
        quoteFont: getComputedStyle(first[0].querySelector("blockquote p")).fontSize,
      };
    });
    expect(layout.firstVisibleCreator).toBe(true);
    expect(layout.cardWidth).toBeLessThan(380);
    expect(layout.cardWidth).toBeLessThanOrEqual(width);
    expect(Math.max(...layout.heights) - Math.min(...layout.heights)).toBeLessThanOrEqual(1);
    expect(layout.overflow).toEqual([]);
    expect(layout.quoteFont).toBe(width < 640 ? "15px" : "12px");
  });
}
