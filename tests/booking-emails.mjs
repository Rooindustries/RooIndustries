import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import { createBookingContactFixture } from './fixtures/booking-contact.mjs';

test('booking confirmation eligibility against PostgreSQL 17', { timeout: 300000 }, async t => {
  const fixture = await createBookingContactFixture();
  const { commerce, database } = fixture;
  const { applyBookingRefund, applyBookingStatusTransition } = await import('../src/server/api/ref/bookingRefunds.js');
  const { reconcileBookingEmailDispatches, dispatchRescheduleNotifications } = await import('../src/server/api/ref/bookingEmails.js');
  const { issueBookingEmailDispatchToken } = await import('../src/server/api/ref/bookingEmailDispatchToken.js');
  const artifact = new URL('../test-results/booking-emails/postgres17.json', import.meta.url);
  const results = { database: fixture.evidence.database, cases: [] };
  const messages = () => fixture.evidence.providerRequests.filter(request => request.path === '/emails');
  const rows = bookingId => database.sql`
    select dispatch.recipient_type, dispatch.status, dispatch.last_error_code,
      dispatch.attempt_count, dispatch.lease_id, dispatch.lease_expires_at,
      dispatch.next_attempt_at, dispatch.sent_at, dispatch.provider_message_id
    from commerce.email_dispatches dispatch
    join commerce.bookings booking on booking.id = dispatch.booking_id
    where booking.legacy_sanity_id = ${bookingId} and dispatch.dispatch_kind = 'booking_confirmation'
    order by dispatch.recipient_type`;
  let sequence = 0;
  const create = async () => {
    const id = ++sequence;
    const bookingId = `booking.emails.${id}`;
    const paymentRecordId = `paymentRecord.emails.${id}`;
    const booking = await commerce.create({
      _id: bookingId, _type: 'booking', backendOwner: 'supabase', cutoverGeneration: 0,
      ...fixture.details, status: 'captured', paymentProvider: 'dodo', paymentRecordId,
      packageTitle: 'Vertex Essentials', packagePrice: '$29.95',
      currency: 'USD', grossAmount: 29.95, netAmount: 29.95, dodoTotalAmount: 29.95,
      startTimeUTC: new Date(Date.UTC(2099, 0, id, 4, 30)).toISOString(),
      hostDate: 'January 2099', hostTime: '10:00 AM', hostTimeZone: 'Asia/Kolkata',
      displayDate: 'January 2099', displayTime: '10:00 AM',
      emailDispatchDeferred: true, emailDispatchStatus: 'pending',
    });
    const record = await commerce.create({
      _id: paymentRecordId, _type: 'paymentRecord', backendOwner: 'supabase', cutoverGeneration: 0,
      provider: 'dodo', status: 'email_partial', bookingId, emailDispatchRequired: true,
      providerOrderId: `session_emails_${id}`, providerPaymentId: `payment_emails_${id}`,
      bookingPayload: { ...fixture.details, packageTitle: booking.packageTitle, netAmount: 29.95, currency: 'USD' },
      providerPublicData: { totalAmount: 2995, currency: 'USD' },
    });
    return { bookingId, record, emailDispatchToken: issueBookingEmailDispatchToken({
      bookingId, email: booking.email, backend: 'supabase', cutoverGeneration: 0,
    }) };
  };
  const confirm = ({ bookingId, emailDispatchToken }) =>
    fixture.post('/api/ref/sendBookingEmails', { bookingId, emailDispatchToken });
  const transition = (bookingId, status) => applyBookingStatusTransition({ client: commerce, bookingId, status });
  const inactive = async (booking, status) => {
    if (status === 'refunded') {
      await applyBookingRefund({ client: commerce, paymentRecord: booking.record,
        refund: { full: true, id: `refund-${booking.bookingId}`, amount: 29.95, currency: 'USD' } });
    } else if (status === 'canceled') {
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
  const check = async (name, run) => t.test(name, async () => {
    const result = { name };
    results.cases.push(result);
    try {
      await run(result);
      result.result = 'pass';
    } catch (error) {
      result.result = 'fail';
      result.error = error.message;
      throw error;
    } finally {
      database.setRequestHook(null);
      results.transportCalls = messages();
      fs.mkdirSync(new URL('.', artifact), { recursive: true });
      fs.writeFileSync(artifact, JSON.stringify(results, null, 2));
    }
  });

  try {
    for (const status of ['refunded', 'cancelled', 'failed', 'canceled']) {
      await check(`${status}: signed confirmation suppresses both recipients`, async result => {
        const booking = await create();
        const before = messages().length;
        await inactive(booking, status);
        result.response = await confirm(booking);
        result.ledger = await rows(booking.bookingId);
        result.transportCalls = messages().slice(before);
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
        const before = messages().length;
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
        assert.equal(messages().length, before);
        assertSuppressed(result.ledger);
        assert.deepEqual(result.ledger.map(row => row.attempt_count), saved.map(row => row.attempt_count));
        assert.ok(result.claims.every(claim => claim.claimed === false && claim.in_progress === false));
        assert.equal(result.replay.body.retryable, false);
      });
    }

    for (const status of ['pending', 'captured', 'completed', '', null, 'unknown']) {
      await check(`active classification ${JSON.stringify(status)} sends each recipient once`, async result => {
        const booking = await create();
        await commerce.patch(booking.bookingId).set({ status }).commit();
        const before = messages().length;
        result.response = await confirm(booking);
        result.replay = await confirm(booking);
        result.ledger = await rows(booking.bookingId);
        assert.equal(result.response.status, 200, JSON.stringify(result.response));
        assert.equal(result.response.body.emailDispatch.allSent, true);
        assert.equal(messages().length - before, 2);
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
      const before = messages().length;
      result.response = await confirm(booking);
      await confirm(booking);
      assert.equal(result.response.status, 200);
      assert.equal(messages().length - before, 2);
    });

    await check('status flip after both claims suppresses transport', async result => {
      const booking = await create();
      const before = messages().length;
      let claimed = 0;
      database.setRequestHook(async (phase, request) => {
        if (phase === 'after' && request.path.endsWith('/roo_claim_booking_email_dispatch') &&
            request.body.p_booking_legacy_id === booking.bookingId) {
          claimed += 1;
          if (claimed === 2) await inactive(booking, 'cancelled');
        }
      });
      result.response = await confirm(booking);
      assert.equal(claimed, 2);
      result.ledger = await rows(booking.bookingId);
      assert.equal(messages().length, before);
      assertSuppressed(result.ledger);
      assert.equal(result.response.body.ok, false);
      assert.equal(result.response.body.retryable, false);
    });

    await check('reactivation sends only the recipient suppressed after the first send', async result => {
      const booking = await create();
      const before = messages().length;
      database.setRequestHook(async (phase, request) => {
        if (phase === 'after' && request.path.endsWith('/roo_complete_booking_email_dispatch') &&
            request.body.p_success === true && request.body.p_idempotency_key === `booking-${booking.bookingId}-client`) {
          database.setRequestHook(null);
          await inactive(booking, 'cancelled');
        }
      });
      result.firstResponse = await confirm(booking);
      result.inactiveLedger = await rows(booking.bookingId);
      assert.equal(messages().length - before, 1);
      assert.equal(result.inactiveLedger[0].status, 'sent');
      assert.equal(result.inactiveLedger[1].status, 'failed');
      assert.equal(result.inactiveLedger[1].last_error_code, 'booking_inactive');
      await commerce.patch(booking.bookingId).set({ status: 'captured' }).commit();
      result.reactivatedResponse = await confirm(booking);
      await confirm(booking);
      result.ledger = await rows(booking.bookingId);
      assert.equal(result.reactivatedResponse.status, 200, JSON.stringify(result.reactivatedResponse));
      assert.deepEqual(messages().slice(before).map(request => request.body.to),
        ['visitor@example.invalid', 'owner@example.invalid']);
      assert.ok(result.ledger.every(row => row.status === 'sent'));
      assert.equal(result.ledger[0].provider_message_id, result.inactiveLedger[0].provider_message_id);
    });

    await check('reactivation makes both suppressed recipients recoverable', async result => {
      const booking = await create();
      await inactive(booking, 'failed');
      await confirm(booking);
      const before = messages().length;
      await commerce.patch(booking.bookingId).set({ status: 'captured' }).commit();
      result.recovery = await reconcileBookingEmailDispatches({ client: commerce, limit: 100 });
      result.ledger = await rows(booking.bookingId);
      assert.equal(messages().length - before, 2);
      assert.ok(result.ledger.every(row => row.status === 'sent'));
      await confirm(booking);
      assert.equal(messages().length - before, 2);
    });

    for (const status of ['cancelled', 'refunded']) {
      await check(`${status}: reschedule notification behavior remains unchanged`, async result => {
        const booking = await create();
        await inactive(booking, status);
        await confirm(booking);
        await commerce.patch(booking.bookingId).set({ requiresReschedule: true,
          originalRequestedStartTimeUTC: '2099-01-05T04:30:00.000Z' }).commit();
        const before = messages().length;
        result.response = await dispatchRescheduleNotifications({ client: commerce, bookingId: booking.bookingId });
        result.messages = messages().slice(before);
        assert.equal(result.messages.length, 2);
        assert.ok(result.messages.every(request => !request.body.html.includes('Booking Received')));
        assert.equal(result.response.ok, true);
      });
    }

    await check('Resend payload conflict remains delivery_unknown across replay and projection', async result => {
      const booking = await create();
      database.setProviderHandler(async request => {
        assert.equal(request.path, '/emails');
        fixture.evidence.providerRequests.push(request);
        return { status: 409, body: { name: 'invalid_idempotent_request', statusCode: 409,
          message: 'This idempotency key has already been used on a different payload.' } };
      });
      const before = messages().length;
      result.response = await confirm(booking);
      await commerce.patch(booking.bookingId).set({ message: 'Unrelated update after uncertain delivery' }).commit();
      result.replay = await confirm(booking);
      await reconcileBookingEmailDispatches({ client: commerce, limit: 100 });
      result.ledger = await rows(booking.bookingId);
      assert.equal(messages().length - before, 2);
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
