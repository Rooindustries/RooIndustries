import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createBookingContactFixture } from './fixtures/booking-contact.mjs';
import { applyBookingRefund } from '../src/server/api/ref/bookingRefunds.js';

let fixture;
let createPaymentAccessToken;
let flow;
let guardDodoCheckoutReuse;
let commitDodoFailureOutcome;
let handleExhaustedCleanupWatchDeadline;
let inspectDodoCheckout;

before(async () => {
  fixture = await createBookingContactFixture({ artifactName: 'payment-dodo-failure-retries' });
  ({ createPaymentAccessToken } = await import('../src/server/api/payment/accessToken.js'));
  flow = await import('../src/server/api/payment/flow.js');
  ({
    commitDodoFailureOutcome,
    guardDodoCheckoutReuse,
    handleExhaustedCleanupWatchDeadline,
  } = await import('../src/server/api/payment/dodoFailureOutcome.js'));
  ({ inspectDodoCheckout } = await import('../src/server/api/payment/dodoProvider.js'));
});

beforeEach(async () => {
  fixture.setPaymentAmountOverrides({});
  fixture.setCheckoutPaymentStarted(true);
  fixture.setProviderLookupFailure(false);
  fixture.setRequestHook(null);
  await fixture.database.sql`delete from commerce.reconcile_hold_cleanup_blocks`;
  await fixture.database.sql`delete from commerce.reconcile_cleanup_runs`;
  const existing = await fixture.commerce.fetch('*[_type == "paymentRecord"]{_id}');
  for (const row of Array.isArray(existing) ? existing : []) {
    await fixture.commerce.patch(row._id).set({
      reconciliationRecoveryTerminal: true,
      providerRecoveryTerminal: true,
      resourceReleasePending: false,
      refundRequiresBookingSync: false,
      emailDispatchRequired: false,
      lateCaptureWatchUntil: '',
      nextRecoveryAt: '9999-12-31T23:59:59.999Z',
    }).commit();
  }
});

after(async () => {
  fixture?.setRequestHook(null);
  await fixture?.stop();
});

const cron = () => fixture.post('/api/payment/reconcile', {}, 'fixture-only-cron');
const holdFor = payload => fixture.commerce.getDocument(payload.slotHoldId);
const recordFor = started =>
  fixture.commerce.fetch('*[_type == "paymentRecord" && providerOrderId == $id][0]', {
    id: started.body.providerPayload.orderId,
  });

const startDodoCheckout = async (extra = {}) => {
  const payload = await fixture.hold();
  const started = await fixture.start({ ...payload, ...extra });
  assert.equal(started.status, 200, JSON.stringify(started));
  const record = await recordFor(started);
  return { payload, started, record, token: started.body.paymentAccessToken };
};

const seedCouponAndLock = async (recordId, tag) => {
  const couponId = `coupon.pr9.${tag}`;
  const redemptionId = `couponRedemption.pr9.${tag}`;
  const lockId = `paymentUpgradeLock.pr9.${tag}`;
  const now = new Date().toISOString();
  await fixture.commerce.create({
    _id: couponId, _type: 'coupon', code: `PR9${tag.toUpperCase()}`, isActive: true,
    discountType: 'fixed', discountValue: 5, maxUses: 10, timesUsed: 0, activeReservations: 1,
  });
  await fixture.commerce.create({
    _id: redemptionId, _type: 'couponRedemption', coupon: { _type: 'reference', _ref: couponId },
    couponCode: `pr9${tag.toLowerCase()}`, ownerId: recordId, paymentRecordId: recordId,
    status: 'reserved', reservedAt: now,
  });
  await fixture.commerce.create({
    _id: lockId, _type: 'paymentUpgradeLock', scope: `upgrade:pr9:${tag}`, paymentRecordId: recordId,
    provider: 'dodo', quoteFingerprint: `fp_${tag}`, createdAt: now, updatedAt: now,
  });
  return { couponId, redemptionId, lockId };
};

const makeToken = (record, { expired = false } = {}) => {
  const origNow = Date.now;
  try {
    if (expired) Date.now = () => origNow() - 40 * 60 * 1000;
    return createPaymentAccessToken({
      paymentRecordId: record._id,
      provider: record.provider,
      pricingFingerprint: record.pricingFingerprint,
      backend: record.backendOwner || 'supabase',
      cutoverGeneration: Number(record.cutoverGeneration || 0),
      expirySeconds: 35 * 60,
    });
  } finally {
    Date.now = origNow;
  }
};

