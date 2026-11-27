import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createBookingContactFixture } from './fixtures/booking-contact.mjs';
import { applyBookingRefund } from '../src/server/api/ref/bookingRefunds.js';

let fixture;
let finalizePaymentSession;
let handleDodoWebhook;
let reconcilePaymentSessions;

before(async () => {
  fixture = await createBookingContactFixture({ artifactName: 'payment-recovery-capture-gates' });
  const flow = await import('../src/server/api/payment/flow.js');
  finalizePaymentSession = flow.finalizePaymentSession;
  handleDodoWebhook = flow.handleDodoWebhook;
  reconcilePaymentSessions = flow.reconcilePaymentSessions;
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

const startCheckout = async ({ couponCode = '' } = {}) => {
  const payload = await fixture.hold();
  const started = await fixture.start({ ...payload, ...(couponCode ? { couponCode } : {}) });
  assert.equal(started.status, 200, JSON.stringify(started));
  const record = await recordFor(started);
  return { payload, started, record };
};

const seedCoupon = async (id, code) => {
  await fixture.commerce.create({
    _id: id,
    _type: 'coupon',
    code,
    isActive: true,
    discountType: 'fixed',
    discountValue: 5,
    maxUses: 5,
    timesUsed: 0,
    activeReservations: 0,
  });
};

const createInterceptingClient = (baseClient, hooks = {}) =>
  new Proxy(baseClient, {
    get(target, prop, receiver) {
      if (prop === 'patch' && (hooks.onPatch || hooks.afterPatch)) {
        return id => {
          const builder = target.patch(id);
          let setPayload = null;
          return new Proxy(builder, {
            get(bTarget, bProp, bReceiver) {
              if (bProp === 'set') {
                return values => {
                  setPayload = { ...(setPayload || {}), ...values };
                  bTarget.set(values);
                  return bReceiver;
                };
              }
              if (bProp === 'ifRevisionId' || bProp === 'setIfMissing' || bProp === 'unset' || bProp === 'inc' || bProp === 'dec') {
                return (...args) => {
                  bTarget[bProp](...args);
                  return bReceiver;
                };
              }
              if (bProp === 'commit') {
                return async options => {
                  if (hooks.onPatch) await hooks.onPatch({ id, set: setPayload || {}, baseClient });
                  const result = await bTarget.commit(options);
                  if (hooks.afterPatch) await hooks.afterPatch({ id, set: setPayload || {}, baseClient, result });
                  return result;
                };
              }
              const value = Reflect.get(bTarget, bProp, bTarget);
              return typeof value === 'function' ? value.bind(bTarget) : value;
            },
          });
        };
      }
      if (prop === 'transaction' && (hooks.beforeTxCommit || hooks.afterTxCommit)) {
        return () => {
          const tx = target.transaction();
          return new Proxy(tx, {
            get(tTarget, tProp) {
              if (tProp === 'commit') {
                return async options => {
                  if (hooks.beforeTxCommit) await hooks.beforeTxCommit({ baseClient });
                  const result = await tTarget.commit(options);
                  if (hooks.afterTxCommit) await hooks.afterTxCommit({ baseClient, result });
                  return result;
                };
              }
              const value = Reflect.get(tTarget, tProp, tTarget);
              return typeof value === 'function' ? value.bind(tTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

const runDirectDodoWebhook = async ({ client, paymentId, type, eventId }) => {
  const rawBody = JSON.stringify({ type, data: { payment_id: paymentId } });
  const ts = String(Math.floor(Date.now() / 1000));
  const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY || 'whsec_dGVzdF9kb2RvX3NlY3JldF8xMjM0NTY=';
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${eventId}.${ts}.${rawBody}`).digest('base64');
  return handleDodoWebhook({
    req: {
      method: 'POST',
      body: { type, data: { payment_id: paymentId } },
      rawBody,
      headers: {
        'webhook-id': eventId,
        'webhook-timestamp': ts,
        'webhook-signature': `v1,${sig}`,
      },
    },
    client,
  });
};

test('Gate 1 commits captureClaimedAt before finalization lease and blocks stale failures', async () => {
  const { payload, started, record } = await startCheckout();
  let observedBeforeLease = null;
  const wrapped = createInterceptingClient(fixture.commerce, {
    onPatch: async ({ id, set, baseClient }) => {
      if (id === record._id && set.status === 'finalizing' && !observedBeforeLease) {
        const stored = await baseClient.getDocument(record._id);
        observedBeforeLease = {
          captureClaimedAt: stored.captureClaimedAt,
          providerPaymentState: stored.providerPaymentState,
          status: stored.status,
        };
      }
    },
  });
  const finalized = await finalizePaymentSession({
    body: {
      paymentAccessToken: started.body.paymentAccessToken,
      providerData: { dodoCheckoutSessionId: record.providerOrderId },
    },
    client: wrapped,
  });
  assert.equal(finalized.httpStatus, 200, JSON.stringify(finalized));
  assert.equal(finalized.body.status, 'booked');
  assert.ok(observedBeforeLease, 'expected lease patch interception');
  assert.ok(observedBeforeLease.captureClaimedAt, 'Gate 1 must commit captureClaimedAt before leasing');
  assert.equal(observedBeforeLease.providerPaymentState, 'succeeded');

  const stale = await startCheckout();
  await fixture.commerce
    .patch(stale.record._id)
    .set({ captureClaimedAt: new Date().toISOString() })
    .commit();
  fixture.setPaymentAmountOverrides({ status: 'failed' });
  const failedHook = await fixture.dodoWebhook(
    `payment_${stale.record.providerOrderId}`,
    'payment.failed',
    `stale_fail_${stale.record._id}`,
  );
  assert.equal(failedHook.status, 503, JSON.stringify(failedHook));
  const afterStale = await fixture.commerce.getDocument(stale.record._id);
  assert.equal(afterStale.status, 'needs_recovery');
  assert.equal(afterStale.recoveryOwnerReviewRequired, true);
  assert.equal(afterStale.recoveryReason, 'captured_payment_release_requires_review');
  assert.equal((await holdFor(stale.payload)).phase, 'payment_pending');
  assert.ok(payload.slotHoldId);
});

for (const mode of ['failure', 'abandonment']) {
  test(`all 3 forced-order release windows protect resources on ${mode}`, async () => {
    const couponPrefix = `GATE${mode.slice(0, 4).toUpperCase()}`;
    const dodoStatus = mode === 'failure' ? 'failed' : 'cancelled';
    const eventType = mode === 'failure' ? 'payment.failed' : 'payment.cancelled';

    for (const preCondition of ['capture', 'pending_dodo', 'owner_review']) {
      const code = `${couponPrefix}W1${preCondition.slice(0, 3).toUpperCase()}`;
      await seedCoupon(`coupon_${code}`, code);
      const { payload, record } = await startCheckout({ couponCode: code });
      const patchSet =
        preCondition === 'capture'
          ? { captureClaimedAt: new Date().toISOString() }
          : preCondition === 'pending_dodo'
            ? { providerPaymentState: 'partially_captured' }
            : { recoveryReason: 'captured_payment_release_requires_review' };
      await fixture.commerce.patch(record._id).set(patchSet).commit();
      fixture.setPaymentAmountOverrides({ status: dodoStatus });
      const res = await runDirectDodoWebhook({
        client: fixture.commerce,
        paymentId: `payment_${record.providerOrderId}`,
        type: eventType,
        eventId: `w1_${mode}_${preCondition}_${record._id}`,
      });
      assert.ok([200, 503].includes(res.httpStatus), JSON.stringify(res));
      assert.equal((await holdFor(payload)).phase, 'payment_pending');
      assert.equal((await fixture.commerce.getDocument(record.couponReservationId)).status, 'reserved');
      const afterDoc = await fixture.commerce.getDocument(record._id);
      assert.notEqual(afterDoc.status, dodoStatus === 'failed' ? 'failed' : 'abandoned');
      assert.notEqual(afterDoc.providerPaymentState, dodoStatus);
    }

    const codeProc = `${couponPrefix}W1PROC`;
    await seedCoupon(`coupon_${codeProc}`, codeProc);
    const procLocal = await startCheckout({ couponCode: codeProc });
    await fixture.commerce.patch(procLocal.record._id).set({
      status: mode === 'failure' ? 'failed' : 'abandoned',
      providerPaymentState: 'processing',
      resourceReleasePending: true,
      resourceReleaseTargetStatus: mode === 'failure' ? 'failed' : 'abandoned',
      resourceReleaseReason: 'local_unverified_release',
      nextRecoveryAt: new Date(Date.now() - 60_000).toISOString(),
    }).commit();
    fixture.setPaymentAmountOverrides({ status: 'processing' });
    const procCron = await cron();
    assert.equal(procCron.status, 200, JSON.stringify(procCron));
    assert.equal((await holdFor(procLocal.payload)).phase, 'payment_pending');
    assert.equal((await fixture.commerce.getDocument(procLocal.record.couponReservationId)).status, 'reserved');
    await fixture.commerce.patch(procLocal.record._id).set({
      reconciliationRecoveryTerminal: true,
      providerRecoveryTerminal: true,
      resourceReleasePending: false,
      lateCaptureWatchUntil: '',
      nextRecoveryAt: '9999-12-31T23:59:59.999Z',
    }).commit();

    const codeW2a = `${couponPrefix}W2A`;
    await seedCoupon(`coupon_${codeW2a}`, codeW2a);
    const w2a = await startCheckout({ couponCode: codeW2a });
    let injectedW2a = false;
    const w2aClient = createInterceptingClient(fixture.commerce, {
      afterPatch: async ({ id, set, baseClient }) => {
        if (id === w2a.record._id && set.resourceReleasePending === true && !injectedW2a) {
          injectedW2a = true;
          await baseClient.patch(w2a.record._id).set({
            providerPaymentState: 'succeeded',
            captureClaimedAt: new Date().toISOString(),
            status: 'needs_recovery',
            resourceReleasePending: false,
          }).commit();
        }
      },
    });
    fixture.setPaymentAmountOverrides({ status: dodoStatus });
    await runDirectDodoWebhook({
      client: w2aClient,
      paymentId: `payment_${w2a.record.providerOrderId}`,
      type: eventType,
      eventId: `w2a_${mode}_${w2a.record._id}`,
    });
    assert.equal(injectedW2a, true);
    assert.equal((await holdFor(w2a.payload)).phase, 'payment_pending');
    assert.equal((await fixture.commerce.getDocument(w2a.record.couponReservationId)).status, 'reserved');
    assert.equal((await fixture.commerce.getDocument(w2a.record._id)).providerPaymentState, 'succeeded');

    const codeW2b = `${couponPrefix}W2B`;
    await seedCoupon(`coupon_${codeW2b}`, codeW2b);
    const w2b = await startCheckout({ couponCode: codeW2b });
    let injectedW2b = false;
    const w2bClient = createInterceptingClient(fixture.commerce, {
      beforeTxCommit: async ({ baseClient }) => {
        if (!injectedW2b) {
          injectedW2b = true;
          await baseClient.patch(w2b.record._id).set({
            providerPaymentState: 'succeeded',
            captureClaimedAt: new Date().toISOString(),
            status: 'needs_recovery',
            resourceReleasePending: false,
          }).commit();
        }
      },
    });
    fixture.setPaymentAmountOverrides({ status: dodoStatus });
    await runDirectDodoWebhook({
      client: w2bClient,
      paymentId: `payment_${w2b.record.providerOrderId}`,
      type: eventType,
      eventId: `w2b_${mode}_${w2b.record._id}`,
    });
    assert.equal(injectedW2b, true);
    assert.equal((await holdFor(w2b.payload)).phase, 'payment_pending');
    assert.equal((await fixture.commerce.getDocument(w2b.record.couponReservationId)).status, 'reserved');
    assert.equal((await fixture.commerce.getDocument(w2b.record._id)).providerPaymentState, 'succeeded');

    const codeW3 = `${couponPrefix}W3`;
    await seedCoupon(`coupon_${codeW3}`, codeW3);
    const w3 = await startCheckout({ couponCode: codeW3 });
    let injectedW3 = false;
    const w3Client = createInterceptingClient(fixture.commerce, {
      afterTxCommit: async ({ baseClient }) => {
        if (!injectedW3) {
          injectedW3 = true;
          await baseClient.patch(w3.record._id).set({
            providerPaymentState: 'succeeded',
            captureClaimedAt: new Date().toISOString(),
            status: 'needs_recovery',
            resourceReleasePending: false,
          }).commit();
        }
      },
    });
    fixture.setPaymentAmountOverrides({ status: dodoStatus });
    await runDirectDodoWebhook({
      client: w3Client,
      paymentId: `payment_${w3.record.providerOrderId}`,
      type: eventType,
      eventId: `w3_${mode}_${w3.record._id}`,
    });
    assert.equal(injectedW3, true);
    const w3After = await fixture.commerce.getDocument(w3.record._id);
    assert.equal(w3After.status, 'needs_recovery');
    assert.equal(w3After.providerPaymentState, 'succeeded');
    assert.ok(w3After.captureClaimedAt);
  });
}

test('normal controls: abandonment, legacy failure completion, and verified unbooked full refund', async () => {
  await seedCoupon('coupon_CTRLABN', 'CTRLABN');
  const abn = await startCheckout({ couponCode: 'CTRLABN' });
  fixture.setPaymentAmountOverrides({ status: 'cancelled' });
  const abnHook = await fixture.dodoWebhook(
    `payment_${abn.record.providerOrderId}`,
    'payment.cancelled',
    `ctrl_abn_${abn.record._id}`,
  );
  assert.equal(abnHook.status, 200, JSON.stringify(abnHook));
  const abnDoc = await fixture.commerce.getDocument(abn.record._id);
  assert.equal(abnDoc.status, 'abandoned');
  assert.equal(abnDoc.resourceReleasePending, false);
  assert.equal((await holdFor(abn.payload)).phase, 'released');
  assert.equal((await fixture.commerce.getDocument(abn.record.couponReservationId)).status, 'released');

  await seedCoupon('coupon_CTRLFAIL', 'CTRLFAIL');
  const fail = await startCheckout({ couponCode: 'CTRLFAIL' });
  await fixture.commerce.patch(fail.record._id).set({
    status: 'failed',
    resourceReleasePending: true,
    resourceReleaseTargetStatus: 'failed',
    resourceReleaseReason: 'legacy_failure_retry',
    nextRecoveryAt: new Date(Date.now() - 60_000).toISOString(),
  }).commit();
  const failCron = await cron();
  assert.equal(failCron.status, 200, JSON.stringify(failCron));
  const failDoc = await fixture.commerce.getDocument(fail.record._id);
  assert.equal(failDoc.status, 'failed');
  assert.equal(failDoc.resourceReleasePending, false);
  assert.equal((await holdFor(fail.payload)).phase, 'released');
  assert.equal((await fixture.commerce.getDocument(fail.record.couponReservationId)).status, 'released');

  await seedCoupon('coupon_CTRLREFU', 'CTRLREFU');
  const refUnverified = await startCheckout({ couponCode: 'CTRLREFU' });
  await fixture.commerce.patch(refUnverified.record._id).set({
    status: 'refunded',
    refundState: 'full',
    refundRequiresBookingSync: true,
    providerPaymentState: 'refunded',
    providerReversalVerified: false,
    nextRecoveryAt: new Date(Date.now() - 60_000).toISOString(),
  }).commit();
  const unvCron = await cron();
  assert.equal(unvCron.status, 200, JSON.stringify(unvCron));
  const unvDoc = await fixture.commerce.getDocument(refUnverified.record._id);
  assert.equal(unvDoc.refundRequiresBookingSync, true);
  assert.equal(unvDoc.recoveryReason, 'refund_resource_release_refused');
  assert.equal((await holdFor(refUnverified.payload)).phase, 'payment_pending');
  assert.equal((await fixture.commerce.getDocument(refUnverified.record.couponReservationId)).status, 'reserved');

  await fixture.commerce.patch(refUnverified.record._id).set({
    providerReversalVerified: true,
    nextRecoveryAt: new Date(Date.now() - 60_000).toISOString(),
  }).commit();
  const verCron = await cron();
  assert.equal(verCron.status, 200, JSON.stringify(verCron));
  const verDoc = await fixture.commerce.getDocument(refUnverified.record._id);
  assert.equal(verDoc.refundRequiresBookingSync, false);
  assert.equal((await holdFor(refUnverified.payload)).phase, 'released');
  assert.equal((await fixture.commerce.getDocument(refUnverified.record.couponReservationId)).status, 'released');
});

test('legacy reason-only owner review preserved across unbooked and booked refund and dispute writes', async () => {
  await seedCoupon('coupon_LEGUNB', 'LEGUNB');
  const unbooked = await startCheckout({ couponCode: 'LEGUNB' });
  await fixture.commerce.patch(unbooked.record._id).set({
    recoveryReason: 'captured_payment_release_requires_review',
    reconciliationRecoveryTerminal: true,
  }).commit();
  const unbookedCents = Math.round(Number(unbooked.record.pricingSnapshot.netAmount) * 100);
  fixture.setPaymentAmountOverrides({
    status: 'succeeded',
    refund_status: 'full',
    refunds: [{
      refund_id: `ref_unb_${unbooked.record._id}`,
      payment_id: `payment_${unbooked.record.providerOrderId}`,
      status: 'succeeded',
      amount: unbookedCents,
      currency: 'USD',
    }],
  });
  const unbHook = await fixture.dodoWebhook(
    `payment_${unbooked.record.providerOrderId}`,
    'refund.succeeded',
    `leg_unb_${unbooked.record._id}`,
  );
  assert.equal(unbHook.status, 503, JSON.stringify(unbHook));
  const unbAfter = await fixture.commerce.getDocument(unbooked.record._id);
  assert.equal(unbAfter.status, 'refunded');
  assert.equal(unbAfter.recoveryOwnerReviewRequired, true);
  assert.equal(unbAfter.refundRequiresBookingSync, true);
  assert.equal((await holdFor(unbooked.payload)).phase, 'payment_pending');
  assert.equal((await fixture.commerce.getDocument(unbooked.record.couponReservationId)).status, 'reserved');

  const booked = await startCheckout();
  fixture.setPaymentAmountOverrides({ status: 'succeeded' });
  const paidHook = await fixture.dodoWebhook(
    `payment_${booked.record.providerOrderId}`,
    'payment.succeeded',
    `leg_book_${booked.record._id}`,
  );
  assert.equal(paidHook.status, 200, JSON.stringify(paidHook));
  const bookedRec = await fixture.commerce.getDocument(booked.record._id);
  assert.ok(bookedRec.bookingId);
  await fixture.commerce.patch(booked.record._id).set({
    recoveryReason: 'captured_payment_release_requires_review',
  }).commit();
  const bookedCents = Math.round(Number(booked.record.pricingSnapshot.netAmount) * 100);
  fixture.setPaymentAmountOverrides({
    status: 'succeeded',
    refund_status: 'full',
    refunds: [{
      refund_id: `ref_bk_${booked.record._id}`,
      payment_id: `payment_${booked.record.providerOrderId}`,
      status: 'succeeded',
      amount: bookedCents,
      currency: 'USD',
    }],
  });
  const bkRefund = await fixture.dodoWebhook(
    `payment_${booked.record.providerOrderId}`,
    'refund.succeeded',
    `leg_bk_ref_${booked.record._id}`,
  );
  assert.equal(bkRefund.status, 200, JSON.stringify(bkRefund));
  const bkAfter = await fixture.commerce.getDocument(booked.record._id);
  assert.equal(bkAfter.status, 'refunded');
  assert.equal(bkAfter.refundRequiresBookingSync, false);
  assert.equal(bkAfter.recoveryOwnerReviewRequired, true);
  assert.equal((await fixture.commerce.getDocument(bookedRec.bookingId)).status, 'refunded');

  const disputed = await startCheckout();
  fixture.setPaymentAmountOverrides({ status: 'succeeded' });
  assert.equal((await fixture.dodoWebhook(
    `payment_${disputed.record.providerOrderId}`,
    'payment.succeeded',
    `leg_disp_pay_${disputed.record._id}`,
  )).status, 200);
  await fixture.commerce.patch(disputed.record._id).set({
    recoveryReason: 'late_capture_watch_unverified_owner_review',
  }).commit();
  const paymentId = `payment_${disputed.record.providerOrderId}`;
  const dispAmount = Number(disputed.record.pricingSnapshot.netAmount).toFixed(2);
  fixture.setPaymentAmountOverrides({
    status: 'succeeded',
    disputes: [{
      dispute_id: `disp_${disputed.record._id}`,
      payment_id: paymentId,
      dispute_status: 'dispute_opened',
      dispute_stage: 'dispute',
      amount: dispAmount,
      currency: 'USD',
      business_id: 'bus_fixture',
      created_at: new Date().toISOString(),
    }],
  });
  const openRes = await fixture.dodoWebhook(paymentId, 'dispute.opened', `leg_disp_open_${disputed.record._id}`);
  assert.equal(openRes.status, 200, JSON.stringify(openRes));
  const afterOpen = await fixture.commerce.getDocument(disputed.record._id);
  assert.equal(afterOpen.recoveryOwnerReviewRequired, true);
  fixture.setPaymentAmountOverrides({
    status: 'succeeded',
    disputes: [{
      dispute_id: `disp_${disputed.record._id}`,
      payment_id: paymentId,
      dispute_status: 'dispute_won',
      dispute_stage: 'dispute',
      amount: dispAmount,
      currency: 'USD',
      business_id: 'bus_fixture',
      created_at: new Date().toISOString(),
    }],
  });
  const wonRes = await fixture.dodoWebhook(paymentId, 'dispute.won', `leg_disp_won_${disputed.record._id}`);
  assert.equal(wonRes.status, 200, JSON.stringify(wonRes));
  assert.equal((await fixture.commerce.getDocument(disputed.record._id)).recoveryOwnerReviewRequired, true);

  const direct = await startCheckout();
  fixture.setPaymentAmountOverrides({ status: 'succeeded' });
  assert.equal((await fixture.dodoWebhook(
    `payment_${direct.record.providerOrderId}`,
    'payment.succeeded',
    `leg_dir_pay_${direct.record._id}`,
  )).status, 200);
  const directRec = await fixture.commerce.patch(direct.record._id).set({
    status: 'needs_recovery',
    reconciliationRecoveryTerminal: true,
    recoveryReason: 'upgrade_credit_changed_after_quote',
  }).commit();
  const directAmount = Number(direct.record.pricingSnapshot.netAmount);
  const applied = await applyBookingRefund({
    client: fixture.commerce,
    paymentRecord: directRec,
    refund: { full: true, id: `ref_dir_${direct.record._id}`, amount: directAmount, currency: 'USD' },
  });
  assert.equal(applied.bookingId, directRec.bookingId);
  const directAfter = await fixture.commerce.getDocument(direct.record._id);
  assert.equal(directAfter.status, 'refunded');
  assert.equal(directAfter.recoveryOwnerReviewRequired, true);

  const replayRec = await fixture.commerce.patch(direct.record._id).set({
    recoveryOwnerReviewRequired: false,
    recoveryReason: 'captured_payment_release_requires_review',
    refundRequiresBookingSync: true,
  }).commit();
  const replayed = await applyBookingRefund({
    client: fixture.commerce,
    paymentRecord: replayRec,
    refund: { full: true, id: `ref_dir_${direct.record._id}`, amount: directAmount, currency: 'USD' },
  });
  assert.equal(replayed.idempotent, true);
  const replayAfter = await fixture.commerce.getDocument(direct.record._id);
  assert.equal(replayAfter.recoveryOwnerReviewRequired, true);
});

test('verified late webhook clears sole late-watch review, blocks independent review, and failed watch reconciles cleanly', async () => {
  const sole = await startCheckout();
  await fixture.commerce.patch(sole.record._id).set({
    status: 'abandoned',
    recoveryReason: 'late_capture_watch_unverified_owner_review',
    reconciliationRecoveryTerminal: true,
    nextRecoveryAt: '9999-12-31T23:59:59.999Z',
  }).commit();
  fixture.setPaymentAmountOverrides({ status: 'succeeded' });
  const soleRes = await fixture.dodoWebhook(
    `payment_${sole.record.providerOrderId}`,
    'payment.succeeded',
    `sole_lw_${sole.record._id}`,
  );
  assert.equal(soleRes.status, 200, JSON.stringify(soleRes));
  const soleAfter = await fixture.commerce.getDocument(sole.record._id);
  assert.ok(soleAfter.bookingId);
  assert.equal(soleAfter.requiresReschedule, true);

  const blocked = await startCheckout();
  await fixture.commerce.patch(blocked.record._id).set({
    status: 'abandoned',
    recoveryReason: 'late_capture_watch_unverified_owner_review',
    recoveryOwnerReviewRequired: true,
    reconciliationRecoveryTerminal: true,
    nextRecoveryAt: '9999-12-31T23:59:59.999Z',
  }).commit();
  fixture.setPaymentAmountOverrides({ status: 'succeeded' });
  const blockedRes = await fixture.dodoWebhook(
    `payment_${blocked.record.providerOrderId}`,
    'payment.succeeded',
    `blocked_lw_${blocked.record._id}`,
  );
  assert.equal(blockedRes.status, 200, JSON.stringify(blockedRes));
  const blockedAfter = await fixture.commerce.getDocument(blocked.record._id);
  assert.equal(blockedAfter.bookingId || '', '');
  assert.equal(blockedAfter.recoveryOwnerReviewRequired, true);
  assert.equal(blockedAfter.status, 'abandoned');

  const failedWatch = await startCheckout();
  await fixture.commerce.patch(failedWatch.record._id).set({
    status: 'failed',
    reconciliationRecoveryTerminal: true,
    lateCaptureWatchUntil: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
    nextRecoveryAt: new Date(Date.now() - 60_000).toISOString(),
  }).commit();
  fixture.setCheckoutPaymentStarted(false);
  const watchRes = await reconcilePaymentSessions({
    req: { headers: { authorization: 'Bearer fixture-only-cron' } },
    client: fixture.commerce,
  });
  assert.equal(watchRes.httpStatus, 200, JSON.stringify(watchRes));
  assert.equal(watchRes.body.summary.failed, 0);
  const afterWatch = await fixture.commerce.getDocument(failedWatch.record._id);
  assert.equal(afterWatch.status, 'failed');
  assert.ok(afterWatch.nextRecoveryAt);

  fixture.setCheckoutPaymentStarted(true);
  fixture.setPaymentAmountOverrides({ status: 'succeeded' });
  await fixture.commerce.patch(failedWatch.record._id).set({
    nextRecoveryAt: new Date(Date.now() - 60_000).toISOString(),
  }).commit();
  const recoveredWatch = await cron();
  assert.equal(recoveredWatch.status, 200, JSON.stringify(recoveredWatch));
  const finalWatch = await fixture.commerce.getDocument(failedWatch.record._id);
  assert.ok(finalWatch.bookingId);
  assert.equal(finalWatch.requiresReschedule, true);
});

test('free checkout failure releases resources, Dodo processing->failed retries cleanly after transient release error, and upgrade locks obey release gates', async () => {
  await seedCoupon('coupon_FREEREL', 'FREEREL');
  const freeCheckout = await startCheckout({ couponCode: 'FREEREL' });
  await fixture.commerce.patch(freeCheckout.payload.slotHoldId).set({
    phase: 'released',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    paymentRecordId: '',
  }).commit();
  await fixture.commerce.patch(freeCheckout.record._id).set({
    provider: 'free',
    status: 'needs_recovery',
    finalizationLeaseId: '',
    finalizationLeaseExpiresAt: '',
    nextRecoveryAt: new Date(Date.now() - 60_000).toISOString(),
  }).commit();
  const freeCron = await cron();
  assert.equal(freeCron.status, 200, JSON.stringify(freeCron));
  const freeAfter = await fixture.commerce.getDocument(freeCheckout.record._id);
  assert.equal(freeAfter.status, 'failed');
  assert.equal(freeAfter.resourceReleasePending, false);
  assert.equal(freeAfter.recoveryOwnerReviewRequired || false, false);
  assert.equal((await fixture.commerce.getDocument(freeCheckout.record.couponReservationId)).status, 'released');

  await seedCoupon('coupon_PROCRETRY', 'PROCRETRY');
  const procRetry = await startCheckout({ couponCode: 'PROCRETRY' });
  await fixture.commerce.patch(procRetry.record._id).set({
    providerPaymentState: 'processing',
  }).commit();
  let failTxOnce = true;
  const transientClient = createInterceptingClient(fixture.commerce, {
    beforeTxCommit: async () => {
      if (failTxOnce) {
        failTxOnce = false;
        throw new Error('Synthetic transient release failure');
      }
    },
  });
  fixture.setPaymentAmountOverrides({ status: 'failed' });
  const firstFailHook = await runDirectDodoWebhook({
    client: transientClient,
    paymentId: `payment_${procRetry.record.providerOrderId}`,
    type: 'payment.failed',
    eventId: `proc_retry_fail_${procRetry.record._id}`,
  });
  assert.equal(failTxOnce, false);
  assert.equal(firstFailHook.httpStatus, 503, JSON.stringify(firstFailHook));
  const pendingDoc = await fixture.commerce.getDocument(procRetry.record._id);
  assert.equal(pendingDoc.resourceReleasePending, true);
  assert.equal(pendingDoc.providerPaymentState, 'failed');
  await fixture.commerce.patch(procRetry.record._id).set({
    nextRecoveryAt: new Date(Date.now() - 60_000).toISOString(),
  }).commit();
  const retryCron = await cron();
  assert.equal(retryCron.status, 200, JSON.stringify(retryCron));
  const retriedDoc = await fixture.commerce.getDocument(procRetry.record._id);
  assert.equal(retriedDoc.status, 'failed');
  assert.equal(retriedDoc.resourceReleasePending, false);
  assert.equal((await holdFor(procRetry.payload)).phase, 'released');
  assert.equal((await fixture.commerce.getDocument(procRetry.record.couponReservationId)).status, 'released');

  const blockedLock = await startCheckout();
  const blockedLockId = `paymentUpgradeLock.${blockedLock.record._id}`;
  await fixture.commerce.create({
    _id: blockedLockId,
    _type: 'paymentUpgradeLock',
    paymentRecordId: blockedLock.record._id,
    originalOrderId: 'order_blocked_lock',
    backendOwner: 'supabase',
    cutoverGeneration: 0,
  });
  await fixture.commerce.patch(blockedLock.record._id).set({
    startClaimId: blockedLockId,
    captureClaimedAt: new Date().toISOString(),
  }).commit();
  fixture.setPaymentAmountOverrides({ status: 'failed' });
  await runDirectDodoWebhook({
    client: fixture.commerce,
    paymentId: `payment_${blockedLock.record.providerOrderId}`,
    type: 'payment.failed',
    eventId: `lock_blocked_${blockedLock.record._id}`,
  });
  assert.ok(await fixture.commerce.getDocument(blockedLockId), 'captured payment must keep upgrade lock');

  const failedLock = await startCheckout();
  const failedLockId = `paymentUpgradeLock.${failedLock.record._id}`;
  await fixture.commerce.create({
    _id: failedLockId,
    _type: 'paymentUpgradeLock',
    paymentRecordId: failedLock.record._id,
    originalOrderId: 'order_failed_lock',
    backendOwner: 'supabase',
    cutoverGeneration: 0,
  });
  await fixture.commerce.patch(failedLock.record._id).set({
    startClaimId: failedLockId,
  }).commit();
  fixture.setPaymentAmountOverrides({ status: 'failed' });
  const failedLockRes = await runDirectDodoWebhook({
    client: fixture.commerce,
    paymentId: `payment_${failedLock.record.providerOrderId}`,
    type: 'payment.failed',
    eventId: `lock_failed_${failedLock.record._id}`,
  });
  assert.equal(failedLockRes.httpStatus, 200, JSON.stringify(failedLockRes));
  assert.equal(await fixture.commerce.getDocument(failedLockId), null, 'allowed failure must delete upgrade lock');

  const refundedLock = await startCheckout();
  const refundedLockId = `paymentUpgradeLock.${refundedLock.record._id}`;
  await fixture.commerce.create({
    _id: refundedLockId,
    _type: 'paymentUpgradeLock',
    paymentRecordId: refundedLock.record._id,
    originalOrderId: 'order_refunded_lock',
    backendOwner: 'supabase',
    cutoverGeneration: 0,
  });
  await fixture.commerce.patch(refundedLock.record._id).set({
    startClaimId: refundedLockId,
    status: 'refunded',
    refundState: 'full',
    refundRequiresBookingSync: true,
    providerPaymentState: 'refunded',
    providerReversalVerified: true,
    nextRecoveryAt: new Date(Date.now() - 60_000).toISOString(),
  }).commit();
  const refundedLockCron = await cron();
  assert.equal(refundedLockCron.status, 200, JSON.stringify(refundedLockCron));
  assert.equal(await fixture.commerce.getDocument(refundedLockId), null, 'verified unbooked full refund must delete upgrade lock');
});
