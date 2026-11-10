import assert from 'node:assert/strict';
import {oldPayoutUtils} from './creator-rollback-payout.mjs';

export async function runHistoricalCreatorRegressions({
  run, seed, documents, commerce, read, post, webhook, refundCurrent, sql, summary, rulesSql, rollbackSql,
}) {
  for (const [provider, accounted] of [['dodo', true], ['paypal', true], ['razorpay', true], ['dodo', false]]) {
    await run(`R5-historical-creator-recovery-${provider}${accounted ? '' : '-uncounted'}`, async () => {
      const state = await seed(provider, {booking: false, amount: 100});
      await commerce.patch(state.record._id).set({
        historicalBookingReconstruction: true, referralAccountingApplied: accounted,
      }).commit();
      const event = provider === 'dodo' ? 'payment.succeeded'
        : provider === 'paypal' ? 'PAYMENT.CAPTURE.COMPLETED' : 'payment.captured';
      assert.equal((await webhook(event)).status, 200);
      const record = await read(state.record._id);
      const booking = await read(record.bookingId);
      assert.equal(booking.requiresReschedule, true);
      assert.equal(booking.referral?._ref, state.creator._id);
      assert.equal(booking.commissionAmount, 10);
      assert.equal(booking.referralAccountingApplied, accounted);
      const earned = await summary(state.creator, 10);
      assert.equal((await documents.getDocument(state.creator._id)).successfulReferrals, 5);
      assert.equal((await webhook(event)).status, 200);
      await summary(state.creator, 10);
      assert.equal((await documents.getDocument(state.creator._id)).successfulReferrals, 5);
      const synced = await post('/api/ref/syncPayouts', {referralId: state.creator._id}, {
        'x-admin-key': 'fixture-admin',
      });
      assert.equal(synced.status, 200, JSON.stringify(synced));
      assert.equal(synced.body.owed.total, 10);
      assert.equal((await refundCurrent(100, 'historical-recovered')).status, 200);
      await summary(state.creator, 0);
      assert.equal((await documents.getDocument(state.creator._id)).successfulReferrals, accounted ? 4 : 5);
      return {booking, earned, synced};
    });
  }

  await run('R5-rollback-pending-creator-old-payout', async () => {
    const connection = await sql.reserve();
    try {
      await connection.unsafe(rulesSql);
      const states = [];
      for (const code of ['present', 'empty']) {
        const state = await seed('dodo', {booking: false});
        await documents.patch(state.creator._id).set({registrationStatus: 'pending_email'}).commit();
        assert.equal((await webhook()).status, 200);
        const record = await read(state.record._id);
        if (code === 'empty') {
          await documents.patch(state.creator._id).set({slug: {current: ''}}).commit();
          await commerce.patch(record.bookingId).set({referralCode: ''}).commit();
        }
        const sync = await post('/api/ref/syncPayouts', {referralId: state.creator._id}, {
          'x-admin-key': 'fixture-admin',
        });
        assert.equal(sync.status, 200, JSON.stringify(sync));
        assert.equal(sync.body.owed.total, 0);
        assert.equal(sync.body.underReview.total, 5.5);
        states.push({state, booking: await read(record.bookingId)});
      }
      const {fetchReferralEarnings, buildBalance} = await oldPayoutUtils();
      await connection.unsafe(rulesSql);
      await connection.unsafe(rollbackSql);
      const results = [];
      for (const {state, booking} of states) {
        const creator = await documents.getDocument(state.creator._id);
        const args = {client: commerce, referralId: creator._id, referralCode: creator.slug.current};
        const earnings = await fetchReferralEarnings(args);
        const receipts = await sql`select payload from migration.source_documents
          where document_type = 'creatorPayout' and not tombstoned order by legacy_sanity_id`;
        const body = {
          referralId: creator._id, packageType: 'vertex', amount: 5.5, payoutId: `r5-${state.key}`,
        };
        const payout = await post('/api/rollback/updatePayments', body, {'x-admin-key': 'fixture-admin'});
        assert.equal(payout.status, 409, JSON.stringify(payout));
        assert.equal(buildBalance(earnings).owed.total, 0);
        assert.equal(creator.owedTotal, 0);
        assert.equal(creator.underReviewTotal, 5.5);
        assert.deepEqual(await read(booking._id), booking);
        assert.deepEqual(await documents.getDocument(creator._id), creator);
        assert.deepEqual(await sql`select payload from migration.source_documents
          where document_type = 'creatorPayout' and not tombstoned order by legacy_sanity_id`, receipts);
        await assert.rejects(commerce.patch(creator._id).set({
          vertexPayments: [{_key: 'direct', amount: 5.5}],
        }).commit(), error => error.statusCode === 409 || error.status === 409);
        await connection.unsafe(rollbackSql);
        assert.deepEqual(await documents.getDocument(creator._id), creator);
        await documents.patch(creator._id).set({registrationStatus: 'verified'}).commit();
        const released = await fetchReferralEarnings(args);
        assert.equal(released.byPackage[state.packageDoc.title], 5.5);
        const verified = await post('/api/rollback/updatePayments', body, {'x-admin-key': 'fixture-admin'});
        assert.equal(verified.status, 200, JSON.stringify(verified));
        assert.equal(verified.body.payments.total, 5.5);
        const replay = await post('/api/rollback/updatePayments', body, {'x-admin-key': 'fixture-admin'});
        assert.equal(replay.status, 200, JSON.stringify(replay));
        assert.equal(replay.body.logs.vertex.length, 1);
        results.push({creator, earnings, payout, verified});
      }
      return {results};
    } finally {
      try {
        await connection.unsafe('rollback');
        await connection.unsafe('drop trigger if exists creator_rollback_payout_hold on migration.source_documents');
        await connection.unsafe('drop function if exists migration.creator_rollback_payout_hold()');
        await connection.unsafe(rulesSql);
      } finally {
        connection.release();
      }
    }
  });
}