const expireHold = async (holdId, ageMs = 25 * 60 * 60 * 1000) => {
  const oldIso = new Date(Date.now() - ageMs).toISOString();
  await fixture.database.sql.begin(async sql => {
    await sql`set local session_replication_role = replica`;
    await sql`update migration.source_documents set payload = jsonb_set(payload, '{expiresAt}', to_jsonb(${oldIso}::text)) where legacy_sanity_id = ${holdId}`;
    await sql`update commerce.slot_holds set expires_at = ${oldIso} where legacy_sanity_id = ${holdId}`;
    await sql`update commerce.slot_claims set expires_at = ${oldIso} where hold_id = (select id from commerce.slot_holds where legacy_sanity_id = ${holdId})`;
  });
};

const withDodoDisabled = async fn => {
  const prev = process.env.DODO_PAYMENTS_API_KEY;
  process.env.DODO_PAYMENTS_API_KEY = '';
  try { return await fn(); } finally { process.env.DODO_PAYMENTS_API_KEY = prev; }
};

test('HTTP failure-reason mapper covers all 10 safe codes without echoing raw errors and enforces 3-retry hold retention', async () => {
  const cases = [
    ['insufficient_funds', 'insufficient_funds'],
    ['card_expired', 'expired_card'],
    ['invalid_cvv', 'incorrect_cvc'],
    ['invalid_card_number', 'incorrect_number'],
    ['3ds_failed', 'authentication_failed'],
    ['do_not_honor', 'card_declined'],
    ['gateway_error', 'processing_error'],
    ['amount_limit_exceeded', 'limit_exceeded'],
    ['customer_cancelled', 'payment_cancelled'],
    ['RAW_SENSITIVE_ISSUER_999', 'payment_failed'],
  ];

  for (const [rawCode, expectedCode] of cases) {
    const rawMsg = `SECRET_RAW_BANK_DETAIL_${rawCode}`;
    const { record, token } = await startDodoCheckout();
    fixture.setPaymentAmountOverrides({ status: 'failed', error_code: rawCode, error_message: rawMsg });
    const wh = await fixture.dodoWebhook(`payment_${record.providerOrderId}`, 'payment.failed', `wh_map_${record._id}`);
    assert.equal(wh.status, 200, JSON.stringify(wh));

    const st = await fixture.post('/api/payment/status', {}, token);
    assert.equal(st.status, 200, JSON.stringify(st));
    assert.equal(st.body.status, 'failed');
    assert.equal(st.body.paymentFailureCode, expectedCode);
    assert.ok(st.body.paymentFailureMessage.length > 10);
    const serialized = JSON.stringify(st.body);
    assert.equal(serialized.includes(rawMsg), false);
    if (rawCode !== expectedCode) assert.equal(serialized.includes(rawCode), false);
  }

  let currentPayload = await fixture.hold();
  let firstAttemptToken = '';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const started = await fixture.start(currentPayload);
    assert.equal(started.status, 200, `attempt ${attempt} start: ${JSON.stringify(started)}`);
    if (attempt === 2 && firstAttemptToken) {
      const staleReplay = await fixture.post('/api/payment/status', {}, firstAttemptToken);
      assert.equal(staleReplay.status, 200);
      assert.equal(staleReplay.body.refreshedHold, undefined);
    }
    const holdBeforeFail = await holdFor(currentPayload);
    const rec = await recordFor(started);
    fixture.setPaymentAmountOverrides({ status: 'failed', error_code: 'do_not_honor', error_message: 'raw bank' });
    const wh = await fixture.dodoWebhook(`payment_${rec.providerOrderId}`, 'payment.failed', `wh_retry_${attempt}_${rec._id}`);
    assert.equal(wh.status, 200, JSON.stringify(wh));
    const st = await fixture.post('/api/payment/status', {}, started.body.paymentAccessToken);
    assert.equal(st.status, 200, JSON.stringify(st));
    const holdAfter = await holdFor(currentPayload);
    if (attempt <= 3) {
      assert.equal(st.body.holdRetained, true);
      assert.equal(st.body.slotReleased, false);
      assert.equal(st.body.retriesRemaining, 3 - attempt);
      assert.equal(holdAfter.phase, 'active');
      assert.equal(holdAfter.paymentFailureCount, attempt);
      assert.equal(holdAfter.expiresAt, holdBeforeFail.expiresAt);
      assert.ok(st.body.refreshedHold?.slotHoldToken);
      if (attempt === 1) firstAttemptToken = started.body.paymentAccessToken;
      currentPayload = { ...currentPayload, slotHoldToken: st.body.refreshedHold.slotHoldToken };
    } else {
      assert.equal(st.body.holdRetained, false);
      assert.equal(st.body.slotReleased, true);
      assert.equal(st.body.retriesRemaining, 0);
      assert.equal(st.body.refreshedHold, undefined);
      assert.equal(holdAfter.phase, 'released');
    }
  }

  const directFail = await startDodoCheckout();
  fixture.setPaymentAmountOverrides({ status: 'failed', error_code: 'do_not_honor', error_message: 'raw bank' });
  const firstFin = await fixture.post('/api/payment/finalize', {}, directFail.token);
  assert.equal(firstFin.status, 200, JSON.stringify(firstFin));
  assert.equal(firstFin.body.status, 'failed');
  assert.equal(firstFin.body.holdRetained, true);
  assert.ok(firstFin.body.refreshedHold?.slotHoldToken);
});

