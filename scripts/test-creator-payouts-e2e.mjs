import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const host = process.env.ROO_TEST_HOST || '127.0.0.1';
const originalFetch = globalThis.fetch;
const baseline = process.argv.find(value => value.startsWith('--baseline='))?.slice(11);
const sources = ['src/server/api/ref/payoutUtils.js', 'src/server/api/ref/bookingRefunds.js', 'src/server/api/ref/bookingCommit.js', 'src/server/api/payment/flow.js'];
const baselineSources = baseline ? Object.fromEntries(sources.map(file => [new URL(`../${file}`, import.meta.url).href, execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' })])) : {};
for (const key of Object.keys(process.env)) {
  if (/^(SANITY|SUPABASE|PAYPAL|RAZORPAY|DODO|REACT_APP_|NEXT_PUBLIC_|ALLOW_LIVE_|RESEND|BOOKING_EMAIL|FROM_EMAIL|OWNER_EMAIL|DATA_|COMMERCE_|VERCEL_ENV|REF_SESSION|CRON_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy)/.test(key) || /SENTRY.*DSN/i.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: 'test', VERCEL_ENV: 'development', DATA_PRIMARY_BACKEND: 'supabase',
  COMMERCE_PRIMARY_BACKEND: 'supabase', COMMERCE_FAILOVER_GENERATION: '0',
  PAYPAL_ENV: 'sandbox', PAYPAL_CLIENT_ID: 'fixture', PAYPAL_CLIENT_SECRET: 'fixture', PAYPAL_WEBHOOK_ID: 'fixture',
  RAZORPAY_KEY_ID: 'rzp_test_fixture', RAZORPAY_KEY_SECRET: 'fixture', RAZORPAY_WEBHOOK_SECRET: 'fixture',
  PAYMENT_SESSION_SECRET: 'fixture', REF_SESSION_SECRET: 'fixture', CRON_SECRET: 'fixture',
  DODO_PAYMENTS_ENVIRONMENT: 'test_mode', DODO_PAYMENTS_API_KEY: 'fixture',
  DODO_PAYMENTS_WEBHOOK_KEY: `whsec_${Buffer.from('fixture').toString('base64')}`,
  DODO_PAYMENTS_PRODUCT_ID: 'pdt_fixture', DODO_PAYMENTS_RETURN_URL: 'https://example.invalid/payment',
  RESEND_API_KEY: 're_fixture', FROM_EMAIL: 'noreply@example.invalid', OWNER_EMAIL: 'owner@example.invalid',
});
registerHooks({ load(url, context, next) {
  return baselineSources[url] ? { format: 'module', source: baselineSources[url], shortCircuit: true } : next(url, context);
}, resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier === 'next/server') return next('next/server.js', context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      for (const suffix of ['.js', '.ts', '/index.js']) {
        const candidate = new URL(specifier + suffix, context.parentURL);
        if (fs.existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
      }
    }
    throw error;
  }
} });
const artifact = path.resolve(process.env.ROO_CREATOR_PAYOUT_ARTIFACT || 'test-results/creator-payouts.json');
fs.mkdirSync(path.dirname(artifact), { recursive: true });
const evidence = { productionRequests: 0, sentryDsnVariables: Object.keys(process.env).filter(key => /SENTRY.*DSN/i.test(key)), scenarios: [], limits: ['Synthetic provider HTTP and email responses; real route adapters, signatures, pricing, document mutations, PostgreSQL 17 and projections. No hosted auth, browser checkout or production data.'] };
assert.deepEqual(evidence.sentryDsnVariables, []);
evidence.source = { baseline: baseline || null, commit: execFileSync('git', ['rev-parse', baseline || 'HEAD'], { encoding: 'utf8' }).trim(), files: Object.fromEntries(sources.map(file => [file, crypto.createHash('sha256').update(baseline ? baselineSources[new URL(`../${file}`, import.meta.url).href] : fs.readFileSync(file)).digest('hex')])) };
let fixture, server, origin, commerce, documents, sql, earnings;
let current, sequence = 0, eventSequence = 0;
const responses = [];
const states = [];
const refundsById = new Map();
const inFlight = new Set();
const providerOrigins = new Set(['https://api-m.sandbox.paypal.com', 'https://api.razorpay.com', 'https://test.dodopayments.com', 'https://api.resend.com']);
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  assert.equal(url.protocol, 'http:', `Nonlocal request blocked: ${url.origin}`);
  assert.equal(url.hostname, host);
  return originalFetch(input, { ...init, redirect: 'error' });
};
const read = id => commerce.getDocument(id);
const cents = value => Math.round(value * 100) / 100;
const post = async (route, body, headers = {}) => {
  const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const webhook = async (type = 'payment.succeeded', id = `event-${++eventSequence}`) => {
  const provider = current.record.provider;
  if (current.refund) {
    refundsById.set(current.refund.id, structuredClone(current.refund));
    current.refunds = [...refundsById.values()].filter(refund => refund.payment_id === current.record.providerPaymentId);
  }
  let body, headers;
  if (provider === 'dodo') {
    body = JSON.stringify({ business_id: 'fixture', type, timestamp: new Date().toISOString(), data: current.payment });
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers = { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${crypto.createHmac('sha256', 'fixture').update(`${id}.${timestamp}.${body}`).digest('base64')}` };
  } else if (provider === 'paypal') {
    body = JSON.stringify({ id, event_type: type, resource: current.refund || { id: current.record.providerPaymentId, supplementary_data: { related_ids: { order_id: current.record.providerOrderId } } } });
    headers = { 'paypal-transmission-id': id, 'paypal-transmission-time': new Date().toISOString(), 'paypal-transmission-sig': 'fixture', 'paypal-cert-url': 'https://example.invalid/cert', 'paypal-auth-algo': 'SHA256withRSA' };
  } else {
    body = JSON.stringify({ event: type, payload: current.refund ? { refund: { entity: current.refund } } : { payment: { entity: current.payment } } });
    headers = { 'x-razorpay-signature': crypto.createHmac('sha256', 'fixture').update(body).digest('hex'), 'x-razorpay-event-id': id };
  }
  return post(`/api/payment/webhook/${provider}`, body, headers);
};
const summary = async (creator, expected) => {
  const args = { referralId: creator._id, referralCode: creator.slug.current };
  const native = await earnings.fetchReferralEarnings({ client: commerce, ...args });
  const fallback = await earnings.fetchReferralEarnings({ client: { fetch: commerce.fetch.bind(commerce) }, ...args });
  assert.equal(native.total, expected, JSON.stringify({ native, fallback, expected }));
  assert.deepEqual(fallback, native);
  return { native, fallback };
};
const seed = async (provider, { amount = 54.95, rate = 10, booking = true, count = 5 } = {}) => {
  const key = `payout-${++sequence}`;
  const creator = await documents.create({
    _id: `referral.${key}`,
    _type: 'referral',
    name: key,
    slug: { _type: 'slug', current: key },
    registrationStatus: 'verified',
    currentCommissionPercent: rate,
    currentDiscountPercent: 0,
    successfulReferrals: count,
    backendOwner: 'supabase',
    cutoverGeneration: 0,
  });
  const packageDoc = await documents.create({ _id: `package.${key}`, _type: 'package', title: `Fixture ${key}`, price: `$${amount.toFixed(2)}` });
  const { resolvePaymentQuote } = await import('../src/server/api/ref/pricing.js');
  const quote = await resolvePaymentQuote({ packageTitle: packageDoc.title, referralCode: key, client: commerce });
  const pricingSnapshot = { ...quote, grossAmount: quote.effectiveGrossAmount, netAmount: quote.effectiveNetAmount, commissionPercent: quote.effectiveCommissionPercent, commissionAmount: quote.commissionAmount, currency: 'USD' };
  const startTimeUTC = new Date(Date.UTC(2099, 0, sequence, 10)).toISOString();
  const record = await commerce.create({
    _id: `paymentRecord.${key}`,
    _type: 'paymentRecord',
    provider,
    backendOwner: 'supabase',
    cutoverGeneration: 0,
    status: booking ? 'booked' : 'abandoned',
    providerOrderId: `order-${key}`,
    providerPaymentId: `payment-${key}`,
    bookingId: booking ? `booking.${key}` : '',
    pricingSnapshot,
    pricingFingerprint: key,
    sessionScope: key,
    providerIdempotencyKey: key,
    sessionExpiresAt: '2099-01-01T10:00:00.000Z',
    bookingPayload: {
      packageTitle: packageDoc.title,
      email: 'customer@example.invalid',
      discord: 'fixture',
      specs: 'fixture computer',
      mainGame: 'fixture',
      referralCode: key,
      startTimeUTC,
      localTimeZone: 'Asia/Kolkata',
    },
    providerPublicData: {
      currency: 'USD',
      productId: 'pdt_fixture',
      environment: 'test_mode',
      totalAmount: Math.round(amount * 100),
      taxInclusive: false,
    },
    emailDispatch: { allSent: true },
  });
  if (booking) await commerce.create({
    _id: record.bookingId,
    _type: 'booking',
    backendOwner: 'supabase',
    cutoverGeneration: 0,
    status: 'captured',
    paymentProvider: provider,
    paymentRecordId: record._id,
    packageTitle: packageDoc.title,
    netAmount: amount,
    grossAmount: amount,
    commissionAmount: quote.commissionAmount,
    commissionPercent: quote.effectiveCommissionPercent,
    referralCode: key,
    referral: { _type: 'reference', _ref: creator._id },
    referralAccountingApplied: true,
    email: 'customer@example.invalid',
    currency: 'USD',
    paypalOrderId: provider === 'paypal' ? record.providerOrderId : '',
    razorpayOrderId: provider === 'razorpay' ? record.providerOrderId : '',
    razorpayPaymentId: provider === 'razorpay' ? record.providerPaymentId : '',
    ...(provider === 'dodo' ? {
      dodoPaymentId: record.providerPaymentId,
      dodoCheckoutSessionId: record.providerOrderId,
      dodoTotalAmount: amount,
    } : {}),
  });
  const payment = provider === 'dodo'
    ? { payment_id: record.providerPaymentId, checkout_session_id: record.providerOrderId, metadata: { paymentRecordId: record._id }, status: 'succeeded', currency: 'USD', total_amount: Math.round(amount * 100), tax: 0, product_cart: [{ product_id: 'pdt_fixture', quantity: 1 }], disputes: [], refunds: [], refund_status: null }
    : { id: record.providerPaymentId, order_id: record.providerOrderId, amount: Math.round(amount * 100), currency: 'USD', status: 'captured', captured: true, amount_refunded: 0, refund_status: null };
  current = { key, creator, packageDoc, quote, record, payment };
  states.push(current);
  return current;
};
const dispute = status => ({ dispute_id: `dispute-${current.key}`, payment_id: current.payment.payment_id, currency: 'USD', amount: current.payment.total_amount, dispute_status: status, dispute_stage: 'dispute' });
const countIs = async expected => { assert.equal((await documents.getDocument(current.creator._id)).successfulReferrals, expected); };
const run = async (name, fn) => {
  if (process.env.ROO_PAYOUT_CASE && !name.includes(process.env.ROO_PAYOUT_CASE)) return;
  const start = Date.now();
  try {
    const proof = await fn();
    const record = await read(current.record._id);
    const booking = record?.bookingId ? await read(record.bookingId) : null;
    if (booking) {
      const [typed] = await sql`select booking_payload, status from commerce.bookings where legacy_sanity_id=${booking._id}`;
      assert.deepEqual(typed.booking_payload, booking);
      assert.equal(typed.status, booking.status);
      proof.typedBooking = typed;
    }
    evidence.scenarios.push({ name, passed: true, proof });
  }
  catch (error) {
    await Promise.allSettled([...inFlight]);
    evidence.scenarios.push({
      name,
      passed: false,
      error: error.stack,
      current: current && {
        record: await read(current.record._id),
        booking: await read((await read(current.record._id))?.bookingId),
        creator: await documents.getDocument(current.creator._id),
      },
    });
    process.exitCode = 1;
  }
  fixture.setRequestHook(null);
  console.log(`${name}: ${evidence.scenarios.at(-1).passed ? 'passed' : 'FAILED'} (${Date.now() - start}ms)`);
  fs.writeFileSync(artifact, JSON.stringify(evidence, null, 2));
};

try {
  const { createSweepPostgresFixture } = await import('./lib/sweep-postgres-fixture.mjs');
  fixture = await createSweepPostgresFixture({ fullMigrationChain: true, excludedMigrations: baseline ? ['20261023090000_preserve_frozen_creator_commissions.sql'] : [] });
  sql = fixture.sql;
  Object.assign(process.env, { SUPABASE_URL: fixture.origin, SUPABASE_SERVICE_ROLE_KEY: fixture.token, NEXT_PUBLIC_SUPABASE_URL: fixture.origin, NEXT_PUBLIC_SUPABASE_ANON_KEY: fixture.token });
  server = http.createServer((req, res) => {
    const pending = (async () => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        if (req.url.startsWith('/api/')) {
          const request = new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers, ...(body ? { body } : {}) });
          let response;
          if (req.url.startsWith('/api/payment/webhook/')) {
            const provider = req.url.split('/').at(-1);
            const route = await import(`../app/api/payment/webhook/${provider}/route.js`);
            response = await route.POST(request);
          } else {
            const action = req.url.split('/').at(-1);
            const { default: handler } = await import(`../src/server/api/payment/${action}.js`);
            const { runLegacyApiHandler } = await import('../src/lib/nextApiAdapter.js');
            response = await runLegacyApiHandler({ request, handler, methodOverride: 'POST' });
          }
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(await response.text());
          return;
        }
        const parts = req.url.split('/');
        const id = parts.at(-1) === 'refunds' ? parts.at(-2) : parts.at(-1);
        const state = states.find(value => [
          value.record.providerOrderId,
          value.record.providerPaymentId,
          value.payment.payment_id,
          value.payment.checkout_session_id,
          value.payment.id,
          value.payment.order_id,
        ].includes(id));
        let result;
        if (req.url === '/emails') result = { id: `email-${++eventSequence}` };
        else if (req.url === '/v1/oauth2/token') result = { access_token: 'fixture', expires_in: 3600 };
        else if (req.url === '/v1/notifications/verify-webhook-signature') result = { verification_status: 'SUCCESS' };
        else if (req.url.startsWith('/payments/')) result = state?.payment;
        else if (req.url.startsWith('/v1/payments/') && req.url.endsWith('/refunds')) result = { items: state?.refunds || [], count: (state?.refunds || []).length };
        else if (req.url.startsWith('/v1/payments/')) result = state?.payment;
        else if (req.url.startsWith('/v2/checkout/orders/')) result = {
          id: state?.record.providerOrderId,
          status: 'COMPLETED',
          purchase_units: [{
            amount: { value: state?.record.pricingSnapshot.netAmount.toFixed(2), currency_code: 'USD' },
            payments: { captures: [{
              id: state?.record.providerPaymentId,
              status: 'COMPLETED',
              amount: { value: state?.record.pricingSnapshot.netAmount.toFixed(2), currency_code: 'USD' },
            }] },
          }],
        };
        else if (req.url.startsWith('/v2/payments/refunds/')) result = refundsById.get(id);
        else if (req.url.startsWith('/checkouts/')) result = { session_id: state?.record.providerOrderId, payment_id: state?.record.providerPaymentId };
        else if (req.url === '/products/pdt_fixture') result = { product_id: 'pdt_fixture', is_recurring: false, price: { type: 'one_time_price', currency: 'USD', pay_what_you_want: true, tax_inclusive: false, purchasing_power_parity: false, discount: 0, price: 0 } };
        else if (req.url === '/checkouts') result = { session_id: current.record.providerOrderId, checkout_url: `https://test.checkout.dodopayments.com/session/${current.key}` };
        else throw new Error(`Unexpected fixture path ${req.url}`);
        assert.ok(result, `Missing provider fixture: ${req.url}`);
        responses.push({ path: req.url, body: structuredClone(result) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    })();
    inFlight.add(pending);
    pending.finally(() => inFlight.delete(pending));
  });
  server.listen(0, host); await once(server, 'listening'); origin = `http://${host}:${server.address().port}`;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const target = providerOrigins.has(url.origin) ? `${origin}${url.pathname}${url.search}` : url.href;
    assert.ok([origin, fixture.origin, fixture.postgrestUrl].includes(new URL(target).origin), `Nonlocal destination blocked: ${url.origin}`);
    return originalFetch(target, { ...init, redirect: 'error', signal: init?.signal || AbortSignal.timeout(120000) });
  };
  const { createSupabaseDocumentClient } = await import('../src/server/supabase/documentClient.js');
  commerce = createSupabaseDocumentClient({ shadowClient: fixture.client, commerceOnly: true, cutoverGeneration: 0 });
  documents = createSupabaseDocumentClient({ shadowClient: fixture.client });
  earnings = await import('../src/server/api/ref/payoutUtils.js');
  evidence.database = { postgres: fixture.postgresVersion, postgrest: fixture.postgrestVersion, migrations: fixture.manifest };

  await run('ROO-575-two-paid-zero-commissions', async () => {
    const first = await seed('dodo', { amount: 9.99, rate: 0.04, count: 0, booking: false });
    const creator = first.creator;
    assert.equal(first.quote.commissionAmount, 0);
    const saved = [];
    for (let index = 0; index < 2; index++) {
      if (index) {
        const second = await seed('dodo', { amount: 9.99, rate: 0.04, count: 0, booking: false });
        current.creator = creator;
        current.record = await commerce.patch(second.record._id).set({ pricingSnapshot: { ...second.record.pricingSnapshot, effectiveReferralId: creator._id, effectiveReferralCode: creator.slug.current }, bookingPayload: { ...second.record.bookingPayload, referralCode: creator.slug.current } }).commit();
      }
      const result = await webhook(); assert.equal(result.status, 200, JSON.stringify(result));
      const record = await read(current.record._id), booking = await read(record.bookingId);
      assert.equal(booking.commissionAmount, 0); saved.push(booking);
    }
    return { quote: first.quote, saved, earnings: await summary(creator, 0) };
  });

  await run('ROO-575-two-normal-checkouts-freeze-zero', async () => {
    const settingsId = '6d8a3646-0ed2-44b5-ad45-c5c9d578126a';
    await documents.create({ _id: settingsId, _type: 'bookingSettings', dateSlots: Array.from({ length: 31 }, (_, index) => ({ date: new Date(Date.UTC(2099, 0, index + 1)).toISOString().slice(0, 10), times: ['15:30'] })) });
    let creator;
    const bookings = [];
    for (let index = 0; index < 2; index++) {
      const state = await seed('dodo', { amount: 9.99, rate: 0.04, count: 0, booking: false });
      creator ||= state.creator;
      await commerce.delete(state.record._id);
      current.record = { ...state.record, providerOrderId: `checkout-${state.key}` };
      current.payment.checkout_session_id = current.record.providerOrderId;
      current.payment.payment_id = `captured-${state.key}`;
      const expiresAt = new Date(Date.now() + 1200000).toISOString();
      const hold = await commerce.create({ _id: `slotHold.${state.key}`, _type: 'slotHold', backendOwner: 'supabase', cutoverGeneration: 0, phase: 'holding', holdNonce: state.key, expiresAt, startTimeUTC: state.record.bookingPayload.startTimeUTC, packageTitle: state.packageDoc.title });
      const { issueHoldToken } = await import('../src/server/booking/holdToken.js');
      const bookingPayload = { ...state.record.bookingPayload, referralCode: creator.slug.current, slotHoldId: hold._id, slotHoldToken: issueHoldToken({ holdId: hold._id, startTimeUTC: hold.startTimeUTC, expiresAt, holdNonce: state.key, backend: 'supabase', cutoverGeneration: 0 }) };
      const { resolvePaymentQuote } = await import('../src/server/api/ref/pricing.js');
      const quote = await resolvePaymentQuote({ ...bookingPayload, client: commerce });
      const { buildQuoteFingerprint } = await import('../src/server/api/payment/paymentRecord.js');
      const started = await post('/api/payment/start', { provider: 'dodo', bookingPayload, quoteFingerprint: buildQuoteFingerprint({ bookingPayload, quote }) });
      assert.equal(started.status, 200, JSON.stringify(started));
      current.record = await commerce.fetch('*[_type == "paymentRecord" && providerOrderId == $id][0]', { id: state.record.providerOrderId });
      assert.ok(current.record?._id);
      current.payment.metadata.paymentRecordId = current.record._id;
      assert.equal(current.record.pricingSnapshot.commissionAmount, 0);
      assert.equal((await webhook()).status, 200);
      const record = await read(current.record._id), booking = await read(record.bookingId);
      assert.equal(booking.requiresReschedule, undefined);
      assert.equal(booking.commissionAmount, 0); bookings.push(booking);
    }
    return { bookings, earnings: await summary(creator, 0) };
  });

  for (const provider of ['paypal', 'razorpay']) await run(`ROO-508-${provider}-partial-retry-and-second-refund`, async () => {
    const state = await seed(provider);
    const send = async (amount, id) => {
      current.refund = provider === 'paypal' ? { id, status: 'COMPLETED', amount: { value: amount.toFixed(2), currency_code: 'USD' }, links: [{ rel: 'up', href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${state.record.providerPaymentId}` }] } : { id, payment_id: state.record.providerPaymentId, amount: Math.round(amount * 100), currency: 'USD', status: 'processed' };
      const response = await webhook(provider === 'paypal' ? 'PAYMENT.CAPTURE.REFUNDED' : 'refund.processed');
      assert.equal(response.status, 200, JSON.stringify(response));
    };
    await send(20, `refund-${state.key}-a`);
    const first = await read(state.record.bookingId);
    assert.equal(first.commissionAmount, cents(state.quote.commissionAmount * (1 - 20 / 54.95)));
    await send(20, `refund-${state.key}-a`);
    assert.equal((await read(first._id)).refundedAmount, 20);
    await send(5, `refund-${state.key}-b`);
    const booking = await read(first._id);
    assert.equal(booking.refundedAmount, 25);
    const expected = cents(state.quote.commissionAmount * (1 - 25 / 54.95));
    assert.equal(booking.commissionAmount, expected);
    return { first, booking, earnings: await summary(state.creator, expected) };
  });

  for (const provider of ['paypal', 'razorpay', 'dodo']) for (const rate of [10, 0.04]) await run(`ROO-520-${provider}-recovery-frozen-and-replayed-${rate}`, async () => {
    const state = await seed(provider, { booking: false, count: 0, rate, amount: rate === 10 ? 54.95 : 9.99 });
    await documents.patch(state.creator._id).set({ currentCommissionPercent: 1 }).commit();
    const type = provider === 'paypal' ? 'PAYMENT.CAPTURE.COMPLETED' : provider === 'razorpay' ? 'payment.captured' : 'payment.succeeded';
    const result = await webhook(type); assert.equal(result.status, 200, JSON.stringify(result));
    const record = await read(state.record._id), booking = await read(record.bookingId);
    assert.equal(booking.requiresReschedule, true);
    assert.equal(booking.commissionPercent, rate); assert.equal(booking.commissionAmount, state.quote.commissionAmount);
    assert.equal((await webhook(type)).status, 200); await countIs(1);
    return { booking, earnings: await summary(state.creator, state.quote.commissionAmount) };
  });

  for (const provider of ['paypal', 'razorpay', 'dodo']) for (const stored of ['missing', 'null']) await run(`ROO-520-legacy-recovery-${provider}-${stored}`, async () => {
    const state = await seed(provider, { booking: false, count: 0 });
    const pricingSnapshot = { ...state.record.pricingSnapshot };
    if (stored === 'null') pricingSnapshot.commissionAmount = null;
    else delete pricingSnapshot.commissionAmount;
    current.record = await commerce.patch(state.record._id).set({ pricingSnapshot }).commit();
    const type = provider === 'paypal' ? 'PAYMENT.CAPTURE.COMPLETED' : provider === 'razorpay' ? 'payment.captured' : 'payment.succeeded';
    assert.equal((await webhook(type)).status, 200);
    const booking = await read((await read(state.record._id)).bookingId);
    assert.equal(booking.requiresReschedule, true);
    assert.equal(booking.commissionPercent, 10);
    await countIs(1);
    return { booking, earnings: await summary(state.creator, 5.5) };
  });

  for (const stored of ['missing', 'null', 'zero']) await run(`ROO-520-legacy-partial-recovery-dodo-${stored}`, async () => {
    const state = await seed('dodo', { booking: false, count: 0 });
    const pricingSnapshot = { ...state.record.pricingSnapshot };
    if (stored === 'missing') delete pricingSnapshot.commissionAmount;
    else pricingSnapshot.commissionAmount = stored === 'null' ? null : 0;
    current.record = await commerce.patch(state.record._id).set({ pricingSnapshot }).commit();
    current.payment.refund_status = 'partial';
    current.payment.refunds = [{ refund_id: `refund-${state.key}`, payment_id: state.payment.payment_id, status: 'succeeded', currency: 'USD', amount: 2000 }];
    const response = await webhook();
    assert.equal(response.status, 200, JSON.stringify(response));
    const booking = await read((await read(state.record._id)).bookingId);
    assert.equal(booking.dodoOriginalCommissionAmount, stored === 'zero' ? 0 : 5.5);
    assert.equal(booking.refundedAmount, 20);
    const expected = stored === 'zero' ? 0 : 3.5;
    assert.equal(booking.commissionAmount, expected);
    assert.equal((await webhook()).status, 200);
    await countIs(1);
    return { booking, earnings: await summary(state.creator, expected) };
  });

  for (const provider of ['paypal', 'razorpay']) await run(`ROO-508-legacy-partial-refund-${provider}`, async () => {
    const state = await seed(provider);
    const pricingSnapshot = { ...state.record.pricingSnapshot };
    delete pricingSnapshot.commissionAmount;
    current.record = await commerce.patch(state.record._id).set({ pricingSnapshot }).commit();
    await commerce.patch(state.record.bookingId).unset(['commissionAmount']).commit();
    current.refund = provider === 'paypal'
      ? { id: `refund-${state.key}`, status: 'COMPLETED', amount: { value: '20.00', currency_code: 'USD' }, links: [{ rel: 'up', href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${state.record.providerPaymentId}` }] }
      : { id: `refund-${state.key}`, payment_id: state.record.providerPaymentId, amount: 2000, currency: 'USD', status: 'processed' };
    const type = provider === 'paypal' ? 'PAYMENT.CAPTURE.REFUNDED' : 'refund.processed';
    const response = await webhook(type);
    assert.equal(response.status, 200, JSON.stringify(response));
    const booking = await read(state.record.bookingId);
    assert.equal(booking.originalCommissionAmount, 5.5);
    assert.equal(booking.commissionAmount, 3.5);
    assert.equal((await webhook(type)).status, 200);
    return { booking, earnings: await summary(state.creator, 3.5) };
  });

  for (const provider of ['paypal', 'razorpay']) await run(`ROO-508-${provider}-failed-sync-cron-and-concurrent-refunds`, async () => {
    const state = await seed(provider);
    const send = async (amount, id) => {
      current.refund = provider === 'paypal' ? { id, status: 'COMPLETED', amount: { value: amount.toFixed(2), currency_code: 'USD' }, links: [{ rel: 'up', href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${state.record.providerPaymentId}` }] } : { id, payment_id: state.record.providerPaymentId, amount: Math.round(amount * 100), currency: 'USD', status: 'processed' };
      return webhook(provider === 'paypal' ? 'PAYMENT.CAPTURE.REFUNDED' : 'refund.processed');
    };
    let blocked = false;
    fixture.setRequestHook(async (phase, request) => {
      if (phase === 'before' && request.body?.p_mutations?.some(mutation => mutation.document?._id === state.record.bookingId && mutation.document.refundStatus === 'partial')) {
        blocked = true; throw new Error('Synthetic booking synchronization failure');
      }
    });
    const firstResponse = await send(20, `refund-${state.key}-a`);
    assert.equal(blocked, true); assert.equal((await read(state.record.bookingId)).commissionAmount, 5.5);
    assert.equal((await read(state.record._id)).refundRequiresBookingSync, true);
    fixture.setRequestHook(null);
    const reconciled = await post('/api/payment/reconcile', {}, { authorization: 'Bearer fixture' });
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled));
    assert.equal((await read(state.record.bookingId)).commissionAmount, 3.5);
    const concurrent = await Promise.all([send(5, `refund-${state.key}-b`), send(10, `refund-${state.key}-c`)]);
    await send(5, `refund-${state.key}-b`); await send(10, `refund-${state.key}-c`);
    const afterConcurrent = await read(state.record._id);
    const retried = await post('/api/payment/reconcile', {}, { authorization: 'Bearer fixture' });
    assert.equal(retried.status, 200, JSON.stringify(retried));
    const booking = await read(state.record.bookingId);
    assert.equal(booking.refundedAmount, 35);
    assert.equal((await read(state.record._id)).refundRequiresBookingSync, false);
    const expected = cents(5.5 * (1 - 35 / 54.95));
    assert.equal(booking.commissionAmount, expected);
    return { blocked, firstResponse, concurrent, afterConcurrent, retried, booking, earnings: await summary(state.creator, expected) };
  });

  for (const lost of ['dispute_lost', 'dispute_accepted', 'dispute_expired']) for (const restored of ['dispute_won', 'dispute_cancelled']) await run(`ROO-509-${lost}-${restored}`, async () => {
    const state = await seed('dodo');
    current.payment.disputes = [dispute(lost)];
    assert.equal((await webhook(`dispute.${lost.replace('dispute_', '')}`)).status, 200); await countIs(4);
    assert.equal((await webhook(`dispute.${lost.replace('dispute_', '')}`)).status, 200); await countIs(4);
    await summary(state.creator, 0);
    current.payment.disputes = [dispute(restored)];
    assert.equal((await webhook(`dispute.${restored.replace('dispute_', '')}`)).status, 200); await countIs(5);
    assert.equal((await webhook(`dispute.${restored.replace('dispute_', '')}`)).status, 200); await countIs(5);
    return { booking: await read(state.record.bookingId), creator: await documents.getDocument(state.creator._id), earnings: await summary(state.creator, 5.5) };
  });

  for (const outcome of ['full-refund', 'admin-cancel', 'second-dispute', 'write-conflict']) await run(`ROO-509-${outcome}`, async () => {
    const state = await seed('dodo');
    let conflict = false;
    if (outcome === 'write-conflict') fixture.setRequestHook(async (phase, request) => {
      if (phase !== 'before' || conflict || !request.body?.p_mutations?.some(mutation => mutation.document?._id === state.record.bookingId && mutation.document.dodoDisputeActive === true)) return;
      conflict = true; fixture.setRequestHook(null);
      await documents.patch(state.creator._id).inc({ successfulReferrals: 1 }).commit();
    });
    current.payment.disputes = [dispute('dispute_lost')];
    let response = await webhook('dispute.lost');
    if (outcome === 'write-conflict') {
      assert.equal(conflict, true); assert.ok(response.status >= 400);
      assert.equal((await read(state.record.bookingId)).dodoDisputeActive, undefined);
      await countIs(6); response = await webhook('dispute.lost');
    }
    assert.equal(response.status, 200, JSON.stringify(response)); await countIs(outcome === 'write-conflict' ? 5 : 4);
    if (outcome === 'full-refund') {
      current.payment.refund_status = 'full';
      current.payment.refunds = [{ refund_id: `refund-${state.key}`, payment_id: state.payment.payment_id, status: 'succeeded', currency: 'USD', amount: state.payment.total_amount }];
      assert.equal((await webhook('refund.succeeded')).status, 200); await countIs(4);
    }
    if (outcome === 'admin-cancel') await commerce.patch(state.record.bookingId).set({ status: 'cancelled' }).commit();
    current.payment.disputes = [dispute('dispute_won')];
    if (outcome === 'second-dispute') current.payment.disputes.push({ ...dispute('dispute_challenged'), dispute_id: 'second-dispute' });
    assert.equal((await webhook('dispute.won')).status, 200);
    await countIs(outcome === 'write-conflict' ? 6 : 4);
    if (outcome === 'second-dispute') {
      current.payment.disputes[1].dispute_status = 'dispute_cancelled';
      assert.equal((await webhook('dispute.cancelled')).status, 200); await countIs(5);
    }
    const booking = await read(state.record.bookingId);
    if (outcome === 'full-refund') assert.equal(booking.status, 'refunded');
    if (outcome === 'admin-cancel') assert.equal(booking.status, 'cancelled');
    return { conflict, booking, earnings: await summary(state.creator, ['full-refund', 'admin-cancel'].includes(outcome) ? 0 : 5.5) };
  });

  await run('ROO-509-open-partial-refund-then-won', async () => {
    const state = await seed('dodo');
    for (const status of ['dispute_opened', 'dispute_challenged']) {
      current.payment.disputes = [dispute(status)];
      assert.equal((await webhook(`dispute.${status.replace('dispute_', '')}`)).status, 200); await countIs(5); await summary(state.creator, 0);
    }
    current.payment.refund_status = 'partial';
    current.payment.refunds = [{ refund_id: `refund-${state.key}`, payment_id: state.payment.payment_id, status: 'succeeded', currency: 'USD', amount: 2000 }];
    assert.equal((await webhook('refund.succeeded')).status, 200);
    assert.equal((await read(state.record.bookingId)).commissionAmount, 0);
    current.payment.disputes = [dispute('dispute_won')];
    assert.equal((await webhook('dispute.won')).status, 200); await countIs(5);
    return { booking: await read(state.record.bookingId), earnings: await summary(state.creator, cents(5.5 * (1 - 20 / 54.95))) };
  });

  await run('ROO-575-explicit-zero-and-legacy-rounding-rebuilds', async () => {
    const state = await seed('dodo', { amount: 12.51 });
    await commerce.patch(state.record.bookingId).set({ commissionAmount: 0 }).commit();
    await summary(state.creator, 0);
    const second = await seed('dodo', { amount: 12.51, rate: 0.04 });
    await commerce.patch(second.record.bookingId).set({ referral: { _type: 'reference', _ref: state.creator._id }, referralCode: state.creator.slug.current }).commit();
    for (const original of [null, 'missing']) {
      for (const id of [state.record.bookingId, second.record.bookingId]) {
        const patch = commerce.patch(id).set({ commissionPercent: 0.04 });
        await (original === null ? patch.set({ commissionAmount: null }) : patch.unset(['commissionAmount'])).commit();
      }
      await summary(state.creator, 0.02);
    }
    for (const rpc of ['roo_project_operational_shadow', 'roo_refresh_operational_shadow']) {
      const result = await fixture.client.rpc(rpc); assert.equal(result.error, null);
      await summary(state.creator, 0.02);
    }
    return { earnings: await summary(state.creator, 0.02), rebuilds: ['original', 'current'] };
  });

  for (const [label, amount, expected] of [['null', null, 1], ['missing', undefined, 1], ['empty', '', 1], ['invalid', 'invalid', 1], ['zero', 0, 0]]) await run(`ROO-575-retained-dodo-original-${label}`, async () => {
    const state = await seed('dodo', { amount: 9.99 });
    let patch = commerce.patch(state.record.bookingId).set({ dodoOriginalCommissionAmount: 1 });
    patch = amount === undefined ? patch.unset(['commissionAmount']) : patch.set({ commissionAmount: amount });
    await patch.commit();
    return { booking: await read(state.record.bookingId), earnings: await summary(state.creator, expected) };
  });

  await run('ROO-575-legacy-rounding-before-sum', async () => {
    const first = await seed('dodo', { amount: 12.51, rate: 0.04 });
    const second = await seed('dodo', { amount: 12.51, rate: 0.04 });
    await commerce.patch(first.record.bookingId).unset(['commissionAmount']).commit();
    await commerce.patch(second.record.bookingId).set({
      commissionAmount: null,
      referral: { _type: 'reference', _ref: first.creator._id },
      referralCode: first.creator.slug.current,
    }).commit();
    return { bookings: [await read(first.record.bookingId), await read(second.record.bookingId)], earnings: await summary(first.creator, 0.02) };
  });

  await run('all-payouts-projection-rebuilds', async () => {
    const snapshot = async () => ({
      bookings: await sql`select legacy_sanity_id, booking_payload, status from commerce.bookings order by legacy_sanity_id`,
      creators: await sql`select legacy_sanity_id, payload from migration.source_documents where document_type='referral' and tombstoned=false order by legacy_sanity_id`,
      earnings: await sql`select legacy_sanity_id, public.roo_referral_earnings_summary(legacy_sanity_id, payload#>>'{slug,current}') as earnings from migration.source_documents where document_type='referral' and tombstoned=false order by legacy_sanity_id`,
    });
    const before = await snapshot();
    const after = {};
    for (const rpc of ['roo_project_operational_shadow', 'roo_refresh_operational_shadow']) {
      assert.equal((await fixture.client.rpc(rpc)).error, null);
      after[rpc] = await snapshot(); assert.deepEqual(after[rpc], before);
    }
    return { before, after };
  });
} catch (error) { evidence.fatal = error.stack; process.exitCode = 1; }
finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (fixture) {
    evidence.databaseRequests = fixture.requestLog;
    await fixture.stop();
  }
  evidence.providerResponses = responses;
  if (!evidence.fatal && evidence.scenarios.length === 0) { evidence.fatal = 'No payout scenarios selected'; process.exitCode = 1; }
  fs.writeFileSync(artifact, JSON.stringify(evidence, null, 2));
  console.log(artifact);
}
