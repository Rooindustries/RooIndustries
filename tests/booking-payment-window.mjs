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
const minutesLater = minutes => {
  clockShiftMs = minutes * 60_000;
};

let fixture;
before(async () => {
  fixture = await createBookingContactFixture({ artifactName: 'booking-payment-window' });
});
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
const recordFor = started =>
  fixture.commerce.fetch('*[_type == "paymentRecord" && providerOrderId == $id][0]', {
    id: started.body.providerPayload.orderId,
  });
const bookingsAt = startTimeUTC =>
  fixture.commerce.fetch(
    '*[_type == "booking" && (startTimeUTC == $start || originalRequestedStartTimeUTC == $start)]',
    { start: startTimeUTC },
  );
const secondVisitor = payload =>
  fixture.post('/api/holdSlot', {
    startTimeUTC: payload.startTimeUTC,
    packageTitle: payload.packageTitle,
  });
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

const holdRunsOut = async ({ payload }, expiredForMs = 1000) => {
  minutesLater(21);
  const expiresAt = new RealDate(RealDate.now() - expiredForMs).toISOString();
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
  const paid = await fixture.dodoWebhook(
    `payment_${checkout.record.providerOrderId}`,
    'payment.succeeded',
    `window_processing_${checkout.record._id}`,
  );
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

test('a payment that cleared in time books its slot from a late, repeated webhook after cleanup', async () => {
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  await fixture.commerce
    .patch(checkout.record._id)
    .set({ nextRecoveryAt: new Date(Date.now() + 60 * 60_000).toISOString() })
    .commit();
  assert.equal((await cron()).status, 200);
  const held = await holdFor(checkout.payload);
  assert.equal(held.phase, 'payment_pending');
  assert.equal(held.paymentRecordId, checkout.record._id);
  const event = `window_late_${checkout.record._id}`;
  const first = await fixture.dodoWebhook(`payment_${checkout.record.providerOrderId}`, 'payment.succeeded', event);
  const duplicate = await fixture.dodoWebhook(`payment_${checkout.record.providerOrderId}`, 'payment.succeeded', event);
  const retried = await fixture.dodoWebhook(
    `payment_${checkout.record.providerOrderId}`,
    'payment.succeeded',
    `${event}_retry`,
  );
  for (const response of [first, duplicate, retried]) assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal((await cron()).status, 200);
  await assertBookedOnHeldSlot(checkout);
});

test('an unpaid checkout keeps its slot until the cron confirms nobody paid, then frees it', async () => {
  fixture.setCheckoutPaymentStarted(false);
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  assert.equal(await isOffered(checkout.payload), false);
  const early = await secondVisitor(checkout.payload);
  assert.equal(early.status, 409, JSON.stringify(early));
  assert.equal(early.body.message, paymentInProgress);
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

test('an unpaid checkout in a provider outage keeps its slot after recovery gives up, freed a day later', async () => {
  fixture.setCheckoutPaymentStarted(false);
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  fixture.setProviderLookupFailure(true);
  assert.ok([200, 503].includes((await cron()).status));
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
  await cronUntilRecoveryStops(checkout);
  assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
  await holdRunsOut(checkout, 25 * 60 * 60_000);
  assert.ok([200, 503].includes((await cron()).status));
  assert.equal((await holdFor(checkout.payload)).phase, 'expired');
  assert.equal(await isOffered(checkout.payload), true);
  assert.equal((await secondVisitor(checkout.payload)).status, 200);
});

const addStaleRecheckRecords = async (checkout, count, { label = 'stale', state = 'unknown', expiresAt } = {}) => {
  const { _id, _rev, _createdAt, _updatedAt, ...fields } = await fixture.commerce.getDocument(checkout.record._id);
  const longAgo = '2000-01-01T00:00:00.000Z';
  for (let index = 0; index < count; index += 1) {
    await fixture.commerce.create({
      ...fields,
      _id: `paymentRecord.session.0-${label}-${index}`,
      status: 'needs_recovery',
      providerPaymentState: state,
      providerStateCheckedAt: longAgo,
      holdSnapshot: { ...fields.holdSnapshot, slotHoldId: '', slotHoldExpiresAt: expiresAt || longAgo },
      providerOrderId: `${fields.providerOrderId}_${label}_${index}`,
      providerIdempotencyKey: `${fields.providerIdempotencyKey}_${label}_${index}`,
      sessionScope: `${fields.sessionScope}:${label}:${index}`,
      startClaimId: `${fields.startClaimId}.${label}.${index}`,
      couponReservationId: '',
      providerPaymentId: '',
      paymentProofClaimId: '',
      bookingId: '',
      lateCaptureWatchUntil: '',
    });
  }
};

test('a payment still going through when recovery gives up keeps its slot once Dodo says it succeeded', async () => {
  fixture.setPaymentAmountOverrides({ status: 'processing' });
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  assert.equal((await cron()).status, 200);
  fixture.setProviderLookupFailure(true);
  await cronUntilRecoveryStops(checkout);
  const hold = await holdFor(checkout.payload);
  assert.equal(hold.phase, 'payment_pending');
  assert.equal(hold.paymentRecordId, checkout.record._id);
  assert.equal(await isOffered(checkout.payload), false);
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
  assert.equal((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentState, 'unknown');
  await addStaleRecheckRecords(checkout, 260);
  await addStaleRecheckRecords(checkout, 260, { label: 'review', state: 'succeeded' });
  await addStaleRecheckRecords(checkout, 300, { label: 'waiting', expiresAt: new Date().toISOString() });
  fixture.setProviderLookupFailure(false);
  fixture.setPaymentAmountOverrides({ status: 'succeeded' });
  for (let hour = 0; hour < 4; hour += 1) {
    clockShiftMs += 60 * 60_000;
    for (let run = 0; run < 12; run += 1) assert.ok([200, 503].includes((await cron()).status));
  }
  assert.equal((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentState, 'succeeded');
  await holdRunsOut(checkout, 25 * 60 * 60_000);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
});

const adminStatus = (bookingId, status) =>
  fixture.post('/api/ref/updateBookingStatus', { bookingId, status }, '', { 'x-admin-key': 'fixture-only-admin' });

test('an admin restoring an old booking cannot take a slot whose payment is still clearing', async () => {
  fixture.setPaymentAmountOverrides({ status: 'processing' });
  const checkout = await startCheckoutBeforeExpiry();
  const cancelled = `booking.fixture.cancelled.${checkout.record._id.slice(-12)}`;
  await fixture.commerce.create({
    _id: cancelled,
    _type: 'booking',
    backendOwner: 'supabase',
    cutoverGeneration: 0,
    status: 'cancelled',
    startTimeUTC: checkout.payload.startTimeUTC,
    packageTitle: checkout.payload.packageTitle,
    email: 'earlier@example.invalid',
  });
  await holdRunsOut(checkout);
  assert.equal((await cron()).status, 200);
  const restored = await adminStatus(cancelled, 'captured');
  assert.equal(restored.status, 409, JSON.stringify(restored));
  assert.equal((await fixture.commerce.getDocument(cancelled)).status, 'cancelled');
  fixture.setPaymentAmountOverrides({});
  const paid = await fixture.dodoWebhook(
    `payment_${checkout.record.providerOrderId}`,
    'payment.succeeded',
    `window_admin_${checkout.record._id}`,
  );
  assert.equal(paid.status, 200, JSON.stringify(paid));
  const booking = (await bookingsAt(checkout.payload.startTimeUTC)).find(
    entry => entry.paymentRecordId === checkout.record._id,
  );
  assert.equal(booking.startTimeUTC, checkout.payload.startTimeUTC);
  assert.notEqual(booking.requiresReschedule, true);
});

const stopRecovery = async (checkout, values = {}) =>
  fixture.commerce
    .patch(checkout.record._id)
    .set({
      reconciliationRecoveryTerminal: true,
      nextRecoveryAt: '9999-12-31T23:59:59.999Z',
      ...values,
    })
    .commit();

test('an unreachable checkout with no payment seen frees its slot a day after the hold ran out', async () => {
  fixture.setCheckoutPaymentStarted(false);
  const checkout = await startCheckoutBeforeExpiry();
  await stopRecovery(checkout);
  await holdRunsOut(checkout, 60 * 60_000);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
  await holdRunsOut(checkout, 25 * 60 * 60_000);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkout.payload)).phase, 'expired');
  assert.equal(await isOffered(checkout.payload), true);
  assert.equal((await secondVisitor(checkout.payload)).status, 200);
});

test('a checkout the cron can no longer reach keeps its slot when Dodo says the payment succeeded', async () => {
  const checkout = await startCheckoutBeforeExpiry();
  await stopRecovery(checkout, {
    providerPaymentId: `payment_${checkout.record.providerOrderId}`,
    providerPaymentState: 'succeeded',
  });
  await holdRunsOut(checkout, 25 * 60 * 60_000);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
  assert.equal(await isOffered(checkout.payload), false);
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
});

test('a verified payment refunded before booking frees its slot a day after the hold ran out', async () => {
  const checkout = await startCheckoutBeforeExpiry();
  await stopRecovery(checkout, {
    status: 'needs_recovery',
    verificationState: 'server_verified',
    providerPaymentState: 'succeeded',
    providerStateCheckedAt: '2000-01-01T00:00:00.000Z',
  });
  fixture.setPaymentAmountOverrides({ refund_status: 'full' });
  clockShiftMs += 2 * 60 * 60_000;
  assert.equal((await cron()).status, 200);
  assert.equal((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentState, 'refunded');
  await holdRunsOut(checkout, 25 * 60 * 60_000);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkout.payload)).phase, 'expired');
  assert.equal((await secondVisitor(checkout.payload)).status, 200);
});