test('before- and after-35m token.exp matrix across all 3 providers makes 0 provider calls and keeps DB unchanged', async () => {
  const providers = ['dodo', 'razorpay', 'paypal'];
  const pastIso = new Date(Date.now() - 60_000).toISOString();
  const futureIso = new Date(Date.now() + 600_000).toISOString();

  for (const provider of providers) {
    for (const terminalStatus of ['failed', 'abandoned']) {
      for (const expired of [false, true]) {
        const id = `paymentRecord.mat.${provider}.${terminalStatus}.${expired ? 'exp' : 'live'}.${crypto.randomUUID().slice(0, 6)}`;
        const fp = `fp_${id}`;
        await fixture.commerce.create({
          _id: id, _type: 'paymentRecord', provider, status: terminalStatus,
          providerOrderId: `ord_${id}`, providerPaymentId: `pay_${id}`,
          providerPaymentState: terminalStatus === 'failed' ? 'failed' : 'cancelled',
          pricingFingerprint: fp, backendOwner: 'supabase', cutoverGeneration: 0,
          resourceReleasePending: false, reconciliationRecoveryTerminal: false,
          providerRecoveryTerminal: provider === 'dodo',
          ...(provider !== 'dodo' && terminalStatus === 'abandoned' ? { lateCaptureWatchUntil: futureIso } : {}),
          ...(terminalStatus === 'abandoned'
            ? { cancelledHoldSnapshot: { slotHoldId: 'slotHold.expired', slotHoldToken: 'tok', slotHoldExpiresAt: pastIso, phase: 'holding' } }
            : { refreshedHoldSnapshot: { slotHoldId: 'slotHold.expired', slotHoldToken: 'tok', slotHoldExpiresAt: pastIso, phase: 'active' } }),
          sessionExpiresAt: futureIso, createdAt: pastIso, updatedAt: pastIso,
        });
        const beforeDoc = await fixture.commerce.getDocument(id);
        const token = makeToken(beforeDoc, { expired });
        const beforeSnap = await fixture.snapshot();

        const stRes = await fixture.post('/api/payment/status', {}, token);
        assert.equal(stRes.status, 200, `${provider}/${terminalStatus}/exp=${expired} /status`);
        assert.equal(stRes.body.refreshedHold, undefined);

        const finRes = await fixture.post('/api/payment/finalize', {}, token);
        assert.equal(finRes.status, provider === 'dodo' ? 200 : 409, `${provider}/${terminalStatus}/exp=${expired} /finalize: ${JSON.stringify(finRes)}`);

        const canRes = await fixture.post('/api/payment/cancel', {}, token);
        if (terminalStatus === 'failed') {
          if (provider === 'dodo') {
            assert.equal(canRes.status, 200);
            assert.equal(canRes.body.cancelled, false);
          } else {
            assert.equal(canRes.status, 409);
          }
        } else if (provider === 'dodo') {
          assert.equal(canRes.status, 200);
          assert.equal(canRes.body.cancelled, true);
          assert.equal(canRes.body.refreshedHold, undefined);
        } else {
          assert.equal(canRes.status, expired ? 409 : 200);
        }

        const afterSnap = await fixture.snapshot();
        assert.deepEqual(afterSnap, beforeSnap, `${provider}/${terminalStatus}/exp=${expired} mutated stored state or called provider`);
      }
    }

    const sid = `paymentRecord.mat.${provider}.started.${crypto.randomUUID().slice(0, 6)}`;
    await fixture.commerce.create({
      _id: sid, _type: 'paymentRecord', provider, status: 'started',
      providerOrderId: `ord_${sid}`, pricingFingerprint: `fp_${sid}`,
      backendOwner: 'supabase', cutoverGeneration: 0, sessionExpiresAt: futureIso,
      createdAt: pastIso, updatedAt: pastIso,
    });
    const startedDoc = await fixture.commerce.getDocument(sid);
    const expiredStartedToken = makeToken(startedDoc, { expired: true });
    assert.equal((await fixture.post('/api/payment/finalize', {}, expiredStartedToken)).status, 401);
    assert.equal((await fixture.post('/api/payment/cancel', {}, expiredStartedToken)).status, 401);
  }
});

