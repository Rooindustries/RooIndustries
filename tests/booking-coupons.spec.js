const { test: base, expect } = require('./fixtures/booking-flow.cjs');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const test = base.extend({
  native: [async ({}, use) => {
    const child = fork(require.resolve('./fixtures/booking-coupons.mjs'), [], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const pending = new Map();
    let nextId = 0;
    const ready = new Promise((resolve, reject) => {
      child.on('message', message => {
        if (message.ready) return resolve();
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
      });
      child.on('exit', code => {
        const error = new Error(`Booking fixture exited (${code})`);
        reject(error);
        for (const request of pending.values()) request.reject(error);
        pending.clear();
      });
    });
    const call = (method, ...args) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      child.send({ id, method, args });
    });
    try {
      await ready;
      await use(call);
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        await call('stop');
        await exited;
      }
    }
  }, { scope: 'worker' }],
});

test.use({ javaScriptEnabled: true, timezoneId: 'Asia/Kolkata', reducedMotion: 'reduce', trace: 'off' });
test.describe.configure({ retries: 0 });
const binaries = [process.env.PG_BIN && path.join(process.env.PG_BIN, 'postgres'), process.env.POSTGREST_BIN];
test.skip(!binaries.every(file => file && fs.existsSync(file)), 'Needs PG_BIN and POSTGREST_BIN for the native PostgreSQL 17 fixture.');

const routeNative = async (context, native, date) => {
  await context.route(/\/api\/(holdSlot|releaseHold|payment\/(quote|start|cancel|status)|ref\/validateCoupon|ref\/validateReferral|bookingAvailability)(?:\?|$)/, async route => {
    const request = route.request();
    const url = new URL(request.url());
    let response;
    if (url.pathname === '/api/bookingAvailability') {
      response = await native('availability');
      const dateSlots = [{ date, times: ['10:00'] }];
      response.body.settings = { ...response.body.settings, dateSlots, xocDateSlots: dateSlots, vertexEssentialsDateSlots: dateSlots, packageDateSlots: [] };
    } else if (url.pathname.startsWith('/api/ref/validate')) {
      response = await native('validate', `${url.pathname}${url.search}`);
    } else {
      response = await native('post', url.pathname, request.postDataJSON(), request.headers().authorization || '');
    }
    return route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
  });
  await context.route('https://test.checkout.dodopayments.com/session/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Checkout</h1>' }));
};
const coupon = (id, code, fields = {}) => ({ _id: `coupon.${id}`, _type: 'coupon', code,
  discountType: 'percent', discountPercent: 5, canCombineWithReferral: true,
  isActive: true, timesUsed: 0, activeReservations: 0, ...fields });
const referral = (id, code, fields = {}) => ({ _id: `referral.${id}`, _type: 'referral',
  slug: { _type: 'slug', current: code }, registrationStatus: 'active',
  currentCommissionPercent: 20, currentDiscountPercent: 10, successfulReferrals: 0, ...fields });
