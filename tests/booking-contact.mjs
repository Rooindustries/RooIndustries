import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { createBookingContactFixture } from './fixtures/booking-contact.mjs';

const invalidInputs = [
  ['malformed email', 'email', 'not-an-email'],
  ['email with empty domain label', 'email', 'visitor@example..invalid'],
  ['email with trailing domain dot', 'email', 'visitor@example.invalid.'],
  ['email with invalid domain character', 'email', 'visitor@exa!mple.invalid'],
  ['email with hyphen-edged domain label', 'email', 'visitor@-example.invalid'],
  ['missing email', 'email', undefined],
  ['empty email', 'email', '   '],
  ['overlong email', 'email', `${'a'.repeat(243)}@example.test`],
  ['email with leading control', 'email', '\nvisitor@example.invalid'],
  ['email with embedded control', 'email', 'visi\u0000tor@example.invalid'],
  ['email with DEL', 'email', 'visi\u007ftor@example.invalid'],
  ['email with C1 control', 'email', 'visi\u0085tor@example.invalid'],
  ['object email', 'email', { address: 'visitor@example.invalid' }],
  ['numeric email', 'email', 123],
  ['array email', 'email', ['visitor@example.invalid']],
  ...['discord', 'specs', 'mainGame'].flatMap(field => [
    [`missing ${field}`, field, undefined],
    [`empty ${field}`, field, ' \t '],
    [`non-string ${field}`, field, { value: 'text' }],
  ]),
  ['non-string message', 'message', ['note']],
  ['invalid timezone', 'localTimeZone', 'Mars/Olympus'],
  ['missing timezone', 'localTimeZone', undefined],
  ['empty timezone', 'localTimeZone', '  '],
  ['non-string timezone', 'localTimeZone', { value: 'UTC' }],
];

const messages = {
  email: 'Enter a valid booking email address.',
  discord: 'Enter your Discord username.',
  specs: 'Enter your PC specifications.',
  mainGame: 'Enter your main game or app.',
  message: 'Booking notes must be text.',
  localTimeZone: 'Select a valid timezone.',
};