test('cleanup-fallback forced-order checks preserve capture/settled/pending states and /cancel honors 409-before-202 precedence', async () => {
  const runFallback = async ({ mutateFresh, expectStatus, expectPending, expectReason, payment = null }) => {
    const { record } = await startDodoCheckout();
    const { redemptionId } = await seedCouponAndLock(record._id, crypto.randomUUID().slice(0, 6));
    await fixture.commerce.patch(record._id).set({ couponReservationId: redemptionId }).commit();
    const stale = await fixture.commerce.getDocument(record._id);

    const outcome = await commitDodoFailureOutcome({
      client: fixture.commerce,
      record: stale,
      payment,
      source: 'reconcile',
      reason: 'dodo_payment_failed',
      prepareCouponRelease: async () => {
        await mutateFresh(record._id);
        throw new Error('forced_coupon_prepare_failure');
      },
      appendCouponRelease: () => { throw new Error('unexpected'); },
      patchRecord: async ({ client, record: r, set }) => client.patch(r._id).ifRevisionId(r._rev).set(set).commit(),
      getNextPaymentRecoveryAt: () => new Date(Date.now() + 60_000).toISOString(),
      buildPublicStatusBody: r => ({ ok: true, status: r.status, recoveryReason: r.recoveryReason || '' }),
    });
    const finalDoc = await fixture.commerce.getDocument(record._id);
    assert.equal(outcome.httpStatus, expectStatus);
    assert.equal(finalDoc.resourceReleasePending === true, expectPending);
    if (expectReason) assert.equal(finalDoc.recoveryReason, expectReason);
  };

  await runFallback({
    mutateFresh: id => fixture.commerce.patch(id).set({ status: 'needs_recovery', verificationState: 'server_verified', providerPaymentState: 'succeeded', captureClaimedAt: new Date().toISOString() }).commit(),
    expectStatus: 200, expectPending: false,
  });
  await runFallback({
    mutateFresh: id => fixture.commerce.patch(id).set({ status: 'booked', bookingId: 'booking.settled.1' }).commit(),
    expectStatus: 200, expectPending: false,
  });
  await runFallback({
    mutateFresh: id => fixture.commerce.patch(id).set({ status: 'started', providerPaymentState: 'succeeded' }).commit(),
    expectStatus: 202, expectPending: false, expectReason: 'captured_payment_release_requires_review',
  });
  await runFallback({
    mutateFresh: id => fixture.commerce.patch(id).set({ status: 'started', providerPaymentState: 'partially_captured' }).commit(),
    expectStatus: 202, expectPending: false, expectReason: 'dodo_partial_capture_requires_recovery',
  });
  await runFallback({
    payment: { payment_id: 'pay_live_failed_partial_race', status: 'failed', error_code: 'do_not_honor' },
    mutateFresh: id => fixture.commerce.patch(id).set({ status: 'started', providerPaymentState: 'partially_captured' }).commit(),
    expectStatus: 202, expectPending: false, expectReason: 'dodo_partial_capture_requires_recovery',
  });

  const { record: pendingRec, token: pendingTok } = await startDodoCheckout();
  await fixture.commerce.patch(pendingRec._id).set({
    status: 'failed', providerPaymentState: 'processing', resourceReleasePending: true, resourceReleaseTargetStatus: 'failed',
  }).commit();
  const activeCancel = await fixture.post('/api/payment/cancel', {}, pendingTok);
  assert.equal(activeCancel.status, 409);
  assert.equal(activeCancel.body.code, 'provider_pending');

  await fixture.commerce.patch(pendingRec._id).set({ providerPaymentState: 'failed' }).commit();
  const pendingCancel = await fixture.post('/api/payment/cancel', {}, pendingTok);
  assert.equal(pendingCancel.status, 202);
  assert.equal(pendingCancel.body.cancelled, false);
});

