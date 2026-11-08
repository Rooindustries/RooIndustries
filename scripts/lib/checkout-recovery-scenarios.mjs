import assert from "node:assert/strict";

export const runCheckoutRecoveryMatrix = async ({ run, a1Start, row, commerce, requestFlow,
  setUnpaidCheckout, creations }) => {
  await run('checkout-upgrade-confirmation-survives-reconciliation', async () => {
    const checkout = await a1Start('razorpay', 'upgrade');
    const paymentAccessToken = checkout.started.body.paymentAccessToken;
    const completed = await requestFlow('finalize', { paymentAccessToken, body: checkout.proof });
    assert.equal(completed.status, 200, JSON.stringify(completed));
    assert.match(completed.body.status, /^(booked|email_partial)$/);
    assert.equal((await requestFlow('reconcile')).status, 200);
    const settled = await requestFlow('status', { paymentAccessToken });
    assert.match(settled.body.status, /^(booked|email_partial)$/);
    assert.notEqual(settled.body.manualReviewRequired, true);
    return { packagePrice: checkout.input.bookingPayload.packagePrice, status: settled.body.status };
  });
  const recoveryRows = [
    ['started', 'resumable'], ['needs_recovery_with_order', 'resumable'],
    ['needs_recovery_without_order', 'confirming'], ['paid', 'confirming'],
    ['expired', 'start_again'], ['closed', 'start_again'],
  ];
  for (const kind of ['booking', 'upgrade']) for (const provider of ['dodo', 'paypal', 'razorpay', 'free']) {
    for (const [state, expected] of recoveryRows) await run(
      'checkout-recovery-matrix-' + kind + '-' + provider + '-' + state, async () => {
        const staged = (provider === 'free' && state !== 'paid') || state === 'needs_recovery_without_order';
        const checkout = await a1Start(provider, kind === 'upgrade' ? 'upgrade' : 'normal',
          { deferEmailsUntilConfirmation: true }, staged);
        let payment = (await row(checkout.id)).payload;
        if (state === 'paid' && provider !== 'free') {
          const completed = await requestFlow('finalize', {
            paymentAccessToken: checkout.started.body.paymentAccessToken, body: checkout.proof,
          });
          assert.equal(completed.status, 200, JSON.stringify(completed));
        } else if (state !== 'paid') {
          payment = await commerce.patch(payment._id).set({
            status: state.startsWith('needs_recovery') ? 'needs_recovery' : state === 'closed' ? 'abandoned' : 'started',
            ...(state === 'expired' ? { sessionExpiresAt: new Date(Date.now() - 1000).toISOString() } : {}),
          }).commit();
        }
        setUnpaidCheckout(provider, payment);
        const before = creations();
        const result = await requestFlow('start', { body: { ...checkout.input, quoteFingerprint: 'lost-start' } });
        if (state === 'closed') {
          assert.equal(result.status, 409, JSON.stringify(result));
          assert.equal(result.body.code, kind === 'upgrade' ? 'upgrade_checkout_closed' : 'payment_checkout_closed');
          assert.equal(result.body.providerPayload, undefined);
        } else {
          assert.equal(result.status, 200, JSON.stringify(result));
          const outcome = provider === 'free' && state !== 'expired' ? 'confirming' : expected;
          assert.equal(result.body.checkoutState, outcome, JSON.stringify(result));
          if (outcome === 'resumable') assert.equal(result.body.providerPayload.orderId, payment.providerOrderId);
          else assert.equal(result.body.providerPayload, null);
          if (state === 'paid' || provider === 'free' && state !== 'expired') assert.ok(result.body.bookingSummary);
          if (state === 'paid') {
            assert.equal((await requestFlow('reconcile')).status, 200);
            const settled = await requestFlow('status', { paymentAccessToken: result.body.paymentAccessToken });
            assert.match(settled.body.status, /^(booked|email_partial)$/);
            assert.notEqual(settled.body.manualReviewRequired, true);
          }
          if (state === 'expired') {
            const cancelled = await requestFlow('cancel', { paymentAccessToken: result.body.paymentAccessToken });
            assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
            assert.equal(cancelled.body.cancelled, true);
            assert.equal((await row(checkout.id)).payload.status, 'abandoned');
          }
        }
        assert.equal(creations(), before);
        return { kind, provider, state, status: result.status, outcome: result.body.checkoutState };
      });
  }
};
