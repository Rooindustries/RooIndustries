const { test, expect } = require("./fixtures/booking-flow.cjs");

const ratings = [undefined, null, "", "5", true, false, 0, 6, -1, 4.5, "invalid", {}, 1, 2, 3, 4, 5];
const reviews = ratings.map((rating, index) => ({
  name: `Claim review ${index}`,
  text: "The session helped me compare my PC's performance.",
  game: "CS2",
  optimizationResult: "Average FPS: 200 to 240",
  ...(rating === undefined ? {} : { rating }),
}));
const legacyHero = (amount) => ({
  headingLine1: `Why Pay $${amount} For RAM?`,
  headingLine2: "Tune Yours For $99.95.",
  description: `A 32GB DDR5 kit that was around $100 in early 2025 costs $${amount} now. You probably don't need a new one. We'll tune the RAM you have, and the rest of your PC, for more FPS and steadier 1% lows.`,
});
const heroHeading = /^Why Pay \$400 For RAM\?\s*Tune Yours For \$99\.95\.$/;
const phase = process.env.CLAIMS_PHASE || "after";
const claim = expect.configure({ soft: true, timeout: phase === "before" ? 100 : 10000 });

test.use({ headless: true, reducedMotion: "reduce", timezoneId: "Asia/Kolkata", video: "on" });
test.fail(phase === "before", "The unchanged site fails the regression assertions.");

const control = async (request, baseURL, data) => {
  const origin = new URL(baseURL);
  origin.port = process.env.TOOLING_CONTENT_PORT || String(Number(origin.port) + 1);
  const response = await request.post(new URL("/__content", origin).href, { data });
  expect(response.status()).toBe(200);
};

const waitForHome = async (request, text) => {
  await expect.poll(async () => {
    const response = await request.get("/");
    return response.status() === 200 && (await response.text()).includes(text);
  }, { timeout: 85000, intervals: [1000, 3000] }).toBe(true);
};

test.beforeAll(async ({ request, baseURL }) => {
  test.setTimeout(120000);
  await control(request, baseURL, { patch: { _id: "tooling-hero", ...legacyHero(400) } });
  await control(request, baseURL, { patch: { _id: "tooling-proReviewsCarousel", reviews } });
  await waitForHome(request, "Claim review 0");
});

test.afterAll(async ({ request, baseURL }) => {
  test.setTimeout(120000);
  await control(request, baseURL, { reset: true });
  await waitForHome(request, "Fixture Hero Heading One");
});

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  const content = new URL(baseURL);
  content.port = process.env.TOOLING_CONTENT_PORT || String(Number(content.port) + 1);
  await guardBrowserContext(context, [baseURL, content.origin]);
});

const screenshot = async (target, testInfo, name) => {
  const path = testInfo.outputPath(`${phase}-${name}.png`);
  await target.screenshot({ path, animations: "disabled" });
  await testInfo.attach(`${phase}-${name}`, { path, contentType: "image/png" });
};

const checkHero = async (page) => {
  await claim(page.locator("#top").locator("h1, h2")).toHaveText(heroHeading);
  await claim(page.locator("#top")).toContainText("A 32GB DDR5 kit that was around $100 in early 2025 costs $400 now.");
};