test('all 5 exhaustion watch-deadline cases plus deadline revision-change race preserve safety', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const seedExhausted = async (tag, extra = {}) => {
    const { payload, record } = await startDodoCheckout();
    const { redemptionId, lockId } = await seedCouponAndLock(record._id, tag);
    await fixture.commerce.patch(record._id).set({
      status: 'failed', recoveryReason: 'resource_release_exhausted',
      recoveryFailureCount: 12, recoveryAttemptCount: 12,
      reconciliationRecoveryTerminal: true, providerRecoveryTerminal: false,
      resourceReleasePending: true, resourceReleaseTargetStatus: 'failed',
      resourceReleaseReason: 'dodo_payment_failed', lateCaptureWatchUntil: past,
      nextRecoveryAt: past, couponReservationId: redemptionId, startClaimId: lockId,
      ...extra,
    }).commit();
    return { payload, recordId: record._id, redemptionId, lockId };
  };

  const c1 = await seedExhausted('dl1', { providerPaymentState: 'unknown' });
  fixture.setPaymentAmountOverrides({ status: 'failed', error_code: 'do_not_honor' });
  assert.equal((await cron()).status, 200);
  const d1 = await fixture.commerce.getDocument(c1.recordId);
  assert.equal(d1.status, 'failed');
  assert.equal(d1.resourceReleasePending, false);
  assert.equal(d1.providerRecoveryTerminal, true);
  assert.equal(d1.lateCaptureWatchUntil, '');
  assert.equal((await fixture.commerce.getDocument(c1.redemptionId)).status, 'released');
  assert.equal(await fixture.commerce.getDocument(c1.lockId), null);

  const cPaid = await seedExhausted('dlpaid', { providerPaymentState: 'unknown', couponReservationId: '', startClaimId: '' });
  fixture.setPaymentAmountOverrides({ status: 'succeeded' });
  assert.equal((await cron()).status, 200);
  const dPaid = await fixture.commerce.getDocument(cPaid.recordId);
  assert.equal(dPaid.status, 'booked');
  assert.ok(dPaid.bookingId);
  assert.equal(dPaid.resourceReleasePending, false);

  for (const [tag, storedState, targetStatus, expectStatus] of [
    ['dl2', 'failed', 'failed', 'failed'],
    ['dl3', 'cancelled', 'abandoned', 'abandoned'],
  ]) {
    const c = await seedExhausted(tag, { providerPaymentState: storedState, resourceReleaseTargetStatus: targetStatus });
    await withDodoDisabled(async () => assert.equal((await cron()).status, 200));
    const doc = await fixture.commerce.getDocument(c.recordId);
    assert.equal(doc.status, expectStatus);
    assert.equal(doc.resourceReleasePending, false);
    assert.equal((await fixture.commerce.getDocument(c.redemptionId)).status, 'released');
    assert.equal(await fixture.commerce.getDocument(c.lockId), null);
  }

  for (const [idx, unsafeState] of ['processing', '', 'unknown'].entries()) {
    const c = await seedExhausted(`dl4_${idx}`, { providerPaymentState: unsafeState });
    await withDodoDisabled(async () => assert.equal((await cron()).status, 200));
    const doc = await fixture.commerce.getDocument(c.recordId);
    assert.equal(doc.status, 'needs_recovery');
    assert.equal(doc.recoveryReason, 'resource_release_exhausted_owner_review');
    assert.equal(doc.recoveryOwnerReviewRequired, true);
    assert.equal(doc.resourceReleasePending, false);
    assert.equal((await fixture.commerce.getDocument(c.redemptionId)).status, 'reserved');
    assert.ok(await fixture.commerce.getDocument(c.lockId));
  }

  const race = await seedExhausted('dlrace', { providerPaymentState: 'failed', providerStateCheckedAt: past });
  const raceDoc = await fixture.commerce.getDocument(race.recordId);
  let bumped = false;
  const raceRes = await handleExhaustedCleanupWatchDeadline({
    client: fixture.commerce,
    record: raceDoc,
    dodoEnabled: false,
    inspection: null,
    prepareCouponRelease: async ({ client, redemptionId }) => {
      if (!bumped) {
        bumped = true;
        await client.patch(race.recordId).set({
          providerPaymentState: 'processing',
          providerStateCheckedAt: new Date().toISOString(),
        }).commit();
      }
      const red = await client.getDocument(redemptionId);
      return { redemption: red, idempotent: false };
    },
    appendCouponRelease: ({ transaction }) => transaction,
    patchRecord: async ({ client, record: r, set }) => client.patch(r._id).ifRevisionId(r._rev).set(set).commit(),
    getNextPaymentRecoveryAt: () => new Date(Date.now() + 60_000).toISOString(),
    buildPublicStatusBody: r => ({ ok: true, status: r.status }),
  });
  assert.equal(raceRes.httpStatus, 202);
  const afterRace = await fixture.commerce.getDocument(race.recordId);
  assert.equal(afterRace.providerPaymentState, 'processing');
  assert.equal(afterRace.resourceReleasePending, true);
  assert.equal((await fixture.commerce.getDocument(race.redemptionId)).status, 'reserved');
  assert.ok(await fixture.commerce.getDocument(race.lockId));
});

