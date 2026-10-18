const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const http = require('node:http');
let fixture;
let restoreGuard;

test.skip(process.env.TOOLING_CREATOR_PORTAL !== '1', 'Select the creator fixture with npm run test:creator:portal.');

test.use({ javaScriptEnabled: true, trace: 'retain-on-failure', video: 'off' });
test.beforeAll(async ({ baseURL }) => {
  fixture = await import('./fixtures/api-routes.mjs');
  const { installNetworkGuard, refuseEnvFiles } = await import('../scripts/lib/test-target-safety.mjs');
  refuseEnvFiles();
  restoreGuard = installNetworkGuard([baseURL, fixture.apiFixtureOrigin(baseURL)]);
  fs.mkdirSync('test-results/creator-portal', { recursive: true });
});
test.afterAll(() => restoreGuard?.());
test.beforeEach(async ({ baseURL, context }) => {
  await fixture.configureApiFixture(baseURL, { reset: true });
  await configure(baseURL, { reset: true });
  const { guardBrowserContext } = await import('../scripts/lib/test-target-safety.mjs');
  await guardBrowserContext(context, [baseURL, fixture.apiFixtureOrigin(baseURL)]);
});

async function configure(baseURL, data) {
  const response = await fixture.requestRoute(fixture.apiFixtureOrigin(baseURL), '/__portal', { data });
  if (response.status !== 200) throw new Error(`Creator portal fixture configuration failed (${response.status}): ${await response.text()}`);
  return response;
}
async function signIn(context, baseURL) {
  await context.addCookies([{ name: 'ref_session', value: fixture.referralSessionCookie(), url: baseURL, httpOnly: true, sameSite: 'Lax' }]);
}

async function holdAccountReply(page, endpoint, reply) {
  let unblock, seen, finished;
  let received = false;
  const gate = new Promise(resolve => { unblock = resolve; });
  const arrived = new Promise(resolve => { seen = resolve; });
  const completed = new Promise(resolve => { finished = resolve; });
  const handler = async route => {
    received = true;
    seen(route.request().postDataJSON());
    await gate;
    try { await (reply === 'abort' ? route.abort('failed') : route.fulfill(reply)); } finally { finished(); }
  };
  await page.route(`**${endpoint}`, handler);
  return { arrived, release: async () => {
    unblock();
    if (received) await completed;
    await page.unroute(`**${endpoint}`, handler);
  } };
}

test('creator session follows login and logout', async ({ page, context }, testInfo) => {
  const protocol = await context.newCDPSession(page);
  const blockedCookies = [];
  await protocol.send('Network.enable');
  protocol.on('Network.responseReceivedExtraInfo', event => {
    for (const cookie of event.blockedCookies || []) blockedCookies.push(cookie.blockedReasons);
  });
  await page.goto('/referrals/login');
  await page.locator('#ref-login-identifier').fill('fixture-creator');
  await page.locator('#ref-login-password').fill('Synthetic-password1!');
  const loginResponse = page.waitForResponse(response => response.url().endsWith('/api/ref/login'));
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  const response = await loginResponse;
  await testInfo.attach('session-cookie-state', { body: JSON.stringify({
    status: response.status(),
    secureContext: await page.evaluate(() => window.isSecureContext),
    secureCookie: Boolean((await response.headerValue('set-cookie'))?.includes('Secure')),
    blockedCookies,
    cookies: (await context.cookies()).map(({ name, secure }) => ({ name, secure })),
  }), contentType: 'application/json' });
  expect(response.status()).toBe(200);
  await expect.poll(async () => (await context.cookies()).some(cookie => cookie.name === 'ref_session')).toBe(true);
  const logout = await page.evaluate(async () => (await fetch('/api/ref/logout', { method: 'POST' })).status);
  expect(logout).toBe(200);
  expect((await context.cookies()).some(cookie => cookie.name === 'ref_session')).toBe(false);
});
async function record(page, testInfo, label, values = {}, fullPage = true) {
  const details = { url: page.url(), viewport: page.viewportSize(), ...values };
  fs.mkdirSync(testInfo.outputDir, { recursive: true });
  fs.writeFileSync(testInfo.outputPath(`${label}.json`), JSON.stringify(details, null, 2));
  await testInfo.attach(label, { body: JSON.stringify(details), contentType: 'application/json' });
  const screenshot = testInfo.outputPath(`${label}.png`);
  await page.screenshot({ path: screenshot, fullPage });
  await testInfo.attach(`${label}-screenshot`, { path: screenshot, contentType: 'image/png' });
}
async function openForm(page, pathname, effectPath) {
  const ready = page.waitForResponse(response => new URL(response.url()).pathname === effectPath);
  await page.goto(pathname);
  const response = await ready;
  expect(response.status()).toBe(200);
  await response.finished();
  await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function expectRegistrationFields(page, email, code) {
  for (const [label, value] of [
    ['Discord Username', 'synthetic-user'], ['Login Email', email],
    ['PayPal Email (for payouts)', 'payout@fixture.invalid'], ['Referral Code', code],
    ['Password', 'Synthetic-password1!'], ['Confirm Password', 'Synthetic-password1!'],
  ]) await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
}
async function fillRegistration(page, email = 'new@fixture.invalid', code = 'new-creator') {
  await page.getByLabel('Discord Username', { exact: true }).fill('synthetic-user');
  await page.getByLabel('Login Email', { exact: true }).fill(email);
  await page.getByLabel('PayPal Email (for payouts)', { exact: true }).fill('payout@fixture.invalid');
  await page.getByLabel('Referral Code', { exact: true }).fill(code);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-password1!');
  await page.getByLabel('Confirm Password', { exact: true }).fill('Synthetic-password1!');
  await expectRegistrationFields(page, email, code);
}
async function submitRegistration(page, email = 'new@fixture.invalid', code = 'new-creator') {
  await fillRegistration(page, email, code);
  await page.getByRole('button', { name: 'Register', exact: true }).click();
}

test("reset acknowledgment persists without clearing or resending the email", async ({ page, context, baseURL }, testInfo) => {
  let sends = 0;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await import("./fixtures/api-routes.mjs");
    await fixture.configureApiFixture(baseURL, { reset: true });
    const response = await fixture.requestRoute(fixture.apiFixtureOrigin(baseURL), "/__portal", { data: { reset: true } });
    expect(response.status).toBe(200);
    await context.unroute("**/*");
    const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
    const local = new URL(baseURL);
    local.hostname = "localhost";
    await guardBrowserContext(context, [baseURL, local.origin, fixture.apiFixtureOrigin(baseURL)]);
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/ref/forgot") sends += 1; });
    const message = "If an account matches that email, we've sent a reset link. Check your inbox and spam folder.";
    for (const email of ["creator@fixture.invalid", "unknown@fixture.invalid"]) {
      await page.goto(`${local.origin}/referrals/forgot`);
      await page.getByLabel("Creator Email", { exact: true }).fill(email);
      const sent = page.waitForResponse(r => new URL(r.url()).pathname === "/api/ref/forgot");
      await page.getByRole("button", { name: "Send Reset Link", exact: true }).click();
      expect((await sent).status()).toBe(200);
      const status = page.getByRole("status").filter({ hasText: message });
      await expect(status).toBeInViewport();
      await expect(page.getByLabel("Creator Email", { exact: true })).toHaveValue(email);
      await page.waitForTimeout(3400);
      await expect(status).toBeVisible();
      await expect(page.getByRole("button", { name: "Send Reset Link", exact: true })).toBeEnabled();
    }
    expect(sends).toBe(2);
  } finally {
    await record(page, testInfo, "reset-email-acknowledgment", { sends });
  }
});

