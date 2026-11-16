const { randomUUID } = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { fixturePort } = require('./fixtures/fixture-ports.cjs');
const { ADMIN_KEY, cms, login, choose, prepareAdminContext } = require('./fixtures/admin-content.cjs');

test.beforeEach(async ({ context, page, request, baseURL }) => {
  await prepareAdminContext({ context, page, request, baseURL });
});

test('a stale CMS publish shows the newer revision', async ({ page, request }) => {
  const original = await cms(request, '/api/admin/content/documents/tooling-hero');
  await login(page);
  await choose(page, 'Hero Section');
  const editor = page.getByRole('region', { name: 'Editor', exact: true });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  const closed = editor.locator('button[aria-expanded="false"]');
  while (await closed.count()) await closed.first().click();
  await page.getByLabel('Main Heading (Line 1)', { exact: true }).fill('An older edit');
  await cms(request, '/api/admin/content/publish', {
    operation: 'replace', type: 'hero', documentId: 'tooling-hero',
    expectedRevision: original.revision, document: { ...original.document, headingLine1: 'The newer edit' },
  });
  const current = await cms(request, '/api/admin/content/documents/tooling-hero');
  const response = page.waitForResponse((item) => item.url().endsWith('/api/admin/content/publish') && item.request().method() === 'POST');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const published = await response;
  expect(published.status()).toBe(409);
  expect(await published.json()).toMatchObject({ code: 'CMS_REVISION_CONFLICT', details: { currentRevision: current.revision } });
  await expect(page.getByRole('alert').filter({ hasText: 'Someone published a newer version' })).toBeVisible();
  expect((await cms(request, '/api/admin/content/documents/tooling-hero')).revision).toBe(current.revision);
});

test('a stale creator terms save shows the conflict', async ({ page, request }) => {
  const headers = { 'x-admin-key': ADMIN_KEY };
  const list = await request.get('/api/admin/referral-creators?limit=100', { headers });
  expect(list.ok()).toBe(true);
  const creator = (await list.json()).creators[0];
  await page.goto('/admin/referrals');
  await page.getByLabel('Admin key', { exact: true }).fill(ADMIN_KEY);
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await page.locator('aside').getByRole('button').filter({ hasText: creator.referral_code }).click();
  await expect(page.getByRole('heading', { name: creator.name, exact: true })).toBeVisible();
  await page.getByLabel('Creator commission percentage').fill('8.75');
  await page.getByLabel('Reason for change').fill('An older edit');
  const newer = await request.patch('/api/admin/referral-creators', { headers, data: {
    creatorId: creator.creator_id, expectedVersion: creator.terms_version, operationId: randomUUID(),
    totalPercent: '15', commissionPercent: '10', discountPercent: '5', bypassUnlock: false,
    reason: 'A newer edit',
  } });
  expect(newer.ok(), await newer.text()).toBe(true);
  const callsUrl = `http://127.0.0.1:${fixturePort('TOOLING_ADMIN_CONTROL_PORT')}/creator-terms-rpcs`;
  const beforeCalls = await (await request.get(callsUrl)).json();
  const response = page.waitForResponse((item) => item.url().endsWith('/api/admin/referral-creators') && item.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save creator settings', exact: true }).click();
  const conflict = await response;
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({ ok: false, error: expect.stringContaining('Reload') });
  const calls = (await (await request.get(callsUrl)).json()).slice(beforeCalls.length);
  expect(calls).toContain('roo_admin_update_creator_terms');
  expect(calls.some((rpc) => rpc.includes('mirror'))).toBe(false);
  await expect(page.getByRole('alert').filter({ hasText: /draft conflict/i })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save creator settings', exact: true })).toBeDisabled();
});
