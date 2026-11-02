import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createBookingContactFixture } from './fixtures/booking-contact.mjs';

const RealDate = Date;
let clockShiftMs = 0;
class ShiftedDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [RealDate.now() + clockShiftMs]));
  }

  static now() {
    return RealDate.now() + clockShiftMs;
  }
}
globalThis.Date = ShiftedDate;
const minutesLater = minutes => { clockShiftMs = minutes * 60_000; };

let fixture;
before(async () => { fixture = await createBookingContactFixture({ artifactName: 'booking-payment-window' }); });
beforeEach(() => {
  minutesLater(0);
  fixture.setPaymentAmountOverrides({});
  fixture.setCheckoutPaymentStarted(true);
  fixture.setProviderLookupFailure(false);
});
after(async () => {
  minutesLater(0);
  await fixture?.stop();
});

const paymentInProgress = 'This slot already has a payment session in progress.';
const cron = () => fixture.post('/api/payment/reconcile', {}, 'fixture-only-cron');
const holdFor = payload => fixture.commerce.getDocument(payload.slotHoldId);
const recordFor = started => fixture.commerce.fetch(
  '*[_type == "paymentRecord" && providerOrderId == $id][0]', { id: started.body.providerPayload.orderId });
const bookingsAt = startTimeUTC => fixture.commerce.fetch(
  '*[_type == "booking" && (startTimeUTC == $start || originalRequestedStartTimeUTC == $start)]', { start: startTimeUTC });
const secondVisitor = payload => fixture.post('/api/holdSlot', {
  startTimeUTC: payload.startTimeUTC, packageTitle: payload.packageTitle });
const isOffered = async payload => {
  const availability = await fixture.availability();
  assert.equal(availability.status, 200, JSON.stringify(availability));
  return !availability.body.bookedSlots.some(slot => slot.startTimeUTC === payload.startTimeUTC);
};

const startCheckoutBeforeExpiry = async () => {
  minutesLater(0);
  const payload = await fixture.hold();
  const started = await fixture.start(payload);
  assert.equal(started.status, 200, JSON.stringify(started));
  const record = await recordFor(started);
  minutesLater(2);
  return { payload, started, record };
};

const holdRunsOut = async ({ payload }) => {
  minutesLater(21);
  const expiresAt = new RealDate(RealDate.now() - 1000).toISOString();
  await fixture.database.sql.begin(async sql => {
    await sql`set local session_replication_role = replica`;
    await sql`update migration.source_documents
      set payload = jsonb_set(payload, '{expiresAt}', to_jsonb(${expiresAt}::text))
      where legacy_sanity_id = ${payload.slotHoldId}`;
    await sql`update commerce.slot_holds set expires_at = ${expiresAt}
      where legacy_sanity_id = ${payload.slotHoldId}`;
    await sql`update commerce.slot_claims set expires_at = ${expiresAt}
      where hold_id = (select id from commerce.slot_holds where legacy_sanity_id = ${payload.slotHoldId})`;
  });
};

const assertBookedOnHeldSlot = async ({ payload, record }) => {
  const bookings = await bookingsAt(payload.startTimeUTC);
  assert.equal(bookings.length, 1, JSON.stringify(bookings));
  const [booking] = bookings;
  assert.equal(booking.paymentRecordId, record._id);
  assert.equal(booking.startTimeUTC, payload.startTimeUTC);
  assert.equal(booking.status, 'captured');
  assert.notEqual(booking.requiresReschedule, true);
  assert.equal((await fixture.commerce.getDocument(record._id)).bookingId, booking._id);
  const hold = await holdFor(payload);
  assert.equal(hold.phase, 'consumed');
  assert.equal(hold.bookingId, booking._id);
  return booking;
};

test('a payment still processing when the hold runs out keeps the slot and books it once it clears', async () => {
  fixture.setPaymentAmountOverrides({ status: 'processing' });
  const checkout = await startCheckoutBeforeExpiry();
  const submitted = await cron();
  assert.equal(submitted.status, 200, JSON.stringify(submitted));
  await holdRunsOut(checkout);
  const expired = await cron();
  assert.equal(expired.status, 200, JSON.stringify(expired));
  const held = await holdFor(checkout.payload);
  assert.equal(held.phase, 'payment_pending');
  assert.equal(held.paymentRecordId, checkout.record._id);
  assert.equal(await isOffered(checkout.payload), false);
  const taken = await secondVisitor(checkout.payload);
  assert.equal(taken.status, 409, JSON.stringify(taken));
  assert.equal(taken.body.message, paymentInProgress);
  fixture.setPaymentAmountOverrides({});
  const paid = await fixture.dodoWebhook(`payment_${checkout.record.providerOrderId}`,
    'payment.succeeded', `window_processing_${checkout.record._id}`);
  assert.equal(paid.status, 200, JSON.stringify(paid));
  await assertBookedOnHeldSlot(checkout);
});

