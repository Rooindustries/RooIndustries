import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { guardBrowserContext, localOrigin } from '../../scripts/lib/test-target-safety.mjs';

const origin = localOrigin(process.env.BASE_URL);
const phase = process.env.TOOLING_OBSERVATION_PHASE || 'before';
const browser = await chromium.launch({ headless: false, args: ['--ozone-platform=x11'] });
const observations = { phase, origin, browser: browser.version(), headed: true, cases: [] };
try {
  const context = await browser.newContext({ javaScriptEnabled: true, viewport: { width: 1536, height: 960 } });
  await guardBrowserContext(context, [origin]);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await context.addInitScript(() => {
    window.__faqProbe = { settled: [], clicks: [] };
    document.addEventListener('click', event => {
      if (event.target.closest('[data-nav-surface="desktop"][data-nav-target="faq"]')) window.__faqProbe.clicks.push({ at: performance.now(), prevented: event.defaultPrevented });
    });
    window.addEventListener('roo:section-align-settled', event => window.__faqProbe.settled.push({ hash: event.detail?.hash, at: performance.now(), scrollY: window.scrollY }));
  });
  const page = await context.newPage();
  for (const hydration of [false, true]) {
    for (let run = 1; run <= 5; run++) {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      const selector = '[data-nav-surface="desktop"][data-nav-target="faq"]';
      if (hydration) await page.waitForFunction(s => Object.keys(document.querySelector(s) || {}).some(key => key.startsWith('__reactProps$')), selector);
      await page.locator(selector).first().click();
      const started = Date.now();
      const samples = [];
      let stableSince = null;
      let lastTop = null;
      while (Date.now() - started < 5000) {
        const top = await page.evaluate(() => Math.round(document.querySelector('#faq').getBoundingClientRect().top));
        samples.push({ ms: Date.now() - started, top });
        if (Math.abs(top) <= 140) {
          if (phase !== 'after') break;
          if (stableSince === null || lastTop === null || Math.abs(top - lastTop) > 1) stableSince = Date.now();
          if (stableSince !== null && Date.now() - stableSince >= 150) break;
        } else stableSince = null;
        lastTop = top;
        await page.waitForTimeout(50);
      }
      const first = await page.evaluate(() => ({ top: Math.round(document.querySelector('#faq').getBoundingClientRect().top), at: performance.now(), settled: [...window.__faqProbe.settled] }));
      const stableTop = first.top;
      const settleMs = Date.now() - started;
      await page.waitForTimeout(2000);
      const result = await page.evaluate(() => ({ ...window.__faqProbe, finalTop: Math.round(document.querySelector('#faq').getBoundingClientRect().top), finalAt: performance.now() }));
      observations.cases.push({ hydration, run, first, samples, settleMs, stableTop, driftPx: Math.abs(result.finalTop - stableTop), ...result });
    }
  }
  await page.screenshot({ path: `test-results/fix-h/faq-scroll-${phase}.png` });
  await context.tracing.stop({ path: `test-results/fix-h/faq-scroll-${phase}.zip` });
  await context.close();
} finally {
  await browser.close();
  const output = `test-results/fix-h/faq-scroll-${phase}.json`;
  fs.writeFileSync(output, JSON.stringify(observations, null, 2) + '\n');
  console.log(JSON.stringify({ output, cases: observations.cases.map(({ hydration, run, stableTop, finalTop, driftPx, click }) => ({ hydration, run, stableTop, finalTop, driftPx, click })) }));
}
assert.equal(observations.cases.length, 10);
if (phase === 'after') for (const item of observations.cases) {
  assert.ok(item.driftPx <= 40, `hydration=${item.hydration} run=${item.run} drift=${item.driftPx}`);
  assert.ok(Math.abs(item.stableTop) <= 140 && Math.abs(item.finalTop) <= 140);
  assert.ok(item.settleMs <= 1200, `settle=${item.settleMs}`);
}
