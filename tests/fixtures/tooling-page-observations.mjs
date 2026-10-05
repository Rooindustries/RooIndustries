import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { guardBrowserContext, localOrigin } from '../../scripts/lib/test-target-safety.mjs';

const origin = localOrigin(process.env.BASE_URL);
const phase = process.env.TOOLING_OBSERVATION_PHASE || 'before';
const browser = await chromium.launch({ headless: false, args: ['--ozone-platform=x11'] });
const observations = { phase, origin, browser: browser.version(), headed: true, pages: [] };
try {
  const nojs = await browser.newContext({ javaScriptEnabled: false });
  await guardBrowserContext(nojs, [origin]);
  const privacy = await nojs.newPage();
  await privacy.goto(`${origin}/privacy`, { waitUntil: 'load' });
  observations.pages.push({ route: '/privacy', javaScriptEnabled: false, headings: await privacy.locator('h1,h2,h3').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, visible: node.getClientRects().length > 0, hiddenAncestor: Boolean(node.closest('[hidden]')) }))), rendered: await privacy.locator('main').innerText(), screenshot: `test-results/fix-h/privacy-${phase}.png` });
  await privacy.screenshot({ path: observations.pages.at(-1).screenshot });
  await nojs.close();
  const context = await browser.newContext({ javaScriptEnabled: true });
  await guardBrowserContext(context, [origin]);
  const page = await context.newPage();
  const reply = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bookingAvailability', { timeout: 15000 });
  await page.goto(`${origin}/booking`);
  const availability = await reply;
  observations.pages.push({ route: '/booking', availabilityStatus: availability.status(), availability: await availability.json() });
  await page.waitForTimeout(700);
  observations.pages.at(-1).selectionHeadingVisible = await page.getByText('Select a Date and Time for Your Session').isVisible();
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto(`${origin}/meet-the-team`);
  observations.pages.push({ route: '/meet-the-team', width: 1536, accessibleTeamLinks: await page.getByRole('link', { name: 'Meet the Team' }).count(), allTeamLinks: await page.locator('a[href="/meet-the-team"]').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent.trim(), visible: node.getClientRects().length > 0, inert: Boolean(node.closest('[inert]')) }))) });
  await page.goto(origin);
  await page.screenshot({ path: `test-results/fix-h/home-${phase}.png` });
  observations.homeScreenshot = `test-results/fix-h/home-${phase}.png`;
  await context.close();
} finally {
  await browser.close();
  const output = `test-results/fix-h/page-observations-${phase}.json`;
  fs.writeFileSync(output, JSON.stringify(observations, null, 2) + '\n');
  console.log(JSON.stringify({ output }));
}
