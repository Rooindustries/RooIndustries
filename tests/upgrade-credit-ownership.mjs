import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { createBookingContactFixture } from './fixtures/booking-contact.mjs';

test('upgrade credit stays verified and belongs to one checkout', { timeout: 900000 }, async t => {
  const fixture = await createBookingContactFixture({ artifactName: 'upgrade-credit-ownership' });
  const { commerce, post, evidence } = fixture;
  const check = (name, run) => t.test(name, async () => {
    const result = { name };
    evidence.cases.push(result);
    try {
      await run(result);
      result.passed = true;
    } catch (error) {
      result.passed = false;
      result.error = error.stack;
      throw error;
    } finally {
      fixture.save();
    }
  });
  const original = async () => {
    const payload = await fixture.hold({ packageTitle: 'Performance Vertex Overhaul' });
    const started = await fixture.start(payload);
    assert.equal(started.status, 200, JSON.stringify(started));
    const finalized = await post('/api/payment/finalize', {}, started.body.paymentAccessToken);
    assert.equal(finalized.status, 200, JSON.stringify(finalized));
    const booking = await commerce.getDocument(finalized.body.bookingId);
    const record = await commerce.getDocument(booking.paymentRecordId);
    const lookup = await post('/api/ref/getUpgradeInfo', { id: booking._id, email: booking.email });
    assert.equal(lookup.status, 200, JSON.stringify(lookup));
    return { booking, record, payload: { originalOrderId: booking._id, email: booking.email,
      packageTitle: lookup.body.targetPackage.title, upgradeIntentToken: lookup.body.upgradeIntentToken,
      deferEmailsUntilConfirmation: true } };
  };
  const freshIntent = async scenario => {
    const lookup = await post('/api/ref/getUpgradeInfo', { id: scenario.booking._id, email: scenario.booking.email });
    assert.equal(lookup.status, 200, JSON.stringify(lookup));
    return { ...scenario.payload, upgradeIntentToken: lookup.body.upgradeIntentToken };
  };
  const refuse = async (scenario, result) => {
    const before = await fixture.snapshot();
    result.lookup = await post('/api/ref/getUpgradeInfo', { id: scenario.booking._id, email: scenario.booking.email });
    result.quote = await post('/api/payment/quote', { bookingPayload: scenario.payload });
    result.start = await post('/api/payment/start', { provider: 'dodo', bookingPayload: scenario.payload,
      quoteFingerprint: 'stale' });
    for (const response of [result.lookup, result.quote, result.start]) {
      assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(response));
    }
    assert.equal(result.start.body.code, result.quote.body.code);
    assert.notEqual(result.start.body.code, 'quote_fingerprint_mismatch');
    result.noMutation = isDeepStrictEqual(before, await fixture.snapshot());
    assert.equal(result.noMutation, true);
  };
  const paymentFor = started => commerce.fetch('*[_type == "paymentRecord" && providerOrderId == $id][0]',
    { id: started.body.providerPayload.orderId });
  const startsFor = scenario => commerce.fetch('*[_type == "paymentRecord" && bookingPayload.originalOrderId == $id]',
    { id: scenario.booking._id });
  try {
    for (const [name, booking, payment] of [
      ['non-USD original', { currency: 'EUR' }, {}],
      ['provider mismatch', { paymentProvider: 'paypal' }, {}],
      ['checkout id mismatch', { dodoCheckoutSessionId: 'different_checkout' }, {}],
      ['payment id mismatch', { dodoPaymentId: 'different_payment' }, {}],
      ['missing checkout id', { dodoCheckoutSessionId: '' }, {}],
      ['missing payment id', { dodoPaymentId: '' }, {}],
      ['unverified source', {}, { verificationState: '' }],
      ['reversed source', {}, { verificationState: 'reversed', status: 'needs_recovery' }],
      ['reversal before booking catches up', {}, { refundState: 'reversal' }],
      ['disputed source before booking catches up', {}, { dodoDisputeActive: true }],
      ['wrong booking binding', {}, { bookingId: 'booking.different' }],
      ['different backend generation', {}, { cutoverGeneration: 1 }],
      ['contradicting amount', { netAmount: 49.95 }, {}],
      ['missing payment currency', {}, { pricingSnapshot: { netAmount: 54.95 },
        bookingPayload: {}, providerPublicData: { totalAmount: 5495, taxAmount: 0, taxInclusive: false } }],
    ]) {
      await check(`unrefunded ${name} cannot grant credit`, async result => {
        const scenario = await original();
        result.source = 'Synthetic historical source documents; native writers already reject some inconsistent states.';
        for (const [id, changes] of [[scenario.booking._id, booking], [scenario.record._id, payment]]) {
          await fixture.database.sql`update migration.source_documents set payload = payload || ${fixture.database.sql.json(changes)}
            where legacy_sanity_id = ${id}`;
        }
        await refuse(scenario, result);
      });
    }
    await check('an unlinked historical booking cannot grant credit', async result => {
      const scenario = await original();
      await commerce.patch(scenario.booking._id).unset(['paymentRecordId']).commit();
      await commerce.delete(scenario.record._id);
      await refuse(scenario, result);
    });
    await check('direct legacy upgrade completion cannot bypass checkout ownership', async result => {
      const scenario = await original();
      const before = await fixture.snapshot();
      result.response = await post('/api/ref/createBooking', { ...scenario.payload, paymentProvider: 'free' });
      assert.equal(result.response.status, 410, JSON.stringify(result.response));
      assert.equal(result.response.body.code, 'upgrade_checkout_required');
      assert.equal(isDeepStrictEqual(before, await fixture.snapshot()), true);
    });
    await check('separate lookups and concurrent starts share one payment and provider checkout', async result => {
      const scenario = await original();
      const secondPayload = await freshIntent(scenario);
      assert.notEqual(scenario.payload.upgradeIntentToken, secondPayload.upgradeIntentToken);
      const before = evidence.providerRequests.filter(request => request.path === '/checkouts').length;
      result.starts = await Promise.all([fixture.start(scenario.payload), fixture.start(secondPayload)]);
      const successful = result.starts.filter(response => response.status === 200);
      assert.ok(successful.length > 0, JSON.stringify(result.starts));
      assert.ok(result.starts.every(response => [200, 409].includes(response.status)));
      result.records = await startsFor(scenario);
      assert.equal(result.records.length, 1, 'Concurrent requests spent the original credit twice');
      assert.equal(evidence.providerRequests.filter(request => request.path === '/checkouts').length - before, 1);
      const retried = await fixture.start(await freshIntent(scenario));
      assert.equal(retried.status, 200, JSON.stringify(retried));
      assert.equal(retried.body.providerPayload.orderId, successful[0].body.providerPayload.orderId);
      result.retried = retried;
      const record = await paymentFor(retried);
      result.finalize = await post('/api/payment/finalize', {}, retried.body.paymentAccessToken);
      assert.equal(result.finalize.status, 200, JSON.stringify(result.finalize));
      result.replay = await fixture.dodoWebhook(`payment_${record.providerOrderId}`, 'payment.succeeded', 'ownership_replay');
      assert.equal(result.replay.status, 200);
      result.bookings = await commerce.fetch('*[_type == "booking" && paymentRecordId == $id]', { id: record._id });
      assert.equal(result.bookings.length, 1);
    });
    await check('different target packages cannot open parallel credit checkouts', async result => {
      const scenario = await original();
      await fixture.database.client.rpc('roo_apply_document_mutations', { p_mutations: [{ operation: 'create',
        document: { _id: 'package.fixture.higher', _type: 'package', title: 'Fixture higher upgrade', price: '$149.95' } }] });
      const { issueUpgradeIntentToken } = await import('../src/server/api/ref/upgradeIntentToken.js');
      const higher = { ...scenario.payload, packageTitle: 'Fixture higher upgrade', upgradeIntentToken: issueUpgradeIntentToken({
        bookingId: scenario.booking._id, email: scenario.booking.email, targetPackageTitle: 'Fixture higher upgrade',
        backend: 'supabase', cutoverGeneration: 0 }) };
      result.first = await fixture.start(scenario.payload);
      assert.equal(result.first.status, 200, JSON.stringify(result.first));
      result.competing = await fixture.start(higher);
      assert.equal(result.competing.status, 409, JSON.stringify(result.competing));
      assert.equal((await startsFor(scenario)).length, 1);
    });
    await check('a fully discounted upgrade also spends its credit and coupon once', async result => {
      const scenario = await original();
      const firstPayload = { ...scenario.payload, couponCode: 'FIXTUREFREE' };
      const secondPayload = { ...await freshIntent(scenario), couponCode: 'FIXTUREFREE' };
      const coupon = await commerce.getDocument('coupon.fixture.free');
      result.starts = await Promise.all([fixture.start(firstPayload, 'free'), fixture.start(secondPayload, 'free')]);
      assert.ok(result.starts.some(response => response.status === 200), JSON.stringify(result.starts));
      assert.ok(result.starts.every(response => [200, 202, 400, 409].includes(response.status)), JSON.stringify(result.starts));
      result.records = await startsFor(scenario);
      assert.equal(result.records.length, 1);
      result.bookings = await commerce.fetch('*[_type == "booking" && paymentRecordId == $id]',
        { id: result.records[0]._id });
      assert.equal(result.bookings.length, 1);
      assert.equal(result.bookings[0].netAmount, 0);
      assert.equal(result.bookings[0].commissionAmount, 0);
      result.coupon = await commerce.getDocument(coupon._id);
      assert.equal(result.coupon.timesUsed, coupon.timesUsed + 1);
      assert.equal(result.coupon.activeReservations, coupon.activeReservations);
      const { issueUpgradeIntentToken } = await import('../src/server/api/ref/upgradeIntentToken.js');
      const higher = { ...scenario.payload, originalOrderId: result.bookings[0]._id, packageTitle: 'Fixture higher upgrade',
        upgradeIntentToken: issueUpgradeIntentToken({ bookingId: result.bookings[0]._id, email: scenario.booking.email,
          targetPackageTitle: 'Fixture higher upgrade', backend: 'supabase', cutoverGeneration: 0 }) };
      result.next = await fixture.start(higher);
      assert.equal(result.next.status, 200, JSON.stringify(result.next));
      assert.equal((await paymentFor(result.next)).pricingSnapshot.netAmount, 95);
    });
    await check('a checkout from the old per-intent lock scheme still blocks parallel credit', async result => {
      const scenario = await original();
      const first = await fixture.start(scenario.payload);
      assert.equal(first.status, 200, JSON.stringify(first));
      const record = await paymentFor(first);
      const lock = await commerce.getDocument(record.startClaimId);
      const legacyId = `${lock._id}.legacy`;
      await commerce.delete(lock._id);
      await commerce.create({ ...lock, _id: legacyId, scope: `${lock.scope}:legacy` });
      await commerce.patch(record._id).set({ startClaimId: legacyId }).commit();
      const before = evidence.providerRequests.filter(request => request.path === '/checkouts').length;
      result.competing = await fixture.start(await freshIntent(scenario));
      assert.equal(result.competing.status, 409, JSON.stringify(result.competing));
      assert.equal(result.competing.body.code, 'upgrade_already_in_progress');
      assert.equal(evidence.providerRequests.filter(request => request.path === '/checkouts').length, before);
      result.finalize = await post('/api/payment/finalize', {}, first.body.paymentAccessToken);
      result.record = await commerce.getDocument(record._id);
      assert.equal(result.record.status, 'needs_recovery');
      assert.equal(result.record.recoveryReason, 'upgrade_credit_changed_after_quote');
      assert.equal(result.record.bookingId, '');
    });
    await check('lost credit after checkout cannot produce a paid upgrade', async result => {
      const scenario = await original();
      const started = await fixture.start(scenario.payload);
      assert.equal(started.status, 200, JSON.stringify(started));
      const record = await paymentFor(started);
      await commerce.patch(scenario.record._id).set({ dodoDisputeActive: true, verificationState: 'disputed' }).commit();
      result.finalize = await post('/api/payment/finalize', {}, started.body.paymentAccessToken);
      result.record = await commerce.getDocument(record._id);
      assert.equal(result.record.status, 'needs_recovery');
      assert.equal(result.record.recoveryReason, 'upgrade_credit_unverified');
      assert.equal(result.record.bookingId, '');
      assert.equal(result.record.reconciliationRecoveryTerminal, true);
    });
    await check('a refund during payment start cannot reserve stale credit', async result => {
      const scenario = await original();
      let refunded = false;
      fixture.setRequestHook(async (phase, request) => {
        if (refunded || phase !== 'before' || request.path !== '/rest/v1/rpc/roo_apply_commerce_document_mutations' ||
            !request.body.p_mutations?.some(mutation => mutation.document?._type === 'paymentUpgradeLock')) return;
        refunded = true;
        result.refund = await fixture.refundPayment(scenario.record.providerPaymentId, [{
          refund_id: 'ownership_start_refund', payment_id: scenario.record.providerPaymentId,
          status: 'succeeded', amount: 2000, currency: 'USD', is_partial: true,
        }], 'ownership_start_refund_event');
        assert.equal(result.refund.status, 200, JSON.stringify(result.refund));
      });
      try {
        result.start = await fixture.start(scenario.payload);
      } finally {
        fixture.setRequestHook(null);
      }
      assert.equal(refunded, true);
      assert.equal(result.start.status, 409, JSON.stringify(result.start));
      assert.equal((await startsFor(scenario)).length, 0);
      result.retry = await fixture.start(await freshIntent(scenario));
      assert.equal(result.retry.status, 200, JSON.stringify(result.retry));
      assert.equal((await paymentFor(result.retry)).pricingSnapshot.netAmount, 65);
    });
    await check('unpaid cancellation permits a fresh checkout and fences a late capture', async result => {
      const scenario = await original();
      const first = await fixture.start(scenario.payload);
      assert.equal(first.status, 200, JSON.stringify(first));
      const oldRecord = await paymentFor(first);
      fixture.setPaymentAmountOverrides({ status: 'cancelled' });
      try {
        result.cancel = await post('/api/payment/cancel', {}, first.body.paymentAccessToken);
        assert.equal(result.cancel.status, 200, JSON.stringify(result.cancel));
        assert.equal(result.cancel.body.cancelled, true);
      } finally {
        fixture.setPaymentAmountOverrides({});
      }
      result.restarted = await fixture.start(await freshIntent(scenario));
      assert.equal(result.restarted.status, 200, JSON.stringify(result.restarted));
      const current = await paymentFor(result.restarted);
      assert.notEqual(current._id, oldRecord._id);
      result.lateCapture = await post('/api/payment/finalize', {}, first.body.paymentAccessToken);
      result.oldRecord = await commerce.getDocument(oldRecord._id);
      assert.equal(result.oldRecord.status, 'needs_recovery');
      assert.equal(result.oldRecord.bookingId, '');
      result.lock = await commerce.getDocument(current.startClaimId);
      assert.equal(result.lock.paymentRecordId, current._id);
      result.finalize = await post('/api/payment/finalize', {}, result.restarted.body.paymentAccessToken);
      assert.equal(result.finalize.status, 200, JSON.stringify(result.finalize));
      assert.equal((await commerce.getDocument(current._id)).status, 'booked');
    });
    await check('an abandoned checkout that still owns credit recovers into the same upgrade chain', async result => {
      const scenario = await original();
      const started = await fixture.start(scenario.payload);
      assert.equal(started.status, 200, JSON.stringify(started));
      const record = await paymentFor(started);
      await commerce.patch(record._id).set({ status: 'abandoned',
        lateCaptureWatchUntil: new Date(Date.now() + 120000).toISOString() }).commit();
      result.finalize = await post('/api/payment/finalize', {}, started.body.paymentAccessToken);
      assert.equal(result.finalize.status, 200, JSON.stringify(result.finalize));
      result.record = await commerce.getDocument(record._id);
      result.booking = await commerce.getDocument(result.record.bookingId);
      assert.equal(result.booking.originalOrderId, scenario.booking._id);
      assert.equal(result.booking.cutoverGeneration, record.cutoverGeneration);
      assert.equal(result.booking.requiresReschedule, true);
      assert.equal(result.booking.netAmount, 45);
      const { issueUpgradeIntentToken } = await import('../src/server/api/ref/upgradeIntentToken.js');
      const higher = { ...scenario.payload, originalOrderId: result.booking._id, packageTitle: 'Fixture higher upgrade',
        upgradeIntentToken: issueUpgradeIntentToken({ bookingId: result.booking._id, email: scenario.booking.email,
          targetPackageTitle: 'Fixture higher upgrade', backend: 'supabase', cutoverGeneration: 0 }) };
      result.next = await fixture.start(higher);
      assert.equal(result.next.status, 200, JSON.stringify(result.next));
      assert.equal((await paymentFor(result.next)).pricingSnapshot.netAmount, 50);
    });
    await check('a refunded upgrade permits replacement and refund retries preserve its lock', async result => {
      const scenario = await original();
      const first = await fixture.start(scenario.payload);
      assert.equal(first.status, 200, JSON.stringify(first));
      result.firstFinalize = await post('/api/payment/finalize', {}, first.body.paymentAccessToken);
      assert.equal(result.firstFinalize.status, 200, JSON.stringify(result.firstFinalize));
      const record = await paymentFor(first);
      const paymentId = `payment_${record.providerOrderId}`;
      const refunds = [{ refund_id: 'ownership_full_refund', payment_id: paymentId,
        status: 'succeeded', amount: 4500, currency: 'USD', is_partial: false }];
      result.refund = await fixture.refundPayment(paymentId, refunds, 'ownership_full_refund_event');
      assert.equal(result.refund.status, 200, JSON.stringify(result.refund));
      result.replacement = await fixture.start(await freshIntent(scenario));
      assert.equal(result.replacement.status, 200, JSON.stringify(result.replacement));
      const replacement = await paymentFor(result.replacement);
      assert.notEqual(record._id, replacement._id);
      result.replay = await fixture.refundPayment(paymentId, refunds, 'ownership_full_refund_retry');
      assert.equal(result.replay.status, 200, JSON.stringify(result.replay));
      result.lock = await commerce.getDocument(replacement.startClaimId);
      assert.equal(result.lock.paymentRecordId, replacement._id);
      result.finalize = await post('/api/payment/finalize', {}, result.replacement.body.paymentAccessToken);
      assert.equal(result.finalize.status, 200, JSON.stringify(result.finalize));
    });
    await check('a refund whose lock cleanup fails cannot replay a closed checkout', async result => {
      const scenario = await original();
      const first = await fixture.start(scenario.payload);
      assert.equal(first.status, 200, JSON.stringify(first));
      const finalized = await post('/api/payment/finalize', {}, first.body.paymentAccessToken);
      assert.equal(finalized.status, 200, JSON.stringify(finalized));
      const record = await paymentFor(first);
      let releaseFailed = false;
      fixture.setRequestHook((phase, request) => {
        if (!releaseFailed && phase === 'before' &&
            request.path === '/rest/v1/rpc/roo_apply_commerce_document_mutations' &&
            request.body.p_mutations?.some(mutation => mutation.operation === 'delete' && mutation.id === record.startClaimId)) {
          releaseFailed = true;
          throw new Error('Synthetic upgrade lock release failure');
        }
      });
      const paymentId = `payment_${record.providerOrderId}`;
      const refunds = [{ refund_id: 'ownership_retained_refund', payment_id: paymentId,
        status: 'succeeded', amount: 4500, currency: 'USD', is_partial: false }];
      try {
        result.refund = await fixture.refundPayment(paymentId, refunds, 'ownership_retained_refund_event');
      } finally {
        fixture.setRequestHook(null);
      }
      assert.equal(releaseFailed, true);
      assert.equal(result.refund.status, 503, JSON.stringify(result.refund));
      result.refunded = await commerce.getDocument(record._id);
      assert.equal(result.refunded.status, 'refunded');
      assert.equal(result.refunded.refundRequiresBookingSync, true);
      assert.equal((await commerce.getDocument(finalized.body.bookingId)).status, 'refunded');
      assert.equal((await commerce.getDocument(record.startClaimId)).paymentRecordId, record._id);
      result.replay = await fixture.start(scenario.payload);
      assert.equal(result.replay.status, 409, JSON.stringify(result.replay));
      assert.equal(result.replay.body.code, 'upgrade_checkout_closed');
      result.pending = await fixture.start(await freshIntent(scenario));
      assert.equal(result.pending.status, 409, JSON.stringify(result.pending));
      assert.equal(result.pending.body.code, 'upgrade_checkout_closed');
      result.retry = await fixture.refundPayment(paymentId, refunds, 'ownership_retained_refund_event');
      assert.equal(result.retry.status, 200, JSON.stringify(result.retry));
      assert.equal((await commerce.getDocument(record._id)).refundRequiresBookingSync, false);
      result.replacement = await fixture.start(await freshIntent(scenario));
      assert.equal(result.replacement.status, 200, JSON.stringify(result.replacement));
      const replacement = await paymentFor(result.replacement);
      assert.notEqual(replacement._id, record._id);
      assert.equal((await commerce.getDocument(record.startClaimId)).paymentRecordId, replacement._id);
      result.duplicate = await fixture.refundPayment(paymentId, refunds, 'ownership_retained_refund_duplicate');
      assert.equal(result.duplicate.status, 200, JSON.stringify(result.duplicate));
      assert.equal((await commerce.getDocument(record.startClaimId)).paymentRecordId, replacement._id);
    });
    await check('a completed upgrade can advance again through either chain booking id', async result => {
      const scenario = await original();
      const first = await fixture.start(scenario.payload);
      assert.equal(first.status, 200, JSON.stringify(first));
      const done = await post('/api/payment/finalize', {}, first.body.paymentAccessToken);
      assert.equal(done.status, 200, JSON.stringify(done));
      const child = await commerce.getDocument(done.body.bookingId);
      const { issueUpgradeIntentToken } = await import('../src/server/api/ref/upgradeIntentToken.js');
      const higher = id => ({ originalOrderId: id, email: scenario.booking.email,
        packageTitle: 'Fixture higher upgrade', upgradeIntentToken: issueUpgradeIntentToken({
          bookingId: id, email: scenario.booking.email, targetPackageTitle: 'Fixture higher upgrade',
          backend: 'supabase', cutoverGeneration: 0 }), deferEmailsUntilConfirmation: true });
      result.invalid = await fixture.start({ ...higher(child._id), specs: { invalid: true } });
      assert.equal(result.invalid.status, 400, JSON.stringify(result.invalid));
      result.start = await fixture.start(higher(child._id));
      assert.equal(result.start.status, 200, JSON.stringify(result.start));
      result.competing = await fixture.start(higher(scenario.booking._id));
      assert.equal(result.competing.status, 409, JSON.stringify(result.competing));
      const current = await paymentFor(result.start);
      assert.equal(current.pricingSnapshot.netAmount, 50);
      result.finalize = await post('/api/payment/finalize', {}, result.start.body.paymentAccessToken);
      assert.equal(result.finalize.status, 200, JSON.stringify(result.finalize));
      result.booking = await commerce.getDocument(result.finalize.body.bookingId);
      assert.equal(result.booking.originalOrderId, scenario.booking._id);
      const allHigher = await commerce.fetch('*[_type == "booking" && packageTitle == $title && originalOrderId == $id]',
        { title: 'Fixture higher upgrade', id: scenario.booking._id });
      assert.equal(allHigher.length, 1);
    });
    await check('a child-booking upgrade can retry failed confirmation emails', async result => {
      const scenario = await original();
      const first = await fixture.start(scenario.payload);
      assert.equal(first.status, 200, JSON.stringify(first));
      const completed = await post('/api/payment/finalize', {}, first.body.paymentAccessToken);
      assert.equal(completed.status, 200, JSON.stringify(completed));
      await fixture.database.client.rpc('roo_apply_document_mutations', { p_mutations: [{ operation: 'create',
        document: { _id: 'package.fixture.retry', _type: 'package', title: 'Fixture retry upgrade', price: '$149.95' } }] });
      const { issueUpgradeIntentToken } = await import('../src/server/api/ref/upgradeIntentToken.js');
      const payload = { ...scenario.payload, originalOrderId: completed.body.bookingId, packageTitle: 'Fixture retry upgrade',
        upgradeIntentToken: issueUpgradeIntentToken({ bookingId: completed.body.bookingId, email: scenario.booking.email,
          targetPackageTitle: 'Fixture retry upgrade', backend: 'supabase', cutoverGeneration: 0 }) };
      const started = await fixture.start(payload);
      assert.equal(started.status, 200, JSON.stringify(started));
      fixture.setEmailFailure(true);
      try {
        result.finalize = await post('/api/payment/finalize', {}, started.body.paymentAccessToken);
      } finally {
        fixture.setEmailFailure(false);
      }
      assert.equal(result.finalize.status, 200, JSON.stringify(result.finalize));
      const record = await paymentFor(started);
      result.before = record;
      assert.equal(record.status, 'email_partial');
      assert.equal(record.bookingPayload.originalOrderId, completed.body.bookingId);
      assert.equal((await commerce.getDocument(record.bookingId)).originalOrderId, scenario.booking._id);
      result.fixtureClock = 'Made only the synthetic failed email ledger entries due now; the database clock is unchanged.';
      await fixture.database.sql`update commerce.email_dispatches set next_attempt_at = now() - interval '1 second'
        where booking_id = (select id from commerce.bookings where legacy_sanity_id = ${record.bookingId})
        and status = 'retry'`;
      result.retry = await fixture.dodoWebhook(`payment_${record.providerOrderId}`, 'payment.succeeded', 'ownership_child_confirmation');
      assert.equal(result.retry.status, 200, JSON.stringify(result.retry));
      result.after = await commerce.getDocument(record._id);
      assert.equal(result.after.status, 'booked');
      assert.equal(result.after.emailDispatch.allSent, true);
      result.bookings = await commerce.fetch('*[_type == "booking" && paymentRecordId == $id]', { id: record._id });
      assert.equal(result.bookings.length, 1);
      assert.equal(result.bookings[0].originalOrderId, scenario.booking._id);
    });
    await check('all requests stayed in local fixtures', async () => assert.deepEqual(evidence.blocked, []));
  } finally {
    await fixture.stop();
  }
});
