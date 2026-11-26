const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { fixtureOrigin } = require('./fixtures/fixture-ports.cjs');
const { HOME_COPY } = require('../src/lib/homeCopy');

test.use({ javaScriptEnabled: true, video: 'off', trace: 'off' });
test.describe.configure({ retries: 0 });

for (const stored of [false, true]) {
  test(`the current hero uses ${stored ? 'a verified stored quote' : 'the approved baseline'}`, async ({ page, context, baseURL }, testInfo) => {
    const { guardBrowserContext } = await import('../scripts/lib/test-target-safety.mjs');
    await guardBrowserContext(context, [baseURL, fixtureOrigin(baseURL, 'TOOLING_CONTENT_PORT')]);
    const ramPrice = {
      priceCents: 50000,
      checkedAt: '2026-11-01T12:00:00.000Z',
      currency: 'USD',
      source: 'v-color',
      sourceUrl: 'https://v-color.net/products/ddr5-manta-xfinity-rgb-gaming-memory-copy?variant=46736066052263',
      sku: 'TMXFL1660830KWK',
      variantId: 'gid://shopify/ProductVariant/46736066052263',
    };
    await page.route('**/api/content/hero', route => route.fulfill({
      json: { ok: true, data: { ...HOME_COPY.hero, ...(stored ? { ramPrice } : {}) } },
    }));
    const shots = process.env.RAM_PRICE_SHOTS;
    for (const width of [360, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/about');
      const response = page.waitForResponse('**/api/content/hero');
      await page.locator('footer a[href="/"]').first().click();
      await response;
      await expect(page.locator('#top .ri-hero-cta-note li')).toHaveCount(3);
      await page.evaluate(() => document.fonts.ready);
      await expect.soft(page.locator('#top h1')).toContainText(stored ? 'Why Pay $500 For RAM?' : HOME_COPY.hero.headingLine1);
      if (shots) await page.screenshot({
        path: path.join(shots, `${process.env.RAM_PRICE_PHASE}-${stored ? 'stored' : 'none'}-${width}.png`),
      });
      await expect.soft(page.locator('#top a[data-ram-price-source]')).toHaveCount(stored ? 1 : 0);
      await expect(page.locator('#top')).toContainText(HOME_COPY.hero.subtext);
      await expect(page.locator('#top')).toContainText(
        stored ? HOME_COPY.hero.description.replace('$400', '$500') : HOME_COPY.hero.description
      );
      expect(await page.locator('#top').evaluate(element => element.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await testInfo.attach('quote-state', { body: JSON.stringify({ stored }), contentType: 'application/json' });
  });
}
