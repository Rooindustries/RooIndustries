import assert from 'node:assert/strict';

export async function runPaymentReviewScenarios({
  run, a1Start, a1Hook, row, sql, commerce, requestFlow, tokenFor,
  originalNow, providerRequests, dodoPayment, snapshot, requestRoute, dodoReq, originalDate, documents,
}) {
  const dodoHook = async (type = 'payment.processing', payment = dodoPayment()) => {
    const req = dodoReq(payment, type, type);
    return requestRoute('/api/payment/webhook/dodo', req.body, req.headers);
  };
  const authenticate = payment => ({ Authorization: `Bearer ${tokenFor(payment)}` });
  const reviewStart = async (variant = 'review-referral') => {
    const checkout = await a1Start('dodo', variant);
    dodoPayment().status = 'requires_merchant_action';
    const pending = await dodoHook();
    assert.equal(pending.status, 200, JSON.stringify(pending));
    return checkout;
  };
  const assertConfirmed = async checkout => {
    const complete = (await row(checkout.id)).payload;
    assert.equal(complete.status, 'booked', JSON.stringify(complete));
    const booking = (await row(complete.bookingId)).payload;
    assert.equal(booking.status, 'captured');
    assert.equal(booking.commissionAmount, 1);
    assert.equal(booking.referralCode.toLowerCase(), 'fixture');
    assert.equal((await row('referral.a1')).payload.successfulReferrals, 1);
    assert.equal(complete.emailDispatch.allSent, true);
    assert.equal(providerRequests().filter(request => request.path === '/emails').length, 2);
    assert.equal((await sql`select id from commerce.bookings`).length, 1);
    assert.equal(providerRequests().filter(request => request.method === 'POST' && request.path === '/checkouts').length, 1);
    return { complete, booking, native: await snapshot() };
  };
  await run('review-dodo-retains-slot-after-expiry', async () => {
    const checkout = await a1Start('dodo', 'review-referral');
    dodoPayment().status = 'requires_merchant_action';
    const pending = await dodoHook();
    const payment = (await row(checkout.id)).payload;
    const hold = (await row(payment.holdSnapshot.slotHoldId)).payload;
    assert.ok([200, 503].includes(pending.status), JSON.stringify(pending));
    assert.equal(payment.reviewPending, true, 'Provider review must be persisted');
    assert.ok(Date.parse(hold.expiresAt) > originalNow() + 86400000,
      'The review must retain the slot beyond the checkout countdown');
    assert.equal(hold.paymentRecordId, checkout.id);
    assert.equal(hold.phase, 'payment_pending');
    const status = await requestFlow('status', { paymentAccessToken: tokenFor(payment) });
    assert.equal(status.body.reviewPending, true);
    assert.equal(status.body.manualReviewRequired, undefined);
    const restarted = await requestRoute('/api/payment/start', {
      ...checkout.input, bookingPayload: payment.bookingPayload,
    });
    assert.equal(restarted.status, 200, JSON.stringify(restarted));
    assert.equal(restarted.body.reviewPending, true);
    assert.deepEqual(restarted.body.providerPayload, {});
    Date.now = () => originalNow() + 21 * 60 * 1000;
    const secondBuyer = await requestRoute('/api/holdSlot', {
      packageTitle: payment.bookingPayload.packageTitle,
      startTimeUTC: payment.bookingPayload.startTimeUTC,
    });
    assert.equal(secondBuyer.status, 409, JSON.stringify(secondBuyer));
    const cleanup = await requestRoute('/api/payment/reconcile', {}, { Authorization: 'Bearer fixture-cron' });
    assert.equal(cleanup.status, 200, JSON.stringify(cleanup));
    assert.equal((await row(hold._id)).payload.paymentRecordId, checkout.id);
    const switched = await requestRoute('/api/payment/cancel', {}, authenticate(payment));
    assert.equal(switched.status, 409, JSON.stringify(switched));
    assert.equal((await row(hold._id)).payload.phase, 'payment_pending');
    return { pending, status, hold, native: await snapshot() };
  });

  for (const approval of ['webhook', 'cron', 'finalize']) {
    await run(`review-dodo-${approval}-approval-after-expiry`, async () => {
      const checkout = await reviewStart();
      const pending = (await row(checkout.id)).payload;
      if (approval === 'webhook') {
        await commerce.patch('referral.a1').set({ currentCommissionPercent: 90 }).commit();
        await documents.patch('package.payment-integration').set({ price: '$19.98' }).commit();
      }
      Date.now = () => originalNow() + 21 * 60 * 1000;
      dodoPayment().status = 'succeeded';
      await commerce.patch(checkout.id).set({ nextRecoveryAt: '' }).commit();
      const approved = approval === 'webhook' ? await dodoHook('payment.succeeded')
        : approval === 'cron' ? await requestRoute('/api/payment/reconcile', {}, { Authorization: 'Bearer fixture-cron' })
        : await requestRoute('/api/payment/finalize', {}, authenticate(pending));
      assert.equal(approved.status, 200, JSON.stringify(approved));
      const proof = await assertConfirmed(checkout);
      await dodoHook('payment.processing', { ...dodoPayment(), status: 'requires_merchant_action' });
      await dodoHook('payment.succeeded');
      assert.equal((await row(checkout.id)).payload.bookingId, proof.complete.bookingId);
      assert.equal((await row('referral.a1')).payload.successfulReferrals, 1);
      return { approved, ...proof };
    });
  }

  await run('review-dodo-replay-and-concurrent-approval', async () => {
    const checkout = await reviewStart();
    const pending = (await row(checkout.id)).payload;
    const premature = await dodoHook('payment.succeeded', { ...dodoPayment(), status: 'succeeded' });
    assert.equal(premature.status, 200);
    assert.equal((await row(checkout.id)).payload.bookingId, '');
    dodoPayment().status = 'succeeded';
    const results = await Promise.all([
      dodoHook('payment.succeeded'), dodoHook('payment.succeeded'),
      requestRoute('/api/payment/finalize', {}, authenticate(pending)),
    ]);
    await dodoHook('payment.succeeded');
    return { results, ...await assertConfirmed(checkout) };
  });

  await run('review-dodo-signatures-and-retry', async () => {
    const checkout = await a1Start('dodo', 'review-referral');
    dodoPayment().status = 'requires_merchant_action';
    const req = dodoReq(dodoPayment(), 'payment.processing', 'retry');
    const originalHold = (await row(checkout.input.bookingPayload.slotHoldId)).payload;
    const tampered = await requestRoute('/api/payment/webhook/dodo',
      { ...req.body, business_id: 'tampered' }, req.headers);
    assert.equal(tampered.status, 401);
    assert.deepEqual((await row(originalHold._id)).payload, originalHold);

    Date.now = () => originalNow() - 360000;
    const stale = dodoReq(dodoPayment(), 'payment.processing', 'stale');
    Date.now = originalNow;
    assert.equal((await requestRoute('/api/payment/webhook/dodo', stale.body, stale.headers)).status, 401);

    await sql.unsafe(`create or replace function public.payment_review_hold_failure_fixture()
      returns trigger language plpgsql as $$ begin
        if new.document_type = 'slotHold' then raise exception 'Synthetic hold storage failure'; end if;
        return new;
      end $$;
      create trigger payment_review_hold_failure_fixture before update on migration.source_documents
      for each row execute function public.payment_review_hold_failure_fixture();`);
    let retryable;
    try {
      retryable = await requestRoute('/api/payment/webhook/dodo', req.body, req.headers);
      assert.equal(retryable.status, 503);
      assert.deepEqual((await row(originalHold._id)).payload, originalHold);
      assert.notEqual((await row(checkout.id)).payload.reviewPending, true);
    } finally {
      await sql.unsafe('drop trigger payment_review_hold_failure_fixture on migration.source_documents');
    }
    const retried = await requestRoute('/api/payment/webhook/dodo', req.body, req.headers);
    assert.equal(retried.status, 200, JSON.stringify(retried));
    assert.equal((await row(checkout.id)).payload.reviewPending, true);
    dodoPayment().status = 'succeeded';
    await dodoHook('payment.succeeded');
    return { tampered, retryable, retried, ...await assertConfirmed(checkout) };
  });

  await run('review-dodo-two-days-keeps-status-and-confirms', async () => {
    const checkout = await reviewStart();
    const pending = (await row(checkout.id)).payload;
    const headers = authenticate(pending);
    const advanced = originalNow() + 2 * 86400000;
    globalThis.Date = class extends originalDate {
      constructor(...args) { super(...(args.length ? args : [advanced])); }
      static now() { return advanced; }
    };
    const status = await requestRoute('/api/payment/status', {}, headers);
    assert.equal(status.status, 200, JSON.stringify(status));
    assert.equal(status.body.reviewPending, true);
    const mutation = await requestRoute('/api/payment/finalize', {}, headers);
    assert.equal(mutation.status, 401, 'An old token only extends status reading');
    dodoPayment().status = 'succeeded';
    assert.equal((await dodoHook('payment.succeeded')).status, 200);
    const completed = await requestRoute('/api/payment/status', {}, headers);
    assert.equal(completed.status, 200, JSON.stringify(completed));
    return { status, completed, ...await assertConfirmed(checkout) };
  });

  for (const decision of ['failed', 'cancelled', 'refunded']) {
    await run(`review-dodo-${decision}-releases-once`, async () => {
      const checkout = await reviewStart();
      const pending = (await row(checkout.id)).payload;
      if (decision === 'refunded') {
        dodoPayment().status = 'succeeded';
        dodoPayment().refund_status = 'full';
        dodoPayment().refunds = [{ refund_id: 'refund-fixture', payment_id: 'payment-fixture',
          status: 'succeeded', amount: 999, currency: 'USD' }];
      } else dodoPayment().status = decision;
      const rejected = await dodoHook(decision === 'refunded' ? 'refund.succeeded' : `payment.${decision}`);
      await dodoHook(decision === 'refunded' ? 'refund.succeeded' : `payment.${decision}`);
      const closed = (await row(checkout.id)).payload;
      assert.equal(closed.status, decision === 'cancelled' ? 'abandoned' : decision);
      assert.equal(closed.reviewPending, false);
      assert.equal((await row(pending.holdSnapshot.slotHoldId)).payload.phase, 'released');
      assert.equal((await sql`select id from commerce.bookings`).length, 0);
      assert.equal((await row('referral.a1')).payload.successfulReferrals, 0);
      assert.equal(closed.refunds?.filter(refund => refund.status === 'processed').length || 0,
        decision === 'refunded' ? 1 : 0);
      return { rejected, closed, native: await snapshot() };
    });
  }

  await run('review-dodo-coupon-rejection-releases-capacity', async () => {
    const checkout = await reviewStart('review-coupon');
    const payment = (await row(checkout.id)).payload;
    const redemption = (await row(payment.couponReservationId)).payload;
    assert.equal(redemption.status, 'reserved');
    dodoPayment().status = 'failed';
    await dodoHook('payment.failed');
    await dodoHook('payment.failed');
    const released = (await row(payment.couponReservationId)).payload;
    const coupon = (await row(released.coupon._ref)).payload;
    assert.equal(released.status, 'released');
    assert.equal(coupon.activeReservations, 0);
    assert.equal(coupon.timesUsed, 0);
    return { payment, released, coupon };
  });

  await run('review-dodo-does-not-retain-another-buyers-hold', async () => {
    const checkout = await a1Start('dodo', 'review-referral');
    const payment = (await row(checkout.id)).payload;
    const id = payment.holdSnapshot.slotHoldId;
    await commerce.patch(id).set({ holdNonce: 'different-owner', paymentRecordId: 'paymentRecord.other' }).commit();
    const foreign = (await row(id)).payload;
    dodoPayment().status = 'requires_merchant_action';
    const response = await dodoHook();
    assert.equal(response.status, 503);
    assert.deepEqual((await row(id)).payload, foreign);
    assert.notEqual((await row(checkout.id)).payload.reviewPending, true);
    await commerce.patch(checkout.id).set({
      status: 'needs_recovery', reconciliationRecoveryTerminal: true,
      nextRecoveryAt: '9999-12-31T23:59:59.999Z',
    }).commit();
    dodoPayment().status = 'failed';
    const rejected = await requestRoute('/api/payment/reconcile', {}, { Authorization: 'Bearer fixture-cron' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected));
    assert.equal((await row(checkout.id)).payload.status, 'failed');
    assert.deepEqual((await row(id)).payload, foreign);
    return { response, rejected, foreignHoldUnchanged: true };
  });

  for (const provider of ['dodo', 'paypal', 'razorpay']) {
    for (const legacyState of ['exhausted', 'expired-legacy', 'cleaned-legacy']) {
      await run(`review-${legacyState}-${provider}-automatically-confirms`, async () => {
        const checkout = await a1Start(provider, 'review-referral');
        await sql.unsafe(`create or replace function public.payment_review_failure_fixture()
          returns trigger language plpgsql as $$ begin
            if new.document_type = 'booking' then raise exception 'Synthetic booking storage failure'; end if;
            return new;
          end $$;
          create trigger payment_review_failure_fixture before insert on migration.source_documents
          for each row execute function public.payment_review_failure_fixture();`);
        try {
          await a1Hook(provider);
          for (let attempt = 1; attempt < 12; attempt += 1) {
            const current = (await row(checkout.id)).payload;
            await requestFlow('finalize', {
              paymentAccessToken: tokenFor(current), body: checkout.proof,
            });
          }
        } finally {
          await sql.unsafe('drop trigger payment_review_failure_fixture on migration.source_documents');
        }
        const pending = (await row(checkout.id)).payload;
        assert.equal(pending.reconciliationRecoveryTerminal, true,
          'Reproduce actual exhausted finalization through provider webhook');
        assert.equal(pending.bookingId, '');
        if (legacyState !== 'exhausted') {
          const releasedAt = new Date(originalNow() - 60000).toISOString();
          if (legacyState === 'cleaned-legacy') {
            await sql.begin(async tx => {
              const id = pending.holdSnapshot.slotHoldId;
              await tx`update migration.source_documents
                set payload = jsonb_set(payload, '{expiresAt}', to_jsonb(${releasedAt}::text))
                where legacy_sanity_id = ${id}`;
              await tx`update commerce.slot_holds set expires_at = ${releasedAt}::timestamptz
                where legacy_sanity_id = ${id}`;
              const [cleanup] = await tx`select public.roo_cleanup_expired_supabase_holds(0, 100) as result`;
              assert.equal(cleanup.result.expired_holds, 1);
            });
            assert.equal((await row(pending.holdSnapshot.slotHoldId)).payload.phase, 'expired');
          } else {
            await commerce.patch(pending.holdSnapshot.slotHoldId).set({
              phase: 'released', expiresAt: releasedAt, paymentRecordId: '', paymentProvider: '',
              releaseReason: 'payment_recovery_hold_expired',
            }).commit();
          }
          await commerce.patch(checkout.id).set({
            reviewPending: false, reviewStartedAt: '',
            nextRecoveryAt: '9999-12-31T23:59:59.999Z',
            holdSnapshot: { ...pending.holdSnapshot, phase: 'released',
              slotHoldExpiresAt: releasedAt, slotHoldToken: checkout.input.bookingPayload.slotHoldToken },
          }).commit();
        }
        const reconciled = await requestFlow('reconcile');
        const complete = (await row(checkout.id)).payload;
        assert.ok(['booked', 'email_partial'].includes(complete.status), JSON.stringify(reconciled));
        assert.ok(complete.bookingId);
        const booking = (await row(complete.bookingId)).payload;
        assert.equal(booking.status, 'captured');
        assert.equal(booking.referralCode.toLowerCase(), 'fixture');
        assert.equal(booking.commissionAmount, 1);
        const referral = (await row('referral.a1')).payload;
        assert.equal(referral.successfulReferrals, 1);
        await requestFlow('reconcile');
        await a1Hook(provider);
        const bookings = await sql`select legacy_sanity_id from commerce.bookings`;
        assert.equal(bookings.length, 1);
        assert.equal((await row('referral.a1')).payload.successfulReferrals, 1);
        assert.equal(providerRequests().filter(request => request.method === 'POST' &&
          /^\/(checkouts|v2\/checkout\/orders|v1\/orders)$/.test(request.path)).length, 1);
        return { pending, complete, booking, reconciled, native: await snapshot() };
      });
    }
  }
}