const checkReviewLink = async (page) => {
  const link = page.locator(".ri-packages-review-link");
  await claim(link).toHaveText("139+ reviews");
  await claim(link).toHaveAttribute("href", "/reviews");
  await claim(link).not.toContainText(/★|5\.0|verified/i);
};

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 360, height: 780 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("server HTML only displays backed claims", async ({ page }, testInfo) => {
      await page.goto("/");
      await checkHero(page);
      await screenshot(page.locator("#top"), testInfo, "home-hero");
      const heights = [];
      for (const [index, rating] of ratings.entries()) {
        const cards = page.locator(`.ri-review-card[data-review-id="Claim review ${index}"]`);
        expect(await cards.count()).toBeGreaterThan(0);
        const stars = cards.locator('[aria-label$="out of 5 stars"]');
        const valid = Number.isInteger(rating) && rating >= 1 && rating <= 5;
        await claim(stars).toHaveCount(valid ? await cards.count() : 0);
        if (valid) await claim(stars.first()).toHaveAttribute("aria-label", `${rating} out of 5 stars`);
        heights.push(await cards.first().evaluate(card => card.getBoundingClientRect().height));
      }
      claim(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
      await screenshot(page.locator(".ri-reviews-viewport"), testInfo, "home-reviews");
      const schemas = await page.locator('script[type="application/ld+json"]').evaluateAll(scripts => scripts.flatMap(script => {
        const value = JSON.parse(script.textContent);
        return value["@graph"] || [value];
      }));
      const aggregates = schemas.flatMap(node => node.aggregateRating ? [node.aggregateRating] : node["@type"] === "AggregateRating" ? [node] : []);
      claim(aggregates).toEqual([expect.objectContaining({ ratingValue: 3, ratingCount: 5 })]);
      claim(schemas.find(node => node["@type"] === "WebPage")?.headline)
        .toBe("Why Pay $400 For RAM? Tune Yours For $99.95.");
      await checkReviewLink(page);
      await screenshot(page.locator("#packages"), testInfo, "home-packages");
      await page.goto("/packages");
      await checkReviewLink(page);
      await screenshot(page.locator("main"), testInfo, "packages");
      const markdown = await page.request.get("/markdown?path=/");
      expect(markdown.status()).toBe(200);
      const text = await markdown.text();
      claim(text).toMatch(/Why Pay \\?\$400 For RAM\\?\? Tune Yours For \\?\$99\\?\.95/);
      await testInfo.attach("home-markdown", { body: text, contentType: "text/markdown" });
      for (const route of ["/booking", "/payment", "/payment-success", "/thank-you"]) {
        await page.goto(route);
        await checkHero(page);
        await checkReviewLink(page);
        await screenshot(page.locator("#top"), testInfo, `${route.slice(1)}-background`);
      }
    });

    test.describe("with JavaScript", () => {
      test.use({ javaScriptEnabled: true });

      test("missing CMS hero copy falls back to the $400 hero through navigation", async ({ page }, testInfo) => {
        for (const [name, hero] of [["missing", null]]) {
          await page.route("**/api/content/hero", route => route.fulfill({ json: { ok: true, data: hero } }));
          await page.goto("/packages");
          await page.evaluate(() => { window.__claimsDocument = true; });
          await page.locator('footer a[href="/"]').first().click();
          await expect(page).toHaveURL(/\/$/);
          await checkHero(page);
          expect(await page.evaluate(() => window.__claimsDocument)).toBe(true);
          await screenshot(page.locator("#top"), testInfo, `home-${name}`);
          const headingBounds = await page.locator("#top h1 > span").evaluateAll(elements => elements.map(element => ({
            width: element.clientWidth, scroll: element.scrollWidth,
          })));
          for (const bounds of headingBounds) claim(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
          await page.goBack();
          await expect(page).toHaveURL(/\/packages$/);
          await checkReviewLink(page);
          await page.goForward();
          await checkHero(page);
          await page.unroute("**/api/content/hero");
        }
      });

      for (const amount of [49, 60]) {
        test(`$${amount} checkout does not promise an unavailable payment method`, async ({ page, flow }, testInfo) => {
          await page.route("**/api/payment/quote", route => route.fulfill({ json: {
            ok: true, quoteFingerprint: "fixture-quote",
            quote: { grossAmount: amount, netAmount: amount, isFree: false },
          } }));
          await flow.review();
          await flow.payment();
          const pay = page.getByRole("button", { name: "Pay your way", exact: true });
          const option = pay.locator("../..");
          await claim(option).toContainText("Payment options shown at checkout.");
          await claim(option).not.toContainText(/Klarna|crypto/i);
          await expect(page.getByText(`$${amount.toFixed(2)} USD`, { exact: true })).toBeVisible();
          await screenshot(option, testInfo, `payment-${amount}`);
          await page.reload();
          await expect(pay).toBeEnabled();
          await claim(option).toContainText("Payment options shown at checkout.");
          await pay.click();
          await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
          expect(flow.state.calls.filter(call => call.path === "/api/payment/start")).toHaveLength(1);
        });
      }
    });
  });
}