test('booking contact validation over HTTP', { timeout: 300000 }, async t => {
  const fixture = await createBookingContactFixture();
  const { post, start, hold, snapshot, recordFor, commerce, seedUpgrade, evidence } = fixture;
  const check = async (name, run) => t.test(name, async () => {
    const result = { name };
    evidence.cases.push(result);
    try {
      await run(result);
      result.result = 'pass';
    } catch (error) {
      result.result = 'fail';
      result.error = error.message;
      throw error;
    } finally {
      fixture.save();
    }
  });
  const submit = (path, payload) => start(payload, path === 'new paid start' ? 'dodo' : 'free');
  const prepare = async (path, changes) => hold({
    couponCode: path === 'new paid start' ? 'FIXTUREPAID' : 'FIXTUREFREE',
    ...changes,
  });

  try {
    for (const path of ['new paid start', 'new zero-value start']) {
      for (const [description, field, value] of invalidInputs) {
        await check(`${path}: rejects ${description} before any mutation`, async result => {
          const payload = await prepare(path, { [field]: value });
          const before = await snapshot();
          result.response = await submit(path, payload);
          const after = await snapshot();
          result.noMutation = isDeepStrictEqual(before, after);
          assert.ok(result.noMutation, 'Invalid contact changed a hold, coupon, payment record or provider');
          assert.equal(result.response.status, 400, JSON.stringify(result.response));
          assert.equal(result.response.body.error, messages[field]);
        });
      }
      await check(`${path}: valid trimmed details still succeed`, async result => {
        const payload = await prepare(path, {
          email: '  visitor@example.invalid  ', discord: '  fixture_visitor  ',
          specs: '  Ryzen 7700 / RTX 4070  ', mainGame: '  CS2  ',
          message: '  Fixture booking  ', localTimeZone: '  Asia/Kolkata  ',
        });
        result.response = await submit(path, payload);
        assert.equal(result.response.status, 200, JSON.stringify(result.response));
        const record = await recordFor(payload);
        const booking = await commerce.fetch('*[_type == "booking" && startTimeUTC == $time][0]', {
          time: payload.startTimeUTC,
        });
        const saved = path === 'new paid start' ? record.bookingPayload : booking;
        for (const [field, expected] of Object.entries(fixture.details)) {
          assert.equal(saved[field], expected, `${field} was not trimmed`);
        }
        if (path === 'new paid start') {
          result.finalize = await post('/api/payment/finalize', {}, result.response.body.paymentAccessToken);
          assert.equal(result.finalize.status, 200, JSON.stringify(result.finalize));
        }
      });
    }

    await check('valid boundary email and optional omitted notes are accepted', async result => {
      const email = `${'a'.repeat(241)}@example.test`;
      assert.equal(email.length, 254);
      const payload = await hold({ email, message: undefined, localTimeZone: 'UTC' });
      result.response = await start(payload);
      assert.equal(result.response.status, 200, JSON.stringify(result.response));
      assert.equal((await recordFor(payload)).bookingPayload.email, email);
    });

    await check('stored payment session with legacy malformed contacts still resumes unchanged', async result => {
      const payload = await hold();
      const created = await start(payload);
      assert.equal(created.status, 200, JSON.stringify(created));
      const record = await recordFor(payload);
      const legacy = { ...record.bookingPayload, email: 'legacy-invalid', discord: '',
        specs: { legacy: true }, mainGame: '', message: ['legacy'], localTimeZone: 'Mars/Olympus' };
      const quote = await post('/api/payment/quote', { bookingPayload: legacy });
      assert.equal(quote.status, 200, JSON.stringify(quote));
      await commerce.patch(record._id).set({ bookingPayload: legacy, quoteFingerprint: quote.body.quoteFingerprint }).commit();
      const before = await snapshot();
      result.response = await start(legacy);
      assert.equal(result.response.status, 200, JSON.stringify(result.response));
      assert.equal(result.response.body.providerPayload.orderId, created.body.providerPayload.orderId);
      assert.ok(isDeepStrictEqual(await snapshot(), before), 'Resuming a session changed stored state');
    });

    for (const localTimeZone of ['UTC', '+01:00', 'US/Eastern']) {
      for (const path of ['new paid start', 'new zero-value start']) {
        await check(`${path}: accepts timezone ${localTimeZone}`, async result => {
          const payload = await prepare(path, { localTimeZone });
          result.response = await submit(path, payload);
          assert.equal(result.response.status, 200, JSON.stringify(result.response));
        });
      }
    }

    await check('stored legacy session with no provider order retains the existing retry outcome', async result => {
      const payload = await hold();
      const created = await start(payload);
      assert.equal(created.status, 200, JSON.stringify(created));
      const record = await recordFor(payload);
      const legacy = { ...record.bookingPayload, email: 'legacy-invalid' };
      const quote = await post('/api/payment/quote', { bookingPayload: legacy });
      await commerce.patch(record._id).set({ bookingPayload: legacy, quoteFingerprint: quote.body.quoteFingerprint,
        providerOrderId: '', orderCreationLeaseId: 'fixture-pending-order' }).commit();
      const before = await snapshot();
      result.response = await start(legacy);
      assert.equal(result.response.status, 409, JSON.stringify(result.response));
      assert.equal(result.response.body.code, 'provider_order_creation_in_progress');
      assert.ok(isDeepStrictEqual(await snapshot(), before), 'Pending session replay changed stored state');
    });

    await check('upgrade with empty placeholders and inherited malformed email still starts and finalizes', async result => {
      const { payload } = await seedUpgrade({ email: 'legacy-invalid' });
      result.response = await start({ ...payload, discord: '', specs: '', mainGame: '', message: '',
        localTimeZone: '', displayDate: '', displayTime: '' });
      assert.equal(result.response.status, 200, JSON.stringify(result.response));
      result.finalize = await post('/api/payment/finalize', {}, result.response.body.paymentAccessToken);
      assert.equal(result.finalize.status, 200, JSON.stringify(result.finalize));
      const saved = await commerce.getDocument(result.finalize.body.bookingId);
      assert.equal(saved.email, 'legacy-invalid');
      assert.equal(saved.discord, fixture.details.discord);
    });
    await check('all requests stayed in the guarded fixture', async () => {
      assert.deepEqual(evidence.blocked, []);
    });
  } finally {
    await fixture.stop();
    console.log('Booking contact artifact: test-results/booking-contact/results.json');
  }
});
