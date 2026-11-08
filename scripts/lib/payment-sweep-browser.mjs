import assert from 'node:assert/strict';
import { chromium } from 'playwright';

export const runPaymentSweepBrowser = async (url) => {
  const origin = new URL(url).origin;
  const browser = await chromium.launch({
    headless: true,
    ignoreDefaultArgs: ['--use-angle=swiftshader'],
    args: ['--enable-gpu'],
  });
  try {
    const page = await browser.newPage();
    const errors = [], blocked = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      blocked.push(route.request().url());
      return route.abort();
    });
    await page.goto(url);
    await Promise.all([
      page.waitForResponse(`${origin}/a1-ui-complete`),
      page.getByRole('button', { name: 'Capture, then close checkout' }).click(),
    ]);
    assert.deepEqual(blocked, []);
    assert.deepEqual(errors, []);
    return await page.evaluate(() => window.a1Proof);
  } finally {
    await browser.close();
  }
};
