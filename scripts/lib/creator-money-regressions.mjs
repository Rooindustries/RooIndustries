import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {runPayerIdentityRegressions} from './payer-identity-regressions.mjs';

export async function runCreatorMoneyRegressions({
  run, seed, documents, commerce, read, post, webhook, refundCurrent, fixture, sql, startCheckout, rulesSql,
  emailRequests, rollbackSql,
}) {
  const prepareCheckout = async (state, email) => {
    const {buildSlotHoldId} = await import('../../src/server/booking/slotIdentity.js');
    const {issueHoldToken} = await import('../../src/server/booking/holdToken.js');
    const startTimeUTC = state.record.bookingPayload.startTimeUTC;
    const hold = await commerce.create({
      _id: buildSlotHoldId(startTimeUTC), _type: 'slotHold', backendOwner: 'supabase', cutoverGeneration: 0,
      phase: 'active', holdNonce: state.key, expiresAt: new Date(Date.now() + 1200000).toISOString(),
      startTimeUTC, packageTitle: state.packageDoc.title,
    });
    await documents.createOrReplace({
      _id: '6d8a3646-0ed2-44b5-ad45-c5c9d578126a', _type: 'bookingSettings',
      dateSlots: [{date: startTimeUTC.slice(0, 10), times: ['15:30']}],
    });
    return {
      ...state.record.bookingPayload, email, status: 'captured', paymentProvider: state.record.provider,
      bookingRequestId: state.key, slotHoldId: hold._id,
      slotHoldToken: issueHoldToken({
        holdId: hold._id, startTimeUTC, expiresAt: hold.expiresAt, holdNonce: state.key,
        backend: 'supabase', cutoverGeneration: 0,
      }),
      ...(state.record.provider === 'paypal' ? {paypalOrderId: state.record.providerOrderId} : {}),
      ...(state.record.provider === 'razorpay' ? {
        razorpayOrderId: state.record.providerOrderId, razorpayPaymentId: state.record.providerPaymentId,
        razorpaySignature: crypto.createHmac('sha256', 'fixture')
          .update(`${state.record.providerOrderId}|${state.record.providerPaymentId}`).digest('hex'),
      } : {}),
    };
  };
  const completeLegacy = async (state, email) => {
    const providerPaymentId = state.record.providerPaymentId;
    const body = await prepareCheckout(state, email);
    const result = await post('/api/ref/createBooking', body);
    assert.equal(result.status, 200, JSON.stringify(result));
    const booking = await commerce.fetch(
      '*[_type == "booking" && packageTitle == $title][0]{...}', {title: state.packageDoc.title},
    );
    assert.ok(booking?._id, JSON.stringify(result));
    state.record = await commerce.fetch(
      '*[_type == "paymentRecord" && providerOrderId == $id][0]{...}', {id: state.record.providerOrderId},
    );
    assert.equal(state.record.bookingId, booking._id);
    assert.equal(state.record.providerPaymentId, providerPaymentId);
    assert.equal((await post('/api/ref/createBooking', body)).status, 200);
    return booking;
  };

  await runPayerIdentityRegressions({run, seed, documents, commerce, read, post, emailRequests, prepareCheckout});

  for (const provider of ['razorpay', 'paypal', 'dodo'])
    for (const mode of ['client', 'recovery'])
      await run(`R3-verified-payer-${provider}-${mode}`, async () => {
        const state = await seed(provider, {booking: false});
        const buyerEmail = 'buyer@example.invalid';
        const payerEmail = 'c.rea.tor+paid@gmail.com';
        await documents.patch(state.creator._id).set({creatorEmail: 'creator@gmail.com'}).commit();
        state.payment.email = payerEmail;
        state.payment.customer = {email: payerEmail};
        const checkout = mode === 'client' ? await prepareCheckout(state, buyerEmail) : {};
        state.record = await commerce.patch(state.record._id).set({
          payerEmail: buyerEmail,
          bookingPayload: {...state.record.bookingPayload, ...checkout, email: buyerEmail},
          ...(mode === 'client' ? {
            status: 'started',
            holdSnapshot: {
              slotHoldId: checkout.slotHoldId, slotHoldToken: checkout.slotHoldToken,
              slotHoldExpiresAt: new Date(Date.now() + 1200000).toISOString(),
            },
          } : {}),
        }).commit();
        if (mode === 'client') await commerce.patch(checkout.slotHoldId).set({
          phase: 'payment_pending', paymentRecordId: state.record._id,
        }).commit();
        const {createPaymentAccessToken} = await import('../../src/server/api/payment/accessToken.js');
        const token = createPaymentAccessToken({
          paymentRecordId: state.record._id, provider,
          pricingFingerprint: state.record.pricingFingerprint, backend: 'supabase', expirySeconds: 3600,
        });
        const complete = () => post('/api/payment/finalize', {
          ...checkout, payerEmail: buyerEmail,
          ...(provider === 'razorpay' ? {
            razorpayOrderId: state.record.providerOrderId,
            razorpayPaymentId: state.record.providerPaymentId,
            razorpaySignature: crypto.createHmac('sha256', 'fixture')
              .update(`${state.record.providerOrderId}|${state.record.providerPaymentId}`).digest('hex'),
          } : {}),
        }, {authorization: `Bearer ${token}`});
        const result = await complete();
        assert.equal(result.status, 200, JSON.stringify(result));
        const record = await read(state.record._id);
        const booking = await read(record.bookingId);
        assert.ok(booking?._id, JSON.stringify(result));
        assert.equal(booking.commissionAmount, 0);
        assert.equal(booking.commissionPercent, 0);
        assert.equal(booking.selfReferral, true);
        assert.equal(record.payerEmail, payerEmail);
        assert.equal(booking.payerEmail, payerEmail);
        if (mode === 'client') assert.equal(booking.requiresReschedule, undefined);
        else assert.equal(booking.requiresReschedule, true);
        assert.equal((await complete()).status, 200);
        assert.equal((await read(booking._id)).commissionAmount, 0);
        return {booking};
      });

  await run('R3-self-referral-without-creator-id', async () => {
    const state = await seed('dodo', {booking: false});
    await commerce.patch(state.record._id).set({pricingSnapshot: {
      ...state.record.pricingSnapshot, effectiveReferralId: '', selfReferral: true,
    }}).commit();
    assert.equal((await webhook()).status, 200);
    const booking = await read((await read(state.record._id)).bookingId);
    assert.equal(booking.selfReferral, true);
    assert.equal(booking.commissionAmount, 0);
    assert.equal(booking.commissionPercent, 0);
    return {booking};
  });

  await run('R3-expired-registration-keeps-review-balances', async () => {
    const state = await seed('dodo', {booking: false, count: 0});
    const email = 'expired-creator@example.invalid';
    const balances = {
      underReviewTotal: 8, emptyCodeReviewXoc: 3, emptyCodeReviewVertex: 6,
      emptyCodeProtectedPaidXoc: 0.5, emptyCodeProtectedPaidVertex: 0.5,
    };
    await documents.patch(state.creator._id).set({
      creatorEmail: email, registrationStatus: 'pending_email',
      registrationVerificationExpiresAt: '2020-01-01T00:00:00Z', ...balances,
    }).commit();
    const result = await post('/api/ref/register', {
      discordUsername: 'fixture', email, paypalEmail: email, slug: state.key,
      password: 'Local-fixture-password-274',
    });
    assert.equal(result.status, 202, JSON.stringify(result));
    const creator = await documents.getDocument(state.creator._id);
    for (const [field, value] of Object.entries(balances)) assert.equal(creator[field], value);
    return {balances};
  });

  await run('R2-custom-domain-mailboxes', async () => {
    const saved = [];
    for (const [creatorEmail, buyerEmail, expected] of [
      ['creator+one@example.invalid', 'creator+two@example.invalid', 5.5],
      ['creator@example.invalid', 'creator+shop@example.invalid', 5.5],
      ['creator@gmail.com', 'c.rea.tor+shop@googlemail.com', 0],
    ]) {
      const state = await seed('dodo', {booking: false});
      await documents.patch(state.creator._id).set({creatorEmail}).commit();
      state.record = await commerce.patch(state.record._id)
        .set({bookingPayload: {...state.record.bookingPayload, email: buyerEmail}}).commit();
      assert.equal((await webhook()).status, 200);
      const booking = await read((await read(state.record._id)).bookingId);
      assert.equal(booking.commissionAmount, expected);
      saved.push(booking);
    }
    return {saved};
  });

  for (const mode of ['recovery', 'full'])
    for (const identity of ['payer', 'live-creator'])
      await run(`R2-self-${mode}-${identity}`, async () => {
        const state = await seed('dodo', {booking: false});
        if (mode === 'full') await startCheckout(state);
        await documents.patch(state.creator._id).set({creatorEmail: 'new-creator@gmail.com'}).commit();
        state.payment.customer.email = identity === 'payer'
          ? 'new-creator+paid@gmail.com' : 'other@example.invalid';
        state.record = await commerce.patch(state.record._id).set({
          payerEmail: identity === 'payer' ? 'new-creator+paid@gmail.com' : 'other@example.invalid',
          bookingPayload: {...state.record.bookingPayload,
            email: identity === 'payer' ? 'buyer@example.invalid' : 'new-creator@gmail.com'},
          pricingSnapshot: {...state.record.pricingSnapshot, referralCreatorEmail: 'old-creator@example.invalid'},
        }).commit();
        assert.equal((await webhook()).status, 200);
        const booking = await read((await read(state.record._id)).bookingId);
        assert.equal(booking.commissionAmount, 0);
        assert.equal(booking.selfReferral, true);
        return {booking};
      });

  for (const provider of ['paypal', 'razorpay'])
    for (const identity of ['buyer', 'payer'])
      await run(`R2-legacy-self-refund-${provider}-${identity}`, async () => {
        const state = await seed(provider, {booking: false});
        await documents.patch(state.creator._id).set({creatorEmail: 'creator@gmail.com'}).commit();
        state.payment.email = identity === 'payer' ? 'c.rea.tor+paid@gmail.com' : 'payer@example.invalid';
        const booking = await completeLegacy(state,
          identity === 'buyer' ? 'creator@gmail.com' : 'buyer@example.invalid');
        assert.equal(booking.commissionAmount, 0);
        assert.equal(booking.commissionPercent, 0);
        if (identity === 'payer') assert.equal(booking.payerEmail, state.payment.email);
        const snapshot = {...state.record.pricingSnapshot, commissionAmount: 5.5, commissionPercent: 10};
        state.record = await commerce.patch(state.record._id).set({pricingSnapshot: snapshot}).commit();
        const partial = await refundCurrent(5.5, 'r2-partial');
        assert.equal(partial.status, 200, JSON.stringify(partial));
        const refunded = await read(booking._id);
        assert.equal(refunded.commissionAmount, 0);
        assert.equal(refunded.originalCommissionAmount, 0);
        assert.equal((await webhook(provider === 'paypal' ? 'PAYMENT.CAPTURE.REFUNDED' : 'refund.processed')).status, 200);
        assert.equal((await read(booking._id)).commissionAmount, 0);
        return {booking, refunded};
      });

  for (const provider of ['paypal', 'razorpay'])
    await run(`R2-frozen-refund-authority-${provider}`, async () => {
      const state = await seed(provider);
      await commerce.patch(state.record.bookingId).set({
        commissionPercent: 0, commissionAmount: 0, selfReferral: true,
      }).commit();
      const refunded = await refundCurrent(5.5, 'frozen-self');
      assert.equal(refunded.status, 200, JSON.stringify(refunded));
      const booking = await read(state.record.bookingId);
      assert.equal(booking.commissionAmount, 0);
      assert.equal(booking.originalCommissionAmount, 0);
      assert.equal(state.record.pricingSnapshot.commissionAmount, 5.5);
      assert.equal((await webhook(provider === 'paypal' ? 'PAYMENT.CAPTURE.REFUNDED' : 'refund.processed')).status, 200);
      assert.equal((await read(booking._id)).commissionAmount, 0);
      return {booking};
    });

  for (const mode of ['recovery', 'full'])
    await run(`R2-missing-creator-${mode}`, async () => {
      const state = await seed('dodo', {booking: false});
      if (mode === 'full') await startCheckout(state);
      await documents.delete(state.creator._id);
      assert.equal((await webhook()).status, 200);
      const booking = await read((await read(state.record._id)).bookingId);
      assert.equal(booking.commissionAmount, 0);
      assert.equal(booking.commissionPercent, 0);
      assert.equal(booking.referralAccountingApplied, false);
      assert.equal(booking.referralReviewRequired, true);
      assert.equal(booking.referralReviewReason, 'creator_missing_at_commit');
      assert.equal(booking.ownerAlertRequired, true);
      assert.equal((await webhook()).status, 200);
      const alerts = () => emailRequests.filter(request =>
        request.body.subject === 'Paid booking needs a creator review' && request.body.text.includes(booking._id));
      const {dispatchCouponAlerts} = await import('../../src/server/api/ref/couponAlerts.js');
      await dispatchCouponAlerts({client: commerce});
      await dispatchCouponAlerts({client: commerce});
      assert.equal(alerts().length, 1);
      assert.ok(alerts()[0].headers['idempotency-key'].startsWith('referral-review/'));
      assert.ok(alerts()[0].body.text.includes(state.creator._id));
      assert.equal((await read(booking._id)).ownerAlertRequired, false);
      assert.equal((await refundCurrent(1, 'missing-creator')).status, 200);
      assert.equal((await read(booking._id)).commissionAmount, 0);
      return {booking, alerts: alerts()};
    });

  await run('R2-alert-settings-read-once', async () => {
    const {dispatchCouponAlerts} = await import('../../src/server/api/ref/couponAlerts.js');
    const alerts = [];
    for (let index = 0; index < 3; index++) alerts.push(await commerce.create({
      _id: `couponRedemption.r2-settings-${index}`, _type: 'couponRedemption',
      ownerAlertRequired: true, ownerAlertRecipient: 'owner@example.invalid', bookingId: `booking.r2-${index}`,
    }));
    let settingsReads = 0;
    fixture.setRequestHook((phase, request) => {
      if (phase === 'before' && JSON.stringify(request.body).includes('bookingSettings')) settingsReads++;
    });
    try {
      await dispatchCouponAlerts({client: commerce});
      assert.equal(settingsReads, 1);
      for (const alert of alerts) assert.equal((await read(alert._id)).ownerAlertRequired, false);
      return {settingsReads};
    } finally {
      fixture.setRequestHook(null);
      for (const alert of alerts) await commerce.delete(alert._id);
    }
  });

  await run('R2-migration-pricing-drift', async () => {
    const signature = 'public.roo_consume_quote_rate_limit_and_get_pricing(text,timestamp with time zone,timestamp with time zone,integer,text[],text,text,text)';
    const [{definition}] = await sql`select pg_get_functiondef(${signature}::regprocedure) as definition`;
    const needle = "      and coalesce(source.payload->>'registrationStatus', '') <> 'pending_email'";
    const [{savedTable}] = await sql`select to_regclass('migration.creator_money_rule_functions') as "savedTable"`;
    const original = savedTable ? (await sql`select before_definition from migration.creator_money_rule_functions
      where signature = ${signature}`)[0].before_definition : definition;
    const connection = await sql.reserve();
    try {
      for (const suffix of ['missing-needle', 'remaining-filter']) {
        const drifted = original.replace(needle, needle.replace('      and', '    and'));
        const body = suffix === 'remaining-filter'
          ? original.replace(/\bbegin\b/i, "begin\n  perform 'pending_email';")
          : drifted.replaceAll("'currentCommissionPercent'", "'renamedCommissionPercent'");
        assert.notEqual(body, definition);
        await connection.unsafe(body);
        await assert.rejects(connection.unsafe(rulesSql), /Creator pricing .*drifted|still excludes pending creators/);
        await connection.unsafe('rollback');
        await connection.unsafe(definition);
      }
      await connection.unsafe(rulesSql);
      return {driftRejected: true, replayPassed: true};
    } finally {
      await connection.unsafe('rollback');
      await connection.unsafe(definition);
      connection.release();
    }
  });

  await run('R2-migration-rollback-keeps-new-payouts', async () => {
    const state = await seed('dodo');
    const foreign = await seed('dodo');
    for (const row of [state, foreign]) await commerce.patch(row.record.bookingId)
      .unset(['commissionCalculationVersion']).set({referralCode: ''}).commit();
    const before = await documents.patch(state.creator._id).set({
      slug: {current: ''}, earnedXoc: 0, earnedVertex: 11, earnedTotal: 11,
      vertexPayments: [{_key: 'before', amount: 2}], paidXoc: 0, paidVertex: 2, paidTotal: 2,
      owedXoc: 0, owedVertex: 9, owedTotal: 9,
    }).commit();
    const connection = await sql.reserve();
    try {
      await connection.unsafe(rulesSql);
      const corrected = await documents.getDocument(state.creator._id);
      assert.equal(corrected.earnedTotal, 5.5);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const [permissions] = await sql`select
          has_table_privilege(${role}, 'migration.creator_empty_code_before', 'select') as readable`;
        assert.equal(permissions.readable, false);
      }
      const durable = await sql`select payload from migration.creator_empty_code_before
        where legacy_sanity_id = ${state.creator._id}`;
      assert.deepEqual(durable[0].payload, before);
      await commerce.create({
        _id: `booking.r2-future-${state.key}`, _type: 'booking', status: 'captured',
        packageTitle: 'Vertex future', commissionCalculationVersion: 2, commissionAmount: 1,
        referral: {_ref: state.creator._id}, referralCode: '',
      });
      const payout = await post('/api/ref/updatePayments', {
        referralId: state.creator._id, packageType: 'vertex', amount: 1, payoutId: `r2-payout-${state.key}`,
      }, {'x-admin-key': 'fixture-admin'});
      assert.equal(payout.status, 200, JSON.stringify(payout));
      const afterPayout = await documents.getDocument(state.creator._id);
      const payments = afterPayout.vertexPayments;
      await documents.patch(state.creator._id).set({notes: 'Changed after correction'}).commit();
      const receipts = await sql`select payload from migration.source_documents
        where document_type = 'creatorPayout' and not tombstoned order by legacy_sanity_id`;
      await connection.unsafe(rollbackSql);
      const restored = await documents.getDocument(state.creator._id);
      assert.equal(restored.earnedTotal, 12);
      assert.equal(restored.paidTotal, 3);
      assert.equal(restored.owedTotal, 9);
      assert.deepEqual(restored.vertexPayments, payments);
      assert.equal(restored.notes, 'Changed after correction');
      assert.equal(Object.hasOwn(restored, 'emptyCodeReviewVertex'), false);
      assert.deepEqual(await sql`select payload from migration.source_documents
        where document_type = 'creatorPayout' and not tombstoned order by legacy_sanity_id`, receipts);
      await connection.unsafe(rollbackSql);
      assert.deepEqual(await documents.getDocument(state.creator._id), restored);
      return {before, corrected, restored};
    } finally {
      await connection.unsafe('rollback');
      connection.release();
    }
  });

  await run('R3-rollback-malformed-legacy-balances', async () => {
    const states = [];
    for (const earnedVertex of ['', 'not-a-number', null]) {
      const state = await seed('dodo');
      const foreign = await seed('dodo');
      for (const row of [state, foreign]) await commerce.patch(row.record.bookingId)
        .unset(['commissionCalculationVersion']).set({referralCode: ''}).commit();
      const payments = [{amount: 2}, {amount: ''}, {amount: 'invalid'}, {amount: null}, {}];
      await documents.patch(state.creator._id).set({
        slug: {current: ''}, earnedXoc: 'invalid', earnedVertex, earnedTotal: 11,
        xocPayments: {}, vertexPayments: payments,
      }).commit();
      states.push({state, payments});
    }
    for (const entry of states) {
      const [{earnings}] = await sql`select public.roo_referral_earnings_summary(
        ${entry.state.creator._id}, '') as earnings`;
      entry.expectedEarned = earnings.total;
    }
    const connection = await sql.reserve();
    try {
      await connection.unsafe(rulesSql);
      await connection.unsafe(rollbackSql);
      const restored = [];
      for (const {state, payments, expectedEarned} of states) {
        const creator = await documents.getDocument(state.creator._id);
        assert.equal(creator.earnedTotal, expectedEarned);
        assert.equal(creator.paidTotal, 2);
        assert.equal(creator.owedTotal, Math.max(0, expectedEarned - 2));
        assert.deepEqual(creator.vertexPayments, payments);
        assert.deepEqual(creator.xocPayments, {});
        restored.push(creator);
      }
      return {restored};
    } finally {
      await connection.unsafe('rollback');
      connection.release();
    }
  });
}
