import assert from 'node:assert/strict';

export const checkProviderBodyTimeouts = async ({
  run, startInput, a1Start, row, commerce, sql, requestFlow, a1Hook, setProviderHook, originalNow,
}) => {
  for (const provider of ['paypal', 'razorpay']) {
    await run(`recovery-body-timeout-${provider}-start`, async () => {
      const input = { ...await startInput(), provider };
      const pending = new Set();
      const requestIds = [];
      let recovered = false;
      let receipt;
      let creates = 0;
      setProviderHook(async (request, req, res) => {
        let body;
        if (request.path.startsWith('/v1/orders?')) {
          body = { items: recovered ? [{ id: 'order-fixture', receipt, amount: 999, currency: 'USD' }] : [] };
        } else if (request.method === 'POST' &&
          request.path === (provider === 'paypal' ? '/v2/checkout/orders' : '/v1/orders')) {
          creates++;
          receipt = request.body.receipt;
          requestIds.push(req.headers['paypal-request-id']);
          if (!recovered) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write('{');
            pending.add(res);
            res.once('close', () => pending.delete(res));
            return true;
          }
          body = { id: 'order-fixture', status: 'CREATED' };
        } else return false;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
        return true;
      });
      let timer;
      let result;
      const request = requestFlow('start', { body: input });
      try {
        result = await Promise.race([request, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Checkout body read exceeded its deadline')), 11000);
        })]);
        assert.equal(result.status, 500, JSON.stringify(result));
        assert.equal(result.body.code, `${provider}_order_create_failed`);
      } finally {
        clearTimeout(timer);
        for (const response of pending) response.destroy();
        await request;
      }
      const [initial] = await sql`select legacy_sanity_id from commerce.payment_records`;
      assert.ok(initial);
      const saved = (await row(initial.legacy_sanity_id)).payload;
      assert.equal(saved.orderState, 'creation_ambiguous');
      assert.equal((await row(input.bookingPayload.slotHoldId)).payload.phase, 'payment_pending');
      const duplicate = await requestFlow('start', { body: input });
      assert.equal(duplicate.status, 409, JSON.stringify(duplicate));
      assert.equal(duplicate.body.code, 'provider_order_creation_in_progress');
      const current = (await row(saved._id)).payload;
      const old = new Date(originalNow() - 600000).toISOString();
      await commerce.patch(current._id).ifRevisionId(current._rev).set({
        createdAt: old, updatedAt: old, nextRecoveryAt: old,
      }).commit();
      recovered = true;
      const retry = await requestFlow('reconcile');
      assert.equal(retry.status, 200, JSON.stringify(retry));
      const completed = (await row(saved._id)).payload;
      assert.equal(completed.providerOrderId, 'order-fixture');
      assert.ok(completed.bookingId);
      assert.equal((await sql`select count(*)::int as count from commerce.payment_records`)[0].count, 1);
      assert.equal((await sql`select count(*)::int as count from commerce.bookings`)[0].count, 1);
      if (provider === 'paypal') {
        assert.equal(creates, 2);
        assert.ok(requestIds[0]);
        assert.equal(new Set(requestIds).size, 1);
      } else assert.equal(creates, 1);
      return { provider, result, retry, saved, creates };
    });
  }
  for (const provider of ['paypal', 'razorpay']) for (const action of ['finalize', 'cancel', 'reconcile', 'webhook']) {
    await run(`recovery-body-timeout-${provider}-${action}`, async () => {
      const checkout = await a1Start(provider);
      const initial = (await row(checkout.id)).payload;
      const old = new Date(originalNow() - 600000).toISOString();
      await commerce.patch(initial._id).ifRevisionId(initial._rev).set({
        createdAt: old, updatedAt: old, nextRecoveryAt: '',
      }).commit();
      const held = (await row(checkout.input.bookingPayload.slotHoldId)).payload;
      const pending = new Set();
      setProviderHook(async (request, req, res) => {
        if (!['/v2/checkout/orders/order-fixture', '/v1/payments/payment-fixture',
          '/v1/orders/order-fixture/payments'].includes(request.path)) return false;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
        pending.add(res);
        res.once('close', () => pending.delete(res));
        return true;
      });
      const began = originalNow();
      let result;
      let timer;
      const request = action === 'webhook' ? a1Hook(provider) : requestFlow(action, {
        paymentAccessToken: checkout.started.body.paymentAccessToken, body: checkout.proof,
      });
      try {
        result = await Promise.race([request, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Payment body read exceeded its deadline')), 11000);
        })]);
        const expectedStatus = action === 'reconcile' ? 200 : action === 'cancel' ? 503 : 202;
        assert.equal(result.status, expectedStatus, JSON.stringify(result));
        const payment = (await row(checkout.id)).payload;
        assert.equal(payment.bookingId, '');
        assert.notEqual(payment.verificationState, 'server_verified');
        const hold = (await row(held._id)).payload;
        assert.equal(hold.phase, 'payment_pending');
        assert.equal(hold.holdNonce, held.holdNonce);
        assert.equal(hold.paymentRecordId, checkout.id);
        assert.equal((await sql`select count(*)::int as count from commerce.bookings`)[0].count, 0);
      } finally {
        clearTimeout(timer);
        for (const response of pending) response.destroy();
        await request;
      }
      setProviderHook(null);
      const retry = await requestFlow('finalize', {
        paymentAccessToken: checkout.started.body.paymentAccessToken, body: checkout.proof,
      });
      assert.equal(retry.status, 200, JSON.stringify(retry));
      const saved = (await row(checkout.id)).payload;
      assert.ok(['booked', 'email_partial'].includes(saved.status), saved.status);
      assert.equal(saved.verificationState, 'server_verified');
      assert.equal((await row(saved.bookingId)).payload.paymentRecordId, checkout.id);
      assert.equal((await sql`select count(*)::int as count from commerce.bookings`)[0].count, 1);
      return { provider, action, result, retry, saved, elapsedMs: originalNow() - began };
    });
  }
};
