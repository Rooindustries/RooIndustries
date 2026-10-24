const { test, expect } = require('@playwright/test');

test.use({ headless: true, video: 'on', javaScriptEnabled: true });
test.describe.configure({ mode: 'serial' });
test.skip(process.env.TOOLING_RAM_PRICE !== '1', 'Uses the isolated RAM source and CMS fixture.');
const headers = { Authorization: 'Bearer fixture-only-ram-price-cron' };
let fixture;
const state = async (request, data) => {
  const response = data ? await request.post(`${fixture}/__ram-price`, { data }) : await request.get(`${fixture}/__ram-price`);
  expect(response.ok()).toBe(true);
  return response.json();
};
const refresh = request => request.get('/api/content/ram-price/refresh', { headers });

test.beforeEach(async ({ request, baseURL, context }) => {
  const origin = new URL(baseURL);
  origin.port = process.env.TOOLING_CONTENT_PORT || String(Number(origin.port) + 1);
  fixture = origin.origin;
  const { guardBrowserContext } = await import('../scripts/lib/test-target-safety.mjs');
  await guardBrowserContext(context, [baseURL, fixture]);
  await state(request, { reset: true });
});

test('source price reaches the rendered hero through the CMS command', async ({ page, request, baseURL }, testInfo) => {
  await publishHero(request);
  await cachedHero(request, 'Why Pay $400 For RAM?');
  const before = await state(request);
  await page.goto('/');
  await expect(page.locator('#top h1')).toContainText('Why Pay $400 For RAM?');
  await expect(page.locator('#top h1')).toContainText('Tune Yours For $99.95.');
  await expect(page.locator('#top a[data-ram-price-source]')).toHaveCount(0);
  await page.locator('#top').screenshot({ path: testInfo.outputPath('before-ram-price.png') });
  const result = await refresh(request);
  expect(result.status(), await result.text()).toBe(200);
  const after = await state(request);
  expect(after.reads).toBe(1);
  expect(after.publishes).toHaveLength(1);
  expect(after.hero.ramPrice.priceCents).toBe(50000);
  expect(after.packages).toEqual(before.packages);
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('#top h1')).toContainText('Why Pay $500 For RAM?');
    await expect(page.locator('#top h1')).toContainText('Tune Yours For $99.95.');
    await expect(page.locator('#top a[data-ram-price-source]')).toContainText('v-color, checked');
    await expect(page.locator('#top a[data-ram-price-source]')).toHaveAttribute('href', after.hero.ramPrice.sourceUrl);
    expect(await page.locator('#top').evaluate(element => element.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('#top').screenshot({ path: testInfo.outputPath(`ram-price-${width}.png`) });
  }
  const markdown = await request.get('/markdown?path=/');
  expect(await markdown.text()).toContain('[v\\-color\\, checked');
  const document = await request.get('/');
  expect(await document.text()).toContain('Why Pay $500 For RAM?');
  await page.goto('/packages');
  await page.locator('footer a[href="/"]').first().click();
  await expect(page).toHaveURL(new URL('/', baseURL).href);
  await expect(page.locator('#top h1')).toContainText('Why Pay $500 For RAM?');
  await page.goBack();
  await expect(page).toHaveURL(/\/packages$/);
  await expect(page.locator('[data-route-key="/packages"]')).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new URL('/', baseURL).href);
  await expect(page.locator('#top h1')).toContainText('Why Pay $500 For RAM?');
  const secondTab = await page.context().newPage();
  await secondTab.goto('/');
  await expect(secondTab.locator('#top a[data-ram-price-source]')).toContainText('v-color, checked');
  await secondTab.close();
  const editing = await state(request, { reset: true, previousPrice: 50000, price: '515.00' });
  const maxPackage = editing.packages.find(pkg => /max|xoc/i.test(pkg.title));
  const published = await request.post('/api/admin/content/publish', {
    headers: { 'x-admin-key': 'fixture-only-ram-price-admin' },
    data: { operation: 'replace', type: 'package', documentId: maxPackage._id, expectedRevision: maxPackage._rev, document: { ...maxPackage, price: '$123.45' } },
  });
  expect(published.status(), await published.text()).toBe(200);
  await page.goto('/packages');
  await expect(page.locator('main')).toContainText('$123.45');
  expect((await refresh(request)).status()).toBe(200);
  await page.goto('/');
  await expect(page.locator('#top h1')).toContainText('Why Pay $515 For RAM?');
  await expect(page.locator('#top h1')).toContainText('Tune Yours For $123.45.');
  await page.goto('/packages');
  await expect(page.locator('main')).toContainText('$123.45');
  await page.route(`${baseURL}/api/admin/content/**`, route => route.fallback({ headers: { ...route.request().headers(), 'x-admin-key': 'fixture-only-ram-price-admin' } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/admin/content');
  await page.getByRole('navigation', { name: 'Content types' }).getByRole('button', { name: 'Hero Section', exact: true }).click();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('aside[aria-label="Version history"]')).toContainText('Automatic RAM price refresh');
  await page.screenshot({ path: testInfo.outputPath('ram-price-audit-history.png'), fullPage: true });
  await testInfo.attach('published-hero', { body: JSON.stringify(after, null, 2), contentType: 'application/json' });
});

test.afterEach(async ({ request }) => { await state(request, { reset: true }); });

test('repeated and concurrent calls cannot repeat the source read or publish', async ({ request }) => {
  const anonymous = await request.get('/api/content/ram-price/refresh');
  expect(anonymous.status()).toBe(403);
  expect((await state(request)).reads).toBe(0);
  const responses = await Promise.all(Array.from({ length: 8 }, () => refresh(request)));
  expect(responses.every(response => [200, 429].includes(response.status()))).toBe(true);
  const current = await state(request);
  expect(current.reads).toBe(1);
  expect(current.publishes).toHaveLength(1);
  expect((await request.post('/api/content/ram-price/refresh', { headers })).status()).toBe(405);
  expect((await state(request)).reads).toBe(1);
});

for (const mode of ['failed', 'malformed', 'oversized', 'slow', 'graphql-error', 'missing', 'missing-price', 'unavailable', 'backorder', 'wrong-sku', 'wrong-variant', 'wrong-product', 'wrong-options', 'wrong-currency', 'wrong-market', 'bulk-only', 'bundle-only', 'subscription', 'stale', 'future', 'cached', 'limiter-down', 'publish-failed', 'publish-timeout']) {
  test(`${mode} keeps the last verified price and its original date`, async ({ request }) => {
    const before = await state(request, { mode, previousPrice: 49000 });
    expect((await refresh(request)).status()).toBe(503);
    const after = await state(request);
    expect(after.hero.ramPrice).toEqual(before.hero.ramPrice);
    expect(after.publishes).toHaveLength(0);
    await refresh(request);
    expect((await state(request)).reads).toBe(mode === 'limiter-down' ? 0 : 1);
  });
}

for (const price of ['1400.00', '1.00', '2000.00', '0', '-100', 'NaN', '5e2', '500.001']) {
  test(`rejects implausible source price ${price}`, async ({ request }) => {
    const before = await state(request, { price, previousPrice: 49000 });
    expect((await refresh(request)).status()).toBe(503);
    const after = await state(request);
    expect(after.hero.ramPrice).toEqual(before.hero.ramPrice);
    expect(after.publishes).toHaveLength(0);
  });
}

test('a concurrent editor change survives the refresh', async ({ request }) => {
  await state(request, { race: true });
  expect((await refresh(request)).status()).toBe(200);
  const after = await state(request);
  expect(after.hero.headingLine1).toBe('Concurrent editor headline');
  expect(after.hero.ramPrice.priceCents).toBe(50000);
  expect(after.publishes).toHaveLength(1);
  expect(after.publishes[0].expected_revision).toBe('concurrent-editor');
});

test('a lost publish receipt never causes a second write', async ({ request }) => {
  await state(request, { lostReceipt: true });
  expect((await refresh(request)).status()).toBe(200);
  await refresh(request);
  expect((await state(request)).publishes).toHaveLength(1);
});

test('a committed write is recovered after its response exceeds the deadline', async ({ request }) => {
  const before = await state(request, { mode: 'commit-timeout', previousPrice: 49000 });
  const warmed = await request.post('/api/admin/content/publish', {
    headers: { 'x-admin-key': 'fixture-only-ram-price-admin' },
    data: { operation: 'replace', type: 'hero', documentId: before.hero._id, expectedRevision: before.hero._rev, document: before.hero },
  });
  expect(warmed.status(), await warmed.text()).toBe(200);
  expect(await (await request.get('/')).text()).toContain('Why Pay $490 For RAM?');
  const response = await refresh(request);
  expect(response.status(), await response.text()).toBe(200);
  expect((await response.json()).state).toBe('updated');
  expect(await (await request.get('/')).text()).toContain('Why Pay $500 For RAM?');
  await refresh(request);
  const after = await state(request);
  expect(after.hero.ramPrice.priceCents).toBe(50000);
  expect(after.reads).toBe(1);
  expect(after.publishes).toHaveLength(1);
});

test('a quote checked in this window is reused without reading the source', async ({ request }) => {
  const before = await state(request, { previousPrice: 49000, checkedAt: new Date().toISOString() });
  expect((await refresh(request)).status()).toBe(200);
  const after = await state(request);
  expect(after.hero.ramPrice).toEqual(before.hero.ramPrice);
  expect(after.reads).toBe(0);
  expect(after.publishes).toHaveLength(0);
});

test('a first-read failure keeps the approved static hero without inventing a quote', async ({ page, request }) => {
  const before = await state(request, { mode: 'failed' });
  const published = await request.post('/api/admin/content/publish', {
    headers: { 'x-admin-key': 'fixture-only-ram-price-admin' },
    data: { operation: 'replace', type: 'hero', documentId: before.hero._id, expectedRevision: before.hero._rev, document: before.hero },
  });
  expect(published.status(), await published.text()).toBe(200);
  expect((await refresh(request)).status()).toBe(503);
  const after = await state(request);
  expect(after.hero.ramPrice).toBeUndefined();
  expect(after.publishes).toHaveLength(0);
  await page.goto('/');
  await expect(page.locator('#top h1')).toContainText('Why Pay $400 For RAM?');
  await expect(page.locator('#top h1')).toContainText('Tune Yours For $99.95.');
  await expect(page.locator('#top')).toContainText('A 32GB DDR5 kit that was around $100 in early 2025 costs $400 now.');
  await expect(page.locator('#top a[data-ram-price-source]')).toHaveCount(0);
});

for (const scenario of [
  { name: 'failed source', mode: 'failed', price: '500.00' },
  { name: 'stale source', mode: 'stale', price: '500.00' },
  { name: 'outlier source', mode: 'normal', price: '1400.00' },
]) {
  test(`${scenario.name} retains the rendered verified price and checked date`, async ({ page, request }) => {
    const before = await state(request, { mode: scenario.mode, price: scenario.price, previousPrice: 49000, checkedAt: new Date(Date.now() - 7 * 3600000).toISOString() });
    const published = await request.post('/api/admin/content/publish', {
      headers: { 'x-admin-key': 'fixture-only-ram-price-admin' },
      data: { operation: 'replace', type: 'hero', documentId: before.hero._id, expectedRevision: before.hero._rev, document: before.hero },
    });
    expect(published.status(), await published.text()).toBe(200);
    await page.goto('/');
    await expect(page.locator('#top h1')).toContainText('Why Pay $490 For RAM?');
    const source = page.locator('#top a[data-ram-price-source]');
    const originalLabel = await source.innerText();
    const checked = new Date(before.hero.ramPrice.checkedAt);
    expect(originalLabel).toContain(`${checked.getUTCDate()} ${checked.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${checked.getUTCFullYear()}`);
    expect((await refresh(request)).status()).toBe(503);
    const after = await state(request);
    expect(after.hero.ramPrice).toEqual(before.hero.ramPrice);
    expect(after.publishes).toHaveLength(0);
    await page.reload();
    await expect(page.locator('#top h1')).toContainText('Why Pay $490 For RAM?');
    await expect(source).toHaveText(originalLabel);
    await expect(source).toHaveAttribute('href', before.hero.ramPrice.sourceUrl);
  });
}

test('an invalid stored date cannot authorize a replacement quote', async ({ request }) => {
  const before = await state(request, { previousPrice: 49000, checkedAt: 'invalid' });
  expect((await refresh(request)).status()).toBe(503);
  const after = await state(request);
  expect(after.hero.ramPrice).toEqual(before.hero.ramPrice);
  expect(after.reads).toBe(0);
  expect(after.publishes).toHaveLength(0);
});

test('a failed package read never substitutes a fixed tune price and recovers from the source', async ({ page, request }, testInfo) => {
  const editing = await state(request);
  const max = editing.packages.find(pkg => /max|xoc/i.test(pkg.title));
  const published = await request.post('/api/admin/content/publish', {
    headers: { 'x-admin-key': 'fixture-only-ram-price-admin' },
    data: { operation: 'replace', type: 'package', documentId: max._id, expectedRevision: max._rev, document: { ...max, price: '$123.45' } },
  });
  expect(published.status(), await published.text()).toBe(200);
  expect((await refresh(request)).status()).toBe(200);
  let unavailable = true;
  let failedReads = 0;
  await page.route('**/api/content/packages-list', route => {
    if (!unavailable) return route.continue();
    failedReads++;
    return route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic package source outage' } });
  });
  await page.goto('/about');
  await page.locator('footer a[href="/"]').first().click();
  await expect(page.locator('#top h1')).toContainText('Why Pay $500 For RAM?');
  await expect.poll(() => failedReads).toBeGreaterThan(0);
  await page.locator('#top').screenshot({ path: testInfo.outputPath('package-source-unavailable.png') });
  await expect(page.locator('#top h1')).not.toContainText('$99.95');
  await expect(page.locator('#top h1')).toContainText('Tune Yours.');
  unavailable = false;
  await expect(page.locator('#top h1')).toContainText('Tune Yours For $123.45.');
  await page.locator('#top').screenshot({ path: testInfo.outputPath('package-source-recovered.png') });
  await page.goto('/packages');
  await expect(page.locator('main')).toContainText('$123.45');
});

test('missing package data keeps HTML and Markdown honest and the hydrated hero recovers', async ({ page, request }) => {
  const url = `${fixture}/__content`;
  try {
    const editing = await state(request);
    const max = editing.packages.find(pkg => /max|xoc/i.test(pkg.title));
    const packagePublished = await request.post('/api/admin/content/publish', {
      headers: { 'x-admin-key': 'fixture-only-ram-price-admin' },
      data: { operation: 'replace', type: 'package', documentId: max._id, expectedRevision: max._rev, document: { ...max, price: '$123.45' } },
    });
    expect(packagePublished.status(), await packagePublished.text()).toBe(200);
    expect((await refresh(request)).status()).toBe(200);
    const before = await state(request);
    expect((await request.post(url, { data: { missing: ['package'] } })).status()).toBe(200);
    const published = await request.post('/api/admin/content/publish', {
      headers: { 'x-admin-key': 'fixture-only-ram-price-admin' },
      data: { operation: 'replace', type: 'hero', documentId: before.hero._id, expectedRevision: before.hero._rev, document: before.hero },
    });
    expect(published.status(), await published.text()).toBe(200);
    const html = await (await request.get('/')).text();
    expect(html).toContain('Why Pay $500 For RAM?');
    expect(html).toContain('Tune Yours.');
    expect(html).not.toContain('Tune Yours For $99.95.');
    const markdown = await (await request.get('/markdown?path=/')).text();
    expect(markdown).toContain('$500');
    expect(markdown).not.toContain('$99');
    let unavailable = true;
    let failedReads = 0;
    await page.route('**/api/content/packages-list', route => {
      if (!unavailable) return route.continue();
      failedReads++;
      return route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic package source outage' } });
    });
    await page.goto('/');
    await expect(page.locator('#top h1')).toContainText('Why Pay $500 For RAM?');
    await expect(page.locator('#top h1')).toContainText('Tune Yours.');
    await expect.poll(() => failedReads).toBeGreaterThan(0);
    expect((await request.post(url, { data: { missing: [] } })).status()).toBe(200);
    const current = await state(request);
    const restored = await request.post('/api/admin/content/publish', {
      headers: { 'x-admin-key': 'fixture-only-ram-price-admin' },
      data: { operation: 'replace', type: 'hero', documentId: current.hero._id, expectedRevision: current.hero._rev, document: current.hero },
    });
    expect(restored.status(), await restored.text()).toBe(200);
    unavailable = false;
    await expect(page.locator('#top h1')).toContainText('Tune Yours For $123.45.');
  } finally {
    expect((await request.post(url, { data: { missing: [] } })).status()).toBe(200);
  }
});

test('leaving the hero cancels pending package read retries', async ({ page, request }, testInfo) => {
  expect((await refresh(request)).status()).toBe(200);
  let reads = 0;
  await page.route('**/api/content/packages-list', route => {
    reads++;
    return route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic package source outage' } });
  });
  await page.goto('/about');
  await page.evaluate(() => { window.__ramPriceDocument = true; });
  await page.locator('footer a[href="/"]').first().click();
  await expect(page.locator('#top h1')).toContainText('Why Pay $500 For RAM?');
  await expect.poll(() => reads).toBeGreaterThan(0);
  await page.locator('footer a[href="/about"]').first().click();
  await expect(page).toHaveURL(/\/about$/);
  expect(await page.evaluate(() => window.__ramPriceDocument)).toBe(true);
  const readsOnExit = reads;
  await page.waitForTimeout(3500);
  expect(reads).toBe(readsOnExit);
  await testInfo.attach('cancelled-package-retries', { body: JSON.stringify({ readsOnExit, readsAfterExit: reads }), contentType: 'application/json' });
});

const publishHero = async request => {
  const { hero } = await state(request);
  const response = await request.post('/api/admin/content/publish', {
    headers: { 'x-admin-key': 'fixture-only-ram-price-admin' },
    data: { operation: 'replace', type: 'hero', documentId: hero._id, expectedRevision: hero._rev, document: hero },
  });
  expect(response.status(), await response.text()).toBe(200);
};
const patchPackageSource = async (request, patch) => {
  expect((await request.post(`${fixture}/__content`, { data: { patch } })).ok()).toBe(true);
  await publishHero(request);
};
const cachedHero = async (request, expected) => {
  let html;
  await expect.poll(async () => {
    const response = await request.get('/');
    expect(response.ok()).toBe(true);
    html = await response.text();
    return response.headers()['x-nextjs-cache'] === 'HIT' && html.includes(expected);
  }, { timeout: 30000 }).toBe(true);
  return html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/)?.[0] || '';
};