test('an unreachable checkout keeps its slot when the payment was verified before a dispute cleared', async () => {
  const checkout = await startCheckoutBeforeExpiry();
  await stopRecovery(checkout, {
    status: 'needs_recovery',
    verificationState: 'server_verified',
    dodoDisputeActive: false,
  });
  await holdRunsOut(checkout, 25 * 60 * 60_000);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
  assert.equal(await isOffered(checkout.payload), false);
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
});

test('a payment stuck waiting on the customer frees its slot a day after the hold ran out', async () => {
  fixture.setPaymentAmountOverrides({ status: 'requires_customer_action' });
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout, 60 * 60_000);
  assert.equal((await cron()).status, 200);
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
  await holdRunsOut(checkout, 25 * 60 * 60_000);
  await fixture.commerce
    .patch(checkout.record._id)
    .set({ nextRecoveryAt: new Date(Date.now() + 60 * 60_000).toISOString() })
    .commit();
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkout.payload)).phase, 'expired');
  assert.equal(await isOffered(checkout.payload), true);
  assert.equal((await secondVisitor(checkout.payload)).status, 200);
});

for (const [problem, overrides] of [
  ['a wrong amount', { total_amount: 1 }],
  ['malformed disputes', { disputes: {} }],
]) {
  test(`a payment that went through with ${problem} keeps its slot for owner review`, async () => {
    fixture.setPaymentAmountOverrides(overrides);
    const checkout = await startCheckoutBeforeExpiry();
    await holdRunsOut(checkout);
    assert.equal((await cron()).status, 200);
    const record = await fixture.commerce.getDocument(checkout.record._id);
    assert.equal(record.providerRecoveryTerminal, true);
    assert.equal(record.providerPaymentState, 'succeeded');
    const held = await holdFor(checkout.payload);
    assert.equal(held.phase, 'payment_pending');
    assert.equal(held.paymentRecordId, checkout.record._id);
    await holdRunsOut(checkout, 25 * 60 * 60_000);
    assert.equal((await cron()).status, 200);
    assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
    assert.equal((await secondVisitor(checkout.payload)).status, 409);
  });
}

