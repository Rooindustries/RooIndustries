const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
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
  await fixture.requestRoute(fixture.apiFixtureOrigin(baseURL), '/__portal', { data: { reset: true } });
  const { guardBrowserContext } = await import('../scripts/lib/test-target-safety.mjs');
  await guardBrowserContext(context, [baseURL, fixture.apiFixtureOrigin(baseURL)]);
});

const configure = (baseURL, data) => fixture.requestRoute(fixture.apiFixtureOrigin(baseURL), '/__portal', { data });
async function signIn(context, baseURL) {
  await context.addCookies([{ name: 'ref_session', value: fixture.referralSessionCookie(), url: baseURL, httpOnly: true, sameSite: 'Lax' }]);
}
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
      await expect(page.locator('#main-content').getByRole('status')).toContainText('Reset link sent');
      await expect(email).toHaveValue('');
      await record(page, testInfo, `announced-outcomes-${size}`);
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
