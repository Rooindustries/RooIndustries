const { test: base, expect } = require('./fixtures/booking-flow.cjs');
const { createHash } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { nativeFixture, nativeBinariesMissing } = require('./fixtures/native-fixture.cjs');

const test = base.extend({ native: nativeFixture(require.resolve('./fixtures/lookup-filters-browser.mjs')) });

test.use({ javaScriptEnabled: true, timezoneId: 'Asia/Kolkata', reducedMotion: 'reduce', trace: 'off' });
test.describe.configure({ retries: 0 });
test.skip(nativeBinariesMissing, 'Needs PG_BIN and POSTGREST_BIN for the native PostgreSQL 17 fixture.');

const OLD_PASSWORD = 'Fixture-old-password-1!';
const NEW_PASSWORD = 'Fixture-new-password-2!';
const HOUR_MS = 3600000;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const inAnHour = () => new Date(Date.now() + HOUR_MS).toISOString();
const creator = (id, code, fields = {}) => ({ _id: `referral.${id}`, _type: 'referral', name: code,
  slug: { _type: 'slug', current: code }, creatorEmail: `${code}@example.invalid`, registrationStatus: 'active',
  creatorPassword: bcrypt.hashSync(OLD_PASSWORD, 4), ...fields });
const commerceFields = { backendOwner: 'supabase', cutoverGeneration: 0 };
const paidBooking = (id, date, fields) => ({ _id: `booking.${id}`, _type: 'booking', ...commerceFields,
  packageTitle: 'Performance Vertex Overhaul', packagePrice: '$54.95', grossAmount: 54.95, netAmount: 54.95,
  status: 'captured', startTimeUTC: `${date}T04:30:00.000Z`, displayDate: 'Fixture date', displayTime: '10:00 AM',
  localTimeZone: 'Asia/Kolkata', ...fields });

const earlierCreators = [
  { title: 'an earlier creator has no reset pending', key: 'reset', fields: () => ({}) },
  { title: 'an unverified creator holds the same reset link', key: 'sharedreset', fields: link => ({ registrationStatus: 'pending_email', ...link }) },
];

const routeNative = (context, native) => context.route(/\/api\/ref\/(reset|verifyRegistration|login|getUpgradeInfo)(?:\?|$)/, async route => {
  const request = route.request();
  const response = await native('post', new URL(request.url()).pathname, request.postDataJSON());
  await route.fulfill({ status: response.status, json: response.body });
});
const seeded = async (context, native, docs, emails, run) => {
  await routeNative(context, native);
  await native('seed', docs);
  try { await run(); } finally { await native('remove', docs.map(doc => doc._id), emails); }
};
const signIn = async (page, code, password) => {
  await page.getByRole('textbox', { name: 'Referral code or login email', exact: true }).fill(code);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const answer = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ref/login');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  expect(await (await answer).json()).toMatchObject({ ok: true, code });
};

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    for (const { title, key, fields } of earlierCreators) test(`a reset link works when ${title}`, async ({ page, context, flow, native }) => {
      const token = sha256(`${key}${viewport.width}`);
      const code = `${key}creator${viewport.width}`;
      const link = { resetTokenHash: sha256(token), resetTokenExpiresAt: inAnHour() };
      const earlier = creator(`aaa-${key}${viewport.width}`, `earliercreator${viewport.width}`, fields(link));
      const real = creator(`zzz-${key}${viewport.width}`, code, link);
      await seeded(context, native, [earlier, real], [real.creatorEmail], async () => {
        await native('account', real._id);
        await page.goto(`/referrals/reset#token=${token}`);
        await page.getByLabel('New Password', { exact: true }).fill(NEW_PASSWORD);
        await page.getByLabel('Confirm Password', { exact: true }).fill(NEW_PASSWORD);
        await page.getByRole('button', { name: 'Update Password', exact: true }).click();
        await expect(page.getByText('Password updated. Log in with your new password.', { exact: true })).toBeVisible();
        await expect(page).toHaveURL(/\/referrals\/login$/);
        await signIn(page, code, NEW_PASSWORD);
        const stored = await native('document', real._id);
        expect(stored).not.toHaveProperty('resetTokenHash');
        expect(bcrypt.compareSync(NEW_PASSWORD, stored.creatorPassword)).toBe(true);
      });
    });

    test('a confirmation link works when an earlier registration has no link pending', async ({ page, context, flow, native }) => {
      const token = sha256(`verify${viewport.width}`).slice(0, 43);
      const code = `newcreator${viewport.width}`;
      const earlier = creator(`aaa-verify${viewport.width}`, `waitingcreator${viewport.width}`, { registrationStatus: 'pending_email' });
      const real = creator(`zzz-verify${viewport.width}`, code, { registrationStatus: 'pending_email',
        registrationVerificationTokenHash: sha256(token), registrationVerificationExpiresAt: inAnHour(),
        registrationVerificationDeliveryToken: `delivery${viewport.width}` });
      await seeded(context, native, [earlier, real], [real.creatorEmail], async () => {
        await page.goto(`/referrals/verify#token=${token}`);
        await expect(page.getByRole('status')).toHaveText('Your account is confirmed. Sign in to open your creator dashboard.');
        await page.getByRole('link', { name: 'Sign in', exact: true }).click();
        await signIn(page, code, OLD_PASSWORD);
        const stored = await native('document', real._id);
        expect(stored.registrationStatus).toBe('active');
        expect(stored.registrationVerificationTokenHash).toBe(sha256(token));
        expect(stored).not.toHaveProperty('registrationVerificationDeliveryToken');
      });
    });

    test('the upgrade page finds a paid booking by its payment id behind one paid another way', async ({ page, context, flow, native }) => {
      const id = `upgrade${viewport.width}`;
      const paymentId = `pay_${id}`;
      const sessionId = `cks_${id}`;
      const docs = [
        paidBooking(`aaa-${id}`, await native('nextDate'), { paymentProvider: 'paypal', paypalOrderId: `order_${id}`, email: 'other@example.invalid' }),
        { _id: `paymentRecord.aaa-${id}`, _type: 'paymentRecord', ...commerceFields, provider: 'dodo', status: 'started' },
        paidBooking(`zzz-${id}`, await native('nextDate'), { paymentProvider: 'dodo', dodoPaymentId: paymentId, dodoCheckoutSessionId: sessionId,
          email: 'visitor@example.invalid', paymentRecordId: `paymentRecord.zzz-${id}` }),
        { _id: `paymentRecord.zzz-${id}`, _type: 'paymentRecord', ...commerceFields, provider: 'dodo', status: 'booked',
          verificationState: 'server_verified', bookingId: `booking.zzz-${id}`, providerOrderId: sessionId, providerPaymentId: paymentId,
          pricingSnapshot: { currency: 'USD', grossAmount: 54.95, netAmount: 54.95 },
          providerPublicData: { currency: 'USD', totalAmount: 5495, taxAmount: 0, taxInclusive: false } },
      ];
      await seeded(context, native, docs, [], async () => {
        await page.goto('/upgrade/max');
        await page.getByRole('textbox', { name: 'Booking email', exact: true }).fill('visitor@example.invalid');
        await page.getByRole('textbox', { name: 'Enter your Order ID', exact: true }).fill(paymentId);
        await page.getByRole('button', { name: 'Check eligibility', exact: true }).click();
        const summary = page.getByRole('heading', { name: 'Upgrade Summary', exact: true }).locator('..');
        await expect(summary).toBeVisible();
        await expect(summary).toContainText('You already paid$54.95');
        await expect(summary).toContainText('Upgrade price$45.00');
      });
    });
  });
}