test('a payment that failed our checks while processing keeps its slot once Dodo says it succeeded', async () => {
  fixture.setPaymentAmountOverrides({ status: 'processing', total_amount: 1 });
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  assert.equal((await cron()).status, 200);
  const closed = await fixture.commerce.getDocument(checkout.record._id);
  assert.equal(closed.providerRecoveryTerminal, true);
  assert.equal(closed.providerPaymentState, 'processing');
  fixture.setPaymentAmountOverrides({ status: 'succeeded', total_amount: 1 });
  const paid = await fixture.dodoWebhook(
    `payment_${checkout.record.providerOrderId}`,
    'payment.succeeded',
    `window_mismatch_${checkout.record._id}`,
  );
  assert.equal(paid.status, 409, JSON.stringify(paid));
  assert.equal((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentState, 'succeeded');
  await holdRunsOut(checkout, 25 * 60 * 60_000);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
});

for (const [status, recorded] of [
  ['processing', 'processing'],
  ['', 'unknown'],
]) {
  test(`the cron learns a "${status}" payment that failed our checks went through with no webhook`, async () => {
    fixture.setPaymentAmountOverrides({ status, total_amount: 1 });
    const checkout = await startCheckoutBeforeExpiry();
    await holdRunsOut(checkout);
    assert.equal((await cron()).status, 200);
    assert.equal((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentState, recorded);
    fixture.setPaymentAmountOverrides({ status: 'succeeded', total_amount: 1 });
    clockShiftMs += 2 * 60 * 60_000;
    assert.equal((await cron()).status, 200);
    assert.equal((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentState, 'succeeded');
    await holdRunsOut(checkout, 25 * 60 * 60_000);
    assert.equal((await cron()).status, 200);
    assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
    assert.equal((await secondVisitor(checkout.payload)).status, 409);
  });
}

test('a payment that failed our checks, then was fully refunded, frees its slot a day after expiry', async () => {
  fixture.setPaymentAmountOverrides({ total_amount: 1 });
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  assert.equal((await cron()).status, 200);
  assert.equal((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentState, 'succeeded');
  const paymentId = `payment_${checkout.record.providerOrderId}`;
  const refunded = await fixture.refundPayment(
    paymentId,
    [
      {
        refund_id: `window_refund_${checkout.record._id.slice(-12)}`,
        payment_id: paymentId,
        amount: Math.round(checkout.record.pricingSnapshot.netAmount * 100),
        currency: 'USD',
        status: 'succeeded',
      },
    ],
    `window_refund_${checkout.record._id}`,
  );
  assert.equal(refunded.status, 409, JSON.stringify(refunded));
  assert.equal((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentState, 'refunded');
  await holdRunsOut(checkout, 25 * 60 * 60_000);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkout.payload)).phase, 'expired');
  assert.equal(await isOffered(checkout.payload), true);
  assert.equal((await secondVisitor(checkout.payload)).status, 200);
});

test('a customer back from a payment that failed our checks records Dodo success and keeps the slot', async () => {
  fixture.setPaymentAmountOverrides({ status: 'processing', total_amount: 1 });
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  assert.equal((await cron()).status, 200);
  assert.equal((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentState, 'processing');
  fixture.setPaymentAmountOverrides({ status: 'succeeded', total_amount: 1 });
  const returned = await fixture.post('/api/payment/finalize', {}, checkout.started.body.paymentAccessToken);
  assert.equal(returned.status, 409, JSON.stringify(returned));
  assert.equal((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentState, 'succeeded');
  await holdRunsOut(checkout, 25 * 60 * 60_000);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
});

test('a payment that failed our checks, then lost its dispute by expiry, frees its slot a day later', async () => {
  fixture.setPaymentAmountOverrides({ total_amount: 1 });
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  assert.equal((await cron()).status, 200);
  assert.equal((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentState, 'succeeded');
  fixture.setPaymentAmountOverrides({
    total_amount: 1,
    disputes: [{ dispute_id: 'window_dispute', dispute_status: 'dispute_expired' }],
  });
  const disputed = await fixture.dodoWebhook(
    `payment_${checkout.record.providerOrderId}`,
    'dispute.expired',
    `window_dispute_${checkout.record._id}`,
  );
  assert.equal(disputed.status, 409, JSON.stringify(disputed));
  assert.equal((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentState, 'disputed');
  await holdRunsOut(checkout, 25 * 60 * 60_000);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkout.payload)).phase, 'expired');
  assert.equal((await secondVisitor(checkout.payload)).status, 200);
});

test('the cron learns of a refund on a payment in owner review when the refund webhook never arrives', async () => {
  fixture.setPaymentAmountOverrides({ total_amount: 1 });
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  assert.equal((await cron()).status, 200);
  const closed = await fixture.commerce.getDocument(checkout.record._id);
  assert.equal(closed.providerPaymentState, 'succeeded');
  const { _id, _rev, _createdAt, _updatedAt, ...fields } = closed;
  for (let index = 0; index < 80; index += 1) {
    await fixture.commerce.create({
      ...fields,
      _id: `${_id}.filler.${index}`,
      status: 'abandoned',
      providerPaymentState: '',
      providerRecoveryTerminal: false,
      providerOrderId: `${fields.providerOrderId}_filler_${index}`,
      providerIdempotencyKey: `${fields.providerIdempotencyKey}_filler_${index}`,
      sessionScope: `${fields.sessionScope}:filler:${index}`,
      startClaimId: `${fields.startClaimId}.filler.${index}`,
      couponReservationId: '',
      bookingId: '',
      lateCaptureWatchUntil: '',
      reconciliationRecoveryTerminal: true,
      nextRecoveryAt: '9999-12-31T23:59:59.999Z',
    });
  }
  fixture.setPaymentAmountOverrides({ total_amount: 1, refund_status: 'full' });
  clockShiftMs += 2 * 60 * 60_000;
  assert.equal((await cron()).status, 200);
  assert.equal((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentState, 'refunded');
  await holdRunsOut(checkout, 25 * 60 * 60_000);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkout.payload)).phase, 'expired');
  assert.equal((await secondVisitor(checkout.payload)).status, 200);
});

test('a late processing webhook cannot undo a recorded success on a payment that failed our checks', async () => {
  fixture.setPaymentAmountOverrides({ status: 'processing', total_amount: 1 });
  const checkout = await startCheckoutBeforeExpiry();
  await holdRunsOut(checkout);
  assert.equal((await cron()).status, 200);
  const paymentId = `payment_${checkout.record.providerOrderId}`;
  fixture.setPaymentAmountOverrides({ status: 'succeeded', total_amount: 1 });
  assert.equal(
    (await fixture.dodoWebhook(paymentId, 'payment.succeeded', `window_order_ok_${checkout.record._id}`)).status,
    409,
  );
  fixture.setPaymentAmountOverrides({ status: 'processing', total_amount: 1 });
  assert.equal(
    (await fixture.dodoWebhook(paymentId, 'payment.processing', `window_order_late_${checkout.record._id}`)).status,
    409,
  );
  assert.equal((await fixture.commerce.getDocument(checkout.record._id)).providerPaymentState, 'succeeded');
  await holdRunsOut(checkout, 25 * 60 * 60_000);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
});

for (const entry of ['webhook', 'cron', 'retry', 'reload']) {
  test(`merchant review through ${entry} keeps the slot beyond the cleanup backstop`, async () => {
    fixture.setPaymentAmountOverrides({ status: 'requires_merchant_action' });
    const checkout = await startCheckoutBeforeExpiry();
    const paymentId = `payment_${checkout.record.providerOrderId}`;
    const alerts = [];
    const reportKey = Symbol.for('roo.reportServerError');
    const previousReporter = globalThis[reportKey];
    globalThis[reportKey] = (label, error) => alerts.push({ label, code: error.code });
    try {
      if (entry === 'webhook') {
        const pending = await fixture.dodoWebhook(paymentId, 'payment.processing', `review_${entry}`);
        assert.equal(pending.status, 503, JSON.stringify(pending));
        assert.equal(pending.body.providerPaymentState, 'requires_merchant_action');
      } else if (entry === 'cron') {
        assert.equal((await cron()).status, 200);
      } else {
        assert.equal((await fixture.post('/api/payment/finalize', {}, checkout.started.body.paymentAccessToken)).status, 202);
      }
      await holdRunsOut(checkout, 25 * 60 * 60_000);
      assert.equal((await cron()).status, 200);
      assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
      assert.equal(await isOffered(checkout.payload), false);
      assert.equal((await secondVisitor(checkout.payload)).status, 409);
      const reviewed = await fixture.commerce.getDocument(checkout.record._id);
      assert.equal(reviewed.providerPaymentState, 'requires_merchant_action');
      assert.equal(reviewed.recoveryOwnerReviewRequired, true);
      assert.equal(alerts.filter(alert => alert.code === 'payment_merchant_review_required').length, 1);
      const { createPaymentAccessToken } = await import('../src/server/api/payment/accessToken.js');
      const token = createPaymentAccessToken({ paymentRecordId: reviewed._id, provider: reviewed.provider,
        pricingFingerprint: reviewed.pricingFingerprint, backend: 'supabase', cutoverGeneration: 0, expirySeconds: 600 });
      for (let reload = 0; reload < 2; reload += 1) {
        const status = await fixture.post('/api/payment/status', {}, token);
        assert.equal(status.status, 200, JSON.stringify(status));
        assert.equal(status.body.bookingId, '');
      }
      fixture.setPaymentAmountOverrides({});
      const approved = await fixture.dodoWebhook(paymentId, 'payment.succeeded', `approved_${entry}`);
      assert.equal(approved.status, 200, JSON.stringify(approved));
      await assertBookedOnHeldSlot(checkout);
      assert.equal((await fixture.commerce.getDocument(reviewed._id)).recoveryOwnerReviewRequired, false);
    } finally {
      if (previousReporter === undefined) delete globalThis[reportKey];
      else globalThis[reportKey] = previousReporter;
    }
  });
}

for (const recoveryEntry of ['cron', 'webhook', 'retry']) {
  test(`verified capture keeps retrying after twelve failures and completes through ${recoveryEntry}`, async () => {
    fixture.setPaymentAmountOverrides({ status: 'requires_merchant_action' });
    const checkout = await startCheckoutBeforeExpiry();
    assert.equal((await fixture.post('/api/payment/finalize', {}, checkout.started.body.paymentAccessToken)).status, 202);
    fixture.setPaymentAmountOverrides({});
    const sql = fixture.database.sql;
    const alerts = [];
    const reportKey = Symbol.for('roo.reportServerError');
    const previousReporter = globalThis[reportKey];
    globalThis[reportKey] = (label, error) => alerts.push({ label, code: error.code });
    await sql.unsafe(`create function public.review_booking_failure_fixture()
      returns trigger language plpgsql as $$ begin
        if new.document_type = 'booking' then raise exception 'Synthetic booking write failure'; end if;
        return new;
      end $$;
      create trigger review_booking_failure_fixture before insert on migration.source_documents
      for each row execute function public.review_booking_failure_fixture()`);
    let exhausted;
    try {
      for (let attempt = 0; attempt < 13; attempt += 1) {
        const response = await fixture.post('/api/payment/finalize', {}, checkout.started.body.paymentAccessToken);
        assert.equal(response.status, 202, JSON.stringify(response));
      }
      exhausted = await fixture.commerce.getDocument(checkout.record._id);
      assert.equal(exhausted.verificationState, 'server_verified');
      assert.equal(exhausted.reconciliationRecoveryTerminal, false);
      assert.equal(exhausted.recoveryOwnerReviewRequired, true);
      assert.equal(exhausted.recoveryFailureCount, 12);
      const delay = Date.parse(exhausted.nextRecoveryAt) - Date.now();
      assert.ok(delay > 0 && delay <= 60 * 60_000, String(delay));
      assert.equal(alerts.filter(alert => alert.code === 'payment_recovery_attempts_exhausted').length, 1);
      const early = await cron();
      assert.equal(early.status, 200);
      assert.equal(early.body.summary.scanned, 0);
    } finally {
      await sql.unsafe('drop trigger review_booking_failure_fixture on migration.source_documents');
      await sql.unsafe('drop function public.review_booking_failure_fixture()');
      if (previousReporter === undefined) delete globalThis[reportKey];
      else globalThis[reportKey] = previousReporter;
    }
    clockShiftMs = Date.parse(exhausted.nextRecoveryAt) - RealDate.now() + 1000;
    let recovered;
    if (recoveryEntry === 'cron') recovered = await cron();
    else if (recoveryEntry === 'webhook') recovered = await fixture.dodoWebhook(
      `payment_${checkout.record.providerOrderId}`, 'payment.succeeded', `capture_retry_${checkout.record._id}`);
    else {
      const { createPaymentAccessToken } = await import('../src/server/api/payment/accessToken.js');
      const token = createPaymentAccessToken({ paymentRecordId: exhausted._id, provider: exhausted.provider,
        pricingFingerprint: exhausted.pricingFingerprint, backend: 'supabase', cutoverGeneration: 0, expirySeconds: 600 });
      recovered = await fixture.post('/api/payment/finalize', {}, token);
    }
    assert.equal(recovered.status, 200, JSON.stringify(recovered));
    await assertBookedOnHeldSlot(checkout);
    assert.equal((await cron()).status, 200);
    assert.equal((await bookingsAt(checkout.payload.startTimeUTC)).length, 1);
    const completed = await fixture.commerce.getDocument(exhausted._id);
    assert.equal(completed.recoveryOwnerReviewRequired, false);
    assert.equal(completed.recoveryFailureCount, 0);
  });
}

for (const outcome of ['cancelled', 'refunded']) {
  test(`merchant review releases its reservation when ${outcome}`, async () => {
    fixture.setPaymentAmountOverrides({ status: 'requires_merchant_action' });
    const checkout = await startCheckoutBeforeExpiry();
    assert.equal((await cron()).status, 200);
    await holdRunsOut(checkout, 25 * 60 * 60_000);
    assert.equal((await cron()).status, 200);
    assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
    fixture.setPaymentAmountOverrides(outcome === 'cancelled' ? { status: 'cancelled' } : {});
    const paymentId = `payment_${checkout.record.providerOrderId}`;
    const result = outcome === 'cancelled'
      ? await fixture.dodoWebhook(paymentId, 'payment.cancelled', `review_cancel_${checkout.record._id}`)
      : await fixture.refundPayment(paymentId, [{ refund_id: 'review_refund', payment_id: paymentId,
        amount: Math.round(checkout.record.pricingSnapshot.netAmount * 100), currency: 'USD', status: 'succeeded' }],
      `review_refund_${checkout.record._id}`);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal((await bookingsAt(checkout.payload.startTimeUTC)).length, 0);
    assert.equal((await holdFor(checkout.payload)).phase, 'released');
    assert.equal((await fixture.commerce.getDocument(checkout.record._id)).recoveryOwnerReviewRequired, false);
    assert.equal(await isOffered(checkout.payload), true);
    assert.equal((await secondVisitor(checkout.payload)).status, 200);
  });
}

test('verified capture migration restores retries and saves a reversible recovery state', async () => {
  const checkout = await startCheckoutBeforeExpiry();
  const states = [];
  for (const provider of ['paypal', 'razorpay', 'dodo']) {
    const id = provider === 'dodo' ? checkout.record._id : `paymentRecord.restart-${provider}`;
    const set = { provider, status: 'needs_recovery', verificationState: 'server_verified',
      reconciliationRecoveryTerminal: true, recoveryFailureCount: 12, recoveryAttemptCount: 12,
      nextRecoveryAt: '9999-12-31T23:59:59.999Z' };
    if (provider === 'dodo') await fixture.commerce.patch(id).set(set).commit();
    else await fixture.commerce.create({ _id: id, _type: 'paymentRecord', backendOwner: 'supabase',
      cutoverGeneration: 0, ...set });
    states.push(await fixture.commerce.getDocument(id));
  }
  const excluded = [];
  for (const [reason, values] of Object.entries({
    unverified: { verificationState: '' }, booked: { bookingId: 'booking.already-done' },
    refund: { providerRefundDetailsMissing: true }, disputed: { dodoDisputeActive: true },
    policy: { providerRecoveryTerminal: true },
  })) {
    const id = `paymentRecord.restart-excluded-${reason}`;
    await fixture.commerce.create({ _id: id, _type: 'paymentRecord', backendOwner: 'supabase', cutoverGeneration: 0,
      provider: 'dodo', status: 'needs_recovery', verificationState: 'server_verified',
      reconciliationRecoveryTerminal: true, recoveryFailureCount: 12, recoveryAttemptCount: 12,
      nextRecoveryAt: '9999-12-31T23:59:59.999Z', ...values });
    excluded.push(await fixture.commerce.getDocument(id));
  }
  const candidates = async () => {
    const { data, error } = await fixture.database.client.rpc('roo_fetch_recovery_payment_documents', {
      p_backend: 'supabase', p_statuses: ['needs_recovery'], p_refunded_status: 'refunded',
      p_booked_status: 'booked', p_abandoned_status: 'abandoned', p_now: new Date().toISOString(),
      p_limit: 100, p_dodo_enabled: true,
    });
    assert.equal(error, null);
    return data.map(record => record._id);
  };
  for (const state of states) assert.ok((await candidates()).includes(state._id));
  await fixture.database.apply('20261108000000_resume_captured_payment_bookings.sql');
  for (const state of states) {
    const current = await fixture.commerce.getDocument(state._id);
    assert.equal(current.reconciliationRecoveryTerminal, false);
    assert.equal(current.recoveryOwnerReviewRequired, true);
    const [backup] = await fixture.database.sql`select previous_state, resumed_revision
      from migration.captured_payment_recovery_resumes where document_id = ${state._id}`;
    assert.equal(backup.resumed_revision, current._rev);
    assert.deepEqual(backup.previous_state, { reconciliationRecoveryTerminal: true,
      nextRecoveryAt: '9999-12-31T23:59:59.999Z' });
    await fixture.commerce.patch(state._id).ifRevisionId(backup.resumed_revision)
      .unset(['reconciliationRecoveryTerminal', 'nextRecoveryAt', 'recoveryOwnerReviewRequired'])
      .set(backup.previous_state).commit();
    const restored = await fixture.commerce.getDocument(state._id);
    assert.equal(restored.reconciliationRecoveryTerminal, true);
    assert.equal(restored.nextRecoveryAt, state.nextRecoveryAt);
    assert.equal(restored.recoveryOwnerReviewRequired, undefined);
  }
  for (const original of excluded) assert.deepEqual(await fixture.commerce.getDocument(original._id), original);
  const recovered = await cron();
  assert.equal(recovered.status, 200, JSON.stringify(recovered));
  await assertBookedOnHeldSlot(checkout);
});
