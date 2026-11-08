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
            assert.equal(cancelled.status, provider === 'free' ? 200 : 409, JSON.stringify(cancelled));
            if (provider === 'free') {
              assert.equal(cancelled.body.cancelled, true);
              assert.equal((await row(checkout.id)).payload.status, 'abandoned');
            } else {
              assert.equal(cancelled.body.code, 'provider_checkout_live');
              assert.equal((await row(checkout.id)).payload.status, 'started');
            }
          }
        }
        assert.equal(creations(), before);
        return { kind, provider, state, status: result.status, outcome: result.body.checkoutState };
      });
  }
};

export const runCheckoutFixScenarios = async ({ run, a1Start, row, commerce, requestFlow,
  setUnpaidCheckout, creations, setProviderHook }) => {
  for (const provider of ['dodo', 'paypal', 'razorpay']) {
    await run(`checkout-fix-live-release-${provider}`, async () => {
      const checkout = await a1Start(provider);
      setUnpaidCheckout(provider, (await row(checkout.id)).payload);
      const before = creations();
      const result = await requestFlow('cancel', { paymentAccessToken: checkout.started.body.paymentAccessToken });
      assert.equal(result.status, 409, JSON.stringify(result));
      assert.equal(result.body.code, 'provider_checkout_live');
      const replay = await requestFlow('start', { body: { ...checkout.input, provider: 'free' } });
      assert.equal(replay.status, 200, JSON.stringify(replay));
      assert.equal(replay.body.providerPayload.orderId, checkout.started.body.providerPayload.orderId);
      assert.equal((await row(checkout.id)).payload.status, 'started');
      assert.equal(creations(), before);
      return { provider, replacementDenied: true, originalOrderRetained: true };
    });
    await run(`checkout-fix-outage-${provider}`, async () => {
      const checkout = await a1Start(provider);
      const reports = [];
      const key = Symbol.for('roo.reportServerError');
      const previous = globalThis[key];
      globalThis[key] = (...args) => reports.push(args);
      setProviderHook(async (request, req, res) => { res.writeHead(503); res.end('{}'); return true; });
      try {
        const result = await requestFlow('start', { body: { ...checkout.input, recoverOnly: true } });
        assert.equal(result.status, 503, JSON.stringify(result));
        assert.equal(result.body.code, 'provider_checkout_unavailable');
        assert.match(result.body.error, /payment provider/);
        assert.equal(reports.length, 1);
        assert.equal(reports[0][2].code, 'provider_checkout_unavailable');
        return { provider, buyerSeesOutage: true, monitored: true };
      } finally { globalThis[key] = previous; }
    });
  }
  for (const provider of ['dodo', 'free']) await run(`checkout-fix-expired-upgrade-proof-${provider}`, async () => {
    const checkout = await a1Start(provider, 'upgrade');
    if (provider !== 'free') setUnpaidCheckout(provider, (await row(checkout.id)).payload);
    const before = creations();
    const originalNow = Date.now;
    Date.now = () => originalNow() + 16 * 60_000;
    try {
      const result = await requestFlow('start', { body: { ...checkout.input, recoverOnly: true,
        quoteFingerprint: 'expired-price', bookingPayload: { ...checkout.input.bookingPayload, couponCode: 'expired' } } });
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.body.checkoutState, provider === 'free' ? 'confirming' : 'resumable');
      if (provider === 'free') assert.equal(result.body.bookingId, checkout.started.body.bookingId);
      else assert.equal(result.body.providerPayload.orderId, checkout.started.body.providerPayload.orderId);
      assert.equal(creations(), before);
      return { provider, originalAuthorizationRetained: true, noFreshQuote: true };
    } finally { Date.now = originalNow; }
  });
};
