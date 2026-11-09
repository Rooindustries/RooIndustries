import assert from 'node:assert/strict';

export const checkProviderDeadlines = async ({
  run, startInput, row, sql, commerce, requestFlow, seed, dodoReq, prepareDodoRefund, setProviderHook, originalNow,
}) => {
  const bounded = async (operation, pending) => {
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Provider operation exceeded its checkout budget')), 11000);
      })]);
    } finally {
      clearTimeout(timer);
      for (const response of pending) response.destroy();
      await operation;
    }
  };
  const stall = (res, pending) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    pending.add(res);
    res.once('close', () => pending.delete(res));
    return true;
  };
  const observeErrors = () => {
    const events = [];
    const key = Symbol.for('roo.reportServerError');
    const previous = globalThis[key];
    globalThis[key] = (label, error, metadata) => { events.push({ label, ...metadata }); };
    return { events, restore: () => { globalThis[key] = previous; } };
  };
  for (const stage of ['product', 'checkout']) await run(`recovery-body-dodo-start-${stage}`, async () => {
    const input = { ...await startInput(), provider: 'dodo' };
    const pending = new Set();
    const observed = observeErrors();
    let creates = 0;
    setProviderHook(async (request, req, res) => {
      if (request.path === '/checkouts') creates++;
      if (request.path === (stage === 'product' ? '/products/pdt_fixture' : '/checkouts')) {
        return stall(res, pending);
      }
      if (request.path !== '/products/pdt_fixture') return false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ product_id: 'pdt_fixture', is_recurring: false, price: {
        type: 'one_time_price', currency: 'USD', pay_what_you_want: true, tax_inclusive: false,
        purchasing_power_parity: false, discount: 0, price: 0,
      } }));
      return true;
    });
    const began = originalNow();
    try {
      const result = await bounded(requestFlow('start', { body: input }), pending);
      assert.equal(result.status, 503, JSON.stringify(result));
      const [saved] = await sql`select source.payload from commerce.payment_records payment
        join migration.source_documents source using(legacy_sanity_id)`;
      assert.equal(saved.payload.orderState, 'creation_ambiguous');
      assert.equal((await row(input.bookingPayload.slotHoldId)).payload.phase, 'payment_pending');
      assert.ok(observed.events.some(event => ['TimeoutError', 'AbortError'].includes(event.name)));
      const retry = await requestFlow('start', { body: input });
      assert.equal(retry.status, 409, JSON.stringify(retry));
      const old = new Date(originalNow() - 600000).toISOString();
      const current = (await row(saved.payload._id)).payload;
      await commerce.patch(current._id).ifRevisionId(current._rev).set({
        createdAt: old, updatedAt: old, nextRecoveryAt: old,
      }).commit();
      await requestFlow('reconcile');
      assert.equal(creates, stage === 'checkout' ? 1 : 0);
      assert.equal((await sql`select count(*)::int as count from commerce.payment_records`)[0].count, 1);
      assert.equal((await sql`select count(*)::int as count from commerce.bookings`)[0].count, 0);
      return { stage, result, retry, creates, elapsedMs: originalNow() - began, errors: observed.events };
    } finally { observed.restore(); }
  });
  await run('recovery-body-dodo-refund', async () => {
    await seed('dodo');
    prepareDodoRefund();
    const before = (await row('booking.fixture')).payload;
    const pending = new Set();
    const observed = observeErrors();
    setProviderHook(async (request, req, res) =>
      request.path === '/refunds/refund-fixture' ? stall(res, pending) : false);
    try {
      const result = await bounded(requestFlow('dodo', { req: dodoReq() }), pending);
      assert.equal(result.status, 503, JSON.stringify(result));
      assert.equal(result.body.code, 'dodo_refund_lookup_pending');
      assert.deepEqual((await row('booking.fixture')).payload, before);
      assert.ok(observed.events.some(event => ['TimeoutError', 'AbortError'].includes(event.name)));
      setProviderHook(null);
      const retry = await requestFlow('dodo', { req: dodoReq() });
      assert.equal(retry.status, 200, JSON.stringify(retry));
      assert.equal((await row('booking.fixture')).payload.status, 'refunded');
      return { result, retry, errors: observed.events };
    } finally { observed.restore(); }
  });
  await run('recovery-body-dodo-refund-shared-deadline', async () => {
    await seed('dodo');
    prepareDodoRefund(true);
    const before = (await row('booking.fixture')).payload;
    const pending = new Set();
    let secondLookup = false;
    setProviderHook(async (request, req, res) => {
      if (request.path === '/refunds/refund-first') {
        const timer = setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ refund_id: 'refund-first', payment_id: 'payment-fixture',
            status: 'succeeded', amount: 499, currency: 'USD' }));
        }, 5000);
        res.once('close', () => clearTimeout(timer));
        return true;
      }
      if (request.path === '/refunds/refund-second') {
        secondLookup = true;
        return stall(res, pending);
      }
      return false;
    });
    const began = originalNow();
    const result = await bounded(requestFlow('dodo', { req: dodoReq() }), pending);
    assert.equal(result.status, 503, JSON.stringify(result));
    assert.equal(result.body.code, 'dodo_refund_lookup_pending');
    assert.equal(secondLookup, true);
    assert.deepEqual((await row('booking.fixture')).payload, before);
    return { result, elapsedMs: originalNow() - began };
  });
  for (const mode of ['found', 'stalled', 'disconnected', 'lookup-stalled']) {
    await run(`recovery-body-razorpay-receipt-${mode}`, async () => {
      const input = { ...await startInput(), provider: 'razorpay' };
      const pending = new Set();
      const observed = observeErrors();
      let created = false;
      let lookups = 0;
      let receipt;
      setProviderHook(async (request, req, res) => {
        if (request.path.startsWith('/v1/orders?')) {
          lookups++;
          if (mode === 'lookup-stalled' || (created && mode === 'stalled')) return stall(res, pending);
          const items = created ? [{ id: 'order-fixture', receipt, amount: 999, currency: 'USD' }] : [];
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ items }));
          return true;
        }
        if (request.path !== '/v1/orders') return false;
        created = true;
        receipt = request.body.receipt;
        if (mode !== 'disconnected') return stall(res, pending);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{', () => res.destroy());
        return true;
      });
      const began = originalNow();
      try {
        const result = await bounded(requestFlow('start', { body: input }), pending);
        assert.ok(observed.events.some(event => event.label === 'Payment provider request failed'));
        if (mode === 'disconnected' || mode === 'found') {
          assert.equal(result.status, 200, JSON.stringify(result));
          assert.equal(result.body.providerPayload.orderId, 'order-fixture');
          assert.equal(lookups, 2);
        } else {
          assert.equal(result.status, 500, JSON.stringify(result));
          assert.equal(result.body.code, 'razorpay_order_create_failed');
          assert.equal(lookups, mode === 'lookup-stalled' ? 1 : 2);
          assert.equal(created, mode !== 'lookup-stalled');
          assert.ok(observed.events.some(event => event.name === 'TimeoutError'));
          assert.equal((await row(input.bookingPayload.slotHoldId)).payload.phase, 'payment_pending');
        }
        assert.equal((await sql`select count(*)::int as count from commerce.bookings`)[0].count, 0);
        return { mode, result, lookups, elapsedMs: originalNow() - began, errors: observed.events };
      } finally { observed.restore(); }
    });
  }
};
