import assert from 'node:assert/strict';

export async function runCreatorMoneyRedeployRegressions({
  run, seed, documents, commerce, read, post, webhook, refundCurrent, sql, rulesSql, rollbackSql,
}) {
  for (const provider of ['dodo', 'paypal', 'razorpay']) {
    for (const flag of ['present', 'absent', 'false', 'archived-false', 'stale-false', 'stale-true']) {
      await run(`R6-historical-refund-${provider}-${flag}`, async () => {
        const state = await seed(provider, {amount: 100});
        const accounted = !['false', 'archived-false', 'stale-true'].includes(flag);
        const paymentFlag = flag === 'stale-false' ? false : flag === 'stale-true' ? true : accounted;
        await commerce.patch(state.record.bookingId).set({referralAccountingApplied: accounted}).commit();
        await commerce.delete(state.record.bookingId);
        await commerce.patch(state.record._id).set({
          historicalBookingReconstruction: true, status: 'needs_recovery',
          recoveryReason: 'payment_booking_missing', nextRecoveryAt: '2000-01-01T00:00:00.000Z',
          lastAttemptAt: '2000-01-01T00:00:00.000Z',
          bookingPayload: {email: state.record.bookingPayload.email, packageTitle: state.packageDoc.title},
          ...(['absent', 'archived-false'].includes(flag) ? {} : {referralAccountingApplied: paymentFlag}),
        }).commit();
        const recovery = await post('/api/payment/reconcile', {}, {authorization: 'Bearer fixture'});
        assert.equal(recovery.status, 200, JSON.stringify(recovery));
        const record = await read(state.record._id);
        const booking = await read(record.bookingId);
        assert.equal(booking.referralAccountingApplied, accounted);
        assert.equal((await documents.getDocument(state.creator._id)).successfulReferrals, 5);
        const refund = await refundCurrent(100, 'recovered-accounting', true);
        assert.equal(refund.status, 200, JSON.stringify(refund));
        assert.equal((await documents.getDocument(state.creator._id)).successfulReferrals, accounted ? 4 : 5);
        assert.equal((await refundCurrent(100, 'recovered-accounting', true)).status, 200);
        assert.equal((await documents.getDocument(state.creator._id)).successfulReferrals, accounted ? 4 : 5);
        return {booking, record};
      });
    }
  }

  for (const provider of ['dodo', 'paypal', 'razorpay']) {
    for (const decision of ['release', 'partial-release', 'reject', 'self', 'former-self']) {
      await run(`R6-payer-review-${provider}-${decision}`, async () => {
        const state = await seed(provider, {booking: false, amount: 100, count: 0});
        state.payment.customer = {email: ''};
        state.payment.email = '';
        const event = {dodo: 'payment.succeeded', paypal: 'PAYMENT.CAPTURE.COMPLETED', razorpay: 'payment.captured'};
        const captured = await webhook(event[provider]);
        assert.equal(captured.status, 200, JSON.stringify(captured));
        const record = await read(state.record._id);
        const booking = await read(record.bookingId);
        assert.equal(booking.commissionAmount, 0);
        assert.equal(booking.heldCommission?.commissionAmount, 10);
        assert.equal(booking.heldCommission?.commissionPercent, 10);
        assert.deepEqual(record.pricingSnapshot.heldCommission, booking.heldCommission);
        await documents.patch(state.creator._id).set({currentCommissionPercent: 50}).commit();
        if (decision === 'former-self') {
          await documents.patch(state.creator._id).set({creatorEmail: 'new-creator@example.invalid'}).commit();
        }
        const selfReferral = decision.endsWith('self');
        const released = decision.endsWith('release');
        if (decision === 'partial-release') {
          const refund = await refundCurrent(20, 'held-partial');
          assert.equal(refund.status, 200, JSON.stringify(refund));
          assert.equal((await read(booking._id)).commissionAmount, 0);
        }
        const body = {
          bookingId: booking._id, status: 'captured',
          referralReview: released || selfReferral ? 'release' : decision,
          payerEmail: selfReferral ? state.creator.creatorEmail : 'verified-buyer@example.invalid',
        };
        assert.equal((await post('/api/ref/updateBookingStatus', body)).status, 403);
        const review = () => post('/api/ref/updateBookingStatus', body, {'x-admin-key': 'fixture-admin'});
        const result = await review();
        assert.equal(result.status, selfReferral ? 409 : 200, JSON.stringify(result));
        const expected = released ? (decision === 'partial-release' ? 8 : 10) : 0;
        assert.equal((await read(booking._id)).commissionAmount, expected);
        assert.equal((await review()).status, selfReferral ? 409 : 200);
        const sync = await post('/api/ref/syncPayouts', {referralId: state.creator._id}, {
          'x-admin-key': 'fixture-admin',
        });
        assert.equal(sync.status, 200, JSON.stringify(sync));
        assert.equal(sync.body.owed.total, expected);
        if (released) {
          const payout = () => post('/api/ref/updatePayments', {
            referralId: state.creator._id, packageType: 'vertex', amount: expected,
            payoutId: `review-${state.key}`, paidOn: '2026-03-01T00:00:00.000Z',
          }, {'x-admin-key': 'fixture-admin'});
          const paid = await payout();
          assert.equal(paid.status, 200, JSON.stringify(paid));
          assert.equal((await payout()).status, 200);
          const creator = await documents.getDocument(state.creator._id);
          assert.equal(creator.vertexPayments.length, 1);
          assert.equal(creator.paidTotal, expected);
          assert.equal(creator.owedTotal, 0);
          const changedPayer = await post('/api/ref/updateBookingStatus', {
            ...body, payerEmail: state.creator.creatorEmail,
          }, {'x-admin-key': 'fixture-admin'});
          assert.equal(changedPayer.status, 409);
          const refund = await refundCurrent(decision === 'partial-release' ? 80 : 100, 'released-full', true);
          assert.equal(refund.status, 200, JSON.stringify(refund));
          assert.equal((await read(booking._id)).commissionAmount, 0);
          assert.equal((await review()).status, 409);
        } else if (decision === 'reject') {
          const release = await post('/api/ref/updateBookingStatus', {...body, referralReview: 'release'}, {
            'x-admin-key': 'fixture-admin',
          });
          assert.equal(release.status, 409);
        }
        return {booking, result, sync};
      });
    }
  }

  for (const bucket of ['Vertex', 'Xoc']) {
    for (const rollback of [false, true]) {
      await run(`R6-${rollback ? 'rollback-redeploy' : 'single-migrate'}-paid-protection-${bucket}`, async () => {
        const own = await seed('dodo');
        const foreign = await seed('dodo');
        for (const state of [own, foreign]) {
          await commerce.patch(state.record.bookingId).unset(['commissionCalculationVersion'])
            .set({referralCode: '', packageTitle: bucket}).commit();
        }
        const paymentsField = `${bucket.toLowerCase()}Payments`;
        let payments = [{_key: 'past', amount: 8, paidOn: '2026-01-01T00:00:00.000Z'}];
        await documents.patch(own.creator._id).set({
          slug: {current: ''}, [paymentsField]: payments, [`earned${bucket}`]: 11, earnedTotal: 11,
        }).commit();
        const connection = await sql.reserve();
        try {
          await connection.unsafe(rulesSql);
          const before = await documents.getDocument(own.creator._id);
          assert.equal(before[`emptyCodeProtectedPaid${bucket}`], 2.5);
          if (rollback) await connection.unsafe(rollbackSql);
          await commerce.create({
            _id: `booking.new-${own.key}`, _type: 'booking', status: 'captured',
            packageTitle: `${bucket} new`, commissionCalculationVersion: 2, commissionAmount: 1,
            referral: {_ref: own.creator._id}, referralCode: '',
          });
          const payment = await post(rollback ? '/api/rollback/updatePayments' : '/api/ref/updatePayments', {
            referralId: own.creator._id, packageType: bucket.toLowerCase(), amount: 0.4,
            payoutId: `during-rollback-${own.key}`, paidOn: '2026-02-01T00:00:00.000Z',
          }, {'x-admin-key': 'fixture-admin'});
          assert.equal(payment.status, 200, JSON.stringify(payment));
          payments = (await documents.getDocument(own.creator._id))[paymentsField];
          assert.equal(payments.length, 2);
          await connection.unsafe(rulesSql);
          await connection.unsafe(rulesSql);
          const after = await documents.getDocument(own.creator._id);
          const protectionFields = [
            'emptyCodeReviewXoc', 'emptyCodeReviewVertex', 'emptyCodeProtectedPaidXoc', 'emptyCodeProtectedPaidVertex',
          ];
          for (const field of protectionFields) assert.equal(after[field], before[field]);
          assert.equal(after.paidTotal, 8.4);
          assert.equal(after.owedTotal, 0.6);
          const sync = await post('/api/ref/syncPayouts', {referralId: own.creator._id}, {
            'x-admin-key': 'fixture-admin',
          });
          assert.equal(sync.status, 200, JSON.stringify(sync));
          assert.equal(sync.body.earnings.total, 6.5);
          assert.equal(sync.body.owed.total, 0.6);
          assert.equal(sync.body.payments.total, 8.4);
          assert.deepEqual((await documents.getDocument(own.creator._id))[paymentsField], payments);
          return {before, after, sync};
        } finally {
          await connection.unsafe('rollback');
          await connection.unsafe('drop trigger if exists creator_rollback_payout_hold on migration.source_documents');
          await connection.unsafe('drop function if exists migration.creator_rollback_payout_hold()');
          connection.release();
        }
      });
    }
  }
}
