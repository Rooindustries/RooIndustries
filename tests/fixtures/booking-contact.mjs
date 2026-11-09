import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { installNetworkGuard, refuseEnvFiles } from '../../scripts/lib/test-target-safety.mjs';
import { portFromEnv } from '../../scripts/lib/free-tcp-port.mjs';

export async function createBookingContactFixture({
  artifactName = 'booking-contact', sourceRoot = new URL('../../src/', import.meta.url),
} = {}) {
  refuseEnvFiles();
  const host = process.env.ROO_TEST_HOST || '127.0.0.1';
  const requested = portFromEnv('BOOKING_CONTACT_PORT');
  const server = http.createServer();
  let base, origins;
  Object.assign(process.env, {
    NODE_ENV: 'test', VERCEL_ENV: 'development', ALLOW_LIVE_PAYMENTS: '0',
    ALLOW_LIVE_PAYMENTS_IN_DEVELOPMENT: '0', DATA_PRIMARY_BACKEND: 'supabase',
    COMMERCE_PRIMARY_BACKEND: 'supabase', COMMERCE_FAILOVER_GENERATION: '0',
    DODO_PAYMENTS_ENVIRONMENT: 'test_mode', DODO_PAYMENTS_API_KEY: 'fixture-only',
    DODO_PAYMENTS_WEBHOOK_KEY: 'whsec_Zml4dHVyZS1vbmx5',
    DODO_PAYMENTS_PRODUCT_ID: 'pdt_fixture',
    PAYMENT_SESSION_SECRET: 'fixture-only-payment-session', HOLD_TOKEN_SECRET: 'fixture-only-hold',
    CRON_SECRET: 'fixture-only-cron', REF_ADMIN_KEY: 'fixture-only-admin',
    REF_SESSION_SECRET: 'fixture-only-ref-session', RESEND_API_KEY: 're_fixture',
    FROM_EMAIL: 'noreply@example.invalid', OWNER_EMAIL: 'owner@example.invalid',
  });
  registerHooks({ resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      if (specifier === 'next/server') return nextResolve('next/server.js', context);
      if (!specifier.startsWith('.') || !context.parentURL?.startsWith('file:')) throw error;
      for (const suffix of ['.js', '.ts', '/index.js']) {
        const candidate = new URL(`${specifier}${suffix}`, context.parentURL);
        if (fs.existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
      throw error;
    }
  } });

  const evidence = { livePayments: false, cases: [], http: [], providerRequests: [], blocked: [] };
  assert.match(artifactName, /^[a-z0-9-]+$/);
  const artifact = new URL(`../../test-results/${artifactName}/results.json`, import.meta.url);
  const save = () => {
    fs.mkdirSync(new URL('.', artifact), { recursive: true });
    fs.writeFileSync(artifact, JSON.stringify(evidence, null, 2));
  };
  let originalFetch;
  let database;
  const stop = async () => {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    if (database) await database.stop();
    if (originalFetch) globalThis.fetch = originalFetch;
    evidence.stopped = true;
    save();
  };

  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requested, host, resolve); });
    base = `http://${host}:${server.address().port}`;
    process.env.DODO_PAYMENTS_RETURN_URL = `${base}/handoff`;
    const { createSweepPostgresFixture } = await import('../../scripts/lib/sweep-postgres-fixture.mjs');
    database = await createSweepPostgresFixture({
      fullMigrationChain: true,
      excludedMigrations: (process.env.ROO_TEST_EXCLUDED_MIGRATIONS || '').split(',').filter(Boolean),
      ports: requested ? { proxy: requested + 1, postgres: requested + 2, rest: requested + 3 } : {},
      pgBin: process.env.PG_BIN || execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(),
      postgrestBin: process.env.POSTGREST_BIN || 'postgrest',
    });
    origins = [base, database.origin, database.postgrestUrl, `http://${host}:${database.pgPort}`];
    installNetworkGuard(origins);
    originalFetch = globalThis.fetch;
    evidence.database = {
      version: database.postgresVersion, postgrest: database.postgrestVersion,
      migrations: database.manifest.length,
      excludedMigrations: (process.env.ROO_TEST_EXCLUDED_MIGRATIONS || '').split(',').filter(Boolean),
    };
    Object.assign(process.env, {
      SUPABASE_URL: database.origin, SUPABASE_SERVICE_ROLE_KEY: database.token,
      NEXT_PUBLIC_SUPABASE_URL: database.origin, NEXT_PUBLIC_SUPABASE_ANON_KEY: database.token,
    });
    const sessions = new Map();
    const paymentRefunds = new Map();
    let paymentTax = 0;
    let paymentTaxInclusive = false;
    let paymentAmountOverrides = {};
    let emailFailure = false;
    let checkoutPaymentStarted = true;
    let providerLookupFailure = false;
    database.setProviderHandler(async request => {
      if (request.path === '/emails') {
        request.bookings = await database.sql`select legacy_sanity_id as id, payload->>'status' as status
          from migration.source_documents where document_type = 'booking' and not tombstoned
          and position('>' || legacy_sanity_id || '<' in ${request.body.html || ''}) > 0`;
      }
      evidence.providerRequests.push(request);
      if (request.path === '/products/pdt_fixture') return { body: {
        product_id: 'pdt_fixture', is_recurring: false,
        price: { type: 'one_time_price', currency: 'USD', pay_what_you_want: true,
          tax_inclusive: false, purchasing_power_parity: false, discount: 0, price: 0 },
      } };
      if (request.path === '/checkouts' && request.method === 'POST') {
        const id = `session_fixture_${sessions.size + 1}`;
        sessions.set(id, request.body);
        return { body: { session_id: id, checkout_url: `https://test.checkout.dodopayments.com/session/${id}` } };
      }
      if (providerLookupFailure && request.method === 'GET' &&
          (request.path.startsWith('/checkouts/') || request.path.startsWith('/payments/'))) {
        return { status: 503, body: { message: 'Synthetic provider outage' } };
      }
      if (request.path.startsWith('/checkouts/')) {
        const id = request.path.split('/').at(-1);
        return { body: { id, payment_id: checkoutPaymentStarted ? `payment_${id}` : null } };
      }
      if (request.path.startsWith('/payments/')) {
        const paymentId = request.path.split('/').at(-1);
        const id = paymentId.replace(/^payment_/, '');
        const session = sessions.get(id);
        assert.ok(session, 'Unknown synthetic payment');
        const refunds = paymentRefunds.get(paymentId) || [];
        const settled = refunds.filter(refund => refund.status === 'succeeded').reduce((sum, refund) => sum + refund.amount, 0);
        const total = session.product_cart[0].amount + (paymentTaxInclusive ? 0 : paymentTax);
        return { body: {
          payment_id: paymentId, checkout_session_id: id, metadata: session.metadata,
          status: 'succeeded', total_amount: total, tax: paymentTax, currency: 'USD',
          product_cart: session.product_cart, refunds, disputes: [], refund_status: settled >= total ? 'full' : settled > 0 ? 'partial' : null,
          customer: session.customer,
          ...paymentAmountOverrides,
        } };
      }
      if (request.path === '/emails') return emailFailure
        ? { status: 429, body: { name: 'rate_limit_exceeded', message: 'Synthetic email failure' } }
        : { body: { id: `email_fixture_${evidence.providerRequests.length}` } };
      throw new Error(`Unhandled local provider request ${request.path}`);
    });
    const providerOrigins = new Set(['https://test.dodopayments.com', 'https://api.resend.com']);
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (providerOrigins.has(url.origin)) {
        return originalFetch(`${database.origin}/provider${url.pathname}${url.search}`, init);
      }
      if (!origins.includes(url.origin)) evidence.blocked.push(url.origin);
      return originalFetch(input, init);
    };

    const { createSupabaseDocumentClient } = await import('../../src/server/supabase/documentClient.js');
    const commerce = createSupabaseDocumentClient({ shadowClient: database.client, commerceOnly: true, cutoverGeneration: 0 });
    const content = createSupabaseDocumentClient({ shadowClient: database.client });
    const { runLegacyApiHandler } = await import('../../src/lib/nextApiAdapter.js');
    const handlers = new Map();
    for (const [route, module] of Object.entries({
      '/api/holdSlot': 'server/booking/holdSlot.js',
      '/api/bookingAvailability': 'server/booking/availability.js',
      '/api/payment/start': 'server/api/payment/start.js',
      '/api/payment/quote': 'server/api/payment/quote.js',
      '/api/payment/finalize': 'server/api/payment/finalize.js',
      '/api/payment/status': 'server/api/payment/status.js',
      '/api/payment/cancel': 'server/api/payment/cancel.js',
      '/api/payment/reconcile': 'server/api/payment/reconcile.js',
      '/api/payment/webhook/dodo': 'server/api/payment/webhookDodo.js',
      '/api/ref/getUpgradeInfo': 'server/api/ref/getUpgradeInfo.js',
      '/api/ref/updateBookingStatus': 'server/api/ref/updateBookingStatus.js',
      '/api/ref/createBooking': 'server/api/ref/createBooking.js',
      '/api/ref/sendBookingEmails': 'server/api/ref/sendBookingEmails.js',
    })) handlers.set(route, (await import(new URL(module, sourceRoot))).default);
    server.on('request', async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        const url = new URL(req.url, base);
        const handler = handlers.get(url.pathname);
        if (!handler) { res.writeHead(404); res.end(); return; }
        const request = new Request(url, { method: req.method, headers: req.headers,
          ...(req.method === 'GET' ? {} : { body: raw }) });
        const response = await runLegacyApiHandler({ request, handler });
        const body = await response.text();
        evidence.http.push({ path: url.pathname, request: raw.length ? JSON.parse(raw) : null,
          status: response.status, response: body ? JSON.parse(body) : null });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(body);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    const dateSlots = Array.from({ length: 240 }, (_, index) => ({
      date: new Date(Date.UTC(2099, 0, index + 1)).toISOString().slice(0, 10), times: ['10:00'],
    }));
    for (const [index, title] of ['Vertex Essentials', 'Performance Vertex Overhaul', 'Performance Vertex Max'].entries()) {
      await content.create({ _id: `package.fixture.${index}`, _type: 'package', title,
        price: ['$29.95', '$54.95', '$99.95'][index] });
    }
    await content.create({ _id: '6d8a3646-0ed2-44b5-ad45-c5c9d578126a', _type: 'bookingSettings',
      dateSlots, xocDateSlots: dateSlots, vertexEssentialsDateSlots: dateSlots, ownerEmail: 'owner@example.invalid' });
    for (const [id, code, discountPercent] of [['free', 'FIXTUREFREE', 100], ['paid', 'FIXTUREPAID', 10]]) {
      await commerce.create({ _id: `coupon.fixture.${id}`, _type: 'coupon', code, isActive: true,
        discountType: 'percent', discountPercent, canCombineWithReferral: true,
        timesUsed: 0, activeReservations: 0, maxUses: 0, backendOwner: 'supabase', cutoverGeneration: 0 });
    }
    const post = async (route, body, token = '', headers = {}) => {
      globalThis.__rooRateLimitBuckets?.clear();
      const response = await fetch(`${base}${route}`, { method: 'POST', headers: {
        'content-type': 'application/json', origin: base,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    let nextDate = 0;
    const details = {
      email: 'visitor@example.invalid', discord: 'fixture_visitor', specs: 'Ryzen 7700 / RTX 4070',
      mainGame: 'CS2', message: 'Fixture booking', localTimeZone: 'Asia/Kolkata',
    };
    const hold = async (changes = {}) => {
      const startTimeUTC = `${dateSlots[nextDate++].date}T04:30:00.000Z`;
      const response = await post('/api/holdSlot', { startTimeUTC, packageTitle: changes.packageTitle || 'Vertex Essentials' });
      assert.equal(response.status, 200, JSON.stringify(response));
      return { packageTitle: 'Vertex Essentials', ...details, startTimeUTC,
        slotHoldId: response.body.holdId, slotHoldToken: response.body.holdToken,
        deferEmailsUntilConfirmation: true, ...changes };
    };
    const start = async (bookingPayload, provider = 'dodo') => {
      const quote = await post('/api/payment/quote', { bookingPayload });
      assert.equal(quote.status, 200, JSON.stringify(quote));
      return post('/api/payment/start', { provider, bookingPayload, quoteFingerprint: quote.body.quoteFingerprint });
    };
    const snapshot = async () => {
      const tables = {};
      for (const table of ['payment_records', 'payment_start_claims', 'payment_upgrade_locks',
        'slot_holds', 'coupons', 'coupon_redemptions', 'bookings']) {
        tables[table] = await database.sql.unsafe(`select to_jsonb(t) as row from commerce.${table} t order by to_jsonb(t)::text`);
      }
      return {
        documents: await database.sql`select legacy_sanity_id,payload,source_revision,tombstoned
          from migration.source_documents order by legacy_sanity_id`,
        tables,
        commands: await database.sql`select command_id from migration.commerce_commands order by command_id`,
        providerRequests: evidence.providerRequests.length,
      };
    };
    const recordFor = async bookingPayload => commerce.fetch(
      '*[_type == "paymentRecord" && bookingPayload.slotHoldId == $id][0]', { id: bookingPayload.slotHoldId });
    const seedUpgrade = async (changes = {}) => {
      const original = { _id: `booking.fixture.upgrade.${nextDate++}`, _type: 'booking',
        backendOwner: 'supabase', cutoverGeneration: 0, packageTitle: 'Performance Vertex Overhaul',
        packagePrice: '$54.95', grossAmount: 54.95, netAmount: 54.95, paymentProvider: 'paypal',
        paypalOrderId: `order_fixture_${nextDate}`, status: 'captured', ...details,
        startTimeUTC: `${dateSlots[nextDate - 1].date}T04:30:00.000Z`,
        displayDate: 'Legacy date', displayTime: '10:00 AM', ...changes };
      const paymentRecordId = `paymentRecord.${original._id}`;
      original.paymentRecordId = paymentRecordId;
      await commerce.create(original);
      await commerce.create({ _id: paymentRecordId, _type: 'paymentRecord',
        backendOwner: 'supabase', cutoverGeneration: 0, provider: 'paypal', status: 'booked',
        verificationState: 'server_verified', bookingId: original._id,
        providerOrderId: original.paypalOrderId, providerPaymentId: `capture_${original._id}`,
        pricingSnapshot: { currency: 'USD', grossAmount: 54.95, netAmount: 54.95 },
        providerPublicData: { currency: 'USD', totalAmount: 5495, taxAmount: 0, taxInclusive: false },
      });
      const lookup = await post('/api/ref/getUpgradeInfo', { id: original._id, email: original.email });
      assert.equal(lookup.status, 200, JSON.stringify(lookup));
      return { original, payload: { originalOrderId: original._id, packageTitle: lookup.body.targetPackage.title,
        email: original.email, upgradeIntentToken: lookup.body.upgradeIntentToken,
        deferEmailsUntilConfirmation: true } };
    };
    const setPaymentTax = amount => {
      assert.ok(Number.isSafeInteger(amount) && amount >= 0);
      paymentTax = amount;
    };
    const setPaymentTaxInclusive = value => {
      assert.equal(typeof value, 'boolean');
      paymentTaxInclusive = value;
    };
    const setPaymentAmountOverrides = values => {
      const knownKeys = ['tax', 'total_amount', 'status', 'disputes', 'refund_status'];
      assert.ok(Object.keys(values).every(key => knownKeys.includes(key)));
      paymentAmountOverrides = { ...values };
    };
    const dodoWebhook = async (paymentId, type, eventId) => {
      const body = { business_id: 'business_fixture', type,
        timestamp: new Date().toISOString(), data: { payment_id: paymentId } };
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', Buffer.from('fixture-only'))
        .update(`${eventId}.${timestamp}.${JSON.stringify(body)}`).digest('base64');
      return post('/api/payment/webhook/dodo', body, '', {
        'webhook-id': eventId, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}`,
      });
    };
    const refundPayment = async (paymentId, refunds, eventId) => {
      paymentRefunds.set(paymentId, refunds);
      return dodoWebhook(paymentId, 'refund.succeeded', eventId);
    };
    return { post, start, hold, snapshot, recordFor, seedUpgrade, commerce, database, details, evidence, save, stop,
      setPaymentTax, setPaymentTaxInclusive, setPaymentAmountOverrides, refundPayment, dodoWebhook,
      resetPayments: () => database.sql`update migration.source_documents
        set tombstoned = true where document_type = 'paymentRecord'`,
      setEmailFailure(value) { emailFailure = value; },
      setCheckoutPaymentStarted(value) { checkoutPaymentStarted = value; },
      setProviderLookupFailure(value) { providerLookupFailure = value; },
      availability: async () => {
        const response = await fetch(`${base}/api/bookingAvailability`, { headers: { origin: base } });
        return { status: response.status, body: await response.json() };
      },
      setRequestHook: database.setRequestHook };
  } catch (error) {
    await stop();
    throw error;
  }
}