test('positive/negative Dodo reversal validation, legacy owner review + dispute_lost + 8499 refund, cancelled booking, and tax-exclusive gross total', async () => {
  const { payload: pRef, record: rRef } = await startDodoCheckout();
  const fullSub = Math.round(rRef.pricingSnapshot.netAmount * 100);
  const pidRef = `payment_${rRef.providerOrderId}`;
  fixture.setPaymentAmountOverrides({
    status: 'succeeded', total_amount: fullSub, refund_status: 'full',
    refunds: [{ refund_id: 'rfnd_full_1', payment_id: pidRef, status: 'succeeded', amount: fullSub, currency: 'USD' }],
  });
  let blockedRelease = false;
  fixture.setRequestHook(async (phase, req) => {
    if (!blockedRelease && phase === 'before' && req.path.includes('roo_apply_commerce_document_mutations')) {
      const raw = JSON.stringify(req.body || {});
      if (raw.includes(pRef.slotHoldId) && raw.includes('"released"')) {
        blockedRelease = true;
        throw new Error('forced_unbooked_refund_release_failure');
      }
    }
  });
  let refWh;
  try {
    refWh = await fixture.dodoWebhook(pidRef, 'refund.succeeded', `wh_full_${rRef._id}`);
  } finally {
    fixture.setRequestHook(null);
  }
  assert.equal(blockedRelease, true);
  assert.equal(refWh.status, 503, JSON.stringify(refWh));
  const afterFull = await fixture.commerce.getDocument(rRef._id);
  assert.equal(afterFull.providerPaymentState, 'refunded');
  assert.equal(afterFull.providerReversalVerified, true);
  assert.equal(afterFull.refundRequiresBookingSync, true);
  assert.equal((await holdFor(pRef)).phase, 'payment_pending');
  await fixture.commerce.patch(rRef._id).set({
    refundRequiresBookingSync: false,
    resourceReleasePending: false,
    nextRecoveryAt: '9999-12-31T23:59:59.999Z',
  }).commit();
  await expireHold(pRef.slotHoldId);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(pRef)).phase, 'expired');

  for (const terminalStatus of ['dispute_lost', 'dispute_accepted', 'dispute_expired']) {
    const { payload: pD, record: rD } = await startDodoCheckout();
    const pid = `payment_${rD.providerOrderId}`;
    fixture.setPaymentAmountOverrides({
      status: 'succeeded',
      disputes: [{ dispute_id: `dsp_${terminalStatus}`, payment_id: pid, currency: 'USD', dispute_stage: 'dispute', dispute_status: terminalStatus, amount: '84.99' }],
    });
    assert.equal((await fixture.dodoWebhook(pid, 'dispute.lost', `wh_${terminalStatus}_${rD._id}`)).status, 200);
    const dDoc = await fixture.commerce.getDocument(rD._id);
    assert.equal(dDoc.providerPaymentState, 'disputed');
    assert.equal(dDoc.providerReversalVerified, true);
    await expireHold(pD.slotHoldId);
    assert.equal((await cron()).status, 200);
    assert.equal((await holdFor(pD)).phase, 'expired');
  }

  const { payload: pUnres, record: rUnres } = await startDodoCheckout();
  const pidUnres = `payment_${rUnres.providerOrderId}`;
  fixture.setPaymentAmountOverrides({
    status: 'succeeded', refund_status: 'full',
    refunds: [{ refund_id: 'rfnd_blocked', payment_id: pidUnres, status: 'succeeded', amount: fullSub, currency: 'USD' }],
    disputes: [
      { dispute_id: 'dsp_open_1', payment_id: pidUnres, currency: 'USD', dispute_stage: 'dispute', dispute_status: 'dispute_opened', amount: '84.99' },
      { dispute_id: 'dsp_lost_1', payment_id: pidUnres, currency: 'USD', dispute_stage: 'dispute', dispute_status: 'dispute_lost', amount: '84.99' },
    ],
  });
  await fixture.dodoWebhook(pidUnres, 'dispute.opened', `wh_unres_${rUnres._id}`);
  const unresDoc = await fixture.commerce.getDocument(rUnres._id);
  assert.equal(unresDoc.providerPaymentState, 'succeeded');
  assert.equal(unresDoc.providerReversalVerified, false);
  await expireHold(pUnres.slotHoldId);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(pUnres)).phase, 'payment_pending');

  const { payload: pBad, record: rBad } = await startDodoCheckout();
  const pidBad = `payment_${rBad.providerOrderId}`;
  fixture.setPaymentAmountOverrides({
    status: 'succeeded', total_amount: 1, refund_status: 'full',
    refunds: [{ refund_id: 'rfnd_mm', payment_id: pidBad, status: 'succeeded', amount: 1, currency: 'USD' }],
  });
  assert.equal((await fixture.dodoWebhook(pidBad, 'refund.succeeded', `wh_mm_${rBad._id}`)).status, 409);
  const badDoc = await fixture.commerce.getDocument(rBad._id);
  assert.equal(badDoc.providerPaymentState, 'succeeded');
  assert.equal(badDoc.providerReversalVerified, false);
  await expireHold(pBad.slotHoldId);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(pBad)).phase, 'payment_pending');

  const { record: rCan } = await startDodoCheckout();
  const pidCan = `payment_${rCan.providerOrderId}`;
  fixture.setPaymentAmountOverrides({ status: 'succeeded' });
  assert.equal((await fixture.dodoWebhook(pidCan, 'payment.succeeded', `wh_can_ok_${rCan._id}`)).status, 200);
  const bookedCan = await fixture.commerce.getDocument(rCan._id);
  await fixture.commerce.patch(bookedCan.bookingId).set({ status: 'cancelled' }).commit();
  fixture.setPaymentAmountOverrides({
    status: 'succeeded',
    disputes: [{ dispute_id: 'dsp_can_1', payment_id: pidCan, currency: 'USD', dispute_stage: 'dispute', dispute_status: 'dispute_lost', amount: '84.99' }],
  });
  assert.equal((await fixture.dodoWebhook(pidCan, 'dispute.lost', `wh_can_dsp_${rCan._id}`)).status, 200);
  const canBooking = await fixture.commerce.getDocument(bookedCan.bookingId);
  assert.equal(canBooking.status, 'cancelled');
  assert.equal(canBooking.commissionAmount, 0);
  assert.equal(canBooking.dodoDisputeActive, true);
  assert.equal(canBooking.paymentVerificationState, 'disputed');

  const { record: rLeg } = await startDodoCheckout();
  const pidLeg = `payment_${rLeg.providerOrderId}`;
  fixture.setPaymentAmountOverrides({ status: 'succeeded' });
  assert.equal((await fixture.dodoWebhook(pidLeg, 'payment.succeeded', `wh_leg_ok_${rLeg._id}`)).status, 200);
  const bookedLeg = await fixture.commerce.getDocument(rLeg._id);
  const referralId = `referral.pr9.${crypto.randomUUID().slice(0, 6)}`;
  await fixture.content.create({
    _id: referralId, _type: 'referral', name: 'PR9 Creator',
    slug: { _type: 'slug', current: `pr9ref-${referralId.slice(-6)}` },
    registrationStatus: 'active', successfulReferrals: 1,
  });
  await fixture.commerce.patch(bookedLeg.bookingId).set({
    status: 'captured', referral: { _type: 'reference', _ref: referralId },
    referralAccountingApplied: true, commissionAmount: 8.5, netAmount: rLeg.pricingSnapshot.netAmount,
  }).commit();
  await fixture.commerce.patch(rLeg._id).set({
    recoveryReason: 'captured_payment_release_requires_review',
    recoveryOwnerReviewRequired: false,
  }).commit();

  fixture.setPaymentAmountOverrides({
    status: 'succeeded',
    disputes: [{ dispute_id: 'dsp_leg_1', payment_id: pidLeg, currency: 'USD', dispute_stage: 'dispute', dispute_status: 'dispute_lost', amount: '84.99' }],
  });
  assert.equal((await fixture.dodoWebhook(pidLeg, 'dispute.lost', `wh_leg_dsp_${rLeg._id}`)).status, 200);
  const midLeg = await fixture.commerce.getDocument(rLeg._id);
  assert.equal(midLeg.recoveryOwnerReviewRequired, true);
  assert.equal((await fixture.commerce.getDocument(referralId)).successfulReferrals, 0);

  fixture.setPaymentAmountOverrides({
    status: 'succeeded', total_amount: fullSub, refund_status: 'full',
    refunds: [{ refund_id: 'rfnd_leg_1', payment_id: pidLeg, status: 'succeeded', amount: fullSub, currency: 'USD' }],
    disputes: [{ dispute_id: 'dsp_leg_1', payment_id: pidLeg, currency: 'USD', dispute_stage: 'dispute', dispute_status: 'dispute_lost', amount: '84.99' }],
  });
  const legRefRes = await flow.refreshDodoPayment({
    client: fixture.commerce, record: midLeg, source: 'webhook', applyBookingRefund,
  });
  assert.equal(legRefRes.httpStatus, 200, JSON.stringify(legRefRes));
  const finalLegRec = await fixture.commerce.getDocument(rLeg._id);
  const finalLegBook = await fixture.commerce.getDocument(bookedLeg.bookingId);
  assert.equal(finalLegRec.recoveryOwnerReviewRequired, true);
  assert.equal(finalLegBook.status, 'refunded');
  assert.equal(finalLegBook.refundStatus, 'full');
  assert.equal(finalLegBook.commissionAmount, 0);
  assert.equal((await fixture.commerce.getDocument(referralId)).successfulReferrals, 0);

  const { record: rTax } = await startDodoCheckout();
  await fixture.commerce.patch(rTax._id).set({
    providerPublicData: { ...rTax.providerPublicData, taxInclusive: false },
  }).commit();
  const pidTax = `payment_${rTax.providerOrderId}`;
  const taxSub = 500;
  const grossSub = fullSub + taxSub;
  fixture.setPaymentAmountOverrides({
    status: 'succeeded', total_amount: grossSub, tax: taxSub, refund_status: 'full',
    refunds: [{ refund_id: 'rfnd_tax_1', payment_id: pidTax, status: 'succeeded', amount: grossSub, currency: 'USD' }],
  });
  assert.equal((await fixture.dodoWebhook(pidTax, 'refund.succeeded', `wh_tax_${rTax._id}`)).status, 200);
  const taxDoc = await fixture.commerce.getDocument(rTax._id);
  assert.equal(taxDoc.providerPublicData.totalAmount, grossSub);
  assert.equal(taxDoc.status, 'refunded');
  assert.equal(taxDoc.refundState, 'full');
});