test.describe('unusable Max sources', () => {
test.afterEach(async ({ request }) => {
  expect((await request.post(`${fixture}/__content`, { data: { reset: true } })).ok()).toBe(true);
});

test('unusable Max source prices never manufacture a tune price in SSR SPA or Markdown', async ({ page, request }, testInfo) => {
  expect((await refresh(request)).status()).toBe(200);
  const { packages } = await state(request);
  const max = packages.find(pkg => /max|xoc/i.test(pkg.title));
  const observations = [];
  for (const price of [null, '', 0, '0', 'invalid', '$123.45']) {
    await patchPackageSource(request, { _id: max._id, price });
    const valid = price === '$123.45';
    const expected = valid ? 'Tune Yours For $123.45.' : 'Tune Yours.';
    const ssr = await cachedHero(request, valid ? expected : 'Why Pay $500 For RAM?');
    const api = await (await request.get('/api/content/packages-list')).json();
    expect(api.data.find(pkg => pkg._id === max._id).price).toBe(price);
    const markdown = (await (await request.get('/markdown?path=/')).text()).replaceAll('\\', '');
    await page.goto('/about');
    await page.locator('footer a[href="/"]').first().click();
    await expect(page.locator('#top h1')).toContainText('Why Pay $500 For RAM?');
    await expect(page.locator('#top h1')).toContainText(valid ? '$123.45' : 'Tune Yours');
    const spa = await page.locator('#top h1').innerText();
    for (const [surface, heading] of Object.entries({ ssr, spa, markdown })) {
      expect.soft(heading, `${surface}, source price=${JSON.stringify(price)}`).toContain(expected);
      if (!valid) expect.soft(heading, `${surface}, source price=${JSON.stringify(price)}`).not.toContain('Tune Yours For $99.95');
    }
    await page.goto('/');
    await expect(page.locator('#top h1')).toContainText('Why Pay $500 For RAM?');
    expect.soft(await page.locator('#top h1').innerText(), `hydrated source price=${JSON.stringify(price)}`).toContain(expected);
    if (price === null) await page.locator('#top').screenshot({ path: testInfo.outputPath('null-Max-source-price.png') });
    observations.push({ price, ssr, spa, markdown });
  }
  await testInfo.attach('raw-price-surfaces', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' });
});

for (const missing of ['empty list', 'missing Max', 'invalid Max price']) {
  test(`successful ${missing} recovers the actual package price on the same page`, async ({ page, request }, testInfo) => {
    expect((await refresh(request)).status()).toBe(200);
    const { packages } = await state(request);
    const max = packages.find(pkg => /max|xoc/i.test(pkg.title));
    if (missing === 'empty list') {
      expect((await request.post(`${fixture}/__content`, { data: { missing: ['package'] } })).ok()).toBe(true);
      await publishHero(request);
    } else {
      await patchPackageSource(request, { _id: max._id, ...(missing === 'missing Max' ? { title: 'Other package' } : { price: null }) });
    }
    await cachedHero(request, 'Why Pay $500 For RAM?');
    let reads = 0;
    await page.route('**/api/content/packages-list', route => { reads++; return route.continue(); });
    await page.goto(missing === 'empty list' ? '/about' : '/');
    await page.evaluate(() => { window.__ramRecoveryDocument = true; });
    if (missing === 'empty list') await page.locator('footer a[href="/"]').first().click();
    await expect(page.locator('#top h1')).toContainText('Tune Yours.');
    const beforeRepair = await page.locator('#top h1').innerText();
    expect((await request.post(`${fixture}/__content`, { data: { missing: [] } })).ok()).toBe(true);
    await patchPackageSource(request, { _id: max._id, title: max.title, price: '$123.45' });
    await expect(page.locator('#top h1')).toContainText('Tune Yours For $123.45.');
    expect(await page.evaluate(() => window.__ramRecoveryDocument)).toBe(true);
    expect(reads).toBeGreaterThan(0);
    await page.locator('#top').screenshot({ path: testInfo.outputPath('source-repaired-without-navigation.png') });
    await testInfo.attach('same-page-recovery', { body: JSON.stringify({ missing, beforeRepair, reads, recovered: await page.locator('#top h1').innerText() }), contentType: 'application/json' });
  });
}

test('successful unusable package reads keep a finite retry budget', async ({ page, request }, testInfo) => {
  expect((await refresh(request)).status()).toBe(200);
  let reads = 0;
  await page.route('**/api/content/packages-list', route => {
    reads++;
    return route.fulfill({ status: 200, json: { ok: true, data: [] } });
  });
  await page.goto('/about');
  await page.locator('footer a[href="/"]').first().click();
  await expect(page.locator('#top h1')).toContainText('Tune Yours.');
  await expect.poll(() => reads).toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(4000);
  const exhaustedReads = reads;
  expect(exhaustedReads).toBeLessThanOrEqual(4);
  await page.waitForTimeout(2500);
  expect(reads).toBe(exhaustedReads);
  await testInfo.attach('finite-package-retries', { body: JSON.stringify({ exhaustedReads, finalReads: reads }), contentType: 'application/json' });
});
});