test.describe('replacement confirmation links in the same tab', () => {
  const stale = 'c'.repeat(43);
  const fresh = 'b'.repeat(43);
  const storageKey = 'referral_registration_verification';
  const endpoint = '**/api/ref/verifyRegistration';
  const collectTokens = page => {
    const tokens = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/ref/verifyRegistration' && request.method() === 'POST') {
        tokens.push(request.postDataJSON().token);
      }
    });
    return tokens;
  };

  test('a replacement link opened after a failed one is confirmed', async ({ page }, testInfo) => {
    const tokens = collectTokens(page);
    await page.goto('/referrals/verify#token=' + stale);
    await expect(page.getByRole('status')).toContainText('Invalid or expired confirmation link');
    expect(new URL(page.url()).hash).toBe('');
    await page.evaluate(() => { window.__verifyDocument = true; });
    await page.goto('/referrals/verify#token=' + fresh);
    await expect(page.getByRole('status')).toContainText('Email confirmed');
    const documentReused = await page.evaluate(() => window.__verifyDocument === true);
    const storedToken = await page.evaluate(key => sessionStorage.getItem(key), storageKey);
    await record(page, testInfo, 'verify-replacement-link', { documentReused, postCount: tokens.length, storedTokenCleared: storedToken === null });
    expect(documentReused).toBe(true);
    expect(new URL(page.url()).hash).toBe('');
    expect(storedToken).toBeNull();
    expect(tokens).toEqual([stale, fresh]);
  });

  test('a late reply for the earlier link changes nothing', async ({ page }, testInfo) => {
    const tokens = collectTokens(page);
    let releaseStale;
    let releaseFresh;
    const staleHeld = new Promise(resolve => { releaseStale = resolve; });
    const freshHeld = new Promise(resolve => { releaseFresh = resolve; });
    await page.route(endpoint, async route => {
      if (route.request().postDataJSON().token === stale) {
        await staleHeld;
        await route.fulfill({ status: 400, json: { ok: false, error: 'Invalid or expired confirmation link.' } });
      } else {
        await freshHeld;
        await route.fallback();
      }
    });
    const staleResponse = page.waitForResponse(response => response.url().endsWith('/api/ref/verifyRegistration') && response.request().postDataJSON().token === stale);
    const freshResponse = page.waitForResponse(response => response.url().endsWith('/api/ref/verifyRegistration') && response.request().postDataJSON().token === fresh);
    staleResponse.catch(() => {});
    freshResponse.catch(() => {});
    try {
      await page.goto('/referrals/verify#token=' + stale);
      await expect(page.getByRole('status')).toContainText('Confirming your email');
      await page.evaluate(() => { window.__verifyDocument = true; });
      await page.goto('/referrals/verify#token=' + fresh);
      await expect.poll(() => tokens).toEqual([stale, fresh]);
      releaseStale();
      const response = await staleResponse;
      expect(response.status()).toBe(400);
      await response.finished();
      await page.waitForTimeout(300);
      const storedToken = await page.evaluate(key => sessionStorage.getItem(key), storageKey);
      await record(page, testInfo, 'verify-earlier-reply', { postCount: tokens.length, storedTokenMatchesFresh: storedToken === fresh });
      await expect(page.getByRole('status')).toContainText('Confirming your email');
      expect(storedToken).toBe(fresh);
      releaseFresh();
      await expect(page.getByRole('status')).toContainText('Email confirmed');
      expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
      expect(await page.evaluate(() => window.__verifyDocument)).toBe(true);
      expect(new URL(page.url()).hash).toBe('');
      await record(page, testInfo, 'verify-current-link', { documentReused: true, postCount: tokens.length, storedTokenCleared: true });
    } finally {
      releaseStale();
      releaseFresh();
      if (tokens.includes(stale)) await staleResponse.then(response => response.finished()).catch(() => {});
      if (tokens.includes(fresh)) await freshResponse.then(response => response.finished()).catch(() => {});
      await page.unrouteAll({ behavior: 'wait' });
    }
  });

  test('the same link opened again while confirming is sent once', async ({ page }, testInfo) => {
    const tokens = collectTokens(page);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route(endpoint, async route => { await held; await route.fallback(); });
    const response = page.waitForResponse(endpoint);
    response.catch(() => {});
    try {
      await page.goto('/referrals/verify#token=' + fresh);
      await expect.poll(() => tokens).toEqual([fresh]);
      await expect(page.getByRole('status')).toContainText('Confirming your email');
      await page.evaluate(() => { window.__verifyDocument = true; });
      await page.goto('/referrals/verify#token=' + fresh);
      await expect.poll(() => new URL(page.url()).hash).toBe('');
      release();
      await expect(page.getByRole('status')).not.toContainText('Confirming your email');
      await record(page, testInfo, 'verify-pending-same-link', { documentReused: await page.evaluate(() => window.__verifyDocument === true), postCount: tokens.length });
      expect(tokens).toEqual([fresh]);
      await expect(page.getByRole('status')).toContainText('Email confirmed');
      expect(await page.evaluate(() => window.__verifyDocument)).toBe(true);
      expect(new URL(page.url()).hash).toBe('');
      expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
    } finally {
      release();
      if (tokens.length) await response.then(result => result.finished()).catch(() => {});
      await page.unrouteAll({ behavior: 'wait' });
    }
  });

  test('reopening a confirmed link keeps the confirmation', async ({ page }, testInfo) => {
    const tokens = collectTokens(page);
    await page.goto('/referrals/verify#token=' + fresh);
    await expect(page.getByRole('status')).toContainText('Email confirmed');
    await page.evaluate(() => { window.__verifyDocument = true; });
    await page.goto('/referrals/verify#token=' + fresh);
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    await page.waitForTimeout(500);
    const storedToken = await page.evaluate(key => sessionStorage.getItem(key), storageKey);
    await record(page, testInfo, 'verify-reopened-confirmed-link', { postCount: tokens.length, storedTokenCleared: storedToken === null });
    await expect(page.getByRole('status')).toContainText('Email confirmed');
    await expect(page.getByRole('button', { name: 'Open dashboard', exact: true })).toBeVisible();
    expect(tokens).toEqual([fresh]);
    expect(await page.evaluate(() => window.__verifyDocument)).toBe(true);
    expect(storedToken).toBeNull();
  });

  test('returning to a link that is still confirming does not send it again', async ({ page }, testInfo) => {
    const tokens = collectTokens(page);
    const release = {};
    const held = {
      [fresh]: new Promise(resolve => { release[fresh] = resolve; }),
      [stale]: new Promise(resolve => { release[stale] = resolve; }),
    };
    await page.route(endpoint, async route => {
      const token = route.request().postDataJSON().token;
      await held[token];
      if (token === stale) await route.fulfill({ status: 400, json: { ok: false, error: 'Invalid or expired confirmation link.' } });
      else await route.fallback();
    });
    const staleResponse = page.waitForResponse(response => response.url().endsWith('/api/ref/verifyRegistration') && response.request().postDataJSON().token === stale);
    staleResponse.catch(() => {});
    try {
      await page.goto('/referrals/verify#token=' + fresh);
      await expect.poll(() => tokens).toEqual([fresh]);
      await page.evaluate(() => { window.__verifyDocument = true; });
      await page.goto('/referrals/verify#token=' + stale);
      await expect.poll(() => tokens).toEqual([fresh, stale]);
      await page.goto('/referrals/verify#token=' + fresh);
      await expect.poll(() => new URL(page.url()).hash).toBe('');
      release[stale]();
      await (await staleResponse).finished();
      await page.waitForTimeout(300);
      const storedToken = await page.evaluate(key => sessionStorage.getItem(key), storageKey);
      await expect(page.getByRole('status')).toContainText('Confirming your email');
      expect(storedToken).toBe(fresh);
      release[fresh]();
      await expect(page.getByRole('status')).toContainText('Email confirmed');
      await record(page, testInfo, 'verify-returned-pending-link', { postCount: tokens.length });
      expect(tokens).toEqual([fresh, stale]);
      expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
      expect(await page.evaluate(() => window.__verifyDocument)).toBe(true);
    } finally {
      release[fresh]();
      release[stale]();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
});

test.describe('portal requests that stall', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page, context, baseURL }) => {
    await signIn(context, baseURL);
    await page.route('**/api/auth/identities?flow=referral', route => route.fulfill({ json: { ok: true, domainAccount: true, providers: ['email', 'google'], unlinkableProviders: ['email', 'google'] } }));
  });

  const stall = async (page, endpoint, method) => {
    let unblock, seen, finished;
    let count = 0;
    const gate = new Promise(resolve => { unblock = resolve; });
    const arrived = new Promise(resolve => { seen = resolve; });
    const completed = new Promise(resolve => { finished = resolve; });
    const handler = async route => {
      if (route.request().method() !== method) return route.fallback();
      count += 1;
      seen();
      await gate;
      try { await route.abort(); } catch {} finally { finished(); }
    };
    await page.route(`**${endpoint}`, handler);
    return { arrived, count: () => count, release: async () => {
      unblock();
      if (count) await completed;
      await page.unroute(`**${endpoint}`, handler);
    } };
  };

  test('stalled payouts can be retried', async ({ page }, testInfo) => {
    const held = await stall(page, '/api/ref/payouts', 'GET');
    try {
      await page.goto('/referrals/dashboard');
      await held.arrived;
      const message = page.getByText('Payout data is taking too long to load.', { exact: true });
      await expect(message).toBeVisible({ timeout: 12000 });
      const retry = message.locator('..').getByRole('button', { name: 'Retry', exact: true });
      await expect(retry).toBeEnabled();
      expect(held.count()).toBe(1);
      await record(page, testInfo, 'stalled-payouts', { timedOut: true, requestsBeforeRetry: held.count() });
      await held.release();
      await retry.click();
      await expect(page.getByText('Total earned', { exact: true })).toBeVisible();
      await expect(message).toHaveCount(0);
    } finally { await held.release(); }
  });

  test('stalled account connections can be retried', async ({ page }, testInfo) => {
    const held = await stall(page, '/api/auth/identities?flow=referral', 'GET');
    try {
      await page.goto('/referrals/dashboard');
      await held.arrived;
      const message = page.getByRole('alert').filter({ hasText: 'Account connections are taking too long to load.' });
      await expect(message).toBeVisible({ timeout: 12000 });
      const panel = page.locator('section[aria-labelledby="referral-connections-title"]');
      const retry = panel.getByRole('button', { name: 'Retry', exact: true });
      await expect(retry).toBeEnabled();
      expect(held.count()).toBe(1);
      await record(page, testInfo, 'stalled-identities', { timedOut: true, requestsBeforeRetry: held.count() });
      await held.release();
      await retry.click();
      await expect(panel.getByRole('heading', { name: 'Connected accounts', exact: true })).toBeVisible();
      await expect(panel.getByText('Google: Linked', { exact: false })).toBeVisible();
      await expect(message).toHaveCount(0);
    } finally { await held.release(); }
  });

  test('stalled settings save reports an unknown outcome', async ({ page }, testInfo) => {
    const held = await stall(page, '/api/ref/updateSplit', 'POST');
    try {
      await page.goto('/referrals/dashboard');
      const commission = page.getByText('Commission (%)', { exact: true }).locator('..');
      await commission.getByRole('button', { name: '+', exact: true }).click();
      await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
      await held.arrived;
      await commission.getByRole('button', { name: '+', exact: true }).click();
      const message = page.getByRole('alert').filter({ hasText: "We couldn't confirm your settings were saved. Reload the page to check them before saving again." });
      await expect(message).toBeVisible({ timeout: 12000 });
      await expect(page.getByRole('button', { name: 'Save Settings', exact: true })).toBeEnabled();
      await page.waitForTimeout(350);
      expect(held.count()).toBe(1);
      await expect(page.getByRole('status').filter({ hasText: 'Saved successfully!' })).toHaveCount(0);
      await record(page, testInfo, 'stalled-settings', { editWhilePending: true, unknownOutcomeShown: true, requests: held.count() });
    } finally { await held.release(); }
  });

  test('a settings save with a stalled response body reports an unknown outcome', async ({ page, context, baseURL }, testInfo) => {
    const target = new URL(baseURL);
    target.port = String(Number(target.port) + 2);
    let requests = 0;
    const server = http.createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/api/ref/updateSplit') {
        response.writeHead(404).end();
        return;
      }
      requests += 1;
      request.resume();
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': new URL(baseURL).origin,
        'Access-Control-Allow-Credentials': 'true',
      });
      response.write('{"ok":');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(target.port), '0.0.0.0', resolve);
    });
    const forward = route => route.continue({ url: `${target.origin}/api/ref/updateSplit` });
    try {
      const { guardBrowserContext } = await import('../scripts/lib/test-target-safety.mjs');
      await context.unroute('**/*');
      await guardBrowserContext(context, [baseURL, fixture.apiFixtureOrigin(baseURL), target.origin]);
      await page.route('**/api/ref/updateSplit', forward);
      await page.goto('/referrals/dashboard');
      await page.getByText('Commission (%)', { exact: true }).locator('..').getByRole('button', { name: '+', exact: true }).click();
      const headers = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ref/updateSplit');
      await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
      expect((await headers).status()).toBe(200);
      const message = page.getByRole('alert').filter({ hasText: "We couldn't confirm your settings were saved. Reload the page to check them before saving again." });
      await expect(message).toBeVisible({ timeout: 12000 });
      await expect(page.getByRole('button', { name: 'Save Settings', exact: true })).toBeEnabled();
      await expect(page.getByRole('status').filter({ hasText: 'Saved successfully!' })).toHaveCount(0);
      expect(requests).toBe(1);
      await record(page, testInfo, 'stalled-settings-body', { headersStatus: 200, bodyCompleted: false, requests, unknownOutcomeShown: true });
    } finally {
      await page.unroute('**/api/ref/updateSplit', forward);
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  });

  test('stalled identity confirmation can be tried again', async ({ page }, testInfo) => {
    const held = await stall(page, '/api/auth/reauth', 'POST');
    try {
      await page.goto('/referrals/dashboard');
      await page.getByLabel('Current password', { exact: true }).fill('Synthetic-password1!');
      const confirm = page.getByRole('button', { name: 'Confirm identity', exact: true });
      await confirm.click();
      await held.arrived;
      await page.getByLabel('Current password', { exact: true }).fill('Edited-while-pending2!');
      const message = page.getByRole('status').filter({ hasText: 'Confirming your identity took too long. Please try again.' });
      await expect(message).toBeVisible({ timeout: 12000 });
      await expect(confirm).toBeEnabled();
      await page.waitForTimeout(350);
      expect(held.count()).toBe(1);
      await record(page, testInfo, 'stalled-confirm-identity', { timedOut: true, requests: held.count(), retryEnabled: true });
    } finally { await held.release(); }
  });

  test('stalled unlink reports an unknown outcome', async ({ page }, testInfo) => {
    await page.route('**/api/auth/reauth', route => route.fulfill({ json: { ok: true } }));
    const held = await stall(page, '/api/auth/identities', 'POST');
    try {
      await page.goto('/referrals/dashboard');
      await page.getByLabel('Current password', { exact: true }).fill('Synthetic-password1!');
      const unlink = page.getByRole('button', { name: 'Unlink google', exact: true });
      await unlink.click();
      await held.arrived;
      const message = page.getByRole('status').filter({ hasText: "We couldn't confirm the unlink. Reload the page to check your connected accounts." });
      await expect(message).toBeVisible({ timeout: 12000 });
      await expect(unlink).toBeEnabled();
      await expect(page.getByText('Google: Linked', { exact: false })).toBeVisible();
      await page.waitForTimeout(350);
      expect(held.count()).toBe(1);
      await record(page, testInfo, 'stalled-unlink', { unknownOutcomeShown: true, requests: held.count(), unlinkEnabled: true });
    } finally { await held.release(); }
  });
});