test('guardDodoCheckoutReuse strips checkoutUrl when payment or hold becomes unstartable during inspection', async () => {
  fixture.setCheckoutPaymentStarted(false);
  const { payload, record, token } = await startDodoCheckout();
  const reuseClean = await guardDodoCheckoutReuse({
    client: fixture.commerce,
    existing: record,
    inspectDodoCheckout,
    patchRecord: async ({ client, record: r, set }) => client.patch(r._id).ifRevisionId(r._rev).set(set).commit(),
    buildProviderPayloadFromRecord: r => ({ orderId: r.providerOrderId, checkoutUrl: r.providerPublicData?.checkoutUrl }),
    paymentAccessToken: token,
    shared: {},
    getHoldById: (c, id) => c.getDocument(id),
  });
  assert.equal(reuseClean.body.attemptStarted, false);
  assert.ok(reuseClean.body.providerPayload.checkoutUrl);

  const reuseAfterHoldReleased = await guardDodoCheckoutReuse({
    client: fixture.commerce,
    existing: record,
    inspectDodoCheckout: async ({ record: r }) => {
      await fixture.commerce.patch(payload.slotHoldId).set({ phase: 'released', paymentRecordId: '' }).commit();
      return inspectDodoCheckout({ record: r });
    },
    patchRecord: async ({ client, record: r, set }) => client.patch(r._id).ifRevisionId(r._rev).set(set).commit(),
    buildProviderPayloadFromRecord: r => ({ orderId: r.providerOrderId, checkoutUrl: r.providerPublicData?.checkoutUrl }),
    paymentAccessToken: token,
    shared: {},
    getHoldById: (c, id) => c.getDocument(id),
  });
  assert.equal(reuseAfterHoldReleased.body.attemptStarted, true);
  assert.equal(reuseAfterHoldReleased.body.providerPayload.checkoutUrl, undefined);
});
