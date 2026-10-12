import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { createBookingContactFixture } from './fixtures/booking-contact.mjs';

test('retained upgrade credit over HTTP with PostgreSQL', { timeout: 300000 }, async t => {
  const fixture = await createBookingContactFixture({ artifactName: 'upgrade-credit' });
  const { post, commerce, seedUpgrade, evidence, snapshot } = fixture;
  const baselineCommit = '45bbda83e81a6c6d486bc4838dafdd9aa90bde64';
  let baseline;
  const check = async (name, run) => t.test(name, async () => {
    const result = { name };
    evidence.cases.push(result);
    try {
      await run(result);
      result.result = 'pass';
    } catch (error) {
      result.result = 'fail';
      result.error = error.message;
      throw error;
    } finally {
      fixture.save();
    }
  });
  const seed = async ({ provider = 'paypal', refunds = [], booking = {}, payment = {} } = {}) => {
    const { original, payload } = await seedUpgrade();
    const record = {
      _id: `paymentRecord.${original._id}`, _type: 'paymentRecord',
      backendOwner: 'supabase', cutoverGeneration: 0, provider, status: 'booked',
      verificationState: 'server_verified',
      bookingId: original._id, providerOrderId: original.paypalOrderId,
      providerPaymentId: `payment_${original._id}`,
      bookingPayload: { ...original, currency: 'USD' },
      pricingSnapshot: { currency: 'USD', grossAmount: 54.95, netAmount: 54.95 },
      providerPublicData: { currency: 'USD', totalAmount: 5495, taxAmount: 0, taxInclusive: false },
      refunds: refunds.map((refund, index) => ({
        _key: `refund_${index}`, providerRefundId: `refund_${original._id}_${index}`,
        providerPaymentId: `payment_${original._id}`, status: 'processed',
        amount: 20, amountInSubunits: 2000, currency: 'USD', ...refund,
      })),
      ...payment,
    };
    record.refundProcessedAmountInSubunits ??= [...new Map(record.refunds
      .filter(refund => refund.status === 'processed')
      .map(refund => [refund.providerRefundId, refund.amountInSubunits])).values()]
      .reduce((sum, amount) => sum + (amount || 0), 0);
    record.refundState ??= record.refundProcessedAmountInSubunits > 0 ? 'partial' : '';
    record.refundCurrency ??= 'USD';
    await commerce.create(record);
    await commerce.patch(original._id).set({
      paymentRecordId: record._id, paymentProvider: provider,
      ...(provider === 'dodo' ? { dodoPaymentId: record.providerPaymentId,
        dodoCheckoutSessionId: record.providerOrderId, dodoTotalAmount: record.providerPublicData.totalAmount / 100 } : {}),
      ...(provider === 'razorpay' ? { razorpayPaymentId: record.providerPaymentId,
        razorpayOrderId: record.providerOrderId } : {}),
      ...booking,
    }).commit();
    return { original, payload, record };
  };
  const price = async ({ original, payload }, result, expectedCredit,
    amount = +(99.95 - expectedCredit).toFixed(2)) => {
    result.lookup = await post('/api/ref/getUpgradeInfo', { id: original._id, email: original.email });
    result.quote = await post('/api/payment/quote', { bookingPayload: payload });
    result.start = await post('/api/payment/start', { provider: 'dodo', bookingPayload: payload,
      quoteFingerprint: result.quote.body.quoteFingerprint });
    for (const [name, response] of Object.entries({ lookup: result.lookup, quote: result.quote, start: result.start })) {
      assert.equal(response.status, 200, `${name}: ${JSON.stringify(response)}`);
    }
    assert.equal(result.lookup.body.originalPaid, expectedCredit, 'Lookup credit');
    assert.equal(result.lookup.body.upgradePrice, amount, 'Lookup payable');
    assert.equal(result.quote.body.quote.grossAmount, amount, 'Quote gross');
    assert.equal(result.quote.body.quote.netAmount, amount, 'Quote net');
    const started = await commerce.fetch(
      '*[_type == "paymentRecord" && providerOrderId == $id][0]',
      { id: result.start.body.providerPayload.orderId }
    );
    assert.equal(started.pricingSnapshot.netAmount, amount, 'Stored checkout price');
    const request = evidence.providerRequests.filter(request => request.path === '/checkouts').at(-1);
    assert.equal(request.body.product_cart[0].amount, Math.round(amount * 100), 'Provider checkout amount');
  };
  const parity = async (scenario, result) => {
    const options = { originalOrderId: scenario.original._id,
      packageTitle: scenario.payload.packageTitle, client: commerce };
    const context = await baseline.resolveUpgradeContext(options);
    const quote = await baseline.resolvePaymentQuote(options);
    result.baseline = { commit: baselineCommit, credit: context.totalPaid, payable: context.upgradePrice,
      grossAmount: quote.effectiveGrossAmount, netAmount: quote.effectiveNetAmount };
    await price(scenario, result, context.totalPaid, context.upgradePrice);
    assert.equal(result.quote.body.quote.grossAmount, quote.effectiveGrossAmount, 'Baseline quote gross');
    assert.equal(result.quote.body.quote.netAmount, quote.effectiveNetAmount, 'Baseline quote net');
  };
  const refuse = async ({ original, payload }, result) => {
    const before = await snapshot();
    result.lookup = await post('/api/ref/getUpgradeInfo', { id: original._id, email: original.email });
    result.quote = await post('/api/payment/quote', { bookingPayload: payload });
    result.start = await post('/api/payment/start', { provider: 'dodo', bookingPayload: payload,
      quoteFingerprint: 'stale-quote' });
    for (const [name, response] of Object.entries({ lookup: result.lookup, quote: result.quote, start: result.start })) {
      assert.ok(response.status >= 400 && response.status < 500, `${name}: ${JSON.stringify(response)}`);
      assert.equal(response.body.ok, false);
    }
    result.noMutation = isDeepStrictEqual(before, await snapshot());
    assert.ok(result.noMutation, 'Rejected upgrade mutated commerce state or contacted a provider');
  };
  const nativeCapture = async ({ taxInclusive = false } = {}) => {
    const bookingPayload = await fixture.hold({ packageTitle: 'Performance Vertex Overhaul' });
    const started = await fixture.start(bookingPayload);
    assert.equal(started.status, 200, JSON.stringify(started));
    if (taxInclusive) {
      const record = await commerce.fetch('*[_type == "paymentRecord" && providerOrderId == $id][0]',
        { id: started.body.providerPayload.orderId });
      await commerce.patch(record._id).set({
        providerPublicData: { ...record.providerPublicData, taxInclusive: true },
      }).commit();
    }
    const finalized = await post('/api/payment/finalize', {}, started.body.paymentAccessToken);
    assert.equal(finalized.status, 200, JSON.stringify(finalized));
    const record = await commerce.fetch('*[_type == "paymentRecord" && providerOrderId == $id][0]',
      { id: started.body.providerPayload.orderId });
    const lookup = await post('/api/ref/getUpgradeInfo', { id: finalized.body.bookingId, email: bookingPayload.email });
    assert.equal(lookup.status, 200, JSON.stringify(lookup));
    return { record, started, original: { _id: finalized.body.bookingId, email: bookingPayload.email },
      payload: { originalOrderId: finalized.body.bookingId, packageTitle: lookup.body.targetPackage.title,
        email: bookingPayload.email, upgradeIntentToken: lookup.body.upgradeIntentToken,
        deferEmailsUntilConfirmation: true } };
  };
  const partialRefund = (record, id) => ({ refund_id: id, payment_id: record.providerPaymentId,
    status: 'succeeded', amount: 550, currency: 'USD', is_partial: true });
  const openNativeUpgrade = async (changes = {}) => {
    const original = await nativeCapture();
    const payload = { ...original.payload, ...changes };
    const started = await fixture.start(payload);
    assert.equal(started.status, 200, JSON.stringify(started));
    const record = await commerce.fetch('*[_type == "paymentRecord" && providerOrderId == $id][0]',
      { id: started.body.providerPayload.orderId });
    return { original, payload, started, record };
  };
  const refundOriginal = async (scenario, id) => {
    const response = await fixture.refundPayment(scenario.original.record.providerPaymentId,
      [{ ...partialRefund(scenario.original.record, id), amount: 2000 }], `event_${id}`);
    assert.equal(response.status, 200, JSON.stringify(response));
  };
  const finalizeUpgrade = async (scenario, via, result) => {
    if (via === 'recovery') {
      const previous = new Date(Date.now() - 120_000).toISOString();
      await commerce.patch(scenario.record._id).set({ createdAt: previous, updatedAt: previous,
        lastAttemptAt: previous, nextRecoveryAt: '' }).commit();
      result.finalize = await post('/api/payment/reconcile', {}, 'fixture-only-cron');
    } else if (via === 'webhook') {
      result.finalize = await fixture.dodoWebhook(`payment_${scenario.record.providerOrderId}`,
        'payment.succeeded', `upgrade_paid_${scenario.record._id}`);
    } else {
      result.finalize = await post('/api/payment/finalize', {}, scenario.started.body.paymentAccessToken);
    }
    return commerce.getDocument(scenario.record._id);
  };
  const assertUpgradeIntact = async (scenario, record, result) => {
    result.paymentRecord = record;
    result.bookings = await commerce.fetch('*[_type == "booking" && paymentRecordId == $id]', { id: record._id });
    assert.equal(record.status, 'needs_recovery');
    assert.equal(record.verificationState, 'server_verified');
    assert.equal(record.pricingSnapshot.netAmount, 45);
    assert.equal(record.providerPublicData.totalAmount, 4500);
    assert.equal(record.providerPaymentId, `payment_${scenario.record.providerOrderId}`);
    assert.equal(record.providerOrderId, scenario.record.providerOrderId);
    assert.equal(record.refundState || '', '');
    assert.equal(record.refundProcessedAmountInSubunits || 0, 0);
    assert.equal(record.bookingId || '', '');
    assert.equal(record.finalizationLeaseId || '', '');
    assert.equal(record.reconciliationRecoveryTerminal, true);
    assert.equal(record.nextRecoveryAt || '', '');
    assert.deepEqual(result.bookings, []);
    assert.ok(!evidence.providerRequests.some(request => request.method === 'POST' && request.path === '/refunds'));
  };

  try {
    const baselineSource = execFileSync('git', ['show', `${baselineCommit}:src/server/api/ref/pricing.js`], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
    }).replace(/from "(\.\.?\/[^\"]+)"/g, (_, path) =>
      `from "${new URL(path, new URL('../src/server/api/ref/pricing.js', import.meta.url)).href}"`);
    baseline = await import(`data:text/javascript;base64,${Buffer.from(baselineSource).toString('base64')}`);
    for (const via of ['client', 'webhook', 'recovery']) {
      await check(`${via}: a $20 refund after a $45 upgrade checkout holds the captured payment for review`, async result => {
        const scenario = await openNativeUpgrade();
        assert.equal(scenario.original.record.pricingSnapshot.netAmount, 54.95);
        assert.equal(scenario.record.pricingSnapshot.netAmount, 45);
        await refundOriginal(scenario, `refund_before_upgrade_${via}`);
        result.lookup = await post('/api/ref/getUpgradeInfo', { id: scenario.original.original._id,
          email: scenario.original.original.email });
        assert.equal(result.lookup.status, 200, JSON.stringify(result.lookup));
        assert.equal(result.lookup.body.upgradePrice, 65);
        const originalError = console.error;
        result.logs = [];
        let record;
        try {
          console.error = (...args) => { result.logs.push(args); originalError(...args); };
          record = await finalizeUpgrade(scenario, via, result);
        } finally {
          console.error = originalError;
        }
        assert.equal(result.finalize.status, 200, JSON.stringify(result.finalize));
        await assertUpgradeIntact(scenario, record, result);
        assert.equal(record.recoveryReason, 'upgrade_credit_changed_after_quote');
        assert.ok(result.logs.some(([, metadata]) => metadata?.code === 'upgrade_credit_changed_after_quote'));
        result.status = await post('/api/payment/status', {}, scenario.started.body.paymentAccessToken);
        assert.equal(result.status.body.ok, true);
        assert.equal(result.status.body.manualReviewRequired, true);
        assert.match(result.status.body.recoveryReason, /payment.*received.*contact/i);
        for (const replay of ['client', 'webhook', 'recovery']) {
          const repeated = await finalizeUpgrade(scenario, replay, { });
          assert.equal(repeated.status, 'needs_recovery');
          assert.equal(repeated.bookingId || '', '');
          assert.equal(repeated.pricingSnapshot.netAmount, 45);
        }
        result.bookings = await commerce.fetch('*[_type == "booking" && paymentRecordId == $id]', { id: record._id });
        assert.deepEqual(result.bookings, []);
      });
      await check(`${via}: an unchanged $45 upgrade still books normally`, async result => {
        const scenario = await openNativeUpgrade();
        const record = await finalizeUpgrade(scenario, via, result);
        assert.equal(result.finalize.status, 200, JSON.stringify(result.finalize));
        assert.equal(record.status, 'booked');
        const booking = await commerce.getDocument(record.bookingId);
        assert.equal(booking.status, 'captured');
        assert.equal(booking.netAmount, 45);
        assert.equal(booking.originalOrderId, scenario.original.original._id);
      });
    }
    for (const [via, unverified] of [['client', false], ['webhook', false], ['recovery', false], ['client', true]]) {
      await check(`${via}: a late upgrade capture with ${unverified ? 'unverifiable' : 'reduced'} credit stays in owner review`, async result => {
        const scenario = await openNativeUpgrade();
        await refundOriginal(scenario, `refund_late_upgrade_${via}_${unverified}`);
        if (unverified) {
          const original = await commerce.getDocument(scenario.original.record._id);
          await commerce.patch(original._id).set({ providerPublicData: { ...original.providerPublicData, taxAmount: null } }).commit();
        }
        await commerce.patch(scenario.record._id).set({ status: 'abandoned',
          lateCaptureWatchUntil: new Date(Date.now() + 120_000).toISOString() }).commit();
        const record = await finalizeUpgrade(scenario, via, result);
        assert.equal(result.finalize.status, unverified ? 409 : 200, JSON.stringify(result.finalize));
        await assertUpgradeIntact(scenario, record, result);
        assert.equal(record.recoveryReason, unverified ? 'upgrade_credit_unverified' : 'upgrade_credit_changed_after_quote');
      });
    }
    await check('a refund on an unrelated booking does not block the captured upgrade', async result => {
      const scenario = await openNativeUpgrade();
      const other = await nativeCapture();
      await refundOriginal({ original: other }, 'refund_unrelated_upgrade');
      const record = await finalizeUpgrade(scenario, 'client', result);
      assert.equal(record.status, 'booked');
      assert.equal((await commerce.getDocument(record.bookingId)).netAmount, 45);
    });
    await check('an unchanged upgrade preserves the discount approved at checkout', async result => {
      const scenario = await openNativeUpgrade({ couponCode: 'FIXTUREPAID' });
      assert.equal(scenario.record.pricingSnapshot.grossAmount, 45);
      assert.equal(scenario.record.pricingSnapshot.netAmount, 40.5);
      const record = await finalizeUpgrade(scenario, 'client', result);
      assert.equal(record.status, 'booked');
      assert.equal((await commerce.getDocument(record.bookingId)).netAmount, 40.5);
    });
    for (const credit of [74.95, 99.95]) {
      await check(`a captured upgrade still books when the retained credit rises to $${credit}`, async result => {
        const scenario = await openNativeUpgrade();
        await commerce.patch(scenario.original.original._id).set({ netAmount: credit }).commit();
        const record = await finalizeUpgrade(scenario, 'client', result);
        assert.equal(record.status, 'booked');
        assert.equal((await commerce.getDocument(record.bookingId)).netAmount, 45);
      });
    }
    await check('unverifiable credit at finalization preserves the capture and returns contact-us 409', async result => {
      const scenario = await openNativeUpgrade();
      await refundOriginal(scenario, 'refund_unknown_credit_upgrade');
      const original = await commerce.getDocument(scenario.original.record._id);
      await commerce.patch(original._id).set({ providerPublicData: { ...original.providerPublicData, taxAmount: null } }).commit();
      const record = await finalizeUpgrade(scenario, 'client', result);
      assert.equal(result.finalize.status, 409, JSON.stringify(result.finalize));
      assert.equal(result.finalize.body.code, 'upgrade_credit_unverified');
      assert.match(result.finalize.body.error, /contact us to upgrade this booking/i);
      await assertUpgradeIntact(scenario, record, result);
    });
    await check('a refund settling during the final booking write cannot grant an underpaid upgrade', async result => {
      const scenario = await openNativeUpgrade();
      let refunded = false;
      fixture.setRequestHook(async (phase, request) => {
        if (phase !== 'before' || !request.body?.p_mutations?.some(mutation =>
          mutation.document?._type === 'booking' && mutation.document.originalOrderId === scenario.original.original._id)) return;
        fixture.setRequestHook(null);
        await refundOriginal(scenario, 'refund_during_upgrade_commit');
        refunded = true;
      });
      try {
        result.first = await post('/api/payment/finalize', {}, scenario.started.body.paymentAccessToken);
      } finally {
        fixture.setRequestHook(null);
      }
      assert.equal(refunded, true);
      let record = await commerce.getDocument(scenario.record._id);
      assert.equal(record.bookingId || '', '');
      record = await finalizeUpgrade(scenario, 'client', result);
      await assertUpgradeIntact(scenario, record, result);
      assert.equal(record.recoveryReason, 'upgrade_credit_changed_after_quote');
    });
    for (const [name, options] of [
      ['historical Dodo without total or tax evidence', { provider: 'dodo', payment: {
        verificationState: '', providerPublicData: { currency: 'USD' },
      } }],
      ['Dodo with verified tax evidence', { provider: 'dodo', payment: {
        providerPublicData: { currency: 'USD', totalAmount: 6045, taxAmount: 550, taxInclusive: false },
      } }],
      ['Dodo with historical tax-inclusive evidence', { provider: 'dodo', payment: {
        providerPublicData: { currency: 'USD', totalAmount: 5495, taxAmount: 500, taxInclusive: true },
      } }],
      ['PayPal', {}],
      ['Razorpay in USD', { provider: 'razorpay' }],
      ['Razorpay in INR', { provider: 'razorpay', booking: { currency: 'INR' }, payment: {
        bookingPayload: { currency: 'INR' }, pricingSnapshot: { currency: 'INR', netAmount: 54.95 },
        providerPublicData: { currency: 'INR' }, refundCurrency: 'INR',
      } }],
      ['booking amount differs from payment snapshot', { payment: {
        pricingSnapshot: { currency: 'USD', netAmount: 49.95 },
        providerPublicData: { currency: 'USD', totalAmount: 4995 },
      } }],
      ['historical provider identifiers differ', { provider: 'dodo', booking: {
        dodoPaymentId: 'historical_payment', dodoCheckoutSessionId: 'historical_checkout',
      } }],
      ['numeric-string net amount uses the original gross fallback', { booking: { netAmount: '25.00' } }],
      ['formatted legacy package price uses the original fallback', { booking: {
        netAmount: null, grossAmount: null, packagePrice: '₹54.95',
      } }],
      ['missing linked payment record', { booking: { paymentRecordId: 'paymentRecord.missing' } }],
    ]) {
      await check(`unrefunded parity: ${name}`, async result => {
        await parity(await seed(options), result);
      });
    }
    for (const status of ['pending', 'review', 'failed']) {
      await check(`unrefunded parity: historical Dodo with only ${status} refunds`, async result => {
        await parity(await seed({ provider: 'dodo', refunds: [{ status, amount: null, amountInSubunits: null }],
          payment: { verificationState: '', refundState: status, refundProcessedAmountInSubunits: 0,
            providerPublicData: { currency: 'USD' } },
        }), result);
      });
    }
    await check('unrefunded parity: legacy booking without a payment record', async result => {
      await parity(await seedUpgrade(), result);
    });
    await check('unrefunded parity: Dodo booking without a payment record', async result => {
      const scenario = await seedUpgrade();
      await commerce.patch(scenario.original._id).set({ paymentProvider: 'dodo' }).commit();
      await parity(scenario, result);
    });
    await check('unrefunded parity: multiple payment records', async result => {
      const scenario = await seed();
      for (const suffix of ['second', 'third']) {
        await commerce.create({ ...scenario.record, _id: `${scenario.record._id}.${suffix}`,
          providerOrderId: `${scenario.record.providerOrderId}_${suffix}`,
          providerPaymentId: `${scenario.record.providerPaymentId}_${suffix}` });
      }
      await commerce.patch(scenario.original._id).unset(['paymentRecordId']).commit();
      await parity(scenario, result);
    });
    await check('a settled refund on the third unlinked payment record refuses ambiguous credit', async result => {
      const scenario = await seed();
      for (const suffix of ['second', 'third']) {
        const paymentId = `${scenario.record.providerPaymentId}_${suffix}`;
        await commerce.create({ ...scenario.record, _id: `${scenario.record._id}.${suffix}`,
          providerOrderId: `${scenario.record.providerOrderId}_${suffix}`, providerPaymentId: paymentId,
          ...(suffix === 'third' ? { refundState: 'partial', refundProcessedAmountInSubunits: 2000,
            refunds: [{ _key: 'settled', providerRefundId: `${paymentId}_refund`, providerPaymentId: paymentId,
              status: 'processed', amount: 20, amountInSubunits: 2000, currency: 'USD' }] } : {}),
        });
      }
      await commerce.patch(scenario.original._id).unset(['paymentRecordId']).commit();
      const firstTwo = await commerce.fetch('*[_type == "paymentRecord" && bookingId == $bookingId][0...2]{...}',
        { bookingId: scenario.original._id });
      assert.equal(firstTwo.length, 2);
      assert.ok(firstTwo.every(record => record.refunds.length === 0));
      await refuse(scenario, result);
    });
    await check('unrefunded parity: mixed-provider upgrade chain', async result => {
      const scenario = await seed({ provider: 'dodo', booking: { netAmount: 29.95 }, payment: {
        verificationState: '', providerPublicData: { currency: 'USD' },
      } });
      await seed({ provider: 'razorpay', booking: { originalOrderId: scenario.original._id,
        netAmount: 25, grossAmount: 25, packagePrice: '$25.00', currency: 'INR' },
        payment: { pricingSnapshot: { currency: 'INR', netAmount: 25 },
          bookingPayload: { currency: 'INR' }, providerPublicData: { currency: 'INR' }, refundCurrency: 'INR' },
      });
      await parity(scenario, result);
    });
    await check('unrefunded parity: chain amounts round after summing', async result => {
      const scenario = await seed({ booking: { netAmount: 20.0049 } });
      await seed({ booking: { originalOrderId: scenario.original._id, netAmount: 25.0049 } });
      await parity(scenario, result);
    });
    await check('legacy booking without refunds keeps its full credit', async result => {
      await price(await seedUpgrade(), result, 54.95);
    });
    await check('legacy settled refund without a payment record refuses credit', async result => {
      const scenario = await seedUpgrade();
      await commerce.patch(scenario.original._id).set({ refundedAmount: 20, refundStatus: 'partial' }).commit();
      await refuse(scenario, result);
    });
    for (const provider of ['paypal', 'razorpay', 'dodo']) {
      await check(`${provider}: settled $20 refund reduces credit to $34.95`, async result => {
        await price(await seed({ provider, refunds: [{}],
          booking: { refundedAmount: 20, refundStatus: 'partial' },
          payment: { refundState: 'partial', refundProcessedAmountInSubunits: 2000, refundCurrency: 'USD' },
        }), result, 34.95);
      });
    }
    await check('two settled $10 refunds reduce credit once each', async result => {
      await price(await seed({ refunds: [{ amount: 10, amountInSubunits: 1000 }, { amount: 10, amountInSubunits: 1000 }],
        booking: { refundedAmount: 20, refundStatus: 'partial' },
        payment: { refundState: 'partial', refundProcessedAmountInSubunits: 2000, refundCurrency: 'USD' },
      }), result, 34.95);
    });
    await check('settled ledger is used before its booking summary catches up', async result => {
      await price(await seed({ refunds: [{}],
        payment: { refundState: 'partial', refundProcessedAmountInSubunits: 2000 },
      }), result, 34.95);
    });
    await check('a verified paid snapshot supplies a missing legacy booking net amount', async result => {
      await price(await seed({ refunds: [{}], booking: { netAmount: null }, payment: {
        pricingSnapshot: { currency: 'USD', grossAmount: 54.95, netAmount: 49.95 },
        providerPublicData: { currency: 'USD', totalAmount: 4995 },
      } }), result, 29.95);
    });
    await check('a mixed-provider upgrade chain credits each retained net amount', async result => {
      const scenario = await seed({ booking: { netAmount: 29.95 }, payment: {
        pricingSnapshot: { currency: 'USD', netAmount: 29.95 }, providerPublicData: { currency: 'USD', totalAmount: 2995 } } });
      await seed({ provider: 'razorpay', refunds: [{ amount: 10, amountInSubunits: 1000 }],
        booking: { originalOrderId: scenario.original._id, netAmount: 25, grossAmount: 25, packagePrice: '$25.00' },
        payment: { pricingSnapshot: { currency: 'USD', netAmount: 25 }, providerPublicData: { currency: 'USD', totalAmount: 2500 } } });
      await price(scenario, result, 44.95);
    });
    await check('the native chain excludes a fully refunded member', async result => {
      const scenario = await seed();
      await seed({ booking: { originalOrderId: scenario.original._id, status: 'refunded', refundStatus: 'full' },
        payment: { status: 'refunded', refundState: 'full' } });
      await price(scenario, result, 54.95);
    });
    for (const status of ['pending', 'review', 'failed']) {
      await check(`${status} refund does not reduce settled credit`, async result => {
        await price(await seed({ provider: 'dodo', refunds: [{ status }],
          payment: { refundState: status, refundProcessedAmountInSubunits: 0 },
        }), result, 54.95);
      });
    }
    await check('fully refunded booking remains ineligible for an upgrade', async result => {
      await refuse(await seed({ refunds: [{ amount: 54.95, amountInSubunits: 5495 }],
        booking: { status: 'refunded', refundedAmount: 54.95, refundStatus: 'full' },
        payment: { status: 'refunded', refundState: 'full', refundProcessedAmountInSubunits: 5495 },
      }), result);
    });
    await check('a settled full amount refuses upgrades before booking status catches up', async result => {
      await refuse(await seed({ refunds: [{ amount: 54.95, amountInSubunits: 5495 }],
        booking: { refundedAmount: 54.95, refundStatus: 'partial' },
        payment: { refundState: 'partial', refundProcessedAmountInSubunits: 5495 },
      }), result);
    });
    await check('settled refund with missing amounts refuses all pricing paths', async result => {
      await refuse(await seed({ refunds: [{ amount: null, amountInSubunits: null }],
        booking: { refundStatus: 'partial' }, payment: { refundState: 'partial' },
      }), result);
    });
    await check('refund currency mismatch refuses all pricing paths', async result => {
      await refuse(await seed({ refunds: [{ currency: 'EUR' }],
        booking: { currency: 'EUR', refundedAmount: 20, refundStatus: 'partial' },
        payment: { refundState: 'partial', refundProcessedAmountInSubunits: 2000,
          pricingSnapshot: { currency: 'EUR', netAmount: 54.95 },
          bookingPayload: { currency: 'EUR' }, providerPublicData: { currency: 'EUR' }, refundCurrency: 'EUR' },
      }), result);
    });
    await check('booking refund ahead of a pending ledger refuses all pricing paths', async result => {
      await refuse(await seed({ refunds: [{ status: 'pending' }],
        booking: { refundedAmount: 20, refundStatus: 'partial' },
        payment: { refundState: 'pending', refundProcessedAmountInSubunits: 0 },
      }), result);
    });
    await check('tax-inclusive retained credit subtracts the settled refund once', async result => {
      await price(await seed({ provider: 'dodo', refunds: [{}],
        booking: { refundedAmount: 20, refundStatus: 'partial' },
        payment: { refundState: 'partial', refundProcessedAmountInSubunits: 2000,
          providerPublicData: { currency: 'USD', totalAmount: 5495, taxAmount: 0, taxInclusive: true } },
      }), result, 34.95);
    });
    await check('a tax-inclusive capture total contradicting the booking refuses credit', async result => {
      await refuse(await seed({ provider: 'dodo', refunds: [{}],
        booking: { refundedAmount: 20, refundStatus: 'partial' },
        payment: { refundState: 'partial', refundProcessedAmountInSubunits: 2000,
          providerPublicData: { currency: 'USD', totalAmount: 6045, taxAmount: 550, taxInclusive: true } },
      }), result);
    });
    await check('an aggregate refund without a price split prorates with upward rounding', async result => {
      await price(await seed({ provider: 'dodo', refunds: [{ amount: 5.5, amountInSubunits: 550 }],
        booking: { refundedAmount: 5.5, refundStatus: 'partial' },
        payment: { refundState: 'partial', refundProcessedAmountInSubunits: 550,
          providerPublicData: { currency: 'USD', totalAmount: 6045, taxAmount: 550, taxInclusive: false } },
      }), result, 49.95);
    });
    await check('several taxed refunds round each settled price component upward', async result => {
      await price(await seed({ provider: 'dodo', refunds: [
        { amount: 10, amountInSubunits: 1000 }, { amount: 10, amountInSubunits: 1000 }],
        payment: { providerPublicData: { currency: 'USD', totalAmount: 6045, taxAmount: 550, taxInclusive: false } },
      }), result, 36.75);
    });
    for (const provider of ['paypal', 'razorpay']) {
      await check(`${provider}: explicitly recorded tax is excluded from retained credit`, async result => {
        await price(await seed({ provider, refunds: [{}], payment: {
          providerPublicData: { currency: 'USD', totalAmount: 6045, taxAmount: 550, taxInclusive: false },
        } }), result, 36.76);
      });
    }
    await check('a historical tax-inclusive purchase credits only its retained pre-tax price', async result => {
      await price(await seed({ provider: 'dodo', refunds: [{}],
        payment: { providerPublicData: { currency: 'USD', totalAmount: 5495, taxAmount: 500, taxInclusive: true } },
      }), result, 31.76);
    });
    for (const missing of ['totalAmount', 'taxAmount']) {
      await check(`Dodo refund with missing verified ${missing} refuses credit`, async result => {
        await refuse(await seed({ provider: 'dodo', refunds: [{}], payment: {
          providerPublicData: { currency: 'USD', totalAmount: 5495, taxAmount: 0, taxInclusive: false, [missing]: null },
        } }), result);
      });
    }
    await check('an unverified refund snapshot refuses credit', async result => {
      await refuse(await seed({ refunds: [{}], payment: { verificationState: '' } }), result);
    });
    await check('refund total above the captured amount refuses credit', async result => {
      await refuse(await seed({ refunds: [{ amount: 60, amountInSubunits: 6000 }] }), result);
    });
    await check('native refund ledger rejects duplicate IDs within one mutation', async () => {
      await assert.rejects(seed({ refunds: [
        { providerRefundId: 'refund_duplicate_settled' },
        { providerRefundId: 'refund_duplicate_settled' },
        { providerRefundId: 'refund_duplicate_settled', status: 'pending' },
      ] }), error => error.code === '21000');
    });
    await check('native refund ledger rejects conflicting amounts for a repeated ID', async () => {
      await assert.rejects(seed({ refunds: [
        { providerRefundId: 'refund_conflicting_repeat' },
        { providerRefundId: 'refund_conflicting_repeat', amount: 10, amountInSubunits: 1000, status: 'pending' },
      ] }), error => error.code === '21000');
    });
    await check('a price covered by retained credit rejects equally on every path', async result => {
      const scenario = await seed({ booking: { netAmount: 150 }, payment: {
        pricingSnapshot: { currency: 'USD', netAmount: 150 }, providerPublicData: { currency: 'USD', totalAmount: 15000 } } });
      await refuse(scenario, result);
      assert.equal(result.lookup.body.error, result.quote.body.error);
      assert.equal(result.start.body.error, result.quote.body.error);
    });
    await check('a refund settling after the quote makes checkout require the new price', async result => {
      const scenario = await seed({ refunds: [{ status: 'pending' }],
        payment: { refundState: 'pending', refundProcessedAmountInSubunits: 0 } });
      const quoted = await post('/api/payment/quote', { bookingPayload: scenario.payload });
      assert.equal(quoted.status, 200, JSON.stringify(quoted));
      await commerce.patch(scenario.record._id).set({ refundState: 'partial',
        refundProcessedAmountInSubunits: 2000,
        refunds: scenario.record.refunds.map(refund => ({ ...refund, status: 'processed' })) }).commit();
      await commerce.patch(scenario.original._id).set({ refundedAmount: 20, refundStatus: 'partial' }).commit();
      const before = await snapshot();
      result.start = await post('/api/payment/start', { provider: 'dodo', bookingPayload: scenario.payload,
        quoteFingerprint: quoted.body.quoteFingerprint });
      assert.equal(result.start.status, 409, JSON.stringify(result.start));
      assert.equal(result.start.body.code, 'quote_fingerprint_mismatch');
      assert.equal(result.start.body.quote.netAmount, 65);
      assert.ok(isDeepStrictEqual(before, await snapshot()), 'Stale quote started a provider session');
      await price(scenario, result, 34.95);
    });
    await check('native Dodo capture and refund replays retain verified tax and settled credit', async result => {
      fixture.setPaymentTax(550);
      try {
        const bookingPayload = await fixture.hold({ packageTitle: 'Performance Vertex Overhaul' });
        const started = await fixture.start(bookingPayload);
        assert.equal(started.status, 200, JSON.stringify(started));
        const finalized = await post('/api/payment/finalize', {}, started.body.paymentAccessToken);
        assert.equal(finalized.status, 200, JSON.stringify(finalized));
        const record = await commerce.fetch(
          '*[_type == "paymentRecord" && providerOrderId == $id][0]',
          { id: started.body.providerPayload.orderId }
        );
        const lookup = await post('/api/ref/getUpgradeInfo', { id: finalized.body.bookingId, email: bookingPayload.email });
        assert.equal(lookup.status, 200, JSON.stringify(lookup));
        const scenario = { original: { _id: finalized.body.bookingId, email: bookingPayload.email },
          payload: { originalOrderId: finalized.body.bookingId, packageTitle: lookup.body.targetPackage.title,
            email: bookingPayload.email, upgradeIntentToken: lookup.body.upgradeIntentToken, deferEmailsUntilConfirmation: true } };
        const refund = { refund_id: 'refund_native_dodo', payment_id: record.providerPaymentId,
          status: 'succeeded', amount: 550, currency: 'USD', is_partial: true };
        for (const [eventId, refunds] of [
          ['refund_native_first', [refund]],
          ['refund_native_first', [refund]],
          ['refund_native_late_pending', [{ ...refund, status: 'pending' }]],
        ]) {
          const response = await fixture.refundPayment(record.providerPaymentId, refunds, eventId);
          assert.equal(response.status, 200, JSON.stringify(response));
        }
        const saved = await commerce.getDocument(record._id);
        assert.equal(saved.providerPublicData.totalAmount, 6045);
        assert.equal(saved.providerPublicData.taxAmount, 550);
        assert.equal(saved.refunds.length, 1);
        assert.equal(saved.refunds[0].status, 'processed');
        assert.equal(saved.refundProcessedAmountInSubunits, 550);
        await price(scenario, result, 49.95);
      } finally {
        fixture.setPaymentTax(0);
      }
    });
    for (const [name, tax] of [['omitted', undefined], ['null', null]]) {
      await check(`a later Dodo retrieve with ${name} tax preserves capture evidence and refund credit`, async result => {
        fixture.setPaymentTax(500);
        fixture.setPaymentTaxInclusive(true);
        try {
          const scenario = await nativeCapture({ taxInclusive: true });
          assert.equal(scenario.record.providerPublicData.taxAmount, 500);
          assert.equal(scenario.record.providerPublicData.totalAmount, 5495);
          fixture.setPaymentAmountOverrides({ tax });
          result.retrieve = await post('/api/payment/finalize', {}, scenario.started.body.paymentAccessToken);
          assert.equal(result.retrieve.status, 200, JSON.stringify(result.retrieve));
          const refreshed = await commerce.getDocument(scenario.record._id);
          result.retrievePublicData = refreshed.providerPublicData;
          result.retrieveDidNotPatch = refreshed._rev === scenario.record._rev;
          const refund = partialRefund(scenario.record, `refund_tax_${name}`);
          result.refund = await fixture.refundPayment(scenario.record.providerPaymentId, [refund], `event_tax_${name}`);
          assert.equal(result.refund.status, 200, JSON.stringify(result.refund));
          await price(scenario, result, 44.95);
          assert.equal(refreshed.providerPublicData.taxAmount, 500);
          assert.equal(refreshed.providerPublicData.totalAmount, 5495);
          assert.ok(result.retrieveDidNotPatch, 'Omitted tax caused an unnecessary payment-record patch');
        } finally {
          fixture.setPaymentTax(0);
          fixture.setPaymentTaxInclusive(false);
          fixture.setPaymentAmountOverrides({});
        }
      });
    }
    await check('a changed Dodo tax amount is logged and the retrieved integers replace stored amounts', async result => {
      fixture.setPaymentTax(550);
      const originalError = console.error;
      try {
        const scenario = await nativeCapture();
        assert.equal(scenario.record.providerPublicData.taxAmount, 550);
        assert.equal(scenario.record.providerPublicData.totalAmount, 6045);
        fixture.setPaymentTax(650);
        result.logs = [];
        console.error = (...args) => { result.logs.push(args); originalError(...args); };
        result.retrieve = await post('/api/payment/finalize', {}, scenario.started.body.paymentAccessToken);
        assert.equal(result.retrieve.status, 200, JSON.stringify(result.retrieve));
        const refreshed = await commerce.getDocument(scenario.record._id);
        assert.equal(refreshed.providerPublicData.taxAmount, 650);
        assert.equal(refreshed.providerPublicData.totalAmount, 6145);
        const logged = result.logs.find(([, metadata]) => metadata?.code === 'dodo_capture_tax_changed');
        assert.ok(logged, 'Changed verified tax was not logged');
        assert.ok(logged[0].includes(scenario.record._id));
        assert.deepEqual(logged[1], { name: 'Error', code: 'dodo_capture_tax_changed', status: 0 });
        const refund = partialRefund(scenario.record, 'refund_changed_tax');
        result.refund = await fixture.refundPayment(scenario.record.providerPaymentId, [refund], 'event_changed_tax');
        assert.equal(result.refund.status, 200, JSON.stringify(result.refund));
        await price(scenario, result, 50.03);
      } finally {
        console.error = originalError;
        fixture.setPaymentTax(0);
      }
    });
    await check('Dodo finalize retry preserves stored capture tax when verification omits it', async result => {
      fixture.setPaymentTax(500);
      fixture.setPaymentTaxInclusive(true);
      try {
        const bookingPayload = await fixture.hold({ packageTitle: 'Performance Vertex Overhaul' });
        const started = await fixture.start(bookingPayload);
        assert.equal(started.status, 200, JSON.stringify(started));
        let record = await commerce.fetch('*[_type == "paymentRecord" && providerOrderId == $id][0]',
          { id: started.body.providerPayload.orderId });
        record = await commerce.patch(record._id).set({ status: 'needs_recovery', verificationState: 'server_verified',
          providerPaymentId: `payment_${started.body.providerPayload.orderId}`,
          providerPublicData: { ...record.providerPublicData, taxInclusive: true, taxAmount: 500, totalAmount: 5495 },
        }).commit();
        fixture.setPaymentAmountOverrides({ tax: undefined });
        result.finalize = await post('/api/payment/finalize', {}, started.body.paymentAccessToken);
        assert.equal(result.finalize.status, 200, JSON.stringify(result.finalize));
        const saved = await commerce.getDocument(record._id);
        result.finalizedPublicData = saved.providerPublicData;
        assert.equal(saved.providerPublicData.taxAmount, 500);
        assert.equal(saved.providerPublicData.totalAmount, 5495);
        const lookup = await post('/api/ref/getUpgradeInfo', { id: result.finalize.body.bookingId, email: bookingPayload.email });
        assert.equal(lookup.status, 200, JSON.stringify(lookup));
        const scenario = { original: { _id: result.finalize.body.bookingId, email: bookingPayload.email },
          payload: { originalOrderId: result.finalize.body.bookingId, packageTitle: lookup.body.targetPackage.title,
            email: bookingPayload.email, upgradeIntentToken: lookup.body.upgradeIntentToken,
            deferEmailsUntilConfirmation: true } };
        result.refund = await fixture.refundPayment(saved.providerPaymentId,
          [partialRefund(saved, 'refund_finalize_missing_tax')], 'event_finalize_missing_tax');
        assert.equal(result.refund.status, 200, JSON.stringify(result.refund));
        await price(scenario, result, 44.95);
      } finally {
        fixture.setPaymentTax(0);
        fixture.setPaymentTaxInclusive(false);
        fixture.setPaymentAmountOverrides({});
      }
    });
    for (const [name, total] of [['omitted', undefined], ['null', null]]) {
      await check(`a Dodo retrieve with ${name} total refuses without erasing stored amounts`, async result => {
        fixture.setPaymentTax(500);
        fixture.setPaymentTaxInclusive(true);
        try {
          const scenario = await nativeCapture({ taxInclusive: true });
          fixture.setPaymentAmountOverrides({ total_amount: total });
          result.retrieve = await post('/api/payment/finalize', {}, scenario.started.body.paymentAccessToken);
          assert.equal(result.retrieve.status, 409, JSON.stringify(result.retrieve));
          const refreshed = await commerce.getDocument(scenario.record._id);
          assert.equal(refreshed.providerPublicData.totalAmount, 5495);
          assert.equal(refreshed.providerPublicData.taxAmount, 500);
          assert.equal(refreshed._rev, scenario.record._rev);
        } finally {
          fixture.setPaymentTax(0);
          fixture.setPaymentTaxInclusive(false);
          fixture.setPaymentAmountOverrides({});
        }
      });
    }
    await check('all requests stayed in the guarded fixture', async () => {
      assert.deepEqual(evidence.blocked, []);
    });
  } finally {
    await fixture.stop();
    console.log('Upgrade credit artifact: test-results/upgrade-credit/results.json');
  }
});