test('a customer back from a slow payment after the hold ran out gets the slot they paid for', async () => {
  fixture.setPaymentAmountOverrides({ status: 'requires_customer_action' });
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  assert.equal((await cron()).status, 200);
  const waiting = await fixture.post('/api/payment/finalize', {}, checkout.started.body.paymentAccessToken);
  assert.equal(waiting.status, 202, JSON.stringify(waiting));
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
  fixture.setPaymentAmountOverrides({});
  const returned = await fixture.post('/api/payment/finalize', {}, checkout.started.body.paymentAccessToken);
  assert.equal(returned.status, 200, JSON.stringify(returned));
  const booking = await assertBookedOnHeldSlot(checkout);
  assert.equal(returned.body.bookingId, booking._id);
});

test('a payment that cleared in time books its slot when the webhook arrives late and twice', async () => {
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  const event = `window_late_${checkout.record._id}`;
  const first = await fixture.dodoWebhook(`payment_${checkout.record.providerOrderId}`, 'payment.succeeded', event);
  const duplicate = await fixture.dodoWebhook(`payment_${checkout.record.providerOrderId}`, 'payment.succeeded', event);
  const retried = await fixture.dodoWebhook(`payment_${checkout.record.providerOrderId}`, 'payment.succeeded', `${event}_retry`);
  for (const response of [first, duplicate, retried]) assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal((await cron()).status, 200);
  await assertBookedOnHeldSlot(checkout);
});

test('an unpaid checkout frees its slot for the next visitor once the hold runs out', async () => {
  fixture.setCheckoutPaymentStarted(false);
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  assert.equal((await cron()).status, 200);
  const record = await fixture.commerce.getDocument(checkout.record._id);
  assert.equal(record.status, 'abandoned');
  assert.equal((await holdFor(checkout.payload)).phase, 'released');
  assert.equal(await isOffered(checkout.payload), true);
  const next = await secondVisitor(checkout.payload);
  assert.equal(next.status, 200, JSON.stringify(next));
  assert.deepEqual(await bookingsAt(checkout.payload.startTimeUTC), []);
});

test('a payment that fails after the hold runs out frees the slot', async () => {
  fixture.setPaymentAmountOverrides({ status: 'processing' });
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  assert.equal((await cron()).status, 200);
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
  fixture.setPaymentAmountOverrides({ status: 'failed' });
  await fixture.commerce.patch(checkout.record._id).set({ nextRecoveryAt: '' }).commit();
  assert.equal((await cron()).status, 200);
  fixture.setPaymentAmountOverrides({});
  assert.equal((await fixture.commerce.getDocument(checkout.record._id)).status, 'failed');
  assert.equal((await holdFor(checkout.payload)).phase, 'released');
  assert.equal(await isOffered(checkout.payload), true);
  assert.equal((await secondVisitor(checkout.payload)).status, 200);
  assert.deepEqual(await bookingsAt(checkout.payload.startTimeUTC), []);
});

const cronUntilRecoveryStops = async checkout => {
  for (let run = 0; run < 15; run += 1) {
    const record = await fixture.commerce.getDocument(checkout.record._id);
    if (record.reconciliationRecoveryTerminal === true || record.providerRecoveryTerminal === true) return record;
    await fixture.commerce.patch(record._id).set({ nextRecoveryAt: '' }).commit();
    clockShiftMs += 2 * 60_000;
    assert.ok([200, 503].includes((await cron()).status));
  }
  assert.fail('Recovery never stopped');
};

test('an unpaid checkout stops blocking its slot when recovery gives up during a provider outage', async () => {
  fixture.setCheckoutPaymentStarted(false);
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  fixture.setProviderLookupFailure(true);
  assert.ok([200, 503].includes((await cron()).status));
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
  const stopped = await cronUntilRecoveryStops(checkout);
  assert.equal(String(stopped.providerPaymentId || ''), '');
  const hold = await holdFor(checkout.payload);
  assert.equal(hold.phase, 'released');
  assert.equal(hold.releaseReason, 'payment_recovery_stopped');
  assert.equal(await isOffered(checkout.payload), true);
  assert.equal((await secondVisitor(checkout.payload)).status, 200);
});

test('a payment already seen going through keeps its slot when recovery gives up', async () => {
  fixture.setPaymentAmountOverrides({ status: 'processing' });
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  assert.equal((await cron()).status, 200);
  assert.ok((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentId);
  fixture.setProviderLookupFailure(true);
  await cronUntilRecoveryStops(checkout);
  const hold = await holdFor(checkout.payload);
  assert.equal(hold.phase, 'payment_pending');
  assert.equal(hold.paymentRecordId, checkout.record._id);
  assert.equal(await isOffered(checkout.payload), false);
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
});
