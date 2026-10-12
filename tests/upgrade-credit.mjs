import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { createBookingContactFixture } from './fixtures/booking-contact.mjs';

test('retained upgrade credit over HTTP with PostgreSQL', { timeout: 300000 }, async t => {
  const fixture = await createBookingContactFixture({ artifactName: 'upgrade-credit' });
  const { post, commerce, seedUpgrade, evidence, snapshot } = fixture;
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
  const price = async ({ original, payload }, result, expectedCredit) => {
    result.lookup = await post('/api/ref/getUpgradeInfo', { id: original._id, email: original.email });
    result.quote = await post('/api/payment/quote', { bookingPayload: payload });
    result.start = await post('/api/payment/start', { provider: 'dodo', bookingPayload: payload,
      quoteFingerprint: result.quote.body.quoteFingerprint });
    for (const [name, response] of Object.entries({ lookup: result.lookup, quote: result.quote, start: result.start })) {
      assert.equal(response.status, 200, `${name}: ${JSON.stringify(response)}`);
    }
    const amount = +(99.95 - expectedCredit).toFixed(2);
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

  try {
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
    await check('all requests stayed in the guarded fixture', async () => {
      assert.deepEqual(evidence.blocked, []);
    });
  } finally {
    await fixture.stop();
    console.log('Upgrade credit artifact: test-results/upgrade-credit/results.json');
  }
});