test('an upstream Auth outage stays explained after a connected-account password edit', async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/auth/identities?flow=referral', route => route.fulfill({ json: { ok: true, domainAccount: true, providers: ['email', 'google'], unlinkableProviders: ['email', 'google'] } }));
  await page.goto('/referrals/login');
  await page.getByLabel('Referral code or login email', { exact: true }).fill('fixture-creator');
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-password1!');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Creator' })).toBeVisible();
  const incorrect = await page.evaluate(async () => {
    const response = await fetch('/api/auth/reauth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flow: 'referral', purpose: 'link_identity', password: 'Earlier-wrong-password1!' }) });
    return { status: response.status, body: await response.json() };
  });
  expect(incorrect).toEqual({ status: 401, body: { ok: false, error: 'Password is incorrect.', reason: 'password_incorrect' } });
  await configure(baseURL, { settings: { authUnavailable: true } });
  let unblock, seen, finished;
  const gate = new Promise(resolve => { unblock = resolve; });
  const arrived = new Promise(resolve => { seen = resolve; });
  const completed = new Promise(resolve => { finished = resolve; });
  const handler = async route => {
    const requestHeaders = await route.request().allHeaders();
    const response = await fixture.requestRoute(baseURL, '/api/auth/reauth', {
      data: route.request().postDataJSON(),
      headers: { cookie: requestHeaders.cookie || '', origin: baseURL },
    });
    const body = await response.json();
    const headers = {};
    const cookie = response.headers.get('set-cookie');
    if (cookie) headers['set-cookie'] = cookie;
    seen({ status: response.status, body });
    await gate;
    try { await route.fulfill({ status: response.status, headers, json: body }); } finally { finished(); }
  };
  await page.route('**/api/auth/reauth', handler);
  const password = page.getByLabel('Current password', { exact: true });
  const confirm = page.getByRole('button', { name: 'Confirm identity', exact: true });
  try {
    await password.fill('Synthetic-password1!');
    await confirm.click();
    const reauth = await arrived;
    await password.fill('Edited-before-outage-reply2!');
    unblock();
    await completed;
    await expect(confirm).toBeEnabled();
    const state = await (await configure(baseURL, {})).json();
    const tokenReplies = state.requests.filter(call => call.path === '/auth/v1/token').map(call => call.status);
    const messages = await page.locator('section[aria-labelledby="referral-connections-title"]').getByRole('status').allTextContents();
    await record(page, testInfo, 'connected-auth-outage', { incorrect, tokenReplies, reauth, messagesAfterPasswordEdit: messages });
    expect(tokenReplies).toContain(503);
    expect(reauth).toEqual({ status: 503, body: { ok: false, error: 'Reauthentication is temporarily unavailable.' } });
    const notice = page.getByRole('status').filter({ hasText: 'Reauthentication is temporarily unavailable.' });
    await expect(notice).toBeVisible();
    await password.fill('Edited-after-outage-reply3!');
    await expect(notice).toBeVisible();
  } finally {
    unblock();
    await page.unroute('**/api/auth/reauth', handler);
  }
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const size = viewport.width === 390 ? 'mobile' : 'desktop';
  test.describe(size, () => {
    test.use({ viewport });

    test('healthy dashboard displays the server balances', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      const dataPromise = page.waitForResponse(r => r.url().endsWith('/api/ref/getData'));
      const payoutPromise = page.waitForResponse(r => r.url().endsWith('/api/ref/payouts'));
      await page.goto('/referrals/dashboard');
      const data = await (await dataPromise).json();
      const payout = await (await payoutPromise).json();
      await expect(page.getByText('Auto-updated', { exact: true })).toBeVisible();
      for (const [label, expected] of [['Total earned', '$21.50'], ['Total paid', '$15.25'], ['Remaining owed', '$6.25']]) {
        await expect(page.getByText(label, { exact: true }).locator('..')).toContainText(expected);
      }
      await expect(page.getByText('Commission (%)', { exact: true }).locator('..')).toContainText('7.25%');
      await expect(page.getByText('Viewer Discount (%)', { exact: true }).locator('..')).toContainText('2.75%');
      const layout = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
      await record(page, testInfo, `dashboard-${size}`, { data, payout, layout });
      expect(layout.documentWidth).toBeLessThanOrEqual(viewport.width + 1);
    });

    test('a transient dashboard read failure keeps the creator on the dashboard', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      await configure(baseURL, { settings: { creatorReadUnavailable: true } });
      const sessionChecks = [];
      const reads = [];
      page.on('response', async response => {
        if (response.url().endsWith('/api/ref/sessionStatus')) sessionChecks.push(await response.json());
        if (response.url().endsWith('/api/ref/getData')) reads.push(response.status());
      });
      await page.addInitScript(() => sessionStorage.setItem('creatorId', 'synthetic-existing-state'));
      await page.goto('/referrals/dashboard');
      await expect(page.locator('#main-content').getByRole('alert')).toContainText('Server error');
      await expect(page).toHaveURL('/referrals/dashboard');
      const state = await page.evaluate(() => sessionStorage.getItem('creatorId'));
      await record(page, testInfo, `dashboard-outage-${size}`, { state, reads, sessionChecks, cookiePresent: (await context.cookies()).some(cookie => cookie.name === 'ref_session') });
      expect(state).toBe('synthetic-existing-state');
      expect((await context.cookies()).some(cookie => cookie.name === 'ref_session')).toBe(true);
      await configure(baseURL, { settings: { creatorReadUnavailable: false } });
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Creator' })).toBeVisible();
      expect(reads.filter(status => status === 500).length).toBeLessThan(4);
    });

    test('a transient account check keeps change password available for retry', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      await configure(baseURL, { settings: { creatorReadUnavailable: true } });
      await page.goto('/referrals/change-password');
      await expect(page.locator('#main-content').getByRole('alert')).toContainText('Server error');
      await expect(page).toHaveURL('/referrals/change-password');
      expect((await context.cookies()).some(cookie => cookie.name === 'ref_session')).toBe(true);
      await record(page, testInfo, `change-password-outage-${size}`);
      await configure(baseURL, { settings: { creatorReadUnavailable: false } });
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(page.getByLabel('Current Password', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save Password', exact: true })).toBeEnabled();
    });

    test('a failed logout does not pretend the session ended', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      await page.goto('/referrals/dashboard');
      await expect(page.getByRole('button', { name: 'Log Out', exact: true })).toBeVisible();
      await page.evaluate(() => sessionStorage.setItem('creatorId', 'synthetic-existing-state'));
      const outcomes = [];
      await page.route('**/api/ref/sessionStatus', route => route.fulfill({ status: 200, json: { ok: true, authenticated: false } }));
      for (const failure of ['http', 'network']) {
        await page.route('**/api/ref/logout', route => failure === 'http'
          ? route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic logout outage.' } })
          : route.abort('failed'));
        await page.getByRole('button', { name: 'Log Out', exact: true }).click();
        const alert = page.locator('#main-content').getByRole('alert');
        await expect(alert).toContainText(/sign out|try again/i);
        await expect(alert.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
        await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Creator' })).toBeVisible();
        await expect(page).toHaveURL('/referrals/dashboard');
        expect(await page.evaluate(() => sessionStorage.getItem('creatorId'))).toBe('synthetic-existing-state');
        expect((await context.cookies()).some(cookie => cookie.name === 'ref_session')).toBe(true);
        outcomes.push({ failure, retainedState: true });
        await page.unroute('**/api/ref/logout');
      }
      await page.unroute('**/api/ref/sessionStatus');
      await page.route('**/api/ref/logout', async route => {
        const response = await fixture.requestRoute(baseURL, '/api/ref/logout', {
          data: {}, headers: { cookie: await route.request().headerValue('cookie') || '' },
        });
        expect(response.status).toBe(200);
        await route.fulfill({
          status: 204,
          headers: { 'set-cookie': response.headers.getSetCookie().find(cookie => cookie.startsWith('ref_session=')) },
          body: '',
        });
      });
      await page.locator('#main-content').getByRole('alert').getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Referral Creator Login', exact: true })).toBeVisible();
      expect((await context.cookies()).some(cookie => cookie.name === 'ref_session')).toBe(false);
      expect(await page.evaluate(() => sessionStorage.getItem('creatorId'))).toBeNull();
      await record(page, testInfo, `logout-outage-${size}`, { outcomes, bodylessSuccess: true });
    });

    test('dashboard and password reset outcomes are announced', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      await page.goto('/referrals/dashboard');
      await page.route('**/api/ref/updateSplit', route => route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic save outage.' } }));
      await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
      await expect(page.locator('#main-content').getByRole('alert')).toHaveText('Synthetic save outage.');
      await page.unroute('**/api/ref/updateSplit');
      await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
      await expect(page.locator('#main-content').getByRole('status')).toContainText(/saved/i);
      await page.goto('/referrals/forgot');
      const email = page.getByLabel('Creator Email', { exact: true });
      await expect(email).toHaveAttribute('autocomplete', 'email');
      await email.fill('creator@fixture.invalid');
      await page.route('**/api/ref/forgot', route => route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic forgot outage.' } }));
      await page.getByRole('button', { name: 'Send Reset Link', exact: true }).click();
      await expect(page.locator('#main-content').getByRole('alert')).toHaveText('Synthetic forgot outage.');
      await expect(email).toHaveValue('creator@fixture.invalid');
      await page.unroute('**/api/ref/forgot');
      await page.getByRole('button', { name: 'Send Reset Link', exact: true }).click();
      await expect(page.locator('#main-content').getByRole('status')).toHaveText("If an account matches that email, we've sent a reset link. Check your inbox and spam folder.");
      await expect(email).toHaveValue('creator@fixture.invalid');
      await record(page, testInfo, `announced-outcomes-${size}`);
    });

    test('connected-account password errors follow the current password', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      await page.route('**/api/auth/identities?flow=referral', route => route.fulfill({ json: { ok: true, domainAccount: true, providers: ['email', 'google'], unlinkableProviders: ['email', 'google'] } }));
      await page.goto('/referrals/dashboard');
      const password = page.getByLabel('Current password', { exact: true });
      const confirm = page.getByRole('button', { name: 'Confirm identity', exact: true });
      const error = page.getByRole('status').filter({ hasText: 'Password is incorrect.' });
      const reply = { status: 401, json: { ok: false, error: 'Password is incorrect.', reason: 'password_incorrect' } };
      const held = await holdAccountReply(page, '/api/auth/reauth', reply);
      try {
        await password.fill('Earlier-wrong-password1!');
        await confirm.click();
        expect(await held.arrived).toMatchObject({ purpose: 'link_identity', password: 'Earlier-wrong-password1!' });
        await password.fill('Current-password2!');
        const response = page.waitForResponse('**/api/auth/reauth');
        await held.release();
        await (await response).finished();
        await expect(confirm).toBeEnabled();
        await page.waitForTimeout(250);
        await expect(error).toHaveCount(0);
      } finally { await held.release(); }
      await page.route('**/api/auth/reauth', route => route.fulfill(reply));
      await confirm.click();
      await expect(error).toBeVisible();
      await password.fill('Another-current-password3!');
      await expect(error).toHaveCount(0);
      await record(page, testInfo, `connected-password-errors-${size}`, { staleReplyShown: false, currentErrorClearedOnEdit: true });
    });

    test('connected-account security errors survive password edits', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      await page.route('**/api/auth/identities?flow=referral', route => route.fulfill({ json: { ok: true, domainAccount: true, providers: ['email', 'google'], unlinkableProviders: ['email', 'google'] } }));
      await page.goto('/referrals/dashboard');
      const password = page.getByLabel('Current password', { exact: true });
      const observed = [];
      for (const [status, message] of [
        [401, 'Sign in again before changing account security.'],
        [429, 'Too many attempts. Try again shortly.'],
        [503, 'Reauthentication is temporarily unavailable.'],
        [400, 'Reauthentication request is invalid.'],
      ]) {
        const held = await holdAccountReply(page, '/api/auth/reauth', { status, json: { ok: false, error: message } });
        try {
          await password.fill('Submitted-password1!');
          await page.getByRole('button', { name: 'Confirm identity', exact: true }).click();
          await held.arrived;
          await password.fill('Edited-before-reply2!');
          await held.release();
          const notice = page.getByRole('status').filter({ hasText: message });
          await expect(notice).toBeVisible();
          await password.fill('Edited-after-reply3!');
          await expect(notice).toBeVisible();
          observed.push({ status, message, retainedAfterEdit: true });
        } finally { await held.release(); }
      }
      await record(page, testInfo, `connected-security-errors-${size}`, { observed });
    });

    test('unlink password errors follow the current password without hiding operation errors', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      let unlinkPosts = 0;
      await page.route('**/api/auth/identities?flow=referral', route => route.fulfill({ json: { ok: true, domainAccount: true, providers: ['email', 'google'], unlinkableProviders: ['email', 'google'] } }));
      await page.goto('/referrals/dashboard');
      const password = page.getByLabel('Current password', { exact: true });
      const unlink = page.getByRole('button', { name: 'Unlink google', exact: true });
      const localError = page.getByRole('status').filter({ hasText: 'Enter your current password, then select Unlink.' });
      await unlink.click();
      await expect(localError).toBeVisible();
      await password.fill('Earlier-wrong-password1!');
      await expect(localError).toHaveCount(0);
      const held = await holdAccountReply(page, '/api/auth/reauth', { status: 401, json: { ok: false, error: 'Password is incorrect.', reason: 'password_incorrect' } });
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/identities' && request.method() === 'POST') unlinkPosts += 1; });
      try {
        await unlink.click();
        expect(await held.arrived).toMatchObject({ purpose: 'unlink_identity', provider: 'google' });
        await password.fill('Current-password2!');
        await held.release();
        await expect(unlink).toBeEnabled();
        await page.waitForTimeout(250);
        await expect(page.getByRole('status').filter({ hasText: 'Password is incorrect.' })).toHaveCount(0);
        expect(unlinkPosts).toBe(0);
      } finally { await held.release(); }
      await page.route('**/api/auth/reauth', route => route.fulfill({ json: { ok: true } }));
      const operation = await holdAccountReply(page, '/api/auth/identities', { status: 409, json: { ok: false, error: 'Synthetic unlink operation conflict.' } });
      try {
        await unlink.click();
        await operation.arrived;
        await password.fill('Edited-during-unlink3!');
        await operation.release();
        const error = page.getByRole('status').filter({ hasText: 'Synthetic unlink operation conflict.' });
        await expect(error).toBeVisible();
        await password.fill('Edited-after-unlink4!');
        await expect(error).toBeVisible();
        expect(unlinkPosts).toBe(1);
        await expect(page.getByText('Google: Linked', { exact: false })).toBeVisible();
      } finally { await operation.release(); }
      await record(page, testInfo, `unlink-password-errors-${size}`, { localErrorClearedOnEdit: true, stalePasswordErrorShown: false, unlinkPosts, operationErrorRetained: true });
    });

    for (const [label, reply, message] of [
      ['503', { status: 503, json: { ok: false, error: 'Reauthentication is temporarily unavailable.' } }, 'Reauthentication is temporarily unavailable.'],
      ['network', 'abort', 'Password update could not be completed. Please try again.'],
    ]) test(`change-password service errors survive password edits (${label})`, async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      await openForm(page, '/referrals/change-password', '/api/ref/getData');
      const current = page.getByLabel('Current Password', { exact: true });
      const password = page.getByLabel('New Password', { exact: true });
      const confirm = page.getByLabel('Confirm Password', { exact: true });
      await current.fill('Synthetic-password1!');
      await password.fill('Replacement-password2!');
      await confirm.fill('Replacement-password2!');
      let passwordUpdates = 0;
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/ref/hashPassword') passwordUpdates += 1; });
      const held = await holdAccountReply(page, '/api/auth/reauth', reply);
      try {
        await page.getByRole('button', { name: 'Save Password', exact: true }).click();
        expect(await held.arrived).toMatchObject({ flow: 'referral', purpose: 'change_password' });
        await current.fill('Edited-before-service-reply2!');
        await held.release();
        const alert = page.locator('#main-content').getByRole('alert').filter({ hasText: message });
        await expect(alert).toBeVisible();
        for (const [field, value] of [[current, 'Synthetic-password1!'], [password, 'Replacement-password3!'], [confirm, 'Replacement-password3!']]) {
          await field.fill(value);
          await expect(alert).toBeVisible();
        }
        await expect(page.getByRole('button', { name: 'Save Password', exact: true })).toBeEnabled();
        expect(passwordUpdates).toBe(0);
        await expect(page).toHaveURL(/\/referrals\/change-password$/);
        await record(page, testInfo, `change-password-service-error-${label}-${size}`, { retainedBeforeAndAfterReply: true, fieldsEditedAfterReply: ['current', 'new', 'confirm'], passwordUpdates });
      } finally { await held.release(); }
    });

    test('account forms ignore errors from earlier submissions', async ({ page, context, baseURL }, testInfo) => {
      const failAfterEdit = async (endpoint, message, buttonName, edit, label) => {
        let edited;
        const changed = new Promise(resolve => { edited = resolve; });
        await page.route(`**${endpoint}`, async route => {
          await new Promise(resolve => setTimeout(resolve, 800));
          await changed;
          await route.fulfill({ status: endpoint === '/api/ref/reset' ? 409 : 401, json: { ok: false, error: message, ...(endpoint === '/api/auth/reauth' ? { reason: 'password_incorrect' } : {}) } });
        });
        const requested = page.waitForRequest(`**${endpoint}`);
        const response = page.waitForResponse(`**${endpoint}`);
        response.catch(() => {});
        try {
          const button = page.getByRole('button', { name: buttonName, exact: true });
          await button.click();
          await requested;
          await edit();
          edited();
          const result = await response;
          await result.finished();
          await expect(button).toBeEnabled();
          await page.waitForTimeout(5000);
          const alert = page.locator('#main-content').getByRole('alert').filter({ hasText: message });
          await record(page, testInfo, `account-earlier-error-${label}-${size}`, { status: result.status(), matchingAlerts: await alert.count() });
          await expect(alert).toHaveCount(0);
        } finally {
          edited();
          await response.catch(() => {});
          await page.unroute(`**${endpoint}`);
        }
      };
      await openForm(page, '/referrals/login', '/api/ref/sessionStatus');
      const identifier = page.getByLabel('Referral code or login email', { exact: true });
      const password = page.getByLabel('Password', { exact: true });
      await identifier.fill('fixture-creator');
      await password.fill('Wrong-password1!');
      await page.route('**/api/ref/login', route => route.fulfill({ status: 401, json: { ok: false, error: 'Synthetic current login failure.' } }));
      await page.getByRole('button', { name: 'Login', exact: true }).click();
      const currentError = page.locator('#main-content').getByRole('alert').filter({ hasText: 'Synthetic current login failure.' });
      await expect(currentError).toBeVisible();
      await password.fill('Synthetic-password1!');
      await expect(currentError).toHaveCount(0);
      await page.unroute('**/api/ref/login');
      await failAfterEdit('/api/ref/login', 'Synthetic earlier login failure.', 'Login', async () => {
        await identifier.fill('edited-creator');
        await password.fill('Edited-password3!');
      }, 'login');

      await signIn(context, baseURL);
      await openForm(page, '/referrals/change-password', '/api/ref/getData');
      await page.getByLabel('Current Password', { exact: true }).fill('Wrong-password1!');
      await page.getByLabel('New Password', { exact: true }).fill('Replacement-password2!');
      await page.getByLabel('Confirm Password', { exact: true }).fill('Replacement-password2!');
      await failAfterEdit('/api/auth/reauth', 'Password is incorrect.', 'Save Password',
        () => page.getByLabel('Current Password', { exact: true }).fill('Synthetic-password1!'), 'change-password');

      await page.goto('/referrals/reset#token=' + 'a'.repeat(64));
      await page.getByLabel('New Password', { exact: true }).fill('Different-password3!');
      await page.getByLabel('Confirm Password', { exact: true }).fill('Different-password3!');
      await failAfterEdit('/api/ref/reset', 'This reset link was already used with a different password.', 'Update Password', async () => {
        await page.getByLabel('New Password', { exact: true }).fill('Replacement-password2!');
        await page.getByLabel('Confirm Password', { exact: true }).fill('Replacement-password2!');
      }, 'reset');
    });

    test('a recovery link the server rejects stays explained after password edits', async ({ page }, testInfo) => {
      for (const [status, message] of [[400, 'Invalid or expired reset link'], [401, 'This recovery session is invalid or expired. Request a new link.']]) {
        await page.goto('about:blank');
        await page.goto('/referrals/reset#token=' + 'a'.repeat(64));
        const next = page.getByLabel('New Password', { exact: true });
        const confirm = page.getByLabel('Confirm Password', { exact: true });
        await next.fill('Different-password3!');
        await confirm.fill('Different-password3!');
        let edited;
        const changed = new Promise(resolve => { edited = resolve; });
        await page.route('**/api/ref/reset', async route => {
          await changed;
          await route.fulfill({ status, json: { ok: false, error: message } });
        });
        const requested = page.waitForRequest('**/api/ref/reset');
        const response = page.waitForResponse('**/api/ref/reset');
        response.catch(() => {});
        try {
          await page.getByRole('button', { name: 'Update Password', exact: true }).click();
          await requested;
          await next.fill('Replacement-password2!');
          await confirm.fill('Replacement-password2!');
          edited();
          await (await response).finished();
          const alert = page.locator('#main-content').getByRole('alert').filter({ hasText: message });
          await expect(alert).toBeVisible();
          await next.fill('Another-password4!');
          await page.waitForTimeout(500);
          await expect(alert).toBeVisible();
          await record(page, testInfo, `reset-link-rejected-${status}-${size}`, { status, matchingAlerts: await alert.count() });
        } finally {
          edited();
          await response.catch(() => {});
          await page.unroute('**/api/ref/reset');
        }
      }
    });

    test("a late login doesn't pull the creator away from another portal page", async ({ page, context, baseURL }, testInfo) => {
      for (const stage of ['response', 'session', 'timer']) {
        await context.clearCookies();
        if (stage === 'timer') await page.clock.install();
        if (stage === 'session') await signIn(context, baseURL);
        else await openForm(page, '/referrals/login', '/api/ref/sessionStatus');
        if (stage === 'timer') await page.clock.pauseAt(new Date(Date.now() + 1000));
        const endpoint = stage === 'session' ? '/api/ref/sessionStatus' : '/api/ref/login';
        let respond;
        const held = new Promise(resolve => { respond = resolve; });
        await page.route(`**${endpoint}`, async route => { await held; await route.continue(); });
        const requested = page.waitForRequest(`**${endpoint}`);
        const completed = page.waitForResponse(`**${endpoint}`);
        completed.catch(() => {});
        try {
          if (stage === 'session') await page.goto('/referrals/login');
          else {
            await page.getByLabel('Referral code or login email', { exact: true }).fill('fixture-creator');
            await page.getByLabel('Password', { exact: true }).fill('Synthetic-password1!');
            if (stage === 'timer') respond();
            await page.getByRole('button', { name: 'Login', exact: true }).click();
          }
          await requested;
          if (stage === 'timer') await expect(page.locator('#main-content').getByRole('status')).toHaveText('Login successful.');
          await page.getByRole('button', { name: 'Forgot your password?', exact: true }).click();
          await expect(page.getByLabel('Creator Email', { exact: true })).toBeVisible();
          respond();
          const response = await completed;
          await response.finished();
          expect(response.status()).toBe(200);
          expect((await response.json())[stage === 'session' ? 'authenticated' : 'ok']).toBe(true);
          if (stage === 'timer') await page.clock.runFor(1600);
          else await page.waitForTimeout(1600);
          const cookiePresent = (await context.cookies()).some(cookie => cookie.name === 'ref_session');
          await record(page, testInfo, `late-login-${stage}-${size}`, { cookiePresent });
          await expect(page).toHaveURL(url => url.pathname === '/referrals/forgot');
          await expect(page.getByLabel('Creator Email', { exact: true })).toBeVisible();
          expect(cookiePresent).toBe(true);
        } finally {
          respond();
          await completed.catch(() => {});
          await page.unroute(`**${endpoint}`);
        }
      }
    });

    test('form errors stay next to their submit button until the creator acts', async ({ page, context, baseURL }, testInfo) => {
      const persistentError = async (message, buttonName, label) => {
        const alert = page.locator('#main-content').getByRole('alert').filter({ hasText: message });
        const button = page.getByRole('button', { name: buttonName, exact: true });
        await expect(alert).toHaveText(message);
        await expect(alert).toBeVisible();
        await page.waitForTimeout(5000);
        await expect(alert).toBeVisible();
        await alert.scrollIntoViewIfNeeded();
        const [errorBox, buttonBox] = await Promise.all([alert.boundingBox(), button.boundingBox()]);
        expect(errorBox).not.toBeNull();
        expect(buttonBox).not.toBeNull();
        const intersects = errorBox.x < buttonBox.x + buttonBox.width &&
          errorBox.x + errorBox.width > buttonBox.x &&
          errorBox.y < buttonBox.y + buttonBox.height &&
          errorBox.y + errorBox.height > buttonBox.y;
        expect(intersects).toBe(false);
        expect(errorBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height);
        await record(page, testInfo, `${label}-inline-error-${size}`, { message, errorBox, buttonBox, intersects });
        return alert;
      };

      await openForm(page, '/referrals/register', '/api/auth/identities');
      await fillRegistration(page);
      const confirm = page.getByLabel('Confirm Password', { exact: true });
      await confirm.fill('Different-password1!');
      await page.getByRole('button', { name: 'Register', exact: true }).click();
      const registrationError = await persistentError('Passwords do not match.', 'Register', 'registration');
      await confirm.fill('Synthetic-password1!');
      await expect(registrationError).toHaveCount(0);

      await signIn(context, baseURL);
      await page.goto('/referrals/dashboard');
      const commission = page.getByText('Commission (%)', { exact: true }).locator('..');
      const discount = page.getByText('Viewer Discount (%)', { exact: true }).locator('..');
      await page.route('**/api/ref/updateSplit', route => route.fulfill({ status: 409, json: { ok: false, error: 'Synthetic split conflict.' } }));
      await commission.getByRole('button', { name: '+', exact: true }).click();
      await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
      const splitError = await persistentError('Synthetic split conflict.', 'Save Settings', 'settings');
      await discount.getByRole('button', { name: '+', exact: true }).click();
      await expect(splitError).toHaveCount(0);
      await page.unroute('**/api/ref/updateSplit');

      await page.goto('/referrals/forgot');
      await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
      const email = page.getByLabel('Creator Email', { exact: true });
      await email.fill('creator@fixture.invalid');
      await page.route('**/api/ref/forgot', route => route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic forgot outage.' } }));
      await page.getByRole('button', { name: 'Send Reset Link', exact: true }).click();
      const forgotError = await persistentError('Synthetic forgot outage.', 'Send Reset Link', 'forgot');
      await email.fill('changed@fixture.invalid');
      await expect(forgotError).toHaveCount(0);
    });

    test('a double-clicked registration submits once and shows no stale error', async ({ page }, testInfo) => {
      let submitting = false;
      let validationRequests = 0;
      let registrationPosts = 0;
      await page.route('**/api/ref/validateReferral*', async route => {
        if (!submitting) {
          await route.fulfill({ status: 503, json: { ok: false, reason: 'unavailable' } });
          return;
        }
        validationRequests += 1;
        await new Promise(resolve => setTimeout(resolve, 800));
        await route.fulfill({ status: 200, json: { ok: false, reason: 'available', error: 'Not found' } });
      });
      await page.route('**/api/ref/register', route => {
        registrationPosts += 1;
        return route.fulfill({ status: 202, json: { ok: true, pendingVerification: true } });
      });
      await openForm(page, '/referrals/register', '/api/auth/identities');
      const backgroundCheck = page.waitForResponse('**/api/ref/validateReferral*');
      await fillRegistration(page);
      expect((await backgroundCheck).status()).toBe(503);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      submitting = true;
      await page.getByRole('button', { name: 'Register', exact: true }).dblclick();
      const notice = page.getByText('Check your email and use the confirmation link to finish creating your account.', { exact: true });
      await expect(notice).toBeVisible();
      await expect.poll(() => registrationPosts).toBe(validationRequests);
      expect(validationRequests).toBe(1);
      expect(registrationPosts).toBe(1);
      await expect(page.locator('#main-content').getByRole('alert')).toHaveCount(0);
      await record(page, testInfo, `serialized-registration-${size}`, { validationRequests, registrationPosts, notice: await notice.innerText() });
    });

    test('a newer toast keeps its own timeout after a slow save', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      const start = new Date();
      await page.clock.install({ time: start });
      await page.goto('/referrals/dashboard');
      await expect(page.getByText('Auto-updated', { exact: true })).toBeVisible();
      const commission = page.getByText('Commission (%)', { exact: true }).locator('..');
      await commission.getByRole('button', { name: '+', exact: true }).click();
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
      await page.clock.pauseAt(new Date(start.getTime() + 60 * 60 * 1000));
      await page.route('**/api/ref/updateSplit', async route => {
        await new Promise(resolve => setTimeout(resolve, 1200));
        await route.fallback();
      });
      await page.getByRole('button', { name: 'Copy', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Referral link copied!' })).toBeVisible();
      const copiedAt = await page.evaluate(() => Date.now());
      await page.clock.runFor(1500);
      await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
      const saved = page.getByRole('status').filter({ hasText: 'Saved successfully!' });
      await expect(saved).toBeVisible();
      const savedAt = await page.evaluate(() => Date.now());
      expect(savedAt - copiedAt).toBe(1500);
      await page.clock.runFor(1500);
      await expect(saved).toBeVisible();
      await record(page, testInfo, `newer-toast-${size}`, { message: await saved.innerText(), copiedAt, savedAt, checkedAt: await page.evaluate(() => Date.now()) });
      await page.clock.runFor(1100);
      await expect(saved).toHaveCount(0);
    });

    test('edited forms ignore errors from earlier submissions', async ({ page, context, baseURL }, testInfo) => {
      const failAfterEdit = async (path, message, buttonName, edit, label) => {
        await page.route(`**${path}`, async route => {
          await new Promise(resolve => setTimeout(resolve, 800));
          await route.fulfill({ status: 503, json: { ok: false, error: message } });
        });
        const request = page.waitForRequest(request => new URL(request.url()).pathname === path && request.method() === 'POST');
        const response = page.waitForResponse(response => new URL(response.url()).pathname === path);
        const button = page.getByRole('button', { name: buttonName, exact: true });
        await button.click();
        await request;
        await edit();
        const result = await response;
        await result.finished();
        expect(result.status()).toBe(503);
        await expect(button).toBeEnabled();
        const alert = page.locator('#main-content').getByRole('alert').filter({ hasText: message });
        await expect(alert).toHaveCount(0);
        await record(page, testInfo, `${label}-edited-during-submit-${size}`, { status: result.status(), message, matchingAlerts: await alert.count() });
      };

      let checkingSubmission = false;
      let editedCheckFinished;
      const editedCheck = new Promise(resolve => { editedCheckFinished = resolve; });
      await page.route('**/api/ref/validateReferral*', async route => {
        const code = new URL(route.request().url()).searchParams.get('code');
        if (code === 'edited-creator') {
          await route.fulfill({ status: 200, json: { ok: false, reason: 'available' } });
          editedCheckFinished();
        } else if (checkingSubmission) {
          await new Promise(resolve => setTimeout(resolve, 800));
          await editedCheck;
          await route.fulfill({ status: 200, json: { ok: false, reason: 'reserved' } });
        } else {
          await route.fulfill({ status: 503, json: { ok: false, reason: 'unavailable' } });
        }
      });
      await openForm(page, '/referrals/register', '/api/auth/identities');
      const backgroundCheck = page.waitForResponse('**/api/ref/validateReferral*');
      await fillRegistration(page);
      await (await backgroundCheck).finished();
      checkingSubmission = true;
      const checking = page.waitForRequest('**/api/ref/validateReferral*');
      const checked = page.waitForResponse(response => new URL(response.url()).searchParams.get('code') === 'new-creator');
      await page.getByRole('button', { name: 'Register', exact: true }).click();
      await checking;
      await page.getByLabel('Referral Code', { exact: true }).fill('edited-creator');
      await (await checked).finished();
      await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeEnabled();
      await expect(page.getByText('Referral code is available.', { exact: true })).toBeVisible();
      await expect(page.getByText('This referral code is already taken.', { exact: true })).toHaveCount(0);
      await expect(page.locator('#main-content').getByRole('alert')).toHaveCount(0);
      await record(page, testInfo, `referral-code-edited-during-submit-${size}`, { editedCode: 'edited-creator', previousCodeAvailability: 'reserved' });
      await page.unroute('**/api/ref/validateReferral*');

      await openForm(page, '/referrals/register', '/api/auth/identities');
      await fillRegistration(page);
      await failAfterEdit('/api/ref/register', 'Synthetic earlier registration failure.', 'Register',
        () => page.getByLabel('Discord Username', { exact: true }).fill('edited-user'), 'registration');

      await page.goto('/referrals/forgot');
      await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
      const email = page.getByLabel('Creator Email', { exact: true });
      await email.fill('creator@fixture.invalid');
      await failAfterEdit('/api/ref/forgot', 'Synthetic earlier forgot failure.', 'Send Reset Link',
        () => email.fill('edited@fixture.invalid'), 'forgot');

      await signIn(context, baseURL);
      await page.goto('/referrals/dashboard');
      const commission = page.getByText('Commission (%)', { exact: true }).locator('..');
      const discount = page.getByText('Viewer Discount (%)', { exact: true }).locator('..');
      await commission.getByRole('button', { name: '+', exact: true }).click();
      await failAfterEdit('/api/ref/updateSplit', 'Synthetic earlier split failure.', 'Save Settings',
        () => discount.getByRole('button', { name: '+', exact: true }).click(), 'settings');
    });

    test('decimal percentage adjustment remains acceptable to the API', async ({ page, context, baseURL }, testInfo) => {
      await configure(baseURL, { documents: [{ _id: 'tooling-referral', currentCommissionPercent: 1.1, currentDiscountPercent: 0 }] });
      await signIn(context, baseURL);
      await page.goto('/referrals/dashboard');
      const controls = page.getByText('Commission (%)', { exact: true }).locator('..');
      await controls.getByRole('button', { name: '–', exact: true }).click();
      const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/ref/updateSplit'));
      await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
      const response = await responsePromise;
      const body = await response.json();
      await record(page, testInfo, `decimal-split-${size}`, { request: response.request().postDataJSON(), status: response.status(), body, shown: await controls.innerText() });
      expect(response.status()).toBe(200);
    });

    test('locked creator percentages agree with the stored and checkout values', async ({ page, context, baseURL }, testInfo) => {
      await configure(baseURL, { documents: [{ _id: 'tooling-referral', successfulReferrals: 2 }] });
      await signIn(context, baseURL);
      const dataPromise = page.waitForResponse(r => r.url().endsWith('/api/ref/getData'));
      await page.goto('/referrals/dashboard');
      const data = await (await dataPromise).json();
      await expect(page.getByRole('button', { name: 'Save Settings', exact: true })).toBeDisabled();
      const checkout = await fixture.requestRoute(baseURL, '/api/ref/validateReferral?code=fixture-creator');
      await record(page, testInfo, `locked-split-${size}`, { data, checkout: await checkout.json() });
      await expect(page.getByText('Commission (%)', { exact: true }).locator('..')).toContainText('7.25%', { timeout: 1000 });
      await expect(page.getByText('Viewer Discount (%)', { exact: true }).locator('..')).toContainText('2.75%', { timeout: 1000 });
    });

    test('payment dialog receives keyboard focus', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      await page.goto('/referrals/dashboard');
      await page.evaluate(() => document.documentElement.classList.add('low-performance-mode'));
      await page.getByRole('button', { name: 'View my payment logs', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
      const opened = await page.evaluate(() => ({ focused: document.activeElement?.textContent, inside: Boolean(document.activeElement?.closest('[role=dialog]')) }));
      await page.keyboard.press('Tab');
      const tabbed = await page.evaluate(() => ({ focused: document.activeElement?.textContent, inside: Boolean(document.activeElement?.closest('[role=dialog]')) }));
      await page.keyboard.press('Shift+Tab');
      const reverseTabbed = await page.evaluate(() => Boolean(document.activeElement?.closest('[role=dialog]')));
      const dialog = await page.getByRole('dialog').evaluate(el => {
        const b = el.getBoundingClientRect();
        const ancestors = [];
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          const css = getComputedStyle(parent);
          if (css.contain !== 'none' || css.transform !== 'none' || css.filter !== 'none') ancestors.push({ tag: parent.tagName, className: parent.className, contain: css.contain, transform: css.transform, filter: css.filter });
        }
        return { top: b.top, bottom: b.bottom, viewport: innerHeight, scrollY, scrollHeight: el.scrollHeight, height: el.clientHeight, htmlClass: document.documentElement.className, ancestors };
      });
      await page.evaluate(() => document.documentElement.classList.remove('low-performance-mode'));
      const withoutContainment = await page.getByRole('dialog').evaluate(el => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; });
      if (dialog.htmlClass.includes('low-performance-mode')) await page.evaluate(() => document.documentElement.classList.add('low-performance-mode'));
      await record(page, testInfo, `payment-dialog-${size}`, { opened, tabbed, reverseTabbed, dialog, withoutContainment }, false);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'View my payment logs', exact: true })).toBeFocused();
      expect(opened.inside).toBe(true);
      expect(tabbed.inside).toBe(true);
      expect(reverseTabbed).toBe(true);
      expect(dialog.ancestors).toEqual([]);
      expect(dialog.top).toBeGreaterThanOrEqual(0);
      expect(dialog.bottom).toBeLessThanOrEqual(viewport.height);
      expect(withoutContainment.top).toBeGreaterThanOrEqual(0);
      expect(withoutContainment.bottom).toBeLessThanOrEqual(viewport.height);
      await page.getByRole('button', { name: 'View my payment logs', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Close payment logs', exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Close payment logs', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'View my payment logs', exact: true })).toBeFocused();
    });

    test('registration with a new normalized code verifies into a working dashboard', async ({ page, baseURL }, testInfo) => {
      await openForm(page, '/referrals/register', '/api/auth/identities');
      const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/ref/register') && r.request().method() === 'POST');
      await submitRegistration(page, 'new@fixture.invalid', ' New-Creator ');
      const response = await responsePromise;
      await record(page, testInfo, `register-${size}`, { status: response.status(), body: await response.json() });
      expect(response.status()).toBe(202);
      await expect(page.getByText('Check your email and use the confirmation link to finish creating your account.')).toBeVisible();
      const state = await (await configure(baseURL, {})).json();
      const dispatch = state.requests.find(request => request.path.endsWith('/roo_enqueue_referral_email_mutation') && request.body.p_dispatch_kind === 'registration_verification');
      await page.goto('/referrals/verify#token=' + dispatch.body.p_delivery_payload.token);
      await expect(page.getByRole('status')).toContainText('Email confirmed');
      await page.getByRole('button', { name: 'Open dashboard' }).click();
      await expect(page.getByRole('heading', { name: 'Welcome, synthetic-user' })).toBeVisible();
      await expect(page.getByText('new-creator', { exact: true })).toBeVisible();
      await record(page, testInfo, `registered-dashboard-${size}`);
    });

    test('a pending code is not advertised as available to another creator', async ({ page }, testInfo) => {
      await openForm(page, '/referrals/register', '/api/auth/identities');
      await page.getByLabel('Referral Code', { exact: true }).fill('pending-code');
      await expect(page.getByText('Referral code is available.', { exact: true })).toBeVisible();
      const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/ref/register') && r.request().method() === 'POST');
      await submitRegistration(page, 'another@fixture.invalid', 'pending-code');
      const response = await responsePromise;
      await record(page, testInfo, `pending-code-${size}`, { status: response.status(), body: await response.json() });
      expect(response.status()).toBe(409);
      await expect(page.getByText('Referral code is available.', { exact: true })).toHaveCount(0, { timeout: 1000 });
    });

    test('unauthorized account reads route by status even without JSON', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      await page.route('**/api/ref/sessionStatus', route => route.fulfill({ status: 200, json: { ok: true, authenticated: false } }));
      const outcomes = [];
      for (const path of ['/referrals/dashboard', '/referrals/change-password']) {
        for (const body of ['', '<h1>Unauthorized</h1>']) {
          await page.route('**/api/ref/getData', route => route.fulfill({ status: 401, contentType: 'text/html', body }));
          await page.goto(path);
          await expect(page.getByRole('heading', { name: 'Referral Creator Login', exact: true })).toBeVisible();
          expect(await page.evaluate(() => sessionStorage.getItem('creatorId'))).toBeNull();
          outcomes.push({ path, body, redirected: true });
          await page.unroute('**/api/ref/getData');
        }
      }
      await record(page, testInfo, `unauthorized-bodies-${size}`, { outcomes });
    });

    test('creator percentages are correct from the first render and paint', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      await page.addInitScript(() => {
        window.creatorRenders = [];
        window.creatorPaints = [];
        const snapshot = () => {
          const paragraphs = [...document.querySelectorAll('p')];
          const commission = paragraphs.find(el => el.textContent === 'Commission (%)')?.parentElement.querySelector('span')?.textContent;
          const discount = paragraphs.find(el => el.textContent === 'Viewer Discount (%)')?.parentElement.querySelector('span')?.textContent;
          const total = [...document.querySelectorAll('div')].find(el => el.childElementCount === 0 && el.textContent.startsWith('Total: '))?.textContent;
          return commission && discount && total ? { commission, discount, total: total.trim() } : null;
        };
        new MutationObserver(() => {
          const values = snapshot();
          if (values && window.creatorRenders.length < 20) window.creatorRenders.push(values);
        }).observe(document, { childList: true, subtree: true, characterData: true });
        const paint = () => {
          const values = snapshot();
          if (values) window.creatorPaints.push(values);
          if (window.creatorPaints.length < 5) requestAnimationFrame(paint);
        };
        requestAnimationFrame(paint);
      });
      await page.goto('/referrals/dashboard');
      await expect.poll(() => page.evaluate(() => window.creatorPaints.length)).toBe(5);
      const frames = await page.evaluate(() => ({ renders: window.creatorRenders, paints: window.creatorPaints }));
      await record(page, testInfo, `initial-percentages-${size}`, frames);
      const expected = { commission: '7.25%', discount: '2.75%', total: 'Total: 10% / Max 15%' };
      expect(frames.renders[0]).toEqual(expected);
      for (const frame of frames.paints) expect(frame).toEqual(expected);
    });

    test('an unauthorized dashboard read returns to login', async ({ page }, testInfo) => {
      await page.goto('/referrals/dashboard');
      await expect(page.getByRole('heading', { name: 'Referral Creator Login', exact: true })).toBeVisible();
      await record(page, testInfo, `anonymous-${size}`);
    });

    test('login errors retain the identifier and enable retry', async ({ page }, testInfo) => {
      await openForm(page, '/referrals/login', '/api/ref/sessionStatus');
      await page.getByLabel('Referral code or login email', { exact: true }).fill('fixture-creator');
      await page.getByLabel('Password', { exact: true }).fill('wrong-password');
      await expect(page.getByLabel('Referral code or login email', { exact: true })).toHaveValue('fixture-creator');
      await expect(page.getByLabel('Password', { exact: true })).toHaveValue('wrong-password');
      const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/ref/login') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Login', exact: true }).click();
      const response = await responsePromise;
      await expect(page.locator('form').getByRole('alert')).toContainText('Invalid login details');
      await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeEnabled();
      await expect(page.getByLabel('Referral code or login email', { exact: true })).toHaveValue('fixture-creator');
      await expect(page.getByLabel('Password', { exact: true })).toHaveValue('wrong-password');
      await record(page, testInfo, `login-invalid-${size}`, { status: response.status(), body: await response.json() });
      expect(response.status()).toBe(401);
    });

    test('a transient verification error retains its token for reload', async ({ page }, testInfo) => {
      await page.route('**/api/ref/verifyRegistration', route => route.fulfill({ status: 503, json: { ok: false, error: 'Account confirmation is temporarily unavailable. Please try again.' } }));
      await page.goto('/referrals/verify#token=' + 'b'.repeat(43));
      await expect(page.getByRole('status')).toContainText('temporarily unavailable');
      await record(page, testInfo, `verify-outage-${size}`, { storageTokenKept: await page.evaluate(() => Boolean(sessionStorage.getItem('referral_registration_verification'))) });
      expect(await page.evaluate(() => Boolean(sessionStorage.getItem('referral_registration_verification')))).toBe(true);
      await page.unroute('**/api/ref/verifyRegistration');
      await page.reload();
      await expect(page.getByRole('status')).toContainText('Email confirmed');
    });

    test('confirmation succeeds and reused links are rejected', async ({ page }, testInfo) => {
      await page.goto('/referrals/verify#token=' + 'b'.repeat(43));
      await expect(page.getByRole('status')).toContainText('Email confirmed');
      expect(new URL(page.url()).hash).toBe('');
      expect(await page.evaluate(() => sessionStorage.getItem('referral_registration_verification'))).toBeNull();
      await page.getByRole('button', { name: 'Open dashboard' }).click();
      await expect(page.getByRole('heading', { name: 'Welcome, Pending Creator' })).toBeVisible();
      await record(page, testInfo, `verified-dashboard-${size}`);
      await page.goto('/referrals/verify#token=' + 'b'.repeat(43));
      await expect(page.getByRole('status')).toContainText('Invalid or expired confirmation link');
    });

    for (const outage of ['linkUnavailable', 'sessionInstallUnavailable']) {
      test(`a confirmation session outage does not leave a consumed link asking for retry (${outage})`, async ({ page, context, baseURL }, testInfo) => {
        await configure(baseURL, { settings: { [outage]: true } });
        await signIn(context, baseURL);
        const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/ref/verifyRegistration'));
        await page.goto('/referrals/verify#token=' + 'b'.repeat(43));
        const response = await responsePromise;
        const body = await response.json();
        const state = await (await configure(baseURL, {})).json();
        const source = state.documents.find(row => row._id === 'portal-pending');
        await record(page, testInfo, `verify-consumed-${outage}-${size}`, { status: response.status(), body, registrationStatus: source.registrationStatus, tokenRetained: Boolean(source.registrationVerificationTokenHash) });
        expect(response.status()).toBe(200);
        expect(body).toEqual({ ok: true, requiresLogin: true });
        expect(source.registrationStatus).toBe('active');
        expect(source.registrationVerificationTokenHash).toBeUndefined();
        await expect(page.getByRole('status')).toContainText('Your account is confirmed');
        expect(await page.evaluate(() => sessionStorage.getItem('referral_registration_verification'))).toBeNull();
        await configure(baseURL, { settings: { [outage]: false } });
        await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/referrals/login?notice=email-confirmed');
        await page.getByRole('link', { name: 'Sign in', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Referral Creator Login', exact: true })).toBeVisible();
        await expect(page.locator('form').getByRole('status')).toContainText('Email confirmed');
        await page.getByLabel('Referral code or login email', { exact: true }).fill('pending-code');
        await page.getByLabel('Password', { exact: true }).fill('Synthetic-password1!');
        await page.getByRole('button', { name: 'Login', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Welcome, Pending Creator' })).toBeVisible();
        await page.goto('/referrals/verify#token=' + 'b'.repeat(43));
        await expect(page.getByRole('status')).toContainText('Invalid or expired confirmation link');
      });
    }

    test('legacy reset changes the password and retains safe replay behavior', async ({ page, baseURL }, testInfo) => {
      await page.goto('/referrals/reset#token=' + 'a'.repeat(64));
      await page.getByLabel('New Password', { exact: true }).fill('Replacement-password2!');
      await page.getByLabel('Confirm Password', { exact: true }).fill('Replacement-password2!');
      const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/ref/reset'));
      await page.getByRole('button', { name: 'Update Password', exact: true }).click();
      const response = await responsePromise;
      await expect(page.locator('form').getByRole('status')).toContainText('Password updated');
      const oldLogin = await fixture.requestRoute(baseURL, '/api/ref/login', { data: { code: 'fixture-creator', password: 'Synthetic-password1!' } });
      const newLogin = await fixture.requestRoute(baseURL, '/api/ref/login', { data: { code: 'fixture-creator', password: 'Replacement-password2!' } });
      const replay = await fixture.requestRoute(baseURL, '/api/ref/reset', { data: { token: 'a'.repeat(64), password: 'Replacement-password2!' } });
      const different = await fixture.requestRoute(baseURL, '/api/ref/reset', { data: { token: 'a'.repeat(64), password: 'Different-password3!' } });
      await expect(page.getByRole('heading', { name: 'Referral Creator Login', exact: true })).toBeVisible();
      await record(page, testInfo, `reset-${size}`, { status: response.status(), oldLogin: oldLogin.status, newLogin: newLogin.status, replay: replay.status, different: different.status, tokenCleared: await page.evaluate(() => sessionStorage.getItem('referral_reset_token') === null) });
      expect(response.status()).toBe(200);
      expect(oldLogin.status).toBe(401);
      expect(newLogin.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(different.status).toBe(409);
    });

    test('successful login and logout preserve the remembered identifier', async ({ page, context }, testInfo) => {
      await openForm(page, '/referrals/login', '/api/ref/sessionStatus');
      await page.getByLabel('Referral code or login email', { exact: true }).fill(' FIXTURE-CREATOR ');
      await page.getByLabel('Password', { exact: true }).fill('Synthetic-password1!');
      await page.getByText('Remember me', { exact: true }).click();
      await expect(page.getByLabel('Referral code or login email', { exact: true })).toHaveValue('FIXTURE-CREATOR');
      await expect(page.getByLabel('Password', { exact: true })).toHaveValue('Synthetic-password1!');
      await expect(page.getByLabel('Remember me', { exact: true })).toBeChecked();
      const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/ref/login'));
      await page.getByRole('button', { name: 'Login', exact: true }).click();
      const response = await responsePromise;
      await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Creator' })).toBeVisible();
      const before = (await context.cookies()).find(cookie => cookie.name === 'ref_session');
      await page.getByRole('button', { name: 'Log Out', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Referral Creator Login', exact: true })).toBeVisible();
      await expect(page.getByLabel('Referral code or login email', { exact: true })).toHaveValue('fixture-creator');
      await expect(page.getByLabel('Remember me', { exact: true })).toBeChecked();
      await record(page, testInfo, `login-logout-${size}`, { loginStatus: response.status(), sessionExpiresIn: Math.round(before.expires - Date.now() / 1000), cookieCleared: !(await context.cookies()).some(cookie => cookie.name === 'ref_session') });
      expect(before.httpOnly).toBe(true);
      expect(before.expires - Date.now() / 1000).toBeGreaterThan(29 * 86400);
      expect((await context.cookies()).some(cookie => cookie.name === 'ref_session')).toBe(false);
    });

    test('login 4xx, 5xx and network errors leave the form usable', async ({ page }, testInfo) => {
      await openForm(page, '/referrals/login', '/api/ref/sessionStatus');
      await page.getByLabel('Referral code or login email', { exact: true }).fill('fixture-creator');
      await page.getByLabel('Password', { exact: true }).fill('Synthetic-password1!');
      const outcomes = [];
      for (const status of [400, 429, 503, 0]) {
        await expect(page.getByLabel('Referral code or login email', { exact: true })).toHaveValue('fixture-creator');
        await expect(page.getByLabel('Password', { exact: true })).toHaveValue('Synthetic-password1!');
        await page.route('**/api/ref/login', route => status ? route.fulfill({ status, json: { ok: false, error: `Synthetic ${status} login failure.` } }) : route.abort('failed'));
        await page.getByRole('button', { name: 'Login', exact: true }).click();
        await expect(page.locator('form').getByRole('alert')).toContainText(status ? `Synthetic ${status}` : 'Login could not be completed');
        await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeEnabled();
        await expect(page.getByLabel('Referral code or login email', { exact: true })).toHaveValue('fixture-creator');
        await expect(page.getByLabel('Password', { exact: true })).toHaveValue('Synthetic-password1!');
        outcomes.push({ status, message: await page.locator('form').getByRole('alert').innerText() });
        await page.unroute('**/api/ref/login');
      }
      await record(page, testInfo, `login-errors-${size}`, { outcomes });
    });

    test('unchecked remember me remains unchecked after normal logout', async ({ page, context }, testInfo) => {
      await openForm(page, '/referrals/login', '/api/ref/sessionStatus');
      const identifier = page.getByLabel('Referral code or login email', { exact: true });
      const remember = page.getByLabel('Remember me', { exact: true });
      await identifier.fill('fixture-creator');
      await page.getByLabel('Password', { exact: true }).fill('Synthetic-password1!');
      await expect(identifier).toHaveValue('fixture-creator');
      await expect(page.getByLabel('Password', { exact: true })).toHaveValue('Synthetic-password1!');
      await expect(remember).not.toBeChecked();
      const loginPromise = page.waitForResponse(response => response.url().endsWith('/api/ref/login') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Login', exact: true }).click();
      const login = await loginPromise;
      const request = login.request().postDataJSON();
      expect(request.rememberMe).toBe(false);
      expect(login.status()).toBe(200);
      await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Creator' })).toBeVisible();
      const cookie = (await context.cookies()).find(value => value.name === 'ref_session');
      const expiresIn = Math.round(cookie.expires - Date.now() / 1000);
      expect(expiresIn).toBeGreaterThan(43100);
      expect(expiresIn).toBeLessThanOrEqual(43200);
      const logoutPromise = page.waitForResponse(response => response.url().endsWith('/api/ref/logout'));
      const sessionPromise = page.waitForResponse(response => response.url().endsWith('/api/ref/sessionStatus'));
      await page.getByRole('button', { name: 'Log Out', exact: true }).click();
      const logout = await logoutPromise;
      const session = await (await sessionPromise).json();
      await expect(page.getByRole('heading', { name: 'Referral Creator Login', exact: true })).toBeVisible();
      await expect(identifier).toHaveValue('fixture-creator');
      const remembered = await remember.isChecked();
      const savedCode = await page.evaluate(() => sessionStorage.getItem('refLoginCode'));
      const cookieCleared = !(await context.cookies()).some(value => value.name === 'ref_session');
      await record(page, testInfo, `remember-unchecked-${size}`, {
        loginStatus: login.status(), request: { code: request.code, rememberMe: request.rememberMe },
        sessionExpiresIn: expiresIn, logoutStatus: logout.status(), session, cookieCleared,
        savedCode, nextRememberMe: remembered, expectedRememberMe: false,
      });
      expect(logout.status()).toBe(200);
      expect(session.authenticated).toBe(false);
      expect(cookieCleared).toBe(true);
      await expect(remember).not.toBeChecked({ timeout: 1000 });
      await page.getByLabel('Password', { exact: true }).fill('Synthetic-password1!');
      const secondLoginPromise = page.waitForResponse(response => response.url().endsWith('/api/ref/login') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Login', exact: true }).click();
      const secondLogin = await secondLoginPromise;
      expect(secondLogin.request().postDataJSON().rememberMe).toBe(false);
      expect(secondLogin.status()).toBe(200);
      await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Creator' })).toBeVisible();
      const secondCookie = (await context.cookies()).find(value => value.name === 'ref_session');
      const secondExpiresIn = Math.round(secondCookie.expires - Date.now() / 1000);
      expect(secondExpiresIn).toBeGreaterThan(43100);
      expect(secondExpiresIn).toBeLessThanOrEqual(43200);
      await record(page, testInfo, `remember-second-login-${size}`, { rememberMe: secondLogin.request().postDataJSON().rememberMe, sessionExpiresIn: secondExpiresIn });
    });

    test('overpaid dashboard agrees with the actual payout API', async ({ page, context, baseURL }, testInfo) => {
      await configure(baseURL, { documents: [{
        _id: 'tooling-referral', xocPayments: [{ amount: 30, paidOn: '2026-10-10T00:00:00Z' }], vertexPayments: [],
      }] });
      await signIn(context, baseURL);
      const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/ref/payouts'));
      await page.goto('/referrals/dashboard');
      const response = await responsePromise;
      const payout = await response.json();
      expect(response.status()).toBe(200);
      expect(payout.earnings.total).toBe(21.5);
      expect(payout.payments.total).toBe(30);
      expect(payout.owed.total).toBe(0);
      expect(payout.overpaid.total).toBe(8.5);
      for (const [label, value] of [['Total earned', '$21.50'], ['Total paid', '$30.00'], ['Remaining owed', '$0.00']]) {
        await expect(page.getByText(label, { exact: true }).locator('..')).toContainText(value);
      }
      await expect(page.getByText('Paid ahead by $8.50.', { exact: true })).toBeVisible();
      await record(page, testInfo, `overpaid-${size}`, { status: response.status(), payout });
    });

    test('change password UI validation and mocked API errors retain usable controls', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      const calls = [];
      let reauthCase = { status: 200, json: { ok: true } };
      let hashCase = { status: 200, json: { ok: true } };
      let release;
      let held;
      await page.route('**/api/auth/reauth', async route => {
        const body = route.request().postDataJSON();
        calls.push({ route: 'reauth', flow: body.flow, purpose: body.purpose, passwordMatches: body.password === 'Synthetic-password1!', status: reauthCase.status });
        if (held) await held;
        if (reauthCase.status) await route.fulfill(reauthCase); else await route.abort('failed');
      });
      await page.route('**/api/ref/hashPassword', async route => {
        calls.push({ route: 'hashPassword', passwordMatches: route.request().postDataJSON().password === 'Replacement-password2!', status: hashCase.status });
        if (hashCase.status) await route.fulfill(hashCase); else await route.abort('failed');
      });
      const dataPromise = page.waitForResponse(response => response.url().endsWith('/api/ref/getData'));
      await openForm(page, '/referrals/change-password', '/api/ref/getData');
      const data = await (await dataPromise).json();
      expect(data.ok).toBe(true);
      expect(data.referral._id).toBe('tooling-referral');
      const current = page.getByLabel('Current Password', { exact: true });
      const password = page.getByLabel('New Password', { exact: true });
      const confirm = page.getByLabel('Confirm Password', { exact: true });
      const save = page.getByRole('button', { name: 'Save Password', exact: true });
      const alert = page.locator('#main-content').getByRole('alert');
      const status = page.locator('#main-content').getByRole('status');
      const outcomes = [];
      await expect(current).toBeVisible();
      await expect(password).toHaveAttribute('aria-describedby', 'ref-change-password-requirement');
      await expect(page.getByRole('button', { name: 'Back to Dashboard', exact: true })).toBeVisible();
      await save.click();
      await expect(alert).toContainText('Fill in all three fields.');
      outcomes.push({ input: 'empty', message: await alert.innerText() });
      await current.fill('Synthetic-password1!');
      await password.fill('Replacement-password2!');
      await confirm.fill('Different-password3!');
      await save.click();
      await expect(alert).toContainText('Passwords do not match.');
      await expect(password).toHaveValue('Replacement-password2!');
      await expect(confirm).toHaveValue('Different-password3!');
      outcomes.push({ input: 'mismatch', message: await alert.innerText() });
      for (const value of ['short', '🙂'.repeat(19)]) {
        await password.fill(value);
        await confirm.fill(value);
        await save.click();
        await expect(alert).toContainText('Use at least 10 characters and at most 72 UTF-8 bytes.');
        await expect(password).toHaveValue(value);
        await expect(confirm).toHaveValue(value);
        await expect(save).toBeEnabled();
        outcomes.push({ input: value === 'short' ? 'short' : '76 UTF-8 bytes', message: await alert.innerText() });
      }
      expect(calls).toHaveLength(0);
      await password.fill('Replacement-password2!');
      await confirm.fill('Replacement-password2!');
      const retained = async () => {
        await expect(current).toHaveValue('Synthetic-password1!');
        await expect(password).toHaveValue('Replacement-password2!');
        await expect(confirm).toHaveValue('Replacement-password2!');
        await expect(save).toBeEnabled();
      };
      for (const code of [403, 503, 0]) {
        reauthCase = { status: code, json: { ok: false, error: `Synthetic ${code} reauth failure.` } };
        const previousHashCalls = calls.filter(call => call.route === 'hashPassword').length;
        await save.click();
        await expect(alert).toContainText(code ? `Synthetic ${code} reauth failure.` : 'Password update could not be completed. Please try again.');
        await retained();
        expect(calls.filter(call => call.route === 'hashPassword')).toHaveLength(previousHashCalls);
        outcomes.push({ route: 'reauth', status: code, message: await alert.innerText() });
      }
      reauthCase = { status: 503, json: { ok: false, error: 'Synthetic held reauth outage.' } };
      held = new Promise(resolve => { release = resolve; });
      try {
        const requested = page.waitForRequest('**/api/auth/reauth');
        await save.click();
        await requested;
        await expect(page.getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
        await record(page, testInfo, `change-password-held-${size}`, { branchCoverage: 'UI only; reauth and hashPassword mocked locally', pendingRequest: true });
      } finally {
        release();
        held = undefined;
      }
      await expect(alert).toContainText('Synthetic held reauth outage.');
      await retained();
      outcomes.push({ route: 'held-reauth', status: 503, message: await alert.innerText(), busyCleared: true });
      reauthCase = { status: 200, json: { ok: true } };
      for (const code of [400, 409, 503, 0]) {
        hashCase = { status: code, json: { ok: false, error: `Synthetic ${code} password failure.` } };
        await save.click();
        await expect(alert).toContainText(code ? `Synthetic ${code} password failure.` : 'Password update could not be completed. Please try again.');
        await retained();
        outcomes.push({ route: 'hashPassword', status: code, message: await alert.innerText() });
      }
      hashCase = { status: 202, json: { ok: true, status: 'pending', message: 'Your password change is saving. It will finish in a moment.' } };
      await save.click();
      await expect(status).toContainText('Your password change is saving. It will finish in a moment.');
      await retained();
      outcomes.push({ route: 'hashPassword', status: 202, message: await status.innerText() });
      expect(calls.every(call => call.passwordMatches)).toBe(true);
      expect(calls.filter(call => call.route === 'reauth').every(call => call.flow === 'referral' && call.purpose === 'change_password')).toBe(true);
      await record(page, testInfo, `change-password-errors-${size}`, { branchCoverage: 'UI only; real getData, reauth and hashPassword mocked locally', data, calls, outcomes });
      await page.getByRole('button', { name: 'Back to Dashboard', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Creator' })).toBeVisible();
    });

    test('payout failures do not sign out or show invented balances', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      await configure(baseURL, { settings: { earningsUnavailable: true } });
      await page.goto('/referrals/dashboard');
      await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Creator' })).toBeVisible();
      await expect(page.getByText('Server error', { exact: true })).toBeVisible();
      await expect(page.getByText('Total earned', { exact: true })).toHaveCount(0);
      await record(page, testInfo, `payout-outage-${size}`);
      await configure(baseURL, { settings: { earningsUnavailable: false, emptyEarnings: true }, documents: [{ _id: 'tooling-referral', xocPayments: [], vertexPayments: [], successfulReferrals: 0 }] });
      await page.reload();
      await expect(page.getByText('Total earned', { exact: true }).locator('..')).toContainText('$0.00');
      await page.getByRole('button', { name: 'View my payment logs', exact: true }).click();
      await expect(page.getByText('No payments logged yet.', { exact: true })).toHaveCount(2);
      await record(page, testInfo, `empty-payments-${size}`);
    });

    test('forgot email has its visible label as an accessible name', async ({ page }, testInfo) => {
      await page.goto('/referrals/forgot');
      const input = page.locator('form input[type=email]');
      await record(page, testInfo, `forgot-label-${size}`, { id: await input.getAttribute('id'), labelledBy: await input.getAttribute('aria-labelledby'), ariaLabel: await input.getAttribute('aria-label'), labelFor: await page.getByText('Creator Email', { exact: true }).getAttribute('for') });
      await expect(page.getByLabel('Creator Email', { exact: true })).toBeVisible({ timeout: 1000 });
    });

    test('settings error messages are announced', async ({ page, context, baseURL }, testInfo) => {
      await signIn(context, baseURL);
      await page.goto('/referrals/dashboard');
      await page.route('**/api/ref/updateSplit', route => route.fulfill({ status: 403, json: { ok: false, error: 'Synthetic settings rejection.' } }));
      await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
      const toast = page.getByText('Synthetic settings rejection.', { exact: true });
      await expect(toast).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save Settings', exact: true })).toBeEnabled();
      const announced = await toast.evaluate(element => Boolean(element.closest('[aria-live],[role=alert],[role=status]')));
      await record(page, testInfo, `settings-error-${size}`, { announced });
      expect(announced).toBe(true);
    });

    test('reset errors and timeouts retain the link and enable retry', async ({ page }, testInfo) => {
      await page.clock.install();
      await page.goto('/referrals/reset#token=' + 'a'.repeat(64));
      await page.getByLabel('New Password', { exact: true }).fill('Replacement-password2!');
      await page.getByLabel('Confirm Password', { exact: true }).fill('Replacement-password2!');
      const outcomes = [];
      for (const status of [400, 409, 429, 503, 0]) {
        await page.route('**/api/ref/reset', route => status ? route.fulfill({ status, json: { ok: false, error: `Synthetic ${status} reset failure.` } }) : route.abort('failed'));
        await page.getByRole('button', { name: 'Update Password', exact: true }).click();
        await expect(page.locator('form').getByRole('alert')).toContainText(status ? `Synthetic ${status}` : 'could not be completed');
        await expect(page.getByRole('button', { name: 'Update Password', exact: true })).toBeEnabled();
        outcomes.push({ status, message: await page.locator('form').getByRole('alert').innerText() });
        await page.unroute('**/api/ref/reset');
      }
      let release;
      const held = new Promise(resolve => { release = resolve; });
      await page.route('**/api/ref/reset', async route => { await held; await route.abort('timedout').catch(() => {}); });
      const requested = page.waitForRequest('**/api/ref/reset');
      await page.getByRole('button', { name: 'Update Password', exact: true }).click();
      await requested;
      await page.clock.fastForward(15001);
      await expect(page.locator('form').getByRole('alert')).toContainText('took too long');
      await expect(page.getByRole('button', { name: 'Update Password', exact: true })).toBeEnabled();
      release();
      await record(page, testInfo, `reset-errors-${size}`, { outcomes, tokenRetained: await page.evaluate(() => Boolean(sessionStorage.getItem('referral_reset_token'))) });
    });

    test('registration failures, forgot failures and connection failures retain usable pages', async ({ page, context, baseURL }, testInfo) => {
      const outcomes = [];
      let registrationPosts = 0;
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/ref/register' && request.method() === 'POST') registrationPosts += 1; });
      await page.route('**/api/ref/validateReferral?*', route => route.fulfill({ status: 503, json: { ok: false, reason: 'unavailable', error: 'Synthetic validation outage.' } }));
      await openForm(page, '/referrals/register', '/api/auth/identities');
      await fillRegistration(page);
      const validationPromise = page.waitForResponse('**/api/ref/validateReferral?*');
      await page.getByRole('button', { name: 'Register', exact: true }).click();
      expect((await validationPromise).status()).toBe(503);
      await expect(page.getByText('Could not validate referral code. Try again.', { exact: true })).toBeVisible();
      await expect(page.getByText('Referral code is available.', { exact: true })).toHaveCount(0);
      await expectRegistrationFields(page, 'new@fixture.invalid', 'new-creator');
      await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeEnabled();
      expect(registrationPosts).toBe(0);
      outcomes.push({ route: 'validateReferral', status: 503, registrationPosts, message: 'Could not validate referral code. Try again.' });
      await record(page, testInfo, `registration-validation-outage-${size}`, { outcomes });
      await page.unroute('**/api/ref/validateReferral?*');
      await page.route('**/api/ref/validateReferral?*', route => route.fulfill({ status: 200, json: { ok: false, reason: 'available', error: 'Not found' } }));
      await page.getByLabel('Referral Code', { exact: true }).fill('retry-creator');
      await expect(page.getByText('Referral code is available.', { exact: true })).toBeVisible();
      for (const status of [400, 409, 429, 503, 0]) {
        await page.route('**/api/ref/register', route => status ? route.fulfill({ status, json: { ok: false, error: `Synthetic ${status} registration failure.` } }) : route.abort('failed'));
        await submitRegistration(page);
        await expect(page.getByText(status ? `Synthetic ${status} registration failure.` : 'Server error.', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeEnabled();
        await expectRegistrationFields(page, 'new@fixture.invalid', 'new-creator');
        const message = page.getByText(status ? `Synthetic ${status} registration failure.` : 'Server error.', { exact: true });
        expect(await message.evaluate(element => Boolean(element.closest('[aria-live],[role=alert],[role=status]')))).toBe(true);
        outcomes.push({ route: 'register', status, registrationPosts, fieldsRetained: true, message: await message.innerText() });
        await page.unroute('**/api/ref/register');
      }
      expect(registrationPosts).toBe(5);
      await record(page, testInfo, `registration-errors-${size}`, { outcomes });
      await page.route('**/api/ref/register', route => route.fulfill({ status: 202, json: { ok: true, pendingVerification: true } }));
      await page.getByRole('button', { name: 'Register', exact: true }).click();
      await expect(page.getByText('Check your email and use the confirmation link to finish creating your account.')).toBeVisible();
      outcomes.push({ route: 'register-retry', status: 202, registrationPosts });
      await openForm(page, '/referrals/login', '/api/ref/sessionStatus');
      await page.getByRole('button', { name: 'Forgot your password?', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Forgot Password', exact: true })).toBeVisible();
      for (const status of [400, 429, 503, 0]) {
        await page.route('**/api/ref/forgot', route => status ? route.fulfill({ status, json: { ok: false, error: `Synthetic ${status} forgot failure.` } }) : route.abort('failed'));
        const email = page.getByLabel('Creator Email', { exact: true });
        await email.fill('creator@fixture.invalid');
        await expect(email).toHaveValue('creator@fixture.invalid');
        const requestPromise = page.waitForRequest('**/api/ref/forgot');
        await page.getByRole('button', { name: 'Send Reset Link', exact: true }).click();
        const request = await requestPromise;
        expect(request.method()).toBe('POST');
        expect(request.postDataJSON()).toEqual({ email: 'creator@fixture.invalid' });
        const message = page.getByText(status ? `Synthetic ${status} forgot failure.` : 'Server error.', { exact: true });
        await expect(message).toBeVisible();
        await expect(page.locator('#main-content').getByRole('alert')).toContainText(await message.innerText());
        await expect(page.getByRole('button', { name: 'Send Reset Link', exact: true })).toBeEnabled();
        await expect(email).toHaveValue('creator@fixture.invalid');
        outcomes.push({ route: 'forgot', status, fieldsRetained: true, message: await message.innerText() });
        await page.unroute('**/api/ref/forgot');
      }
      await signIn(context, baseURL);
      await page.route('**/api/auth/identities?flow=referral', route => route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic connections outage.' } }));
      await page.goto('/referrals/dashboard');
      await expect(page.getByText('Synthetic connections outage.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Creator' })).toBeVisible();
      await page.unroute('**/api/auth/identities?flow=referral');
      const recoveryPromise = page.waitForResponse('**/api/auth/identities?flow=referral');
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      expect((await recoveryPromise).status()).toBe(200);
      await expect(page.getByText('Synthetic connections outage.', { exact: true })).toHaveCount(0);
      await record(page, testInfo, `form-errors-${size}`, { outcomes });
    });
  });
}

test('session probes distinguish unavailable verification from a rejected session', async ({ page, baseURL }, testInfo) => {
  const cookie = 'ref_session=' + fixture.referralSessionCookie();
  const outcomes = [];
  for (const session of ['unavailable', 'network_error', 'malformed_response', 'valid']) {
    await fixture.configureApiFixture(baseURL, { session });
    const response = await fixture.requestRoute(baseURL, '/api/ref/sessionStatus', { headers: { cookie } });
    const body = await response.json();
    outcomes.push({ session, status: response.status, body });
    await record(page, testInfo, 'session-probe', { outcomes });
    expect(response.status).toBe(session === 'valid' ? 200 : 503);
    if (session === 'valid') expect(body.authenticated).toBe(true);
    else {
      expect(body.ok).toBe(false);
      expect(body.authenticated).not.toBe(false);
    }
  }
});

test('API rejects invalid registration, expired links and rejected sessions', async ({ page, baseURL }, testInfo) => {
  const valid = { discordUsername: 'Synthetic user', email: 'new@fixture.invalid', paypalEmail: 'payout@fixture.invalid', slug: 'new-code', password: 'Synthetic-password1!' };
  const results = [];
  for (const [name, data, expected] of [
    ['missing', {}, 400], ['email', { ...valid, email: 'invalid' }, 400],
    ['long-email', { ...valid, email: 'a'.repeat(255) + '@fixture.invalid' }, 400],
    ['paypal-email', { ...valid, paypalEmail: 'invalid' }, 400], ['code', { ...valid, slug: 'invalid code' }, 400],
    ['password', { ...valid, password: 'short' }, 400], ['duplicate-email', { ...valid, email: ' CREATOR@FIXTURE.INVALID ' }, 409],
    ['active-code', { ...valid, slug: ' FIXTURE-CREATOR ' }, 409], ['coupon', { ...valid, slug: ' COUPON-CODE ' }, 409],
    ['pending-other', { ...valid, slug: 'pending-code' }, 409], ['pending-owner', { ...valid, email: 'pending@fixture.invalid', slug: 'pending-code' }, 202],
  ]) {
    await fixture.configureApiFixture(baseURL, { reset: true });
    await configure(baseURL, { reset: true });
    const response = await fixture.requestRoute(baseURL, '/api/ref/register', { data });
    results.push({ name, status: response.status, body: await response.json() });
    expect(response.status).toBe(expected);
  }
  await fixture.configureApiFixture(baseURL, { reset: true });
  await configure(baseURL, { reset: true, documents: [{ _id: 'portal-pending', registrationVerificationExpiresAt: '2020-01-01T00:00:00Z' }, { _id: 'tooling-referral', resetTokenExpiresAt: '2020-01-01T00:00:00Z' }] });
  for (const [name, route, data] of [['verify-expired', 'verifyRegistration', { token: 'b'.repeat(43) }], ['reset-expired', 'reset', { token: 'a'.repeat(64), password: 'Replacement-password2!' }]]) {
    const response = await fixture.requestRoute(baseURL, `/api/ref/${route}`, { data });
    results.push({ name, status: response.status, body: await response.json() });
    expect(response.status).toBe(400);
  }
  for (const [name, cookie] of [['missing', ''], ['bad-signature', 'invalid.invalid'], ['expired', fixture.referralSessionCookie({ exp: 1 })], ['revoked', fixture.referralSessionCookie({ sv: 2 })]]) {
    const response = await fixture.requestRoute(baseURL, '/api/ref/sessionStatus', { headers: { cookie: 'ref_session=' + cookie } });
    const body = await response.json();
    results.push({ name: `session-${name}`, status: response.status, body });
    expect(response.status).toBe(200);
    expect(body.authenticated).toBe(false);
  }
  await page.goto('/referrals/login');
  await record(page, testInfo, 'api-controls', { results });
});

test.describe('payment timestamps in western time zones', () => {
  test.use({ timezoneId: 'America/Los_Angeles', viewport: { width: 1440, height: 900 } });
  test('calendar payout dates keep their day while timestamps use the local day', async ({ page, context, baseURL }, testInfo) => {
    await configure(baseURL, { documents: [{ _id: 'tooling-referral', vertexPayments: [{ _key: 'timestamp', amount: 5.25, paidOn: '2026-10-10T00:00:00Z', note: 'UTC timestamp payout' }] }] });
    await signIn(context, baseURL);
    await page.goto('/referrals/dashboard');
    await page.getByRole('button', { name: 'View my payment logs', exact: true }).click();
    const row = page.getByText('Date-only payout', { exact: true }).locator('../..');
    await record(page, testInfo, 'payment-calendar-date', { shown: await row.innerText(), stored: '2026-10-10', timezone: 'America/Los_Angeles' });
    await expect(row).toContainText('Oct 10, 2026');
    await expect(page.getByText('UTC timestamp payout', { exact: true }).locator('../..')).toContainText('Oct 9, 2026');
  });
});
