import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
    '*[_type == "booking" && (startTimeUTC == $start || requestedStartTimeUTC == $start || originalRequestedStartTimeUTC == $start)]',
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

const holdMigration = '20261102000000_keep_payment_holds_until_resolved.sql';
const shadowMigration = '20261111000000_keep_payment_hold_claims_in_shadow_refresh.sql';
const migrationText = name => fs.readFileSync(path.join(process.cwd(), 'supabase/migrations', name), 'utf8');
const rollbackText = () => fs.readFileSync(path.join(process.cwd(), 'supabase/rollbacks', shadowMigration), 'utf8');
const originalDefinitions = {
  'migration.reconcile_slot_claims_for_times': 'b7c6c85622ee8eabfff784c8e4805b88',
  'migration.assert_slot_claim_integrity': 'd3bc74fa923444bbfda133ad0bcd32e0',
  'public.roo_fetch_commerce_availability': '1abf74171cbffe29e8a81aec8b8da5cb',
  'public.roo_cleanup_expired_supabase_holds': '1efbfaa0bc2294f1904484a7b3e318b4',
  'public.roo_project_operational_shadow': '39c69cc7898c12b1729e58bb25c1a8d6',
  'public.roo_cleanup_operational_shadow': 'fb8b81cf126eadb7f042f488a2286e39',
  'migration.project_commerce_document_ids_unserialized': '5bba516f0d0e27ebb094410023a75aca',
};
const definitionHashes = async () => {
  const rows = await fixture.database.sql`
    select n.nspname || '.' || p.proname as name, md5(pg_get_functiondef(p.oid)) as hash
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname || '.' || p.proname = any(${Object.keys(originalDefinitions)})`;
  assert.equal(rows.length, 7);
  return Object.fromEntries(rows.map(row => [row.name, row.hash]));
};
const expiryFunctions = async () => {
  const pattern = "phase in \\('active', 'payment'\\)\\s+and hold\\.expires_at";
  const [result] = await fixture.database.sql`
    select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname) as functions
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.prokind = 'f'
      and n.nspname not in ('pg_catalog', 'information_schema')
      and pg_get_functiondef(p.oid) ~ ${pattern}`;
  return result.functions;
};

test('payment hold rollback restores and reapplies both migrations', async () => {
  const before = await definitionHashes();
  await fixture.database.apply(shadowMigration, rollbackText());
  try {
    assert.deepEqual(await definitionHashes(), originalDefinitions);
    assert.deepEqual(await expiryFunctions(), [
      'migration.assert_slot_claim_integrity',
      'migration.project_commerce_document_ids_unserialized',
      'migration.reconcile_slot_claims_for_times',
      'public.roo_cleanup_expired_supabase_holds',
      'public.roo_cleanup_operational_shadow',
      'public.roo_project_operational_shadow',
    ]);
    await fixture.content.create({ _id: 'package.fixture.rollback', _type: 'package', title: 'Rollback' });
    assert.equal((await fixture.content.getDocument('package.fixture.rollback')).title, 'Rollback');
  } finally {
    await fixture.database.apply(holdMigration, migrationText(holdMigration));
    await fixture.database.apply(shadowMigration, migrationText(shadowMigration));
  }
  assert.deepEqual(await definitionHashes(), before);
  assert.equal(await expiryFunctions(), null);
});

test('payment hold rollback refuses an in-progress payment without changing definitions', async () => {
  const checkout = await startCheckoutBeforeExpiry();
  assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
  const before = await definitionHashes();
  await assert.rejects(fixture.database.apply(shadowMigration, rollbackText()), /payment holds are present.*fix forward/i);
  assert.deepEqual(await definitionHashes(), before);
  const paid = await fixture.dodoWebhook(
    `payment_${checkout.record.providerOrderId}`, 'payment.succeeded', `rollback_${checkout.record._id}`,
  );
  assert.equal(paid.status, 200, JSON.stringify(paid));
  await assertBookedOnHeldSlot(checkout);
});

test('a payment still processing when the hold runs out keeps the slot and books it once it clears', async () => {
  fixture.setPaymentAmountOverrides({ status: 'processing' });
  const checkout = await startCheckoutBeforeExpiry();
  const submitted = await cron();
  assert.equal(submitted.status, 200, JSON.stringify(submitted));
  await holdRunsOut(checkout, 3_600_000);
  const expired = await cron();
  assert.equal(expired.status, 200, JSON.stringify(expired));
  await fixture.content.create({ _id: 'package.fixture.shadow-refresh-processing', _type: 'package', title: 'Processing' });
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
  for (let run = 0; run < 14; run += 1) {
    const record = await fixture.commerce.getDocument(checkout.record._id);
    assert.notEqual(record.reconciliationRecoveryTerminal, true);
    assert.notEqual(record.providerRecoveryTerminal, true);
    await fixture.commerce.patch(record._id).set({ nextRecoveryAt: '' }).commit();
    clockShiftMs += 2 * 60_000;
    assert.ok([200, 503].includes((await cron()).status));
  }
  const watched = await fixture.commerce.getDocument(checkout.record._id);
  assert.ok(watched.lateCaptureWatchUntil);
  clockShiftMs = new RealDate(watched.lateCaptureWatchUntil).getTime() - RealDate.now() + 1000;
  for (let run = 0; run < 13; run += 1) {
    const record = await fixture.commerce.getDocument(checkout.record._id);
    if (record.reconciliationRecoveryTerminal === true || record.providerRecoveryTerminal === true) return record;
    await fixture.commerce.patch(record._id).set({ nextRecoveryAt: '' }).commit();
    assert.ok([200, 503].includes((await cron()).status));
  }
  assert.fail('Recovery never stopped after the watch expired');
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
  await fixture.content.create({ _id: 'package.fixture.shadow-refresh-unpaid', _type: 'package', title: 'Unpaid' });
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
  await fixture.content.create({ _id: 'package.fixture.shadow-refresh-paid', _type: 'package', title: 'Paid' });
  assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
  assert.equal(await isOffered(checkout.payload), false);
  assert.equal((await secondVisitor(checkout.payload)).status, 409);
});

test('payment holds are not tied to the original hold expiry', async () => {
  const pattern = "phase in \\('active', 'payment'\\)\\s+and hold\\.expires_at";
  const [result] = await fixture.database.sql`
    select string_agg(oid::regprocedure::text, ',') as functions
    from pg_proc
    where prokind = 'f'
      and pronamespace::regnamespace::text not in ('pg_catalog', 'information_schema')
      and pg_get_functiondef(oid) ~ ${pattern}`;
  assert.equal(result.functions, null);
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