const REFERRAL_DISCOUNT = '5.50';
const behindCodelessReferral = async (native, id, run) => {
  const code = `realcode${id}`;
  const docs = [referral(`aaa-${id}`, null, { slug: null }), referral(`zzz-${id}`, code, { registrationStatus: undefined })];
  for (const doc of docs) await native('create', doc);
  try { await run(code, docs[1]._id); } finally { await native('remove', docs.map(doc => doc._id)); }
};
const paymentCode = (page, name) => {
  const input = page.getByRole('textbox', { name, exact: true });
  return { input, apply: input.locator('..').getByRole('button', { name: 'Apply', exact: true }) };
};

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });
    test('a coupon reduces the referral base before discount and commission', async ({ page, context, flow, native }) => {
      const date = await native('nextDate');
      const id = `combined${viewport.width}`;
      const code = `creator${viewport.width}`;
      await native('setPrice', '$49.95');
      try {
        await native('create', coupon(id, id.toUpperCase()));
        await native('create', referral(id, code));
        await routeNative(context, native, date);
        await flow.review('/booking?package=overhaul');
        await flow.codeInput(code);
        await expect(page.getByRole('button', { name: `Remove referral code ${code}`, exact: true })).toBeVisible();
        await flow.codeInput(id);
        await expect(page.getByRole('button', { name: `Remove coupon code ${id.toUpperCase()}`, exact: true })).toBeVisible();
        await flow.payment();
        await page.getByRole('button', { name: 'Pay your way', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Checkout', exact: true })).toBeVisible();
        const record = (await native('rows', 'paymentRecord')).find(row => row.bookingPayload?.couponCode?.toLowerCase() === id);
        expect(record).toBeTruthy();
        expect((await native('webhook', `payment_${record.providerOrderId}`, 'payment.succeeded', `paid_${id}`)).status).toBe(200);
        const bookings = (await native('rows', 'booking')).filter(row => row.couponCode === id.toUpperCase());
        expect(bookings).toHaveLength(1);
        expect(bookings[0]).toMatchObject({
          grossAmount: 49.95, couponDiscountPercent: 5, couponDiscountAmount: 2.5,
          discountAmount: 7.25, netAmount: 42.7, commissionPercent: 20, commissionAmount: 9.49,
        });
      } finally { await native('setPrice', '$54.95'); }
    });

    test('a full referral discount completes a free booking without a coupon', async ({ page, context, flow, native }) => {
      const date = await native('nextDate');
      const code = `freecreator${viewport.width}`;
      await native('create', referral(code, code, { currentCommissionPercent: 0, currentDiscountPercent: 100 }));
      await routeNative(context, native, date);
      await flow.review('/booking?package=overhaul');
      await flow.codeInput(code);
      await expect(page.getByRole('button', { name: `Remove referral code ${code}`, exact: true })).toBeVisible();
      await flow.payment();
      const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/payment/start');
      await page.getByRole('button', { name: 'Confirm Free Booking', exact: true }).click();
      expect((await response).status()).toBe(200);
      const bookings = (await native('rows', 'booking')).filter(row => row.referralCode === code);
      expect(bookings).toHaveLength(1);
      expect(bookings[0]).toMatchObject({
        paymentProvider: 'free', grossAmount: 54.95, netAmount: 0, referralCode: code,
        discountPercent: 100, discountAmount: 54.95, commissionAmount: 0,
      });
      expect(bookings[0]).not.toHaveProperty('couponCode');
      expect((await native('referral', `referral.${code}`)).successfulReferrals).toBe(1);
    });

    for (const first of [0, 1]) test(`two customers racing for the final coupon use: customer ${first + 1} first`, async ({ page, context, flow, native }) => {
      const date = await native('nextDate');
      const otherDate = await native('nextDate');
      const id = `last${viewport.width}${first}`;
      await native('create', coupon(id, id.toUpperCase(), { discountPercent: 100, maxUses: 1 }));
      await routeNative(context, native, date);
      const other = await context.newPage();
      try {
        await other.route(/\/api\/bookingAvailability(?:\?|$)/, async route => {
          const response = await native('availability');
          const dateSlots = [{ date: otherDate, times: ['10:00'] }];
          response.body.settings = { ...response.body.settings, dateSlots, xocDateSlots: dateSlots, vertexEssentialsDateSlots: dateSlots, packageDateSlots: [] };
          await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
        });
        await flow.review('/booking?package=overhaul');
        await flow.codeInput(id);
        await expect(page.getByRole('button', { name: `Remove coupon code ${id.toUpperCase()}`, exact: true })).toBeVisible();
        await flow.payment();
        await other.goto('/booking?package=overhaul');
        await other.getByRole('button', { name: /^Earliest available:/ }).click();
        await other.getByRole('button', { name: '10:00 AM', exact: true }).click();
        await other.getByRole('button', { name: 'Next', exact: true }).last().click();
        await other.getByRole('textbox', { name: 'Discord username', exact: true }).fill('other_visitor');
        await other.getByRole('textbox', { name: 'Booking email', exact: true }).fill('other@example.invalid');
        await other.getByRole('textbox', { name: 'PC specifications', exact: true }).fill('Ryzen 7700 / RTX 4070');
        await other.getByRole('textbox', { name: 'Main game or application', exact: true }).fill('CS2');
        await other.getByRole('button', { name: 'Review before payment', exact: true }).click();
        await other.getByRole('button', { name: 'Have a referral or coupon code?', exact: true }).click();
        await other.getByRole('textbox', { name: 'Referral or coupon code', exact: true }).fill(id);
        await other.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect(other.getByRole('button', { name: `Remove coupon code ${id.toUpperCase()}`, exact: true })).toBeVisible();
        await other.getByRole('button', { name: 'Continue to payment', exact: true }).click();
        const buttons = [page, other].map(tab => tab.getByRole('button', { name: 'Confirm Free Booking', exact: true }));
        for (const button of buttons) await expect(button).toBeEnabled();
        await native('lockCommerce');
        try {
          const responses = [page, other].map(tab => tab.waitForResponse(response => new URL(response.url()).pathname === '/api/payment/start'));
          const clicks = [];
          clicks[first] = buttons[first].click();
          await expect.poll(() => native('waiting')).toBe(1);
          clicks[1 - first] = buttons[1 - first].click();
          await expect.poll(() => native('waiting')).toBe(2);
          await native('unlockCommerce');
          await Promise.all(clicks);
          const statuses = (await Promise.all(responses)).map(response => response.status());
          expect(statuses[first]).toBe(200);
          expect(statuses[1 - first]).toBe(409);
        } finally { await native('unlockCommerce'); }
        const stored = await native('get', `coupon.${id}`);
        expect(stored).toMatchObject({ timesUsed: 1, activeReservations: 0 });
        const bookings = (await native('rows', 'booking')).filter(row => row.couponCode?.toLowerCase() === id);
        expect(bookings).toHaveLength(1);
        expect(bookings[0].email).toBe(first === 0 ? 'visitor@example.invalid' : 'other@example.invalid');
        const redemptions = (await native('rows', 'couponRedemption')).filter(row => row.coupon?._ref === `coupon.${id}`);
        expect(redemptions).toHaveLength(1);
        expect(redemptions[0].status).toBe('consumed');
      } finally { await other.close(); }
    });

    test('a creator link keeps its discount and credit behind a referral that has no code', async ({ page, context, flow, native }) => {
      const date = await native('nextDate');
      const id = `link${viewport.width}`;
      await native('create', coupon(id, id.toUpperCase(), { canCombineWithReferral: false }));
      await behindCodelessReferral(native, id, async (code, referralId) => {
        await routeNative(context, native, date);
        await page.goto(`/?ref=${code}`);
        await expect.poll(() => page.evaluate(() => sessionStorage.getItem('referral_session'))).toBe(code);
        await page.locator('.ri-package-card').filter({ has: page.getByRole('heading', { name: 'Performance Vertex Overhaul', exact: true }) })
          .locator('.ri-package-book-button').click();
        await page.getByRole('button', { name: /^Earliest available:/ }).click();
        await page.getByRole('button', { name: '10:00 AM', exact: true }).click();
        await page.getByRole('button', { name: 'Next', exact: true }).last().click();
        await flow.details();
        await page.getByRole('button', { name: 'Review before payment', exact: true }).click();
        await expect(page.getByRole('button', { name: `Remove referral code ${code}`, exact: true })).toBeVisible();
        await flow.payment();
        await expect(page.getByText(`${code} · −$${REFERRAL_DISCOUNT}`, { exact: true })).toBeVisible();
        const couponCode = paymentCode(page, 'Coupon Code (optional)');
        await couponCode.input.fill(id);
        await couponCode.apply.click();
        await expect(page.locator('#payment-coupon-code-error')).toHaveText(
          "This coupon can't be used together with a referral discount. Remove the referral or use a different coupon.");
        await page.getByRole('button', { name: 'Pay your way', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Checkout', exact: true })).toBeVisible();
        const record = (await native('rows', 'paymentRecord')).find(row => row.bookingPayload?.referralCode === code);
        expect(record).toBeTruthy();
        expect((await native('webhook', `payment_${record.providerOrderId}`, 'payment.succeeded', `paid_${id}`)).status).toBe(200);
        const bookings = (await native('rows', 'booking')).filter(row => row.referralCode === code);
        expect(bookings).toHaveLength(1);
        expect(bookings[0]).toMatchObject({ grossAmount: 54.95, discountPercent: 10.01, discountAmount: 5.5, netAmount: 49.45,
          commissionPercent: 20, commissionAmount: 10.99 });
        expect(bookings[0]).not.toHaveProperty('couponCode');
        expect((await native('referral', referralId)).successfulReferrals).toBe(1);
      });
    });

    test('a referral code typed on the payment page keeps its discount behind a referral that has no code', async ({ page, context, flow, native }) => {
      const date = await native('nextDate');
      await behindCodelessReferral(native, `typed${viewport.width}`, async code => {
        await routeNative(context, native, date);
        await flow.review('/booking?package=overhaul');
        await flow.payment();
        const referralCode = paymentCode(page, 'Referral Code (optional)');
        await referralCode.input.fill(code);
        await referralCode.apply.click();
        await expect(page.getByText(`${code} · −$${REFERRAL_DISCOUNT}`, { exact: true })).toBeVisible();
      });
    });

    test('a refund restores capacity but preserves a later manual disable', async ({ page, context, flow, native }) => {
      const date = await native('nextDate');
      const id = `refund${viewport.width}`;
      await native('create', coupon(id, id.toUpperCase(), { discountPercent: 100, canCombineWithReferral: false, maxUses: 1 }));
      await routeNative(context, native, date);
      await flow.review('/booking?package=overhaul');
      await flow.codeInput(id);
      await expect(page.getByRole('button', { name: `Remove coupon code ${id.toUpperCase()}`, exact: true })).toBeVisible();
      await flow.payment();
      const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/payment/start');
      await page.getByRole('button', { name: 'Confirm Free Booking', exact: true }).click();
      const result = await (await response).json();
      expect(result.status).toBe('booked');
      expect((await native('get', `coupon.${id}`)).timesUsed).toBe(1);
      await native('disableLater', `coupon.${id}`);
      expect((await native('refund', result.bookingId)).status).toBe(200);
      expect(await native('get', `coupon.${id}`)).toMatchObject({ timesUsed: 0, isActive: false });
    });

    test('a fixed coupon covers the full price and is consumed once', async ({ page, context, flow, native }) => {
      const date = await native('nextDate');
      const id = `fixed${viewport.width}`;
      await native('setPrice', '$49.95');
      try {
        await native('create', coupon(id, id.toUpperCase(), { discountType: 'fixed', discountAmount: 50,
          eligiblePackages: [{ _ref: 'package.fixture.1' }] }));
        await routeNative(context, native, date);
        await flow.review('/booking?package=overhaul');
        await flow.codeInput(id);
        await expect(page.getByRole('button', { name: `Remove coupon code ${id.toUpperCase()}`, exact: true })).toBeVisible();
        await flow.payment();
        const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/payment/start');
        await page.getByRole('button', { name: 'Confirm Free Booking', exact: true }).click();
        expect((await response).status()).toBe(200);
        const bookings = (await native('rows', 'booking')).filter(row => row.couponCode === id.toUpperCase());
        expect(bookings).toHaveLength(1);
        expect(bookings[0]).toMatchObject({
          grossAmount: 49.95, netAmount: 0, couponCode: id.toUpperCase(), couponDiscountType: 'fixed', couponDiscountValue: 50,
          couponDiscountPercent: 100, couponDiscountAmount: 49.95, commissionAmount: 0,
        });
        expect((await native('get', `coupon.${id}`)).timesUsed).toBe(1);
      } finally { await native('setPrice', '$54.95'); }
    });
  });
}
