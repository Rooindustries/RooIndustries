import assert from 'node:assert/strict';
import crypto from 'node:crypto';

export async function runPayerIdentityRegressions({
  run, seed, documents, commerce, read, post, emailRequests, prepareCheckout,
}) {
  for (const provider of ['dodo', 'paypal', 'razorpay']) {
    const modes = ['client', 'recovery', 'cron-missing-payload', ...(provider === 'dodo' ? [] : ['legacy'])];
    for (const mode of modes) for (const identity of ['self', 'unknown']) {
      await run(`R4-payer-${provider}-${mode}-${identity}`, async () => {
        const state = await seed(provider, {booking: false, count: 0});
        await documents.patch(state.creator._id).set({creatorEmail: 'creator@gmail.com'}).commit();
        const payerEmail = identity === 'self' ? 'c.rea.tor+paid@googlemail.com' : '';
        state.payment.email = payerEmail;
        state.payment.customer = {email: payerEmail};
        const buyerEmail = 'buyer@example.invalid';
        const checkout = ['client', 'legacy'].includes(mode) ? await prepareCheckout(state, buyerEmail) : {};
        state.record = await commerce.patch(state.record._id).set({
          payerEmail: 'claimed-payer@example.invalid',
          ...(mode === 'cron-missing-payload' ? {status: 'needs_recovery'} : {}),
          lastAttemptAt: new Date(Date.now() - 120000).toISOString(),
          bookingPayload: mode === 'cron-missing-payload'
            ? {email: buyerEmail}
            : {...state.record.bookingPayload, ...checkout, email: buyerEmail},
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
        const body = {
          ...checkout, payerEmail: 'claimed-payer@example.invalid',
          ...(provider === 'razorpay' ? {
            razorpayOrderId: state.record.providerOrderId, razorpayPaymentId: state.record.providerPaymentId,
            razorpaySignature: crypto.createHmac('sha256', 'fixture')
              .update(`${state.record.providerOrderId}|${state.record.providerPaymentId}`).digest('hex'),
          } : {}),
        };
        const complete = () => mode === 'cron-missing-payload'
          ? post('/api/payment/reconcile', {}, {authorization: 'Bearer fixture'})
          : mode === 'legacy' ? post('/api/ref/createBooking', body)
            : post('/api/payment/finalize', body, {authorization: `Bearer ${token}`});
        const result = await complete();
        assert.equal(result.status, 200, JSON.stringify(result));
        const record = mode === 'legacy'
          ? await commerce.fetch('*[_type == "paymentRecord" && providerOrderId == $id][0]', {
            id: state.record.providerOrderId,
          }) : await read(state.record._id);
        const booking = await read(record.bookingId);
        assert.ok(booking?._id, JSON.stringify({result, record}));
        assert.equal(booking.commissionAmount, 0);
        assert.equal(booking.commissionPercent, 0);
        assert.equal(booking.payerEmail, payerEmail);
        assert.equal(booking.selfReferral, identity === 'self');
        assert.equal(booking.netAmount, state.quote.effectiveNetAmount);
        if (mode !== 'legacy') {
          assert.equal(record.payerEmail, payerEmail);
          assert.equal(record.pricingSnapshot.commissionAmount, 0);
          assert.equal(record.pricingSnapshot.commissionPercent, 0);
        }
        if (identity === 'unknown') {
          assert.equal(booking.referralReviewRequired, true);
          assert.equal(booking.referralReviewReason, 'payer_identity_unavailable');
          const {fetchReferralEarnings} = await import('../../src/server/api/ref/payoutUtils.js');
          assert.equal((await fetchReferralEarnings({
            client: commerce, referralId: state.creator._id, referralCode: state.key,
          })).total, 0);
          const {dispatchCouponAlerts} = await import('../../src/server/api/ref/couponAlerts.js');
          for (let index = 0; index < 2; index++) await dispatchCouponAlerts({
            client: commerce,
          });
          const alerts = emailRequests.filter(request =>
            request.body.subject === 'Paid booking needs a creator review' && request.body.text.includes(booking._id));
          assert.equal(alerts.length, 1);
          assert.ok(alerts[0].body.text.includes('could not confirm the payer email'));
          assert.ok((await read(booking._id)).ownerAlertSentAt);
        }
        assert.equal((await complete()).status, 200);
        assert.equal((await read(booking._id)).commissionAmount, 0);
        return {booking, record};
      });
    }
  }
}
