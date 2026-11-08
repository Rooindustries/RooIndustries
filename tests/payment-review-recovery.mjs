import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createBookingContactFixture } from './fixtures/booking-contact.mjs';

const RealDate = Date;
let now = RealDate.now();
class TestDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
globalThis.Date = TestDate;
let fixture;
before(async () => { fixture = await createBookingContactFixture({ artifactName: 'payment-review-recovery' }); });
beforeEach(async () => {
  await fixture.resetPayments();
  now = RealDate.now();
  fixture.setProviderLookupFailure(false);
  fixture.setCheckoutPaymentStarted(true);
  fixture.setPaymentAmountOverrides({});
});
after(async () => { globalThis.Date = RealDate; await fixture?.stop(); });
const cron = () => fixture.post('/api/payment/reconcile', {}, 'fixture-only-cron');
const start = async () => {
  const hold = await fixture.hold();
  const started = await fixture.start(hold);
  assert.equal(started.status, 200, JSON.stringify(started));
  const { verifyPaymentAccessToken } = await import('../src/server/api/payment/accessToken.js');
  const id = verifyPaymentAccessToken({ token: started.body.paymentAccessToken }).payload.paymentRecordId;
  now += 2 * 60_000;
  return { hold, token: started.body.paymentAccessToken, id };
};
const saved = checkout => fixture.commerce.getDocument(checkout.id);
const status = checkout => fixture.post('/api/payment/status', {}, checkout.token);
const advanceToRetry = record => { now = Date.parse(record.nextRecoveryAt) + 1000; };

for (const state of ['unverified', 'requires_merchant_action']) {
  test(`${state} keeps retrying beyond twelve provider lookup failures`, async () => {
    fixture.setPaymentAmountOverrides({ status: state === 'unverified' ? 'processing' : state });
    const checkout = await start();
    if (state !== 'unverified') {
      assert.equal((await cron()).status, 200);
      advanceToRetry(await saved(checkout));
    }
    fixture.setProviderLookupFailure(true);
    const alerts = [];
    const key = Symbol.for('roo.reportServerError');
    const previous = globalThis[key];
    globalThis[key] = (label, error) => alerts.push(error.code);
    let record;
    try {
      for (let attempt = 1; attempt <= 14; attempt += 1) {
        assert.equal((await cron()).status, 200);
        record = await saved(checkout);
        assert.equal(record.reconciliationRecoveryTerminal, false);
        assert.equal(record.recoveryFailureCount, Math.min(12, attempt));
        assert.ok(Date.parse(record.nextRecoveryAt) > now);
        assert.ok(Date.parse(record.nextRecoveryAt) <= now + 60 * 60_000);
        assert.equal((await cron()).body.summary.scanned, 0);
        if (attempt < 14) advanceToRetry(record);
      }
      assert.equal(record.recoveryOwnerReviewRequired, true);
      assert.equal(alerts.filter(code => code === 'payment_recovery_attempts_exhausted').length, 1);
      now += 25 * 60 * 60_000;
      assert.equal((await status(checkout)).status, 200);
      if (state === 'requires_merchant_action') {
        const cleanup = await fixture.database.client.rpc('roo_cleanup_expired_supabase_holds',
          { p_cutover_generation: 0, p_limit: 25 });
        assert.equal(cleanup.error, null);
        assert.equal((await fixture.commerce.getDocument(checkout.hold.slotHoldId)).phase, 'payment_pending');
      }
    } finally {
      fixture.setProviderLookupFailure(false);
      if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
    }
    fixture.setPaymentAmountOverrides({});
    assert.equal((await cron()).status, 200);
    const completed = await saved(checkout);
    assert.ok(completed.bookingId);
    assert.equal(completed.recoveryOwnerReviewRequired, false);
    assert.equal((await status(checkout)).status, 200);
    assert.equal((await cron()).status, 200);
    const bookings = await fixture.commerce.fetch('*[_type == "booking" && paymentRecordId == $id]', { id: checkout.id });
    assert.equal(bookings.length, 1);
  });
}

for (const outcome of ['booked', 'refunded', 'failed', 'cancelled', 'abandoned']) {
  test(`review completion ${outcome} has exactly one hour of read access`, async () => {
    fixture.setPaymentAmountOverrides({ status: 'requires_merchant_action' });
    const checkout = await start();
    assert.equal((await cron()).status, 200);
    now += 25 * 60 * 60_000;
    const waiting = await status(checkout);
    assert.equal(waiting.status, 200);
    assert.equal(waiting.body.manualReviewRequired, true);
    fixture.setPaymentAmountOverrides(outcome === 'abandoned' ? { status: 'requires_payment_method' } :
      ['failed', 'cancelled'].includes(outcome) ? { status: outcome } : {});
    const paymentId = `payment_${(await saved(checkout)).providerOrderId}`;
    if (outcome === 'refunded') {
      const record = await saved(checkout);
      const response = await fixture.refundPayment(paymentId, [{ refund_id: `refund_${checkout.id}`,
        payment_id: paymentId, amount: Math.round(record.pricingSnapshot.netAmount * 100),
        currency: 'USD', status: 'succeeded' }], `refund_${checkout.id}`);
      assert.equal(response.status, 200, JSON.stringify(response));
    } else if (outcome === 'abandoned') assert.equal((await cron()).status, 200);
    else {
      const response = await fixture.dodoWebhook(paymentId,
        `payment.${outcome === 'booked' ? 'succeeded' : outcome}`, `complete_${checkout.id}`);
      assert.equal(response.status, 200, JSON.stringify(response));
    }
    const completed = await saved(checkout);
    assert.equal(completed.status, outcome === 'cancelled' ? 'abandoned' : outcome);
    const deadline = Date.parse(completed.reviewResultAccessUntil);
    assert.equal(deadline, now + 60 * 60_000);
    const { createPaymentAccessToken } = await import('../src/server/api/payment/accessToken.js');
    const longToken = createPaymentAccessToken({ paymentRecordId: completed._id, provider: completed.provider,
      pricingFingerprint: completed.pricingFingerprint, backend: 'supabase', cutoverGeneration: 0,
      expirySeconds: 24 * 60 * 60 });
    assert.equal((await status(checkout)).status, 200);
    now = deadline - 1;
    assert.equal((await status(checkout)).status, 200);
    assert.equal((await saved(checkout)).reviewResultAccessUntil, completed.reviewResultAccessUntil);
    now = deadline;
    assert.equal((await status(checkout)).status, 401);
    assert.equal((await fixture.post('/api/payment/status', {}, longToken)).status, 401);
  });
}
