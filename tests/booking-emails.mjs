import strictAssert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import { createBookingContactFixture } from './fixtures/booking-contact.mjs';

const rollout = process.env.BOOKING_EMAIL_ROLLOUT || '';
strictAssert.ok(['', 'code-first', 'migration-first'].includes(rollout));
let contractDifferences;
const assertion = fn => (...args) => {
  const failed = error => {
    if (!rollout || !contractDifferences) throw error;
    contractDifferences.push(error.message);
  };
  try {
    const result = fn(...args);
    return result?.catch ? result.catch(failed) : result;
  } catch (error) { return failed(error); }
};
const assert = new Proxy(strictAssert, {
  apply: (target, receiver, args) => assertion(target)(...args),
  get: (target, key) => typeof target[key] === 'function' ? assertion(target[key]) : target[key],
});

test('booking confirmation eligibility against PostgreSQL 17', { timeout: 300000 }, async t => {
  const fixture = await createBookingContactFixture();
  const { commerce, database } = fixture;
  const { applyBookingRefund, applyBookingStatusTransition } = await import('../src/server/api/ref/bookingRefunds.js');
  const { reconcileBookingEmailDispatches, dispatchRescheduleNotifications,
    sendBookingEmailsForBooking, getBookingForEmailDispatch } = await import('../src/server/api/ref/bookingEmails.js');
  const { issueBookingEmailDispatchToken } = await import('../src/server/api/ref/bookingEmailDispatchToken.js');
  const { reconcilePaymentSessions } = await import('../src/server/api/payment/flow.js');
  process.env.CRON_SECRET = 'fixture-booking-emails-cron';
  const artifact = new URL(process.env.BOOKING_EMAIL_ARTIFACT || '../test-results/booking-emails/postgres17.json', import.meta.url);
  const results = { rollout, database: fixture.evidence.database, cases: [] };
  const messages = (bookingId = '') => fixture.evidence.providerRequests.filter(request =>
    request.path === '/emails' && (!bookingId || request.body.html?.includes(`>${bookingId}<`)));
  const rows = bookingId => database.sql`
    select dispatch.recipient_type, dispatch.status, dispatch.last_error_code,
      dispatch.attempt_count, dispatch.lease_id, dispatch.lease_expires_at,
      dispatch.next_attempt_at, dispatch.sent_at, dispatch.provider_message_id
    from commerce.email_dispatches dispatch
    join commerce.bookings booking on booking.id = dispatch.booking_id
    where booking.legacy_sanity_id = ${bookingId} and dispatch.dispatch_kind = 'booking_confirmation'
    order by dispatch.recipient_type`;
  let sequence = 0;
  const createdRecordIds = [];
  const create = async ({ provider = 'dodo' } = {}) => {
    const id = ++sequence;
    const bookingId = `booking.emails.${id}`;
    const paymentRecordId = `paymentRecord.emails.${id}`;
    const booking = await commerce.create({
      _id: bookingId, _type: 'booking', backendOwner: 'supabase', cutoverGeneration: 0,
      ...fixture.details, status: 'captured', paymentProvider: provider, paymentRecordId,
      ...(provider === 'paypal' ? { paypalOrderId: `order_emails_${id}` } : {}),
      ...(provider === 'razorpay' ? { razorpayOrderId: `order_emails_${id}`, razorpayPaymentId: `payment_emails_${id}` } : {}),
      packageTitle: 'Vertex Essentials', packagePrice: '$29.95',
      currency: 'USD', grossAmount: 29.95, netAmount: 29.95, dodoTotalAmount: 29.95,
      startTimeUTC: new Date(Date.UTC(2099, 0, id, 4, 30)).toISOString(),
      hostDate: 'January 2099', hostTime: '10:00 AM', hostTimeZone: 'Asia/Kolkata',
      displayDate: 'January 2099', displayTime: '10:00 AM',
      emailDispatchDeferred: true, emailDispatchStatus: 'pending',
    });
    const record = await commerce.create({
      _id: paymentRecordId, _type: 'paymentRecord', backendOwner: 'supabase', cutoverGeneration: 0,
      provider, status: 'email_partial', bookingId, emailDispatchRequired: true,
      providerOrderId: provider === 'paypal' || provider === 'razorpay' ? `order_emails_${id}` : `session_emails_${id}`,
      providerPaymentId: `payment_emails_${id}`,
      bookingPayload: { ...fixture.details, packageTitle: booking.packageTitle, netAmount: 29.95, currency: 'USD' },
      providerPublicData: { totalAmount: 2995, currency: 'USD' },
    });
    createdRecordIds.push(record._id);
    return { bookingId, record, emailDispatchToken: issueBookingEmailDispatchToken({
      bookingId, email: booking.email, backend: 'supabase', cutoverGeneration: 0,
    }) };
  };
  const confirm = ({ bookingId, emailDispatchToken }) =>
    fixture.post('/api/ref/sendBookingEmails', { bookingId, emailDispatchToken });
  const replay = async booking => {
    const saved = await commerce.getDocument(booking.bookingId);
    return fixture.post('/api/ref/createBooking', { ...fixture.details,
      packageTitle: saved.packageTitle, packagePrice: saved.packagePrice,
      paymentProvider: saved.paymentProvider, paymentRecordId: saved.paymentRecordId,
      paypalOrderId: saved.paypalOrderId,
      razorpayOrderId: saved.razorpayOrderId, razorpayPaymentId: saved.razorpayPaymentId,
      status: 'captured', startTimeUTC: saved.startTimeUTC, deferEmailsUntilConfirmation: true });
  };
  const conflictAfterRead = (booking, changes, result) => {
    let reads = 0;
    let changing = false;
    result.conflicts = 0;
    database.setRequestHook(async (phase, request) => {
      if (changing || phase !== 'after' || !request.path.endsWith('/roo_fetch_shadow_documents_targeted') ||
          !request.body.p_document_types?.includes('booking') || !request.body.p_ids?.includes(booking.bookingId)) return;
      reads += 1;
      if (reads < 3 || result.conflicts >= changes.length) return;
      changing = true;
      try { await changes[result.conflicts++](booking); } finally { changing = false; }
    });
  };
  const transition = (bookingId, status) => applyBookingStatusTransition({ client: commerce, bookingId, status });
  const inactive = async (booking, status) => {
    if (status === 'refunded') {
      await applyBookingRefund({ client: commerce, paymentRecord: booking.record,
        refund: { full: true, id: `refund-${booking.bookingId}`, amount: 29.95, currency: 'USD' } });
    } else if (status === 'canceled' || status !== status.trim()) {
      await commerce.patch(booking.bookingId).set({ status }).commit();
    } else {
      await transition(booking.bookingId, status);
    }
  };
  const assertSuppressed = saved => {
    assert.equal(saved.length, 2);
    for (const row of saved) {
      assert.equal(row.status, 'failed');
      assert.equal(row.last_error_code, 'booking_inactive');
      for (const field of ['sent_at', 'provider_message_id', 'lease_id', 'lease_expires_at', 'next_attempt_at']) {
        assert.equal(row[field], null, field);
      }
    }
  };
  const recoveryCandidates = async () => {
    const { data, error } = await database.client.rpc('roo_fetch_recovery_payment_documents', {
      p_backend: 'supabase', p_statuses: ['started', 'captured_client', 'captured_webhook',
        'finalizing', 'email_partial', 'needs_recovery'], p_refunded_status: 'refunded',
      p_booked_status: 'booked', p_abandoned_status: 'abandoned',
      p_now: new Date().toISOString(), p_limit: 100, p_dodo_enabled: true,
    });
    assert.equal(error, null);
    return data.map(record => record._id);
  };
  const isolateRecovery = async booking => {
    for (const id of createdRecordIds.filter(id => id !== booking.record._id)) {
      await commerce.patch(id).set({ status: 'booked', emailDispatchRequired: false,
        nextRecoveryAt: '', refundRequiresBookingSync: false, resourceReleasePending: false }).commit();
    }
  };
  const recover = () => reconcilePaymentSessions({ client: commerce, backend: 'supabase',
    req: { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } } });
  const check = async (name, run) => t.test(name, {
    skip: !!process.env.BOOKING_EMAIL_SCENARIO && !name.includes(process.env.BOOKING_EMAIL_SCENARIO),
  }, async () => {
    const result = { name, contractDifferences: [] };
    const transportStart = messages().length;
    const firstBooking = sequence + 1;
    const httpStart = fixture.evidence.http.length;
    contractDifferences = result.contractDifferences;
    results.cases.push(result);
    try {
      await run(result);
      result.contract = result.contractDifferences.length ? 'fail' : 'pass';
      result.transports = messages().slice(transportStart);
      result.http = fixture.evidence.http.slice(httpStart);
      if (rollout) {
        const confirmations = result.transports.filter(request =>
          request.body.html.includes('Booking Received') || request.body.html.includes('New Booking'));
        strictAssert.ok(confirmations.every(request => request.bookings?.length === 1), 'Transport status must be observed');
        strictAssert.ok(confirmations.every(request =>
          !['failed', 'refunded', 'cancelled', 'canceled'].includes(String(request.bookings[0].status || '').trim().toLowerCase())),
        'Inactive booking reached confirmation transport');
        const ownConfirmations = confirmations.filter(request =>
          Number(request.bookings[0].id.split('.').at(-1)) >= firstBooking);
        if (name.startsWith('active classification') || name.startsWith('active deferred replay') || name.startsWith('partial refund') ||
            name.startsWith('suppressed never-attempted') || name.startsWith('projection-only') ||
            name.startsWith('reactivation')) {
          strictAssert.deepEqual(ownConfirmations.map(request => request.body.to).sort(),
            ['owner@example.invalid', 'visitor@example.invalid'], 'Active recipients must each send exactly once');
          const activeResponse = result.reactivatedResponse || result.response;
          if (activeResponse) strictAssert.equal(activeResponse.status ?? activeResponse.httpStatus, 200,
            'Active flow must return success');
          if (name.startsWith('reactivation makes')) strictAssert.ok(result.ledger.every(row => row.status === 'sent'),
            'Active recovery must send without waiting for replay');
        }
      }
      result.result = 'pass';
    } catch (error) {
      result.result = 'fail';
      result.error = error.message;
      if (rollout && name.startsWith('missing current booking') && messages().length === transportStart) {
        result.contract = 'fail';
        result.result = 'pass';
      } else throw error;
    } finally {
      database.setRequestHook(null);
      contractDifferences = null;
      result.bookings = Array.from({ length: sequence - firstBooking + 1 }, (_, index) => `booking.emails.${firstBooking + index}`);
      result.transports = messages().slice(transportStart);
      result.http = fixture.evidence.http.slice(httpStart);
      results.transportCalls = messages();
      fs.mkdirSync(new URL('.', artifact), { recursive: true });
      fs.writeFileSync(artifact, JSON.stringify(results, null, 2));
    }
  });

  try {
    for (const status of ['refunded', 'cancelled', 'failed', 'canceled', ' cancelled ']) {
      await check(`${status}: signed confirmation suppresses both recipients`, async result => {
        const booking = await create();
        const before = messages(booking.bookingId).length;
        await inactive(booking, status);
        result.response = await confirm(booking);
        result.ledger = await rows(booking.bookingId);
        result.transportCalls = messages(booking.bookingId).slice(before);
        assert.equal(result.transportCalls.length, 0);
        assertSuppressed(result.ledger);
        assert.equal(result.response.body.ok, false);
        assert.equal(result.response.body.retryable, false);
        assert.equal(result.response.body.emailDispatch.allSent, false);
        assert.ok(result.response.status >= 400);
      });
      await check(`${status}: reconciliation and replay never reclaim suppression`, async result => {
        const booking = await create();
        await inactive(booking, status);
        await confirm(booking);
        const before = messages(booking.bookingId).length;
        const saved = await rows(booking.bookingId);
        await commerce.patch(booking.bookingId).set({ message: 'Unrelated booking update' }).commit();
        await database.sql`select migration.project_commerce_extensions(array[${booking.bookingId}])`;
        result.recovery = await reconcileBookingEmailDispatches({ client: commerce,
          now: new Date(Date.now() + 3600000).toISOString(), limit: 100 });
        result.replay = await confirm(booking);
        result.claims = [];
        for (const recipient of ['customer', 'owner']) {
          const { data, error } = await database.client.rpc('roo_claim_booking_email_dispatch', {
            p_booking_legacy_id: booking.bookingId, p_dispatch_kind: 'booking_confirmation',
            p_recipient_type: recipient, p_lease_id: crypto.randomUUID(), p_lease_seconds: 120,
          });
          assert.equal(error, null);
          result.claims.push(data);
        }
        result.ledger = await rows(booking.bookingId);
        assert.equal(messages(booking.bookingId).length, before);
        assertSuppressed(result.ledger);
        assert.deepEqual(result.ledger.map(row => row.attempt_count), saved.map(row => row.attempt_count));
        assert.ok(result.claims.every(claim => claim.claimed === false && claim.in_progress === false));
        assert.equal(result.replay.body.retryable, false);
      });
    }

    await check('inactive confirmation rows are terminal at first projection and with a live foreign lease', async result => {
      const booking = await create();
      await commerce.patch(booking.bookingId).set({
        emailDispatchLeaseId: 'foreign-live-lease',
        emailDispatchLeaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
        status: ' cancelled ',
      }).commit();
      result.projected = await rows(booking.bookingId);
      const { data, error } = await database.client.rpc('roo_claim_booking_email_dispatch', {
        p_booking_legacy_id: booking.bookingId, p_dispatch_kind: 'booking_confirmation',
        p_recipient_type: 'customer', p_lease_id: 'new-dispatch-lease', p_lease_seconds: 120,
      });
      assert.equal(error, null);
      result.claim = data;
      assertSuppressed(result.projected);
      assert.equal(data.claimed, false);
      assert.equal(data.in_progress, false);
      assert.equal(data.booking_inactive, true);
    });

    await check('email recovery excludes unattempted inactive work and keeps sent timestamp repair', async result => {
      const booking = await create();
      await inactive(booking, 'cancelled');
      const { data, error } = await database.client.rpc('roo_list_email_dispatch_recovery_bookings', {
        p_dispatch_kind: 'booking_confirmation', p_now: new Date().toISOString(), p_limit: 100,
      });
      assert.equal(error, null);
      result.candidates = data;
      assert.ok(!data.includes(booking.bookingId));
      await commerce.patch(booking.bookingId).set({ status: 'captured' }).commit();
      await confirm(booking);
      await commerce.patch(booking.bookingId).unset(['emailDispatchClientSentAt']).commit();
      const repaired = await reconcileBookingEmailDispatches({ client: commerce, limit: 100 });
      result.repaired = repaired;
      assert.ok((await commerce.getDocument(booking.bookingId)).emailDispatchClientSentAt);
      const sentCalls = messages(booking.bookingId).length;
      await commerce.patch(booking.bookingId).unset(['emailDispatchClientSentAt']).commit();
      await inactive(booking, 'cancelled');
      await reconcileBookingEmailDispatches({ client: commerce, limit: 100 });
      assert.ok((await commerce.getDocument(booking.bookingId)).emailDispatchClientSentAt);
      assert.equal(messages(booking.bookingId).length, sentCalls);
    });

    await check('payment recovery excludes inactive confirmations but retains independent recovery duties', async result => {
      const active = await create();
      const inactiveBooking = await create();
      const refund = await create();
      const release = await create();
      const reschedule = await create();
      for (const booking of [inactiveBooking, refund, release, reschedule]) await inactive(booking, ' cancelled ');
      await commerce.patch(refund.record._id).set({ status: 'refunded', refundRequiresBookingSync: true }).commit();
      await commerce.patch(release.record._id).set({ status: 'abandoned', resourceReleasePending: true }).commit();
      await commerce.patch(reschedule.record._id).set({ requiresReschedule: true }).commit();
      result.candidates = await recoveryCandidates();
      assert.ok(result.candidates.includes(active.record._id));
      assert.ok(!result.candidates.includes(inactiveBooking.record._id));
      for (const booking of [refund, release, reschedule]) assert.ok(result.candidates.includes(booking.record._id));
    });

    await check('payment recovery terminalizes a status flip after candidate selection without retrying', async result => {
      const booking = await create();
      await isolateRecovery(booking);
      await commerce.patch(booking.record._id).set({ recoveryAttemptCount: 3 }).commit();
      let changed = false;
      database.setRequestHook(async (phase, request) => {
        if (!changed && phase === 'after' && request.path.endsWith('/roo_fetch_recovery_payment_documents')) {
          changed = true;
          await inactive(booking, 'cancelled');
        }
      });
      const before = messages(booking.bookingId).length;
      result.recovery = await recover();
      assert.equal(changed, true);
      result.record = await commerce.getDocument(booking.record._id);
      assert.equal(result.record.emailDispatchRequired, false);
      assert.equal(result.record.recoveryAttemptCount, 3);
      assert.equal(result.record.nextRecoveryAt || '', '');
      assert.equal(result.record.recoveryReason, 'booking_inactive');
      assert.equal(result.record.emailDeliveryReviewRequired, false);
      assert.equal(result.record.emailDispatch.allSent, false);
      assert.equal(messages(booking.bookingId).length, before);
      result.secondRecovery = await recover();
      assert.equal(messages(booking.bookingId).length, before);
      strictAssert.equal((await commerce.getDocument(booking.record._id))._rev, result.record._rev,
        'Suppressed payment recovery must not run again');
    });

    await check('deferred paid replay preserves inactive aggregate and recipient suppression', async result => {
      const booking = await create({ provider: 'paypal' });
      await inactive(booking, 'cancelled');
      await confirm(booking);
      const saved = await commerce.getDocument(booking.bookingId);
      result.response = await fixture.post('/api/ref/createBooking', { ...fixture.details,
        packageTitle: saved.packageTitle, packagePrice: saved.packagePrice,
        paymentProvider: 'paypal', paypalOrderId: saved.paypalOrderId, status: 'captured',
        startTimeUTC: saved.startTimeUTC, deferEmailsUntilConfirmation: true });
      result.booking = await commerce.getDocument(booking.bookingId);
      result.ledger = await rows(booking.bookingId);
      assert.equal(result.booking.emailDispatchStatus, 'failed');
      assert.equal(result.booking.emailDispatchLastError, 'booking_inactive');
      assert.equal(result.booking.emailDispatchNextAttemptAt || '', '');
      assertSuppressed(result.ledger);
    });

    for (const provider of ['paypal', 'razorpay']) {
      for (const status of ['cancelled', 'refunded']) {
        await check(`${provider}: inactive ${status} create replay succeeds and clears payment email work`, async result => {
          const booking = await create({ provider });
          await inactive(booking, status);
          result.response = await replay(booking);
          result.record = await commerce.getDocument(booking.record._id);
          assert.equal(result.response.status, 200, JSON.stringify(result.response));
          assert.equal(result.response.body.bookingId, booking.bookingId);
          assert.equal(result.response.body.idempotent, true);
          assert.equal(result.response.body.emailDispatch?.suppressed, true);
          assert.equal(result.response.body.emailDispatch?.allSent, false);
          for (const recipient of ['client', 'owner']) {
            assert.equal(result.response.body.emailDispatch?.[recipient]?.sent, false);
            assert.equal(result.response.body.emailDispatch?.[recipient]?.skippedReason, 'booking_inactive');
          }
          assert.equal(result.record.emailDispatchRequired, false);
          assert.equal(result.record.emailDispatchToken || '', '');
          result.replay = await replay(booking);
          assert.equal(result.replay.status, 200);
          await isolateRecovery(booking);
          const saved = await commerce.getDocument(booking.record._id);
          result.recovery = await recover();
          assert.equal((await commerce.getDocument(booking.record._id))._rev, saved._rev);
          assert.equal(messages(booking.bookingId).length, 0);
        });
      }
      for (const recordStatus of ['refunded', 'failed', 'abandoned']) {
        await check(`${provider}: suppressed create replay preserves a ${recordStatus} payment record`, async result => {
          const booking = await create({ provider });
          await inactive(booking, recordStatus === 'refunded' ? 'refunded' : 'cancelled');
          await commerce.patch(booking.record._id).set({ status: recordStatus, emailDispatchRequired: true,
            emailDispatchToken: 'stale-confirmation-token', refundRequiresBookingSync: recordStatus === 'refunded' }).commit();
          result.response = await replay(booking);
          result.record = await commerce.getDocument(booking.record._id);
          assert.equal(result.response.status, 200);
          assert.equal(result.record.status, recordStatus);
          assert.equal(result.record.refundRequiresBookingSync, recordStatus === 'refunded');
          assert.equal(result.record.emailDispatchRequired, false);
          assert.equal(result.record.emailDispatchToken, '');
          assert.equal(messages(booking.bookingId).length, 0);
        });
      }
    }

    await check('inactive create replay reports suppression even with prior delivery receipts', async result => {
      const booking = await create({ provider: 'paypal' });
      await confirm(booking);
      const before = messages(booking.bookingId).length;
      await inactive(booking, 'cancelled');
      result.response = await replay(booking);
      result.ledger = await rows(booking.bookingId);
      assert.equal(result.response.status, 200);
      assert.equal(result.response.body.emailDispatch?.allSent, false);
      assert.equal(result.response.body.emailDispatch?.client?.sent, false);
      assert.equal(result.response.body.emailDispatch?.owner?.sent, false);
      assert.ok(result.ledger.every(row => row.status === 'sent'));
      assert.equal(messages(booking.bookingId).length, before);
    });

    await check('reactivation during create replay reports the actual active delivery', async result => {
      const booking = await create({ provider: 'paypal' });
      await inactive(booking, 'cancelled');
      conflictAfterRead(booking, [value => commerce.patch(value.bookingId).set({ status: 'captured' }).commit()], result);
      result.response = await replay(booking);
      database.setRequestHook(null);
      await confirm({ ...booking, emailDispatchToken: result.response.body.emailDispatchToken || booking.emailDispatchToken });
      assert.equal(result.conflicts, 1);
      assert.equal(result.response.status, 200);
      assert.equal(result.response.body.emailDispatch?.allSent, true);
      assert.equal(result.response.body.emailDispatch?.client?.sent, true);
      assert.equal(result.response.body.emailDispatch?.owner?.sent, true);
      assert.equal(messages(booking.bookingId).length, 2);
    });

    for (const status of ['cancelled', 'refunded']) {
      await check(`${status}: deferred replay rechecks inactivity after a revision conflict`, async result => {
        const booking = await create({ provider: 'paypal' });
        conflictAfterRead(booking, [value => inactive(value, status)], result);
        result.response = await replay(booking);
        database.setRequestHook(null);
        result.booking = await commerce.getDocument(booking.bookingId);
        result.record = await commerce.getDocument(booking.record._id);
        assert.equal(result.conflicts, 1);
        assert.equal(result.response.status, 200, JSON.stringify(result.response));
        assert.equal(result.response.body.idempotent, true);
        assert.equal(result.response.body.emailDispatch?.suppressed, true);
        assert.equal(result.response.body.emailDispatch?.allSent, false);
        assert.equal(result.record.emailDispatchRequired, false);
        assert.equal(result.booking.status, status);
        assert.equal(result.booking.emailDispatchLastError, 'booking_inactive');
        assert.equal(messages(booking.bookingId).length, 0);
      });
    }

    for (const conflicts of [1, 2]) {
      await check(`active deferred replay succeeds after ${conflicts} revision conflicts`, async result => {
        const booking = await create({ provider: 'paypal' });
        conflictAfterRead(booking, Array.from({ length: conflicts }, (_, index) => value =>
          commerce.patch(value.bookingId).set({ message: `Concurrent update ${index + 1}` }).commit()), result);
        result.response = await replay(booking);
        database.setRequestHook(null);
        result.booking = await commerce.getDocument(booking.bookingId);
        assert.equal(result.conflicts, conflicts);
        assert.equal(result.response.status, 200, JSON.stringify(result.response));
        assert.equal(result.response.body.idempotent, true);
        assert.equal(result.response.body.emailDispatch?.deferred, true);
        assert.equal(result.response.body.emailDispatch?.allSent, false);
        assert.equal(result.booking.message, `Concurrent update ${conflicts}`);
        if (conflicts === 1) assert.ok(result.booking.emailDispatchQueuedAt);
        else assert.ok(!result.booking.emailDispatchQueuedAt);
        result.confirmation = await confirm({ ...booking, emailDispatchToken: result.response.body.emailDispatchToken });
        await confirm({ ...booking, emailDispatchToken: result.response.body.emailDispatchToken });
        assert.equal(result.confirmation.status, 200);
        assert.equal(messages(booking.bookingId).length, 2);
      });
    }

    await check('payment finalization accepts an existing inactive booking without scheduling confirmation recovery', async result => {
      const startTimeUTC = '2099-08-01T04:30:00.000Z';
      const held = await fixture.post('/api/holdSlot', { startTimeUTC, packageTitle: 'Vertex Essentials' });
      assert.equal(held.status, 200, JSON.stringify(held));
      const payload = { ...fixture.details, packageTitle: 'Vertex Essentials', startTimeUTC,
        slotHoldId: held.body.holdId, slotHoldToken: held.body.holdToken, deferEmailsUntilConfirmation: true };
      const started = await fixture.start(payload);
      assert.equal(started.status, 200);
      const record = await commerce.fetch('*[_type == "paymentRecord" && bookingPayload.slotHoldId in $holdIds][0]',
        { holdIds: [payload.slotHoldId] });
      assert.ok(record);
      const bookingId = 'booking.emails.finalize';
      await commerce.create({ _id: bookingId, _type: 'booking', backendOwner: 'supabase', cutoverGeneration: 0,
        ...payload, packagePrice: '$29.95', grossAmount: 29.95, netAmount: 29.95, currency: 'USD',
        status: 'cancelled', paymentProvider: 'dodo', paymentRecordId: record._id,
        dodoCheckoutSessionId: record.providerOrderId, dodoPaymentId: `payment_${record.providerOrderId}`,
        emailDispatchDeferred: true, emailDispatchStatus: 'pending' });
      await commerce.patch(record._id).set({ bookingId }).commit();
      result.response = await fixture.post('/api/payment/finalize', {}, started.body.paymentAccessToken);
      result.record = await commerce.getDocument(record._id);
      assert.equal(result.response.status, 200, JSON.stringify(result.response));
      assert.equal(result.response.body.bookingId, bookingId);
      assert.equal(result.record.status, 'email_partial');
      assert.equal(result.record.emailDispatch.suppressed, true);
      assert.equal(result.record.emailDispatchRequired, false);
      assert.equal(result.record.nextRecoveryAt || '', '');
      assert.equal(result.record.finalizationLeaseId || '', '');
      assert.equal(messages(bookingId).length, 0);
    });

    for (const unavailable of ['configuration', 'recipients']) {
      await check(`inactive suppression precedes missing ${unavailable}`, async result => {
        const booking = await create();
        const previousFrom = process.env.FROM_EMAIL;
        const previousOwner = process.env.OWNER_EMAIL;
        try {
          if (unavailable === 'configuration') process.env.FROM_EMAIL = '';
          else {
            process.env.OWNER_EMAIL = '';
            await commerce.patch(booking.bookingId).set({ email: '', payerEmail: '' }).commit();
            await database.sql`update migration.source_documents set payload = payload - 'ownerEmail'
              where document_type = 'bookingSettings'`;
          }
          await inactive(booking, 'cancelled');
          const before = await commerce.getDocument(booking.bookingId);
          const calls = messages(booking.bookingId).length;
          result.response = await sendBookingEmailsForBooking({ client: commerce, bookingId: booking.bookingId });
          result.booking = await commerce.getDocument(booking.bookingId);
          assert.equal(result.response.body.code, 'booking_inactive');
          assert.equal(result.response.body.retryable, false);
          assert.equal(result.response.body.emailDispatch.allSent, false);
          assert.equal(result.booking.emailDispatchAttemptCount || 0, before.emailDispatchAttemptCount || 0);
          assert.equal(result.booking.emailDispatchLastAttemptAt, before.emailDispatchLastAttemptAt);
          assert.equal(result.booking.emailDispatchClientFirstAttemptAt, before.emailDispatchClientFirstAttemptAt);
          assert.equal(result.booking.emailDispatchOwnerFirstAttemptAt, before.emailDispatchOwnerFirstAttemptAt);
          assert.equal(messages(booking.bookingId).length, calls);
        } finally {
          process.env.FROM_EMAIL = previousFrom;
          process.env.OWNER_EMAIL = previousOwner;
          await database.sql`update migration.source_documents set payload = payload || '{"ownerEmail":"owner@example.invalid"}'::jsonb
            where document_type = 'bookingSettings'`;
        }
      });
    }

    await check('suppressed never-attempted recipients do not inherit a 25-hour booking attempt on reactivation', async result => {
      const booking = await create();
      const lastAttemptAt = new Date(Date.now() - 25 * 3600000).toISOString();
      await commerce.patch(booking.bookingId).set({ status: 'failed', emailDispatchAttemptCount: 4,
        emailDispatchLastAttemptAt: lastAttemptAt }).commit();
      await confirm(booking);
      const suppressed = await commerce.getDocument(booking.bookingId);
      assert.equal(suppressed.emailDispatchLastAttemptAt, lastAttemptAt);
      assert.equal(suppressed.emailDispatchAttemptCount, 4);
      assert.ok(!suppressed.emailDispatchClientFirstAttemptAt && !suppressed.emailDispatchOwnerFirstAttemptAt);
      const before = messages(booking.bookingId).length;
      await commerce.patch(booking.bookingId).set({ status: 'captured' }).commit();
      result.response = await confirm(booking);
      result.ledger = await rows(booking.bookingId);
      assert.equal(result.response.body.deliveryUnknown, false);
      assert.equal(result.response.body.emailDispatch.allSent, true);
      assert.equal(messages(booking.bookingId).length - before, 2);
    });

    await check('a genuine previous recipient attempt remains delivery_unknown after suppression and reactivation', async result => {
      const booking = await create();
      const firstAttemptAt = new Date(Date.now() - 25 * 3600000).toISOString();
      await commerce.patch(booking.bookingId).set({ status: 'failed', emailDispatchAttemptCount: 4,
        emailDispatchLastAttemptAt: firstAttemptAt, emailDispatchClientFirstAttemptAt: firstAttemptAt,
        emailDispatchOwnerFirstAttemptAt: firstAttemptAt }).commit();
      await confirm(booking);
      const before = messages(booking.bookingId).length;
      await commerce.patch(booking.bookingId).set({ status: 'captured' }).commit();
      result.response = await confirm(booking);
      assert.equal(result.response.body.deliveryUnknown, true);
      assert.equal(messages(booking.bookingId).length, before);
      assert.equal((await commerce.getDocument(booking.bookingId)).emailDispatchClientFirstAttemptAt, firstAttemptAt);
    });

    await check('projection-only suppression does not age out an unattempted recipient after reactivation', async result => {
      const booking = await create();
      await commerce.patch(booking.bookingId).set({ status: 'failed', emailDispatchAttemptCount: 4,
        emailDispatchLastAttemptAt: new Date(Date.now() - 25 * 3600000).toISOString() }).commit();
      assertSuppressed(await rows(booking.bookingId));
      await commerce.patch(booking.bookingId).set({ status: 'captured' }).commit();
      const before = messages(booking.bookingId).length;
      result.response = await confirm(booking);
      assert.equal(result.response.body.deliveryUnknown, false);
      assert.equal(messages(booking.bookingId).length - before, 2);
    });

    await check('missing current booking cannot dispatch a supplied stale booking snapshot', async result => {
      const booking = await create();
      const supplied = await commerce.getDocument(booking.bookingId);
      const before = messages(booking.bookingId).length;
      result.lookup = await getBookingForEmailDispatch({ client: commerce, bookingId: 'booking.emails.missing' });
      result.response = await sendBookingEmailsForBooking({ client: commerce, bookingId: 'booking.emails.missing',
        booking: { ...supplied, _id: 'booking.emails.missing' } });
      assert.equal(result.lookup, null);
      assert.equal(result.response.httpStatus, 404);
      assert.equal(messages(booking.bookingId).length, before);
    });

    await check('status update between the transport read and revision patch sends nothing and terminalizes', async result => {
      const booking = await create();
      const before = messages(booking.bookingId).length;
      let claims = 0;
      let flipped = false;
      database.setRequestHook(async (phase, request) => {
        if (phase !== 'after') return;
        if (request.path.endsWith('/roo_claim_booking_email_dispatch')) claims += 1;
        if (claims === 2 && !flipped && request.path.endsWith('/roo_fetch_shadow_documents_targeted') &&
            request.body.p_document_types?.includes('booking')) {
          flipped = true;
          await inactive(booking, 'cancelled');
        }
      });
      result.response = await confirm(booking);
      assert.equal(flipped, true);
      assert.equal(messages(booking.bookingId).length, before);
      assert.equal(result.response.body.code, 'booking_inactive');
      assert.equal(result.response.body.retryable, false);
      result.ledger = await rows(booking.bookingId);
      assertSuppressed(result.ledger);
      assert.equal((await commerce.getDocument(booking.bookingId)).emailDispatchAttemptCount || 0, 0);
    });

    await check('a refunded booking still cannot be reactivated by the status transition API', async result => {
      const booking = await create();
      await inactive(booking, 'refunded');
      await assert.rejects(transition(booking.bookingId, 'captured'), error => error.code === 'refunded_booking_terminal');
      result.booking = await commerce.getDocument(booking.bookingId);
      assert.equal(result.booking.status, 'refunded');
    });

    await check('the migration function definitions can be reapplied without changing state', async result => {
      const name = fixture.evidence.database.excludedMigrations.includes('20261012000000_suppress_inactive_booking_confirmations.sql')
        ? '20261005000000_terminalize_unknown_booking_email_delivery.sql'
        : '20261012000000_suppress_inactive_booking_confirmations.sql';
      const file = new URL(`../supabase/migrations/${name}`, import.meta.url);
      const before = await database.sql`select id, to_jsonb(dispatch) as row from commerce.email_dispatches dispatch order by id`;
      if (fixture.evidence.database.excludedMigrations.length) {
        const definitions = await database.sql`select pg_get_functiondef(oid) as sql from pg_proc
          where pronamespace = 'public'::regnamespace and proname in
          ('roo_claim_booking_email_dispatch', 'roo_complete_booking_email_dispatch',
           'roo_list_email_dispatch_recovery_bookings', 'roo_fetch_recovery_payment_documents')`;
        for (const definition of definitions) await database.sql.unsafe(definition.sql);
      } else await database.sql.unsafe(fs.readFileSync(file, 'utf8'));
      const after = await database.sql`select id, to_jsonb(dispatch) as row from commerce.email_dispatches dispatch order by id`;
      assert.deepEqual(after, before);
      result.reapplied = true;
      result.migrations = database.manifest.length;
    });

    for (const status of ['pending', 'captured', 'completed', '', null, 'unknown']) {
      await check(`active classification ${JSON.stringify(status)} sends each recipient once`, async result => {
        const booking = await create();
        await commerce.patch(booking.bookingId).set({ status }).commit();
        const before = messages(booking.bookingId).length;
        result.response = await confirm(booking);
        result.replay = await confirm(booking);
        result.ledger = await rows(booking.bookingId);
        assert.equal(result.response.status, 200, JSON.stringify(result.response));
        assert.equal(result.response.body.emailDispatch.allSent, true);
        assert.equal(messages(booking.bookingId).length - before, 2);
        assert.ok(result.ledger.every(row => row.status === 'sent' && row.sent_at && row.provider_message_id));
      });
    }

    await check('partial refund still sends each recipient once', async result => {
      const booking = await create();
      await applyBookingRefund({ client: commerce, paymentRecord: booking.record,
        refund: { full: false, id: `partial-${booking.bookingId}`, totalRefundedAmount: 5, currency: 'USD' } });
      result.booking = await commerce.getDocument(booking.bookingId);
      assert.equal(result.booking.status, 'captured');
      assert.equal(result.booking.refundStatus, 'partial');
      const before = messages(booking.bookingId).length;
      result.response = await confirm(booking);
      await confirm(booking);
      assert.equal(result.response.status, 200);
      assert.equal(messages(booking.bookingId).length - before, 2);
    });

    await check('status flip after both claims suppresses transport', async result => {
      const booking = await create();
      const before = messages(booking.bookingId).length;
      let claimed = 0;
      database.setRequestHook(async (phase, request) => {
        if (claimed < 2 && phase === 'after' && request.path.endsWith('/roo_claim_booking_email_dispatch') &&
            request.body.p_booking_legacy_id === booking.bookingId) {
          claimed += 1;
          if (claimed === 2) await inactive(booking, 'cancelled');
        }
      });
      result.response = await confirm(booking);
      assert.equal(claimed, 2);
      result.ledger = await rows(booking.bookingId);
      assert.equal(messages(booking.bookingId).length, before);
      assertSuppressed(result.ledger);
      assert.equal(result.response.body.ok, false);
      assert.equal(result.response.body.retryable, false);
    });

    await check('reactivation sends only the recipient suppressed after the first send', async result => {
      const booking = await create();
      const before = messages(booking.bookingId).length;
      database.setRequestHook(async (phase, request) => {
        if (phase === 'after' && request.path.endsWith('/roo_complete_booking_email_dispatch') &&
            request.body.p_success === true && request.body.p_idempotency_key === `booking-${booking.bookingId}-client`) {
          database.setRequestHook(null);
          await inactive(booking, 'cancelled');
        }
      });
      result.firstResponse = await confirm(booking);
      result.inactiveLedger = await rows(booking.bookingId);
      assert.equal(messages(booking.bookingId).length - before, 1);
      assert.equal(result.inactiveLedger[0].status, 'sent');
      assert.equal(result.inactiveLedger[1].status, 'failed');
      assert.equal(result.inactiveLedger[1].last_error_code, 'booking_inactive');
      await commerce.patch(booking.bookingId).set({ status: 'captured' }).commit();
      result.reactivatedResponse = await confirm(booking);
      await confirm(booking);
      result.ledger = await rows(booking.bookingId);
      assert.equal(result.reactivatedResponse.status, 200, JSON.stringify(result.reactivatedResponse));
      assert.deepEqual(messages(booking.bookingId).slice(before).map(request => request.body.to),
        ['visitor@example.invalid', 'owner@example.invalid']);
      assert.ok(result.ledger.every(row => row.status === 'sent'));
      assert.equal(result.ledger[0].provider_message_id, result.inactiveLedger[0].provider_message_id);
    });

    await check('a receipt arriving after cancellation preserves the accepted transport', async result => {
      const booking = await create();
      database.setRequestHook(async (phase, request) => {
        if (phase === 'before' && request.path.endsWith('/roo_complete_booking_email_dispatch') &&
            request.body.p_success === true && request.body.p_idempotency_key === `booking-${booking.bookingId}-client`) {
          database.setRequestHook(null);
          await inactive(booking, 'cancelled');
        }
      });
      result.response = await confirm(booking);
      result.ledger = await rows(booking.bookingId);
      assert.equal(messages(booking.bookingId).length, 1);
      assert.equal(result.ledger[0].status, 'sent');
      assert.equal(result.ledger[1].status, 'failed');
      assert.equal(result.ledger[1].last_error_code, 'booking_inactive');
      await commerce.patch(booking.bookingId).set({ status: 'captured' }).commit();
      result.reactivatedResponse = await confirm(booking);
      assert.equal(messages(booking.bookingId).length, 2);
      assert.equal(result.reactivatedResponse.status, 200);
      assert.equal((await rows(booking.bookingId))[0].provider_message_id, result.ledger[0].provider_message_id);
    });

    for (const repair of ['reconciliation', 'confirmation replay']) {
      for (const providerReceipt of [true, false]) {
        await check(`late accepted customer receipt repairs missing source fields through ${repair}, provider receipt ${providerReceipt}`, async result => {
          const booking = await create();
          let receiptRecorded = false;
          const hook = async (phase, request) => {
            if (!receiptRecorded && request.path.endsWith('/roo_complete_booking_email_dispatch') &&
                request.body.p_success === true && request.body.p_idempotency_key === `booking-${booking.bookingId}-client`) {
              if (phase === 'before') {
                strictAssert.equal(messages(booking.bookingId).length, 1);
                database.setRequestHook(null);
                await inactive(booking, 'cancelled');
                await commerce.patch(booking.bookingId).set({ emailDispatchStatus: 'failed',
                  emailDispatchLastError: 'booking_inactive', emailDispatchDeferred: false,
                  emailDispatchNextAttemptAt: '' }).commit();
                database.setRequestHook(hook);
              } else {
                receiptRecorded = true;
                result.completion = request.response;
              }
            }
            if (receiptRecorded && phase === 'before' && request.path.endsWith('/roo_apply_commerce_document_mutations')) {
              throw new Error('Fixture process interrupted after ledger receipt completion');
            }
          };
          database.setRequestHook(hook);
          result.interruptedResponse = await confirm(booking);
          database.setRequestHook(null);
          strictAssert.equal(receiptRecorded, true);
          if (!providerReceipt) {
            await database.sql`update commerce.email_dispatches set provider_message_id = null
              where idempotency_key = ${`booking-${booking.bookingId}-client`}`;
          }
          result.before = await commerce.getDocument(booking.bookingId);
          result.beforeLedger = await rows(booking.bookingId);
          strictAssert.equal(result.before.status, 'cancelled');
          strictAssert.equal(result.before.emailDispatchStatus, 'failed');
          strictAssert.equal(result.before.emailDispatchLastError, 'booking_inactive');
          strictAssert.ok(!result.before.emailDispatchClientSentAt && !result.before.emailDispatchClientProviderId);
          strictAssert.equal(result.beforeLedger[0].status, 'sent');
          const { data, error } = await database.client.rpc('roo_list_email_dispatch_recovery_bookings', {
            p_dispatch_kind: 'booking_confirmation', p_now: new Date().toISOString(), p_limit: 100,
          });
          strictAssert.equal(error, null);
          strictAssert.ok(data.includes(booking.bookingId));
          if (repair === 'reconciliation') {
            result.recovery = await reconcileBookingEmailDispatches({ client: commerce, limit: 100 });
            strictAssert.ok(result.recovery.scanned > 0);
          } else result.response = await confirm(booking);
          result.booking = await commerce.getDocument(booking.bookingId);
          result.ledger = await rows(booking.bookingId);
          strictAssert.equal(new Date(result.booking.emailDispatchClientSentAt).toISOString(),
            new Date(result.beforeLedger[0].sent_at).toISOString());
          strictAssert.equal(result.booking.emailDispatchClientProviderId || '', result.beforeLedger[0].provider_message_id || '');
          strictAssert.equal(result.booking.emailDispatchStatus, 'partial');
          strictAssert.ok(!result.booking.emailDispatchOwnerSentAt);
          strictAssert.equal(result.ledger[0].status, 'sent');
          strictAssert.equal(new Date(result.ledger[0].sent_at).getTime(), new Date(result.beforeLedger[0].sent_at).getTime());
          strictAssert.equal(result.ledger[0].provider_message_id, result.beforeLedger[0].provider_message_id);
          strictAssert.deepEqual(result.ledger.map(row => row.attempt_count), result.beforeLedger.map(row => row.attempt_count));
          strictAssert.equal(result.booking.emailDispatchAttemptCount, result.before.emailDispatchAttemptCount);
          await confirm(booking);
          await reconcileBookingEmailDispatches({ client: commerce, limit: 100 });
          strictAssert.equal(messages(booking.bookingId).length, 1);
          strictAssert.equal(messages(booking.bookingId)[0].body.to, 'visitor@example.invalid');
        });
      }
    }

    await check('reactivation makes both suppressed recipients recoverable', async result => {
      const booking = await create();
      await inactive(booking, 'failed');
      await confirm(booking);
      const before = messages(booking.bookingId).length;
      await commerce.patch(booking.bookingId).set({ status: 'captured' }).commit();
      result.recovery = await reconcileBookingEmailDispatches({ client: commerce, limit: 100 });
      result.ledger = await rows(booking.bookingId);
      assert.equal(messages(booking.bookingId).length - before, 2);
      assert.ok(result.ledger.every(row => row.status === 'sent'));
      await confirm(booking);
      assert.equal(messages(booking.bookingId).length - before, 2);
    });

    for (const status of ['cancelled', 'refunded']) {
      await check(`${status}: reschedule notification behavior remains unchanged`, async result => {
        const booking = await create();
        await inactive(booking, status);
        await confirm(booking);
        await commerce.patch(booking.bookingId).set({ requiresReschedule: true,
          originalRequestedStartTimeUTC: '2099-01-05T04:30:00.000Z' }).commit();
        const before = messages(booking.bookingId).length;
        result.response = await dispatchRescheduleNotifications({ client: commerce, bookingId: booking.bookingId });
        result.messages = messages(booking.bookingId).slice(before);
        assert.equal(result.messages.length, 2);
        assert.ok(result.messages.every(request => !request.body.html.includes('Booking Received')));
        assert.equal(result.response.ok, true);
      });
    }

    await check('suppressed recovery stops claiming within twelve scheduled attempts', async result => {
      const booking = await create();
      await isolateRecovery(booking);
      await inactive(booking, 'cancelled');
      await confirm(booking);
      result.attempts = [];
      result.paymentRevisions = [];
      for (let attempt = 0; attempt < 14; attempt += 1) {
        await database.sql`update commerce.email_dispatches set next_attempt_at = now() - interval '1 second',
          lease_id = null, lease_expires_at = null
          where booking_id = (select id from commerce.bookings where legacy_sanity_id = ${booking.bookingId})
          and status not in ('sent', 'historical_unknown')`;
        await reconcileBookingEmailDispatches({ client: commerce,
          now: new Date(Date.now() + 3600000).toISOString(), limit: 100 });
        await recover();
        const saved = await rows(booking.bookingId);
        result.attempts.push(saved.map(row => row.attempt_count));
        result.paymentRevisions.push((await commerce.getDocument(booking.record._id))._rev);
      }
      strictAssert.deepEqual(result.attempts.at(-1), result.attempts[1], 'Suppressed work is still being reclaimed');
      strictAssert.equal(result.paymentRevisions.at(-1), result.paymentRevisions[1], 'Suppressed payment recovery is still running');
      strictAssert.equal(messages(booking.bookingId).length, 0);
    });

    await check('inactive recovery candidates cannot crowd out an active booking at the SQL limit', async result => {
      const previousBookings = await commerce.fetch('*[_type == "booking"]{_id}');
      for (const booking of previousBookings) {
        await commerce.patch(booking._id).set({ status: 'cancelled', emailDispatchLastError: 'booking_inactive' }).commit();
      }
      for (let index = 0; index < 101; index += 1) {
        await commerce.create({ _id: `booking.crowded.${index}`, _type: 'booking',
          backendOwner: 'supabase', cutoverGeneration: 0, status: 'cancelled',
          emailDispatchStatus: 'failed', emailDispatchLastError: 'booking_inactive' });
      }
      const booking = await create();
      await commerce.patch(booking.bookingId).set({ emailDispatchStatus: 'failed' }).commit();
      result.recovery = await reconcileBookingEmailDispatches({ client: commerce, limit: 20 });
      result.ledger = await rows(booking.bookingId);
      strictAssert.equal(messages(booking.bookingId).length, 2);
      strictAssert.ok(result.ledger.every(row => row.status === 'sent'));
    });

    await check('Resend payload conflict remains delivery_unknown across replay and projection', async result => {
      const booking = await create();
      database.setProviderHandler(async request => {
        assert.equal(request.path, '/emails');
        request.bookings = [{ id: booking.bookingId, status: (await commerce.getDocument(booking.bookingId)).status }];
        fixture.evidence.providerRequests.push(request);
        return { status: 409, body: { name: 'invalid_idempotent_request', statusCode: 409,
          message: 'This idempotency key has already been used on a different payload.' } };
      });
      const before = messages(booking.bookingId).length;
      result.response = await confirm(booking);
      await commerce.patch(booking.bookingId).set({ message: 'Unrelated update after uncertain delivery' }).commit();
      result.replay = await confirm(booking);
      await inactive(booking, 'cancelled');
      result.inactiveReplay = await confirm(booking);
      await commerce.patch(booking.bookingId).set({ status: 'captured' }).commit();
      await reconcileBookingEmailDispatches({ client: commerce, limit: 100 });
      result.ledger = await rows(booking.bookingId);
      assert.equal(messages(booking.bookingId).length - before, 2);
      assert.equal(result.inactiveReplay.body.deliveryUnknown, true);
      assert.equal(result.response.body.deliveryUnknown, true);
      assert.equal(result.response.body.retryable, false);
      assert.equal(result.replay.body.retryable, false);
      assert.ok(result.ledger.every(row => row.status === 'historical_unknown' && row.next_attempt_at === null));
    });
    assert.deepEqual(fixture.evidence.blocked, []);
  } finally {
    await fixture.stop();
    results.stopped = fixture.evidence.stopped;
    fs.writeFileSync(artifact, JSON.stringify(results, null, 2));
  }
});
