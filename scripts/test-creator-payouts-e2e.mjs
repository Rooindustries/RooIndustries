import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {once} from 'node:events';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const host = process.env.ROO_TEST_HOST || '127.0.0.1';
const originalFetch = globalThis.fetch;
const baseline = process.argv
  .find((value) => value.startsWith('--baseline='))
  ?.slice(11);
const sources = [
  'src/server/api/ref/payoutUtils.js',
  'src/server/api/ref/bookingRefunds.js',
  'src/server/api/ref/bookingCommit.js',
  'src/server/api/payment/flow.js',
  'src/server/api/payment/reconcile.js',
  'src/server/api/ref/pricing.js',
  'src/server/api/ref/createBooking.js',
  'src/server/api/ref/updatePayments.js',
  'src/server/api/ref/validateReferral.js',
  'src/server/api/ref/cronSyncAll.js',
  'src/server/api/ref/syncPayouts.js',
  'src/server/api/ref/payouts.js',
  'src/server/api/ref/couponReservations.js',
  'src/server/supabase/documentClient.js',
  'src/server/supabase/shadowStore.js',
  'src/server/commerce/store.js',
];
for (const source of [
  'src/server/referrals/commissionMoney.js',
  'src/server/referrals/disputeAccounting.js',
  'src/server/api/ref/couponAlerts.js',
]) {
  try {
    if (baseline) {
      execFileSync('git', ['cat-file', '-e', `${baseline}:${source}`], {
        stdio: 'ignore',
      });
    }
    sources.push(source);
  } catch (error) {
    if (error.status !== 128) throw error;
  }
}
const baselineSources = baseline
  ? Object.fromEntries(
      sources.map((file) => [
        new URL(`../${file}`, import.meta.url).href,
        execFileSync('git', ['show', `${baseline}:${file}`], {
          encoding: 'utf8',
        }),
      ])
    )
  : {};
const migrationPath =
  'supabase/migrations/20261023090000_preserve_frozen_creator_commissions.sql';
let baselineMigration;
if (baseline) {
  try {
    baselineMigration = execFileSync(
      'git',
      ['show', `${baseline}:${migrationPath}`],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}
    );
  } catch (error) {
    if (!/does not exist|exists on disk, but not in/.test(String(error.stderr)))
      throw error;
  }
}
let baselineRulesMigration;
if (baseline) {
  try {
    baselineRulesMigration = execFileSync('git', ['show', baseline + ':supabase/migrations/20261024000000_creator_money_rules.sql'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  } catch (error) {
    if (!/does not exist|exists on disk, but not in/.test(String(error.stderr))) throw error;
  }
}
for (const key of Object.keys(process.env)) {
  if (
    /^(SANITY|SUPABASE|PAYPAL|RAZORPAY|DODO|REACT_APP_|NEXT_PUBLIC_|ALLOW_LIVE_|RESEND|BOOKING_EMAIL|FROM_EMAIL|OWNER_EMAIL|DATA_|COMMERCE_|VERCEL_ENV|REF_SESSION|CRON_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy)/.test(
      key
    ) ||
    /SENTRY.*DSN/i.test(key)
  )
    delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: 'test',
  VERCEL_ENV: 'development',
  DATA_PRIMARY_BACKEND: 'supabase',
  COMMERCE_PRIMARY_BACKEND: 'supabase',
  COMMERCE_FAILOVER_GENERATION: '0',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_CLIENT_ID: 'fixture',
  PAYPAL_CLIENT_SECRET: 'fixture',
  PAYPAL_WEBHOOK_ID: 'fixture',
  RAZORPAY_KEY_ID: 'rzp_test_fixture',
  RAZORPAY_KEY_SECRET: 'fixture',
  RAZORPAY_WEBHOOK_SECRET: 'fixture',
  PAYMENT_SESSION_SECRET: 'fixture',
  REF_SESSION_SECRET: 'fixture',
  CRON_SECRET: 'fixture',
  REF_ADMIN_KEY: 'fixture-admin',
  DODO_PAYMENTS_ENVIRONMENT: 'test_mode',
  DODO_PAYMENTS_API_KEY: 'fixture',
  DODO_PAYMENTS_WEBHOOK_KEY: `whsec_${Buffer.from('fixture').toString('base64')}`,
  DODO_PAYMENTS_PRODUCT_ID: 'pdt_fixture',
  DODO_PAYMENTS_RETURN_URL: 'https://example.invalid/payment',
  RESEND_API_KEY: 're_fixture',
  FROM_EMAIL: 'noreply@example.invalid',
  OWNER_EMAIL: 'owner@example.invalid',
});
registerHooks({
  load(url, context, next) {
    return baselineSources[url]
      ? {format: 'module', source: baselineSources[url], shortCircuit: true}
      : next(url, context);
  },
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier === 'next/server') return next('next/server.js', context);
      if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
        for (const suffix of ['.js', '.ts', '/index.js']) {
          const candidate = new URL(specifier + suffix, context.parentURL);
          if (fs.existsSync(fileURLToPath(candidate)))
            return next(candidate.href, context);
        }
      }
      throw error;
    }
  },
});
const artifact = path.resolve(
  process.env.ROO_CREATOR_PAYOUT_ARTIFACT || 'test-results/creator-payouts.json'
);
fs.mkdirSync(path.dirname(artifact), {recursive: true});
const evidence = {
  productionRequests: 0,
  sentryDsnVariables: Object.keys(process.env).filter((key) =>
    /SENTRY.*DSN/i.test(key)
  ),
  scenarios: [],
  limits: [
    'Synthetic provider HTTP and email responses; real route adapters, signatures, pricing, document mutations, PostgreSQL 17 and projections. No hosted auth, browser checkout or production data.',
  ],
};
assert.deepEqual(evidence.sentryDsnVariables, []);
evidence.source = {
  baseline: baseline || null,
  commit: execFileSync('git', ['rev-parse', baseline || 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  files: Object.fromEntries(
    sources.map((file) => [
      file,
      crypto
        .createHash('sha256')
        .update(
          baseline
            ? baselineSources[new URL(`../${file}`, import.meta.url).href]
            : fs.readFileSync(file)
        )
        .digest('hex'),
    ])
  ),
};
if (!baseline)
  for (const file of [
    'src/server/referrals/commissionMoney.js',
    'supabase/migrations/20261023090000_preserve_frozen_creator_commissions.sql',
    'supabase/migrations/20261024000000_creator_money_rules.sql',
    'src/server/referrals/bookingCommission.js',
    'src/server/api/ref/couponAlerts.js',
  ])
    evidence.source.files[file] = crypto
      .createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex');
if (baselineMigration)
  evidence.source.files[migrationPath] = crypto
    .createHash('sha256')
    .update(baselineMigration)
    .digest('hex');
let fixture, server, origin, commerce, documents, sql, earnings;
let current,
  sequence = 0,
  eventSequence = 0;
const responses = [];
const emailRequests = [];
let failCouponAlert = false;
let failCouponAlertKey = '';
let pauseCouponAlerts = false;
let abortedCouponAlerts = 0;
const pausedCouponAlerts = new Set();
const states = [];
const refundsById = new Map();
const inFlight = new Set();
const providerOrigins = new Set([
  'https://api-m.sandbox.paypal.com',
  'https://api.razorpay.com',
  'https://test.dodopayments.com',
  'https://api.resend.com',
]);
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === 'string' || input instanceof URL
      ? String(input)
      : input.url
  );
  assert.equal(
    url.protocol,
    'http:',
    `Nonlocal request blocked: ${url.origin}`
  );
  assert.equal(url.hostname, host);
  return originalFetch(input, {...init, redirect: 'error'});
};
const read = (id) => commerce.getDocument(id);
const cents = (value) => Math.round(value * 100) / 100;
const post = async (route, body, headers = {}) => {
  const response = await fetch(`${origin}${route}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', ...headers},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return {status: response.status, body: await response.json()};
};
const webhook = async (
  type = 'payment.succeeded',
  id = `event-${++eventSequence}`
) => {
  const provider = current.record.provider;
  if (current.refund) {
    refundsById.set(current.refund.id, structuredClone(current.refund));
    current.refunds = [...refundsById.values()].filter(
      (refund) => refund.payment_id === current.record.providerPaymentId
    );
  }
  let body, headers;
  if (provider === 'dodo') {
    body = JSON.stringify({
      business_id: 'fixture',
      type,
      timestamp: new Date().toISOString(),
      data: current.payment,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers = {
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${crypto.createHmac('sha256', 'fixture').update(`${id}.${timestamp}.${body}`).digest('base64')}`,
    };
  } else if (provider === 'paypal') {
    body = JSON.stringify({
      id,
      event_type: type,
      resource: current.refund || {
        id: current.record.providerPaymentId,
        supplementary_data: {
          related_ids: {order_id: current.record.providerOrderId},
        },
      },
    });
    headers = {
      'paypal-transmission-id': id,
      'paypal-transmission-time': new Date().toISOString(),
      'paypal-transmission-sig': 'fixture',
      'paypal-cert-url': 'https://example.invalid/cert',
      'paypal-auth-algo': 'SHA256withRSA',
    };
  } else {
    body = JSON.stringify({
      event: type,
      payload: current.refund
        ? {refund: {entity: current.refund}}
        : {payment: {entity: current.payment}},
    });
    headers = {
      'x-razorpay-signature': crypto
        .createHmac('sha256', 'fixture')
        .update(body)
        .digest('hex'),
      'x-razorpay-event-id': id,
    };
  }
  return post(`/api/payment/webhook/${provider}`, body, headers);
};
const summary = async (creator, expected) => {
  const args = {referralId: creator._id, referralCode: creator.slug.current};
  const native = await earnings.fetchReferralEarnings({
    client: commerce,
    ...args,
  });
  const fallback = await earnings.fetchReferralEarnings({
    client: {fetch: commerce.fetch.bind(commerce)},
    ...args,
  });
  assert.equal(
    native.total,
    expected,
    JSON.stringify({native, fallback, expected})
  );
  assert.deepEqual(fallback, native);
  return {native, fallback};
};
const seed = async (
  provider,
  {
    amount = 54.95,
    rate = 10,
    booking = true,
    count = 5,
    discount = 0,
    coupon = 0,
  } = {}
) => {
  const key = `payout-${++sequence}`;
  const creator = await documents.create({
    _id: `referral.${key}`,
    _type: 'referral',
    name: key,
    slug: {_type: 'slug', current: key},
    registrationStatus: 'verified',
    currentCommissionPercent: rate,
    currentDiscountPercent: discount,
    successfulReferrals: count,
    backendOwner: 'supabase',
    cutoverGeneration: 0,
  });
  const packageDoc = await documents.create({
    _id: `package.${key}`,
    _type: 'package',
    title: `Fixture ${key}`,
    price: `$${amount.toFixed(2)}`,
  });
  const couponCode = coupon ? `coupon-${key}` : '';
  if (coupon)
    await documents.create({
      _id: `coupon.${key}`,
      _type: 'coupon',
      code: couponCode,
      isActive: true,
      canCombineWithReferral: true,
      discountType: 'percent',
      discountPercent: coupon,
    });
  const {resolvePaymentQuote} = await import(
    '../src/server/api/ref/pricing.js'
  );
  const quote = await resolvePaymentQuote({
    packageTitle: packageDoc.title,
    referralCode: key,
    couponCode,
    client: commerce,
  });
  const pricingSnapshot = {
    ...quote,
    grossAmount: quote.effectiveGrossAmount,
    netAmount: quote.effectiveNetAmount,
    commissionPercent: quote.effectiveCommissionPercent,
    commissionAmount: quote.commissionAmount,
    currency: 'USD',
  };
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
      couponCode,
      startTimeUTC,
      localTimeZone: 'Asia/Kolkata',
    },
    providerPublicData: {
      currency: 'USD',
      productId: 'pdt_fixture',
      environment: 'test_mode',
      totalAmount: Math.round(quote.effectiveNetAmount * 100),
      taxInclusive: false,
    },
    emailDispatch: {allSent: true},
  });
  if (booking)
    await commerce.create({
      _id: record.bookingId,
      _type: 'booking',
      backendOwner: 'supabase',
      cutoverGeneration: 0,
      status: 'captured',
      commissionCalculationVersion: 2,
      paymentProvider: provider,
      paymentRecordId: record._id,
      packageTitle: packageDoc.title,
      netAmount: quote.effectiveNetAmount,
      couponDiscountAmount: quote.couponDiscountAmount,
      grossAmount: amount,
      commissionAmount: quote.commissionAmount,
      commissionPercent: quote.effectiveCommissionPercent,
      referralCode: key,
      referral: {_type: 'reference', _ref: creator._id},
      referralAccountingApplied: true,
      email: 'customer@example.invalid',
      currency: 'USD',
      paypalOrderId: provider === 'paypal' ? record.providerOrderId : '',
      razorpayOrderId: provider === 'razorpay' ? record.providerOrderId : '',
      razorpayPaymentId:
        provider === 'razorpay' ? record.providerPaymentId : '',
      ...(provider === 'dodo'
        ? {
            dodoPaymentId: record.providerPaymentId,
            dodoCheckoutSessionId: record.providerOrderId,
            dodoTotalAmount: quote.effectiveNetAmount,
          }
        : {}),
    });
  const payment =
    provider === 'dodo'
      ? {
          payment_id: record.providerPaymentId,
          checkout_session_id: record.providerOrderId,
          metadata: {paymentRecordId: record._id},
          status: 'succeeded',
          currency: 'USD',
          total_amount: Math.round(quote.effectiveNetAmount * 100),
          tax: 0,
          product_cart: [{product_id: 'pdt_fixture', quantity: 1}],
          disputes: [],
          refunds: [],
          refund_status: null,
        }
      : {
          id: record.providerPaymentId,
          order_id: record.providerOrderId,
          amount: Math.round(quote.effectiveNetAmount * 100),
          currency: 'USD',
          status: 'captured',
          captured: true,
          amount_refunded: 0,
          refund_status: null,
        };
  current = {key, creator, packageDoc, quote, record, payment};
  states.push(current);
  return current;
};
const dispute = (status) => ({
  dispute_id: `dispute-${current.key}`,
  payment_id: current.payment.payment_id,
  currency: 'USD',
  amount: current.payment.total_amount,
  dispute_status: status,
  dispute_stage: 'dispute',
});
const startCheckout = async (state, email = 'customer@example.invalid') => {
  await commerce.delete(state.record._id);
  current.record = {...state.record, providerOrderId: `checkout-${state.key}`};
  current.payment.checkout_session_id = current.record.providerOrderId;
  current.payment.payment_id = `captured-${state.key}`;
  const startTimeUTC = state.record.bookingPayload.startTimeUTC;
  await documents.createOrReplace({
    _id: '6d8a3646-0ed2-44b5-ad45-c5c9d578126a', _type: 'bookingSettings',
    dateSlots: [{date: startTimeUTC.slice(0, 10), times: ['15:30']}],
  });
  const expiresAt = new Date(Date.now() + 1200000).toISOString();
  const hold = await commerce.create({
    _id: `slotHold.${state.key}`, _type: 'slotHold', backendOwner: 'supabase',
    cutoverGeneration: 0, phase: 'holding', holdNonce: state.key, expiresAt,
    startTimeUTC, packageTitle: state.packageDoc.title,
  });
  const {issueHoldToken} = await import('../src/server/booking/holdToken.js');
  const bookingPayload = {...state.record.bookingPayload, email,
    slotHoldId: hold._id, slotHoldToken: issueHoldToken({
      holdId: hold._id, startTimeUTC, expiresAt, holdNonce: state.key,
      backend: 'supabase', cutoverGeneration: 0,
    }),
  };
  const quote = await post('/api/payment/quote', {bookingPayload});
  assert.equal(quote.status, 200, JSON.stringify(quote));
  const started = await post('/api/payment/start', {
    provider: 'dodo', bookingPayload, quoteFingerprint: quote.body.quoteFingerprint,
  });
  assert.equal(started.status, 200, JSON.stringify(started));
  current.record = await commerce.fetch('*[_type == "paymentRecord" && providerOrderId == $id][0]', {id: current.record.providerOrderId});
  assert.ok(current.record?._id);
  current.payment.metadata.paymentRecordId = current.record._id;
  current.payment.total_amount = current.record.providerPublicData.totalAmount || Math.round(current.record.pricingSnapshot.netAmount * 100);
  return current.record;
};

const countIs = async (expected) => {
  assert.equal(
    (await documents.getDocument(current.creator._id)).successfulReferrals,
    expected
  );
};
const run = async (name, fn, {expectedFailure = false} = {}) => {
  if (
    process.env.ROO_PAYOUT_CASE &&
    !process.env.ROO_PAYOUT_CASE.split(',').some(value => name.includes(value))
  )
    return;
  const start = Date.now();
  try {
    const proof = await fn();
    const record = await read(current.record._id);
    const booking = record?.bookingId ? await read(record.bookingId) : null;
    if (booking) {
      const [typed] =
        await sql`select booking_payload, status from commerce.bookings where legacy_sanity_id=${booking._id}`;
      assert.deepEqual(typed.booking_payload, booking);
      assert.equal(typed.status, booking.status);
      proof.typedBooking = typed;
    }
    evidence.scenarios.push({name, passed: true, proof});
  } catch (error) {
    await Promise.allSettled([...inFlight]);
    const failure = {
      name,
      passed: false,
      error: error.stack,
    };
    evidence.scenarios.push(failure);
    try {
      if (current) {
        const record = await read(current.record._id);
        failure.current = {
          record,
          booking: record?.bookingId ? await read(record.bookingId) : null,
          creator: await documents.getDocument(current.creator._id),
        };
      }
    } catch (snapshotError) {
      failure.current = {snapshotError: snapshotError.stack};
    }
    if (!expectedFailure) process.exitCode = 1;
  }
  fixture.setRequestHook(null);
  console.log(
    `${name}: ${evidence.scenarios.at(-1).passed ? 'passed' : expectedFailure ? 'expected failure' : 'FAILED'} (${Date.now() - start}ms)`
  );
  fs.writeFileSync(artifact, JSON.stringify(evidence, null, 2));
};

try {
  const {createSweepPostgresFixture} = await import(
    './lib/sweep-postgres-fixture.mjs'
  );
  fixture = await createSweepPostgresFixture({
    fullMigrationChain: true,
    excludedMigrations: baseline
      ? ['20261023090000_preserve_frozen_creator_commissions.sql', '20261024000000_creator_money_rules.sql']
      : [],
  });
  sql = fixture.sql;
  const applyCommissionMigration = async ({traceProjections = false} = {}) => {
    const connection = await sql.reserve();
    const definitions = [];
    try {
      let writerDefinition;
      if (traceProjections) {
        await connection`create temporary table payout_projection_calls (kind text, ids text[])`;
        for (const [signature, kind, ids] of [
          [
            'migration.project_commerce_document_ids(text[])',
            'targeted',
            'p_document_ids',
          ],
          [
            'public.roo_project_operational_shadow()',
            'full_project',
            'null::text[]',
          ],
          [
            'public.roo_refresh_operational_shadow()',
            'full_refresh',
            'null::text[]',
          ],
        ]) {
          const [{definition}] =
            await connection`select pg_get_functiondef(${signature}::regprocedure) as definition`;
          definitions.push({signature, definition});
          const traced = definition.replace(
            /\nbegin\n/i,
            `\nbegin\n  insert into pg_temp.payout_projection_calls values ('${kind}', ${ids});\n`
          );
          assert.notEqual(traced, definition, signature);
          await connection.unsafe(traced);
        }
        const [writer] =
          await connection`select pg_get_functiondef('migration.roo_apply_commerce_document_mutations_unbounded(text,jsonb,integer)'::regprocedure) as definition`;
        writerDefinition = writer.definition;
      }
      await connection.unsafe(
        baselineMigration || fs.readFileSync(migrationPath, 'utf8')
      );
      if (!baseline) await connection.unsafe(fs.readFileSync('supabase/migrations/20261024000000_creator_money_rules.sql', 'utf8'));
      return traceProjections
        ? {
            calls:
              await connection`select kind, ids from pg_temp.payout_projection_calls`,
            definitions,
            writerDefinition,
          }
        : null;
    } catch (error) {
      await connection.unsafe('rollback');
      throw error;
    } finally {
      try {
        for (const {definition} of definitions.reverse()) {
          await connection.unsafe(definition);
        }
        if (traceProjections) {
          await connection`drop table if exists pg_temp.payout_projection_calls`;
        }
      } finally {
        connection.release();
      }
    }
  };
  if (baselineMigration) await applyCommissionMigration();
  if (baselineRulesMigration) {
    const connection = await sql.reserve();
    try {
      await connection.unsafe(baselineRulesMigration);
      await connection.unsafe("notify pgrst, 'reload schema'");
    } finally { connection.release(); }
    for (let attempt = 0; attempt < 50; attempt++) {
      const probe = await fixture.client.rpc('roo_pending_coupon_alerts', {p_limit: 1});
      if (!probe.error || probe.error.code !== 'PGRST202') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  Object.assign(process.env, {
    SUPABASE_URL: fixture.origin,
    SUPABASE_SERVICE_ROLE_KEY: fixture.token,
    NEXT_PUBLIC_SUPABASE_URL: fixture.origin,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: fixture.token,
  });
  server = http.createServer((req, res) => {
    const pending = (async () => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        if (req.url.startsWith('/api/')) {
          const request = new Request(`${origin}${req.url}`, {
            method: req.method,
            headers: req.headers,
            ...(body ? {body} : {}),
          });
          let response;
          if (req.url.startsWith('/api/ref/')) {
            const action = new URL(req.url, origin).pathname.split('/').at(-1);
            const route = await import('../app/api/ref/[action]/route.js');
            response = await route[req.method](request, {
              params: Promise.resolve({action}),
            });
          } else if (req.url.startsWith('/api/payment/webhook/')) {
            const provider = req.url.split('/').at(-1);
            const route = await import(
              `../app/api/payment/webhook/${provider}/route.js`
            );
            response = await route.POST(request);
          } else {
            const action = req.url.split('/').at(-1);
            const {default: handler} = await import(
              `../src/server/api/payment/${action}.js`
            );
            const {runLegacyApiHandler} = await import(
              '../src/lib/nextApiAdapter.js'
            );
            response = await runLegacyApiHandler({
              request,
              handler,
              methodOverride: 'POST',
            });
          }
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(await response.text());
          return;
        }
        const parts = req.url.split('/');
        const id = parts.at(-1) === 'refunds' ? parts.at(-2) : parts.at(-1);
        const state = states.find((value) =>
          [
            value.record.providerOrderId,
            value.record.providerPaymentId,
            value.payment.payment_id,
            value.payment.checkout_session_id,
            value.payment.id,
            value.payment.order_id,
          ].includes(id)
        );
        let result;
        if (req.url === '/emails') {
          const requestBody = JSON.parse(body);
          emailRequests.push({body: requestBody, headers: req.headers});
          if (pauseCouponAlerts && requestBody.subject === 'Paid checkout exceeded a coupon limit') {
            await new Promise(resolve => {
              const resume = () => { pausedCouponAlerts.delete(resume); resolve(); };
              pausedCouponAlerts.add(resume);
              res.once('close', () => { if (!res.writableEnded) abortedCouponAlerts++; resume(); });
            });
            if (res.destroyed) return;
          }
          if (requestBody.subject === 'Paid checkout exceeded a coupon limit' && requestBody.from === 'unverified@example.invalid') {
            res.writeHead(403, {'content-type': 'application/json'});
            res.end(JSON.stringify({name: 'validation_error', statusCode: 403, message: 'Synthetic unverified sending domain'}));
            return;
          }
          if ((failCouponAlert || (failCouponAlertKey && req.headers['idempotency-key'] === failCouponAlertKey)) && requestBody.subject === 'Paid checkout exceeded a coupon limit') {
            res.writeHead(503, {'content-type': 'application/json'});
            res.end(JSON.stringify({name: 'application_error', message: 'Synthetic alert outage'}));
            return;
          }
          result = {id: 'email-' + ++eventSequence};
        }
        else if (req.url === '/v1/oauth2/token')
          result = {access_token: 'fixture', expires_in: 3600};
        else if (req.url === '/v1/notifications/verify-webhook-signature')
          result = {verification_status: 'SUCCESS'};
        else if (req.url.startsWith('/payments/')) result = state?.payment;
        else if (
          req.url.startsWith('/v1/payments/') &&
          req.url.endsWith('/refunds')
        )
          result = {
            items: state?.refunds || [],
            count: (state?.refunds || []).length,
          };
        else if (req.url.startsWith('/v1/payments/')) result = state?.payment;
        else if (req.url.startsWith('/v2/checkout/orders/'))
          result = {
            id: state?.record.providerOrderId,
            status: 'COMPLETED',
            purchase_units: [
              {
                amount: {
                  value: state?.record.pricingSnapshot.netAmount.toFixed(2),
                  currency_code: 'USD',
                },
                payments: {
                  captures: [
                    {
                      id: state?.record.providerPaymentId,
                      status: 'COMPLETED',
                      amount: {
                        value:
                          state?.record.pricingSnapshot.netAmount.toFixed(2),
                        currency_code: 'USD',
                      },
                    },
                  ],
                },
              },
            ],
          };
        else if (req.url.startsWith('/v2/payments/refunds/'))
          result = refundsById.get(id);
        else if (req.url.startsWith('/checkouts/'))
          result = {
            id: state?.record.providerOrderId,
            payment_id: state?.payment.payment_id,
          };
        else if (req.url === '/products/pdt_fixture')
          result = {
            product_id: 'pdt_fixture',
            is_recurring: false,
            price: {
              type: 'one_time_price',
              currency: 'USD',
              pay_what_you_want: true,
              tax_inclusive: false,
              purchasing_power_parity: false,
              discount: 0,
              price: 0,
            },
          };
        else if (req.url === '/checkouts')
          result = {
            session_id: current.record.providerOrderId,
            checkout_url: `https://test.checkout.dodopayments.com/session/${current.key}`,
          };
        else throw new Error(`Unexpected fixture path ${req.url}`);
        assert.ok(result, `Missing provider fixture: ${req.url}`);
        responses.push({path: req.url, body: structuredClone(result)});
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, {'content-type': 'application/json'});
        res.end(JSON.stringify({error: error.message}));
      }
    })();
    inFlight.add(pending);
    pending.finally(() => inFlight.delete(pending));
  });
  server.listen(0, host);
  await once(server, 'listening');
  origin = `http://${host}:${server.address().port}`;
  globalThis.fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL
        ? String(input)
        : input.url
    );
    const target = providerOrigins.has(url.origin)
      ? `${origin}${url.pathname}${url.search}`
      : url.href;
    assert.ok(
      [origin, fixture.origin, fixture.postgrestUrl].includes(
        new URL(target).origin
      ),
      `Nonlocal destination blocked: ${url.origin}`
    );
    return originalFetch(target, {
      ...init,
      redirect: 'error',
      signal: init?.signal || AbortSignal.timeout(120000),
    });
  };
  const {createSupabaseDocumentClient} = await import(
    '../src/server/supabase/documentClient.js'
  );
  commerce = createSupabaseDocumentClient({
    shadowClient: fixture.client,
    commerceOnly: true,
    cutoverGeneration: 0,
  });
  documents = createSupabaseDocumentClient({shadowClient: fixture.client});
  earnings = await import('../src/server/api/ref/payoutUtils.js');
  evidence.database = {
    postgres: fixture.postgresVersion,
    postgrest: fixture.postgrestVersion,
    migrations: fixture.manifest,
  };

  await run('ROO-575-two-paid-zero-commissions', async () => {
    const first = await seed('dodo', {
      amount: 9.99,
      rate: 0.04,
      count: 0,
      booking: false,
    });
    const creator = first.creator;
    assert.equal(first.quote.commissionAmount, 0);
    const saved = [];
    for (let index = 0; index < 2; index++) {
      if (index) {
        const second = await seed('dodo', {
          amount: 9.99,
          rate: 0.04,
          count: 0,
          booking: false,
        });
        current.creator = creator;
        current.record = await commerce
          .patch(second.record._id)
          .set({
            pricingSnapshot: {
              ...second.record.pricingSnapshot,
              effectiveReferralId: creator._id,
              effectiveReferralCode: creator.slug.current,
            },
            bookingPayload: {
              ...second.record.bookingPayload,
              referralCode: creator.slug.current,
            },
          })
          .commit();
      }
      const result = await webhook();
      assert.equal(result.status, 200, JSON.stringify(result));
      const record = await read(current.record._id),
        booking = await read(record.bookingId);
      assert.equal(booking.commissionAmount, 0);
      saved.push(booking);
    }
    return {quote: first.quote, saved, earnings: await summary(creator, 0)};
  });

  await run('ROO-575-two-normal-checkouts-freeze-zero', async () => {
    const settingsId = '6d8a3646-0ed2-44b5-ad45-c5c9d578126a';
    await documents.create({
      _id: settingsId,
      _type: 'bookingSettings',
      dateSlots: Array.from({length: 31}, (_, index) => ({
        date: new Date(Date.UTC(2099, 0, index + 1)).toISOString().slice(0, 10),
        times: ['15:30'],
      })),
    });
    let creator;
    const bookings = [];
    for (let index = 0; index < 2; index++) {
      const state = await seed('dodo', {
        amount: 9.99,
        rate: 0.04,
        count: 0,
        booking: false,
      });
      creator ||= state.creator;
      await commerce.delete(state.record._id);
      current.record = {
        ...state.record,
        providerOrderId: `checkout-${state.key}`,
      };
      current.payment.checkout_session_id = current.record.providerOrderId;
      current.payment.payment_id = `captured-${state.key}`;
      const expiresAt = new Date(Date.now() + 1200000).toISOString();
      const hold = await commerce.create({
        _id: `slotHold.${state.key}`,
        _type: 'slotHold',
        backendOwner: 'supabase',
        cutoverGeneration: 0,
        phase: 'holding',
        holdNonce: state.key,
        expiresAt,
        startTimeUTC: state.record.bookingPayload.startTimeUTC,
        packageTitle: state.packageDoc.title,
      });
      const {issueHoldToken} = await import(
        '../src/server/booking/holdToken.js'
      );
      const bookingPayload = {
        ...state.record.bookingPayload,
        referralCode: creator.slug.current,
        slotHoldId: hold._id,
        slotHoldToken: issueHoldToken({
          holdId: hold._id,
          startTimeUTC: hold.startTimeUTC,
          expiresAt,
          holdNonce: state.key,
          backend: 'supabase',
          cutoverGeneration: 0,
        }),
      };
      const {resolvePaymentQuote} = await import(
        '../src/server/api/ref/pricing.js'
      );
      const quote = await resolvePaymentQuote({
        ...bookingPayload,
        client: commerce,
      });
      const {buildQuoteFingerprint} = await import(
        '../src/server/api/payment/paymentRecord.js'
      );
      const started = await post('/api/payment/start', {
        provider: 'dodo',
        bookingPayload,
        quoteFingerprint: buildQuoteFingerprint({bookingPayload, quote}),
      });
      assert.equal(started.status, 200, JSON.stringify(started));
      current.record = await commerce.fetch(
        '*[_type == "paymentRecord" && providerOrderId == $id][0]',
        {id: state.record.providerOrderId}
      );
      assert.ok(current.record?._id);
      current.payment.metadata.paymentRecordId = current.record._id;
      assert.equal(current.record.pricingSnapshot.commissionAmount, 0);
      assert.equal((await webhook()).status, 200);
      const record = await read(current.record._id),
        booking = await read(record.bookingId);
      assert.equal(booking.requiresReschedule, undefined);
      assert.equal(booking.commissionAmount, 0);
      bookings.push(booking);
    }
    return {bookings, earnings: await summary(creator, 0)};
  });

  for (const provider of ['paypal', 'razorpay'])
    await run(
      `ROO-508-${provider}-partial-retry-and-second-refund`,
      async () => {
        const state = await seed(provider);
        const send = async (amount, id) => {
          current.refund =
            provider === 'paypal'
              ? {
                  id,
                  status: 'COMPLETED',
                  amount: {value: amount.toFixed(2), currency_code: 'USD'},
                  links: [
                    {
                      rel: 'up',
                      href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${state.record.providerPaymentId}`,
                    },
                  ],
                }
              : {
                  id,
                  payment_id: state.record.providerPaymentId,
                  amount: Math.round(amount * 100),
                  currency: 'USD',
                  status: 'processed',
                };
          const response = await webhook(
            provider === 'paypal'
              ? 'PAYMENT.CAPTURE.REFUNDED'
              : 'refund.processed'
          );
          assert.equal(response.status, 200, JSON.stringify(response));
        };
        await send(20, `refund-${state.key}-a`);
        const first = await read(state.record.bookingId);
        assert.equal(
          first.commissionAmount,
          cents(state.quote.commissionAmount * (1 - 20 / 54.95))
        );
        await send(20, `refund-${state.key}-a`);
        assert.equal((await read(first._id)).refundedAmount, 20);
        await send(5, `refund-${state.key}-b`);
        const booking = await read(first._id);
        assert.equal(booking.refundedAmount, 25);
        const expected = cents(state.quote.commissionAmount * (1 - 25 / 54.95));
        assert.equal(booking.commissionAmount, expected);
        return {
          first,
          booking,
          earnings: await summary(state.creator, expected),
        };
      }
    );

  for (const provider of ['paypal', 'razorpay', 'dodo'])
    for (const rate of [10, 0.04])
      await run(
        `ROO-520-${provider}-recovery-frozen-and-replayed-${rate}`,
        async () => {
          const state = await seed(provider, {
            booking: false,
            count: 0,
            rate,
            amount: rate === 10 ? 54.95 : 9.99,
          });
          await documents
            .patch(state.creator._id)
            .set({currentCommissionPercent: 1})
            .commit();
          const type =
            provider === 'paypal'
              ? 'PAYMENT.CAPTURE.COMPLETED'
              : provider === 'razorpay'
                ? 'payment.captured'
                : 'payment.succeeded';
          const result = await webhook(type);
          assert.equal(result.status, 200, JSON.stringify(result));
          const record = await read(state.record._id),
            booking = await read(record.bookingId);
          assert.equal(booking.requiresReschedule, true);
          assert.equal(booking.commissionPercent, rate);
          assert.equal(booking.commissionAmount, state.quote.commissionAmount);
          assert.equal((await webhook(type)).status, 200);
          await countIs(1);
          return {
            booking,
            earnings: await summary(
              state.creator,
              state.quote.commissionAmount
            ),
          };
        }
      );

  for (const provider of ['paypal', 'razorpay', 'dodo'])
    for (const stored of ['missing', 'null'])
      await run(`ROO-520-legacy-recovery-${provider}-${stored}`, async () => {
        const state = await seed(provider, {booking: false, count: 0});
        const pricingSnapshot = {...state.record.pricingSnapshot};
        if (stored === 'null') pricingSnapshot.commissionAmount = null;
        else delete pricingSnapshot.commissionAmount;
        current.record = await commerce
          .patch(state.record._id)
          .set({pricingSnapshot})
          .commit();
        const type =
          provider === 'paypal'
            ? 'PAYMENT.CAPTURE.COMPLETED'
            : provider === 'razorpay'
              ? 'payment.captured'
              : 'payment.succeeded';
        assert.equal((await webhook(type)).status, 200);
        const booking = await read((await read(state.record._id)).bookingId);
        assert.equal(booking.requiresReschedule, true);
        assert.equal(booking.commissionPercent, 10);
        await countIs(1);
        return {booking, earnings: await summary(state.creator, 5.5)};
      });

  for (const stored of ['missing', 'null', 'zero'])
    await run(`ROO-520-legacy-partial-recovery-dodo-${stored}`, async () => {
      const state = await seed('dodo', {booking: false, count: 0});
      const pricingSnapshot = {...state.record.pricingSnapshot};
      if (stored === 'missing') delete pricingSnapshot.commissionAmount;
      else pricingSnapshot.commissionAmount = stored === 'null' ? null : 0;
      current.record = await commerce
        .patch(state.record._id)
        .set({pricingSnapshot})
        .commit();
      current.payment.refund_status = 'partial';
      current.payment.refunds = [
        {
          refund_id: `refund-${state.key}`,
          payment_id: state.payment.payment_id,
          status: 'succeeded',
          currency: 'USD',
          amount: 2000,
        },
      ];
      const response = await webhook();
      assert.equal(response.status, 200, JSON.stringify(response));
      const booking = await read((await read(state.record._id)).bookingId);
      assert.equal(
        booking.dodoOriginalCommissionAmount,
        stored === 'zero' ? 0 : 5.5
      );
      assert.equal(booking.refundedAmount, 20);
      const expected = stored === 'zero' ? 0 : 3.5;
      assert.equal(booking.commissionAmount, expected);
      assert.equal((await webhook()).status, 200);
      await countIs(1);
      return {booking, earnings: await summary(state.creator, expected)};
    });

  for (const provider of ['paypal', 'razorpay'])
    await run(`ROO-508-legacy-partial-refund-${provider}`, async () => {
      const state = await seed(provider);
      const pricingSnapshot = {...state.record.pricingSnapshot};
      delete pricingSnapshot.commissionAmount;
      current.record = await commerce
        .patch(state.record._id)
        .set({pricingSnapshot})
        .commit();
      await commerce
        .patch(state.record.bookingId)
        .unset(['commissionAmount'])
        .commit();
      current.refund =
        provider === 'paypal'
          ? {
              id: `refund-${state.key}`,
              status: 'COMPLETED',
              amount: {value: '20.00', currency_code: 'USD'},
              links: [
                {
                  rel: 'up',
                  href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${state.record.providerPaymentId}`,
                },
              ],
            }
          : {
              id: `refund-${state.key}`,
              payment_id: state.record.providerPaymentId,
              amount: 2000,
              currency: 'USD',
              status: 'processed',
            };
      const type =
        provider === 'paypal' ? 'PAYMENT.CAPTURE.REFUNDED' : 'refund.processed';
      const response = await webhook(type);
      assert.equal(response.status, 200, JSON.stringify(response));
      const booking = await read(state.record.bookingId);
      assert.equal(booking.originalCommissionAmount, 5.5);
      assert.equal(booking.commissionAmount, 3.5);
      assert.equal((await webhook(type)).status, 200);
      return {booking, earnings: await summary(state.creator, 3.5)};
    });

  for (const provider of ['paypal', 'razorpay'])
    await run(
      `ROO-508-${provider}-failed-sync-cron-and-concurrent-refunds`,
      async () => {
        const state = await seed(provider);
        const send = async (amount, id) => {
          current.refund =
            provider === 'paypal'
              ? {
                  id,
                  status: 'COMPLETED',
                  amount: {value: amount.toFixed(2), currency_code: 'USD'},
                  links: [
                    {
                      rel: 'up',
                      href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${state.record.providerPaymentId}`,
                    },
                  ],
                }
              : {
                  id,
                  payment_id: state.record.providerPaymentId,
                  amount: Math.round(amount * 100),
                  currency: 'USD',
                  status: 'processed',
                };
          return webhook(
            provider === 'paypal'
              ? 'PAYMENT.CAPTURE.REFUNDED'
              : 'refund.processed'
          );
        };
        let blocked = false;
        fixture.setRequestHook(async (phase, request) => {
          if (
            phase === 'before' &&
            request.body?.p_mutations?.some(
              (mutation) =>
                mutation.document?._id === state.record.bookingId &&
                mutation.document.refundStatus === 'partial'
            )
          ) {
            blocked = true;
            throw new Error('Synthetic booking synchronization failure');
          }
        });
        const firstResponse = await send(20, `refund-${state.key}-a`);
        assert.equal(blocked, true);
        assert.equal(
          (await read(state.record.bookingId)).commissionAmount,
          5.5
        );
        assert.equal(
          (await read(state.record._id)).refundRequiresBookingSync,
          true
        );
        fixture.setRequestHook(null);
        const reconciled = await post(
          '/api/payment/reconcile',
          {},
          {authorization: 'Bearer fixture'}
        );
        assert.equal(reconciled.status, 200, JSON.stringify(reconciled));
        assert.equal(
          (await read(state.record.bookingId)).commissionAmount,
          3.5
        );
        const concurrent = await Promise.all([
          send(5, `refund-${state.key}-b`),
          send(10, `refund-${state.key}-c`),
        ]);
        await send(5, `refund-${state.key}-b`);
        await send(10, `refund-${state.key}-c`);
        const afterConcurrent = await read(state.record._id);
        const retried = await post(
          '/api/payment/reconcile',
          {},
          {authorization: 'Bearer fixture'}
        );
        assert.equal(retried.status, 200, JSON.stringify(retried));
        const booking = await read(state.record.bookingId);
        assert.equal(booking.refundedAmount, 35);
        assert.equal(
          (await read(state.record._id)).refundRequiresBookingSync,
          false
        );
        const expected = cents(5.5 * (1 - 35 / 54.95));
        assert.equal(booking.commissionAmount, expected);
        return {
          blocked,
          firstResponse,
          concurrent,
          afterConcurrent,
          retried,
          booking,
          earnings: await summary(state.creator, expected),
        };
      }
    );

  for (const lost of ['dispute_lost', 'dispute_accepted', 'dispute_expired'])
    for (const restored of ['dispute_won', 'dispute_cancelled'])
      await run(`ROO-509-${lost}-${restored}`, async () => {
        const state = await seed('dodo');
        current.payment.disputes = [dispute(lost)];
        assert.equal(
          (await webhook(`dispute.${lost.replace('dispute_', '')}`)).status,
          200
        );
        await countIs(4);
        assert.equal(
          (await webhook(`dispute.${lost.replace('dispute_', '')}`)).status,
          200
        );
        await countIs(4);
        await summary(state.creator, 0);
        current.payment.disputes = [dispute(restored)];
        assert.equal(
          (await webhook(`dispute.${restored.replace('dispute_', '')}`)).status,
          200
        );
        await countIs(5);
        assert.equal(
          (await webhook(`dispute.${restored.replace('dispute_', '')}`)).status,
          200
        );
        await countIs(5);
        return {
          booking: await read(state.record.bookingId),
          creator: await documents.getDocument(state.creator._id),
          earnings: await summary(state.creator, 5.5),
        };
      });

  for (const outcome of [
    'full-refund',
    'admin-cancel',
    'second-dispute',
    'write-conflict',
  ])
    await run(`ROO-509-${outcome}`, async () => {
      const state = await seed('dodo');
      let conflict = false;
      if (outcome === 'write-conflict')
        fixture.setRequestHook(async (phase, request) => {
          if (
            phase !== 'before' ||
            conflict ||
            !request.body?.p_mutations?.some(
              (mutation) =>
                mutation.document?._id === state.record.bookingId &&
                mutation.document.dodoDisputeActive === true
            )
          )
            return;
          conflict = true;
          fixture.setRequestHook(null);
          await documents
            .patch(state.creator._id)
            .inc({successfulReferrals: 1})
            .commit();
        });
      current.payment.disputes = [dispute('dispute_lost')];
      let response = await webhook('dispute.lost');
      if (outcome === 'write-conflict') {
        assert.equal(conflict, true);
        assert.ok(response.status >= 400);
        assert.equal(
          (await read(state.record.bookingId)).dodoDisputeActive,
          undefined
        );
        await countIs(6);
        response = await webhook('dispute.lost');
      }
      assert.equal(response.status, 200, JSON.stringify(response));
      await countIs(outcome === 'write-conflict' ? 5 : 4);
      if (outcome === 'full-refund') {
        current.payment.refund_status = 'full';
        current.payment.refunds = [
          {
            refund_id: `refund-${state.key}`,
            payment_id: state.payment.payment_id,
            status: 'succeeded',
            currency: 'USD',
            amount: state.payment.total_amount,
          },
        ];
        assert.equal((await webhook('refund.succeeded')).status, 200);
        await countIs(4);
      }
      if (outcome === 'admin-cancel')
        await commerce
          .patch(state.record.bookingId)
          .set({status: 'cancelled'})
          .commit();
      current.payment.disputes = [dispute('dispute_won')];
      if (outcome === 'second-dispute')
        current.payment.disputes.push({
          ...dispute('dispute_challenged'),
          dispute_id: 'second-dispute',
        });
      assert.equal((await webhook('dispute.won')).status, 200);
      await countIs(outcome === 'write-conflict' ? 6 : 4);
      if (outcome === 'second-dispute') {
        current.payment.disputes[1].dispute_status = 'dispute_cancelled';
        assert.equal((await webhook('dispute.cancelled')).status, 200);
        await countIs(5);
      }
      const booking = await read(state.record.bookingId);
      if (outcome === 'full-refund') assert.equal(booking.status, 'refunded');
      if (outcome === 'admin-cancel') assert.equal(booking.status, 'cancelled');
      return {
        conflict,
        booking,
        earnings: await summary(
          state.creator,
          ['full-refund', 'admin-cancel'].includes(outcome) ? 0 : 5.5
        ),
      };
    });

  const zeroCounterStart = states.length;
  for (const lost of ['dispute_lost', 'dispute_accepted', 'dispute_expired'])
    for (const counter of ['zero', 'missing'])
      for (const outcome of [
        'won-cycle',
        'cancelled-cycle',
        'full-refund',
        'legacy-snapshot',
        'legacy-full-refund',
      ])
        await run(
          `ROO-509-zero-counter-${lost}-${counter}-${outcome}`,
          async () => {
            const state = await seed('dodo', {count: 0});
            if (counter === 'missing')
              await documents
                .patch(state.creator._id)
                .unset(['successfulReferrals'])
                .commit();
            current.payment.disputes = [dispute(lost)];
            assert.equal((await webhook('dispute.lost')).status, 200);
            const first = await read(state.record.bookingId);
            assert.equal(
              Number(
                (await documents.getDocument(state.creator._id))
                  .successfulReferrals || 0
              ),
              0
            );
            assert.equal(first.dodoReferralReversedAfterDispute, false);
            if (outcome.startsWith('legacy-'))
              await commerce
                .patch(first._id)
                .unset(['dodoReferralDisputeAccounted'])
                .commit();

            const next = await seed('dodo', {booking: false, count: 0});
            current.creator = state.creator;
            current.record = await commerce
              .patch(next.record._id)
              .set({
                pricingSnapshot: {
                  ...next.record.pricingSnapshot,
                  effectiveReferralId: state.creator._id,
                  effectiveReferralCode: state.creator.slug.current,
                },
                bookingPayload: {
                  ...next.record.bookingPayload,
                  referralCode: state.creator.slug.current,
                },
              })
              .commit();
            assert.equal((await webhook()).status, 200);
            const paidBooking = await read(
              (await read(next.record._id)).bookingId
            );
            assert.equal(paidBooking.referral._ref, state.creator._id);
            assert.equal(paidBooking.referralAccountingApplied, true);
            current = state;
            await countIs(1);

            if (!outcome.endsWith('full-refund')) {
              current.payment.disputes[0].remarks =
                'Updated evidence after another paid booking';
              const eventId = `changed-dispute-${state.key}`;
              assert.equal(
                (await webhook('dispute.updated', eventId)).status,
                200
              );
              await countIs(1);
              assert.equal(
                (await webhook('dispute.updated', eventId)).status,
                200
              );
              await countIs(1);
              const restored =
                outcome === 'cancelled-cycle'
                  ? 'dispute_cancelled'
                  : 'dispute_won';
              current.payment.disputes[0].dispute_status = restored;
              assert.equal((await webhook('dispute.resolved')).status, 200);
              await countIs(1);
              current.payment.disputes[0].dispute_status = lost;
              assert.equal((await webhook('dispute.reopened')).status, 200);
              await countIs(1);
              current.payment.disputes[0].dispute_status = restored;
              assert.equal((await webhook('dispute.resolved')).status, 200);
              await countIs(1);
            }
            current.payment.refund_status = 'full';
            current.payment.refunds = [
              {
                refund_id: `refund-${state.key}`,
                payment_id: state.payment.payment_id,
                status: 'succeeded',
                currency: 'USD',
                amount: state.payment.total_amount,
              },
            ];
            assert.equal((await webhook('refund.succeeded')).status, 200);
            await countIs(1);
            assert.equal((await webhook('refund.succeeded')).status, 200);
            await countIs(1);
            const booking = await read(state.record.bookingId);
            assert.equal(booking.status, 'refunded');
            assert.equal(booking.dodoReferralDisputeAccounted, true);
            assert.equal(booking.dodoReferralReversedAfterDispute, false);
            return {
              first,
              paidBooking,
              booking,
              creator: await documents.getDocument(state.creator._id),
              earnings: await summary(state.creator, 5.5),
            };
          }
        );
  if (states.length > zeroCounterStart) {
    await run('ROO-509-zero-counter-projections', async () => {
      const snapshot = async () => ({
        bookings:
          await sql`select legacy_sanity_id, booking_payload, status from commerce.bookings order by legacy_sanity_id`,
        creators:
          await sql`select legacy_sanity_id, payload from migration.source_documents where document_type='referral' and tombstoned=false order by legacy_sanity_id`,
      });
      const before = await snapshot();
      const after = {};
      for (const rpc of [
        'roo_project_operational_shadow',
        'roo_refresh_operational_shadow',
      ]) {
        assert.equal((await fixture.client.rpc(rpc)).error, null);
        after[rpc] = await snapshot();
        assert.deepEqual(after[rpc], before);
      }
      return {before, after};
    });
    for (const state of states.slice(zeroCounterStart)) {
      const record = await read(state.record._id);
      if (record?.bookingId) await commerce.delete(record.bookingId);
    }
  }

  const missingCreatorStart = states.length;
  for (const lost of ['dispute_lost', 'dispute_accepted', 'dispute_expired']) {
    for (const when of ['before-terminal', 'before-resolution']) {
      for (const restored of ['dispute_won', 'dispute_cancelled']) {
        await run(
          `ROO-509-missing-creator-${lost}-${when}-${restored}`,
          async () => {
            const state = await seed('dodo');
            if (when === 'before-terminal')
              await documents.delete(state.creator._id);
            current.payment.disputes = [dispute(lost)];
            const terminalResponse = await webhook('dispute.lost');
            assert.equal(
              terminalResponse.status,
              200,
              JSON.stringify(terminalResponse)
            );
            const disputedBooking = await read(state.record.bookingId);
            const disputedRecord = await read(state.record._id);
            assert.equal(disputedBooking.status, 'pending');
            assert.equal(disputedBooking.commissionAmount, 0);
            assert.equal(disputedBooking.dodoReferralDisputeAccounted, true);
            assert.equal(disputedRecord.dodoDisputeActive, true);
            assert.equal(disputedRecord.providerRecoveryTerminal, true);
            if (when === 'before-resolution') {
              await countIs(4);
              await documents.delete(state.creator._id);
            }
            current.payment.disputes[0].dispute_status = restored;
            const eventId = `missing-creator-${state.key}`;
            const response = await webhook('dispute.resolved', eventId);
            assert.equal(response.status, 200, JSON.stringify(response));
            assert.equal(
              (await webhook('dispute.resolved', eventId)).status,
              200
            );
            current.payment.disputes[0].remarks =
              'Updated while creator is absent';
            assert.equal((await webhook('dispute.updated')).status, 200);
            const restoredBooking = await read(state.record.bookingId);
            const restoredRecord = await read(state.record._id);
            assert.equal(restoredBooking.status, 'captured');
            assert.equal(restoredBooking.commissionAmount, 5.5);
            assert.equal(restoredBooking.dodoReferralDisputeAccounted, true);
            assert.equal(
              restoredBooking.dodoReferralReversedAfterDispute,
              when === 'before-resolution'
            );
            assert.equal(restoredRecord.dodoDisputeActive, false);
            assert.equal(restoredRecord.providerRecoveryTerminal, false);
            assert.equal(restoredRecord.status, 'booked');
            assert.equal(await documents.getDocument(state.creator._id), null);
            current.payment.refund_status = 'full';
            current.payment.refunds = [
              {
                refund_id: `refund-${state.key}`,
                payment_id: state.payment.payment_id,
                status: 'succeeded',
                currency: 'USD',
                amount: state.payment.total_amount,
              },
            ];
            assert.equal((await webhook('refund.succeeded')).status, 200);
            assert.equal((await webhook('refund.succeeded')).status, 200);
            const booking = await read(state.record.bookingId);
            assert.equal(booking.status, 'refunded');
            assert.equal(booking.commissionAmount, 0);
            assert.equal(await documents.getDocument(state.creator._id), null);
            return {
              terminalResponse,
              disputedBooking,
              disputedRecord,
              response,
              restoredBooking,
              restoredRecord,
              booking,
            };
          }
        );
      }
    }
  }
  if (states.length > missingCreatorStart) {
    await run('ROO-509-missing-creator-projections', async () => {
      const snapshot = async () => ({
        bookings:
          await sql`select legacy_sanity_id, booking_payload, status from commerce.bookings order by legacy_sanity_id`,
        creators:
          await sql`select legacy_sanity_id, payload from migration.source_documents where document_type='referral' and tombstoned=false order by legacy_sanity_id`,
      });
      const before = await snapshot();
      const after = {};
      for (const rpc of [
        'roo_project_operational_shadow',
        'roo_refresh_operational_shadow',
      ]) {
        assert.equal((await fixture.client.rpc(rpc)).error, null);
        after[rpc] = await snapshot();
        assert.deepEqual(after[rpc], before);
      }
      return {before, after};
    });
    for (const state of states.slice(missingCreatorStart)) {
      const record = await read(state.record._id);
      if (record?.bookingId) await commerce.delete(record.bookingId);
    }
  }

  const legacyAccountingStart = states.length;
  for (const lost of ['dispute_lost', 'dispute_accepted', 'dispute_expired']) {
    for (const counter of ['positive', 'zero', 'missing']) {
      await run(`legacy-dispute-accounting-${lost}-${counter}`, async () => {
        const initial = counter === 'positive' ? 5 : 0;
        const state = await seed('dodo', {count: initial});
        current.payment.disputes = [dispute(lost)];
        assert.equal((await webhook('dispute.lost')).status, 200);
        await commerce
          .patch(state.record.bookingId)
          .unset([
            'dodoReferralDisputeAccounted',
            'dodoReferralReversedAfterDispute',
            'commissionCalculationVersion',
          ])
          .commit();
        if (counter === 'missing') {
          await documents
            .patch(state.creator._id)
            .unset(['successfulReferrals'])
            .commit();
        } else {
          await documents
            .patch(state.creator._id)
            .set({successfulReferrals: initial})
            .commit();
        }
        const historical = {
          booking: await read(state.record.bookingId),
          record: await read(state.record._id),
          creator: await documents.getDocument(state.creator._id),
        };
        assert.equal(
          Object.hasOwn(historical.booking, 'dodoReferralDisputeAccounted'),
          false
        );
        assert.equal(
          Object.hasOwn(historical.booking, 'dodoReferralReversedAfterDispute'),
          false
        );
        assert.equal((await webhook('dispute.updated')).status, 200);
        const afterFirst = Math.max(initial - 1, 0);
        assert.equal(
          Number(
            (await documents.getDocument(state.creator._id))
              .successfulReferrals || 0
          ),
          afterFirst
        );

        const next = await seed('dodo', {booking: false, count: 0});
        current.creator = state.creator;
        current.record = await commerce
          .patch(next.record._id)
          .set({
            pricingSnapshot: {
              ...next.record.pricingSnapshot,
              effectiveReferralId: state.creator._id,
              effectiveReferralCode: state.creator.slug.current,
            },
            bookingPayload: {
              ...next.record.bookingPayload,
              referralCode: state.creator.slug.current,
            },
          })
          .commit();
        assert.equal((await webhook()).status, 200);
        const paidBooking = await read((await read(next.record._id)).bookingId);
        assert.equal(paidBooking.referral._ref, state.creator._id);
        assert.equal(paidBooking.referralAccountingApplied, true);
        current = state;
        await countIs(afterFirst + 1);
        current.payment.disputes[0].remarks =
          'Updated historical terminal dispute';
        const eventId = `legacy-accounting-${state.key}`;
        assert.equal((await webhook('dispute.updated', eventId)).status, 200);
        assert.equal((await webhook('dispute.updated', eventId)).status, 200);
        await countIs(afterFirst + 1);
        current.payment.disputes[0].dispute_status = 'dispute_won';
        assert.equal((await webhook('dispute.won')).status, 200);
        await countIs(initial + 1);
        current.payment.disputes[0].dispute_status = lost;
        assert.equal((await webhook('dispute.reopened')).status, 200);
        await countIs(afterFirst + 1);
        current.payment.disputes[0].dispute_status = 'dispute_cancelled';
        assert.equal((await webhook('dispute.cancelled')).status, 200);
        await countIs(initial + 1);
        current.payment.refund_status = 'full';
        current.payment.refunds = [
          {
            refund_id: `refund-${state.key}`,
            payment_id: state.payment.payment_id,
            status: 'succeeded',
            currency: 'USD',
            amount: state.payment.total_amount,
          },
        ];
        assert.equal((await webhook('refund.succeeded')).status, 200);
        assert.equal((await webhook('refund.succeeded')).status, 200);
        await countIs(afterFirst + 1);
        return {
          historical,
          paidBooking,
          booking: await read(state.record.bookingId),
          creator: await documents.getDocument(state.creator._id),
          earnings: await summary(state.creator, 5.5),
        };
      });
    }
  }
  if (states.length > legacyAccountingStart) {
    await run('legacy-dispute-accounting-projections', async () => {
      const snapshot = async () => ({
        bookings:
          await sql`select legacy_sanity_id, booking_payload, status from commerce.bookings order by legacy_sanity_id`,
        creators:
          await sql`select legacy_sanity_id, payload from migration.source_documents where document_type='referral' and tombstoned=false order by legacy_sanity_id`,
      });
      const before = await snapshot();
      const after = {};
      for (const rpc of [
        'roo_project_operational_shadow',
        'roo_refresh_operational_shadow',
      ]) {
        assert.equal((await fixture.client.rpc(rpc)).error, null);
        after[rpc] = await snapshot();
        assert.deepEqual(after[rpc], before);
      }
      return {before, after};
    });
    for (const state of states.slice(legacyAccountingStart)) {
      const record = await read(state.record._id);
      if (record?.bookingId) await commerce.delete(record.bookingId);
    }
  }

  await run('ROO-509-open-partial-refund-then-won', async () => {
    const state = await seed('dodo');
    for (const status of ['dispute_opened', 'dispute_challenged']) {
      current.payment.disputes = [dispute(status)];
      assert.equal(
        (await webhook(`dispute.${status.replace('dispute_', '')}`)).status,
        200
      );
      await countIs(5);
      await summary(state.creator, 0);
    }
    current.payment.refund_status = 'partial';
    current.payment.refunds = [
      {
        refund_id: `refund-${state.key}`,
        payment_id: state.payment.payment_id,
        status: 'succeeded',
        currency: 'USD',
        amount: 2000,
      },
    ];
    assert.equal((await webhook('refund.succeeded')).status, 200);
    assert.equal((await read(state.record.bookingId)).commissionAmount, 0);
    current.payment.disputes = [dispute('dispute_won')];
    assert.equal((await webhook('dispute.won')).status, 200);
    await countIs(5);
    return {
      booking: await read(state.record.bookingId),
      earnings: await summary(state.creator, cents(5.5 * (1 - 20 / 54.95))),
    };
  });

  await run('ROO-575-explicit-zero-and-legacy-rounding-rebuilds', async () => {
    const state = await seed('dodo', {amount: 12.51});
    await commerce
      .patch(state.record.bookingId)
      .set({commissionAmount: 0})
      .commit();
    await summary(state.creator, 0);
    const second = await seed('dodo', {amount: 12.51, rate: 0.04});
    await commerce
      .patch(second.record.bookingId)
      .set({
        referral: {_type: 'reference', _ref: state.creator._id},
        referralCode: state.creator.slug.current,
      })
      .commit();
    for (const original of [null, 'missing']) {
      for (const id of [state.record.bookingId, second.record.bookingId]) {
        const patch = commerce.patch(id).set({commissionPercent: 0.04});
        await (
          original === null
            ? patch.set({commissionAmount: null})
            : patch.unset(['commissionAmount'])
        ).commit();
      }
      await summary(state.creator, 0.02);
    }
    for (const rpc of [
      'roo_project_operational_shadow',
      'roo_refresh_operational_shadow',
    ]) {
      const result = await fixture.client.rpc(rpc);
      assert.equal(result.error, null);
      await summary(state.creator, 0.02);
    }
    return {
      earnings: await summary(state.creator, 0.02),
      rebuilds: ['original', 'current'],
    };
  });

  for (const [label, amount, expected] of [
    ['null', null, 1],
    ['missing', undefined, 1],
    ['empty', '', 1],
    ['invalid', 'invalid', 1],
    ['zero', 0, 0],
  ])
    await run(`ROO-575-retained-dodo-original-${label}`, async () => {
      const state = await seed('dodo', {amount: 9.99});
      let patch = commerce
        .patch(state.record.bookingId)
        .set({dodoOriginalCommissionAmount: 1});
      patch =
        amount === undefined
          ? patch.unset(['commissionAmount'])
          : patch.set({commissionAmount: amount});
      await patch.commit();
      return {
        booking: await read(state.record.bookingId),
        earnings: await summary(state.creator, expected),
      };
    });

  await run('ROO-575-legacy-rounding-before-sum', async () => {
    const first = await seed('dodo', {amount: 12.51, rate: 0.04});
    const second = await seed('dodo', {amount: 12.51, rate: 0.04});
    await commerce
      .patch(first.record.bookingId)
      .unset(['commissionAmount'])
      .commit();
    await commerce
      .patch(second.record.bookingId)
      .set({
        commissionAmount: null,
        referral: {_type: 'reference', _ref: first.creator._id},
        referralCode: first.creator.slug.current,
      })
      .commit();
    return {
      bookings: [
        await read(first.record.bookingId),
        await read(second.record.bookingId),
      ],
      earnings: await summary(first.creator, 0.02),
    };
  });

  for (const [label, amount, rate, expected, stored] of [
    ['half-cent', 1.05, 10, 0.11, {}],
    ['fractional-rate', 1, 7.5, 0.08, {}],
    [
      'decimal-text',
      1.05,
      10,
      0.11,
      {netAmount: '1.05', commissionPercent: '10'},
    ],
    ['gross-fallback', 1.05, 10, 0.11, {netAmount: 0, grossAmount: 1.05}],
    ['invalid-stored-text', 1.05, 10, 0.11, {commissionAmount: '0\t'}],
  ])
    await run(`ROO-575-decimal-rounding-${label}`, async () => {
      const state = await seed('dodo', {amount, rate});
      await commerce
        .patch(state.record.bookingId)
        .unset(['commissionAmount'])
        .set(stored)
        .commit();
      return {
        booking: await read(state.record.bookingId),
        earnings: await summary(state.creator, expected),
      };
    });

  for (const provider of ['paypal', 'razorpay', 'dodo'])
    await run(`ROO-520-decimal-rounding-${provider}`, async () => {
      const state = await seed(provider, {
        amount: 1.05,
        booking: false,
        count: 0,
      });
      const pricingSnapshot = {...state.record.pricingSnapshot};
      delete pricingSnapshot.commissionAmount;
      current.record = await commerce
        .patch(state.record._id)
        .set({pricingSnapshot})
        .commit();
      const type =
        provider === 'paypal'
          ? 'PAYMENT.CAPTURE.COMPLETED'
          : provider === 'razorpay'
            ? 'payment.captured'
            : 'payment.succeeded';
      assert.equal((await webhook(type)).status, 200);
      const booking = await read((await read(state.record._id)).bookingId);
      assert.equal(booking.commissionAmount, 0.11);
      return {booking, earnings: await summary(state.creator, 0.11)};
    });

  for (const provider of ['paypal', 'razorpay'])
    await run(`ROO-508-decimal-rounding-${provider}`, async () => {
      const state = await seed(provider, {amount: 1.05});
      const pricingSnapshot = {...state.record.pricingSnapshot};
      delete pricingSnapshot.commissionAmount;
      current.record = await commerce
        .patch(state.record._id)
        .set({pricingSnapshot})
        .commit();
      await commerce
        .patch(state.record.bookingId)
        .unset(['commissionAmount'])
        .commit();
      current.refund =
        provider === 'paypal'
          ? {
              id: `refund-${state.key}`,
              status: 'COMPLETED',
              amount: {value: '0.05', currency_code: 'USD'},
              links: [
                {
                  rel: 'up',
                  href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${state.record.providerPaymentId}`,
                },
              ],
            }
          : {
              id: `refund-${state.key}`,
              payment_id: state.record.providerPaymentId,
              amount: 5,
              currency: 'USD',
              status: 'processed',
            };
      const response = await webhook(
        provider === 'paypal' ? 'PAYMENT.CAPTURE.REFUNDED' : 'refund.processed'
      );
      assert.equal(response.status, 200);
      const booking = await read(state.record.bookingId);
      assert.equal(booking.originalCommissionAmount, 0.11);
      assert.equal(booking.commissionAmount, 0.1);
      return {booking, earnings: await summary(state.creator, 0.1)};
    });

  for (const snapshotState of ['read-error', 'missing-booking'])
    await run(`runner-snapshot-${snapshotState}`, async () => {
      await seed('dodo', {booking: snapshotState !== 'missing-booking'});
      if (snapshotState === 'read-error')
        fixture.setRequestHook((phase, request) => {
          if (
            phase === 'before' &&
            request.path.includes('roo_fetch_shadow_documents_targeted')
          ) {
            throw new Error('Synthetic diagnostic read failure');
          }
        });
      try {
        await run(
          `runner-snapshot-${snapshotState}/probe`,
          async () => {
            throw new Error('Synthetic original scenario failure');
          },
          {expectedFailure: true}
        );
      } finally {
        fixture.setRequestHook(null);
      }
      const failure = evidence.scenarios.pop();
      assert.equal(failure.passed, false);
      assert.match(failure.error, /Synthetic original scenario failure/);
      if (snapshotState === 'read-error') {
        assert.match(
          failure.current.snapshotError,
          /Supabase targeted shadow fetch failed/
        );
      } else {
        assert.equal(failure.current.booking, null);
        assert.equal(failure.current.record._id, current.record._id);
        assert.equal(failure.current.creator._id, current.creator._id);
      }
      return {failure};
    });

  const startDodoCheckout = async (state) => {
    const settingsId = '6d8a3646-0ed2-44b5-ad45-c5c9d578126a';
    const settings = await documents.getDocument(settingsId);
    await documents.createOrReplace({
      ...settings,
      _id: settingsId,
      _type: 'bookingSettings',
      dateSlots: [
        ...(settings?.dateSlots || []),
        {
          date: state.record.bookingPayload.startTimeUTC.slice(0, 10),
          times: ['15:30'],
        },
      ],
    });
    await commerce.delete(state.record._id);
    current.record = {
      ...state.record,
      providerOrderId: 'checkout-' + state.key,
    };
    current.payment.checkout_session_id = current.record.providerOrderId;
    current.payment.payment_id = 'captured-' + state.key;
    const expiresAt = new Date(Date.now() + 1200000).toISOString();
    const hold = await commerce.create({
      _id: 'slotHold.' + state.key,
      _type: 'slotHold',
      backendOwner: 'supabase',
      cutoverGeneration: 0,
      phase: 'holding',
      holdNonce: state.key,
      expiresAt,
      startTimeUTC: state.record.bookingPayload.startTimeUTC,
      packageTitle: state.packageDoc.title,
    });
    const {issueHoldToken} = await import('../src/server/booking/holdToken.js');
    const bookingPayload = {
      ...state.record.bookingPayload,
      slotHoldId: hold._id,
      slotHoldToken: issueHoldToken({
        holdId: hold._id,
        startTimeUTC: hold.startTimeUTC,
        expiresAt,
        holdNonce: state.key,
        backend: 'supabase',
        cutoverGeneration: 0,
      }),
    };
    const {buildQuoteFingerprint} = await import(
      '../src/server/api/payment/paymentRecord.js'
    );
    const provider = state.quote.effectiveNetAmount === 0 ? 'free' : 'dodo';
    const started = await post('/api/payment/start', {
      provider,
      bookingPayload,
      quoteFingerprint: buildQuoteFingerprint({
        bookingPayload,
        quote: state.quote,
      }),
    });
    assert.equal(started.status, 200, JSON.stringify(started));
    if (provider === 'free') {
      current.record = await read(
        (await read(started.body.bookingId)).paymentRecordId
      );
      assert.ok(current.record?._id);
      return started;
    }
    current.record = await commerce.fetch(
      '*[_type == "paymentRecord" && providerOrderId == $id][0]',
      {id: current.record.providerOrderId}
    );
    assert.ok(current.record?._id);
    current.payment.metadata.paymentRecordId = current.record._id;
  };
  const moneyCases = [
    {
      name: 'plain',
      amount: 54.95,
      rate: 10,
      original: 5.5,
      refund: 20,
      retained: 3.5,
      legacyOriginal: 5.5,
      legacyExact: 5.495,
      legacyRetained: 3.5,
    },
    {
      name: 'referral-discount',
      amount: 54.95,
      rate: 10,
      discount: 20,
      original: 5.5,
      refund: 21.98,
      retained: 2.75,
      legacyOriginal: 4.4,
      legacyExact: 4.396,
      legacyRetained: 2.2,
    },
    {
      name: 'combined-coupon',
      amount: 54.95,
      rate: 10,
      discount: 20,
      coupon: 20,
      original: 4.4,
      refund: 17.58,
      retained: 2.2,
      legacyOriginal: 3.52,
      legacyExact: 3.517,
      legacyRetained: 1.76,
    },
    {
      name: 'half-cent',
      amount: 20.1,
      rate: 10,
      original: 2.01,
      refund: 10.05,
      retained: 1.01,
    },
    {
      name: 'below-half',
      amount: 20.1,
      rate: 10,
      original: 2.01,
      refund: 10.06,
      retained: 1,
    },
    {
      name: 'above-half',
      amount: 20.1,
      rate: 10,
      original: 2.01,
      refund: 10.04,
      retained: 1.01,
    },
  ];
  const refundCurrent = async (amount, suffix, full = false) => {
    const id = `refund-${current.key}-${suffix}`;
    if (current.record.provider === 'dodo') {
      current.payment.refunds.push({
        refund_id: id,
        payment_id: current.payment.payment_id,
        status: 'succeeded',
        currency: 'USD',
        amount: Math.round(amount * 100),
      });
      current.payment.refund_status = full ? 'full' : 'partial';
      return webhook('refund.succeeded');
    }
    current.refund =
      current.record.provider === 'paypal'
        ? {
            id,
            status: 'COMPLETED',
            amount: {value: amount.toFixed(2), currency_code: 'USD'},
            links: [
              {
                rel: 'up',
                href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${current.record.providerPaymentId}`,
              },
            ],
          }
        : {
            id,
            payment_id: current.record.providerPaymentId,
            amount: Math.round(amount * 100),
            currency: 'USD',
            status: 'processed',
          };
    return webhook(
      current.record.provider === 'paypal'
        ? 'PAYMENT.CAPTURE.REFUNDED'
        : 'refund.processed'
    );
  };
  for (const provider of ['dodo', 'paypal', 'razorpay'])
    for (const row of moneyCases)
      await run(`R1-money-table-${provider}-${row.name}`, async () => {
        const state = await seed(provider, {...row, booking: false, count: 0});
        assert.equal(state.quote.commissionAmount, row.original);
        const pricingSnapshot = {...state.record.pricingSnapshot};
        delete pricingSnapshot.commissionAmount;
        current.record = await commerce
          .patch(state.record._id)
          .set({pricingSnapshot})
          .commit();
        await documents
          .patch(state.creator._id)
          .set({currentCommissionPercent: 1, currentDiscountPercent: 0})
          .commit();
        const captureType =
          provider === 'paypal'
            ? 'PAYMENT.CAPTURE.COMPLETED'
            : provider === 'razorpay'
              ? 'payment.captured'
              : 'payment.succeeded';
        const captured = await webhook(captureType);
        assert.equal(captured.status, 200, JSON.stringify(captured));
        const bookingId = (await read(state.record._id)).bookingId;
        const before = await read(bookingId);
        assert.equal(before.commissionAmount, row.original);
        assert.equal((await refundCurrent(row.refund, 'partial')).status, 200);
        const partial = await read(bookingId);
        assert.equal(partial.commissionAmount, row.retained);
        await summary(state.creator, row.retained);
        if (provider === 'dodo') {
          current.payment.disputes = [dispute('dispute_opened')];
          assert.equal((await webhook('dispute.opened')).status, 200);
          assert.equal((await read(bookingId)).commissionAmount, 0);
          current.payment.disputes = [dispute('dispute_won')];
          assert.equal((await webhook('dispute.won')).status, 200);
          assert.equal((await read(bookingId)).commissionAmount, row.retained);
        }
        assert.equal(
          (
            await refundCurrent(
              cents(state.quote.effectiveNetAmount - row.refund),
              'remaining',
              true
            )
          ).status,
          200
        );
        const full = await read(bookingId);
        assert.equal(full.status, 'refunded');
        assert.equal(full.commissionAmount, 0);
        return {
          row,
          quote: state.quote,
          before,
          partial,
          full,
          earnings: await summary(state.creator, 0),
        };
      });
  for (const row of moneyCases)
    await run(
      `R1-money-table-dodo-partial-before-recovery-${row.name}`,
      async () => {
        const state = await seed('dodo', {...row, booking: false, count: 0});
        const pricingSnapshot = {...state.record.pricingSnapshot};
        delete pricingSnapshot.commissionAmount;
        current.record = await commerce
          .patch(state.record._id)
          .set({pricingSnapshot})
          .commit();
        current.payment.refunds = [
          {
            refund_id: `refund-${state.key}`,
            payment_id: current.payment.payment_id,
            status: 'succeeded',
            currency: 'USD',
            amount: Math.round(row.refund * 100),
          },
        ];
        current.payment.refund_status = 'partial';
        const response = await webhook();
        assert.equal(response.status, 200, JSON.stringify(response));
        const booking = await read((await read(state.record._id)).bookingId);
        assert.equal(booking.dodoOriginalCommissionAmount, row.original);
        assert.equal(booking.commissionAmount, row.retained);
        return {
          row,
          quote: state.quote,
          booking,
          earnings: await summary(state.creator, row.retained),
        };
      }
    );

  for (const row of moneyCases)
    await run('R1-money-table-dodo-ordinary-checkout-' + row.name, async () => {
      const state = await seed('dodo', {...row, booking: false, count: 0});
      await startDodoCheckout(state);
      assert.equal(
        current.record.pricingSnapshot.commissionAmount,
        row.original
      );
      current.payment.refunds = [
        {
          refund_id: 'refund-' + state.key,
          payment_id: current.payment.payment_id,
          status: 'succeeded',
          currency: 'USD',
          amount: Math.round(row.refund * 100),
        },
      ];
      current.payment.refund_status = 'partial';
      const response = await webhook();
      assert.equal(response.status, 200, JSON.stringify(response));
      const booking = await read((await read(current.record._id)).bookingId);
      assert.equal(booking.requiresReschedule, undefined);
      assert.equal(booking.commissionCalculationVersion, 2);
      assert.equal(booking.dodoOriginalCommissionAmount, row.original);
      assert.equal(booking.commissionAmount, row.retained);
      return {
        row,
        quote: state.quote,
        booking,
        earnings: await summary(state.creator, row.retained),
      };
    });
  await run('R1-money-table-free-coupon', async () => {
    const state = await seed('dodo', {coupon: 100, booking: false, count: 0});
    const response = await startDodoCheckout(state);
    assert.equal(state.quote.effectiveNetAmount, 0);
    assert.equal(state.quote.commissionAmount, 0);
    const booking = await read((await read(current.record._id)).bookingId);
    assert.equal(booking.commissionAmount, 0);
    assert.equal(booking.paymentProvider, 'free');
    return {
      quote: state.quote,
      response,
      booking,
      earnings: await summary(state.creator, 0),
    };
  });
  for (const provider of ['paypal', 'razorpay'])
    await run('R1-money-table-cumulative-half-' + provider, async () => {
      const state = await seed(provider, {amount: 0.6, rate: 1.67});
      assert.equal(state.quote.commissionAmount, 0.01);
      assert.equal((await refundCurrent(0.1, 'first')).status, 200);
      assert.equal((await refundCurrent(0.2, 'second')).status, 200);
      const booking = await read(state.record.bookingId);
      assert.equal(booking.refundedAmount, 0.3);
      assert.equal(booking.commissionAmount, 0.01);
      return {booking, earnings: await summary(state.creator, 0.01)};
    });

  for (const kind of [
    'retry',
    'concurrent',
    'conflict',
    'distinct',
    'missing-key',
    'cross-creator',
    'retry-no-date',
    'header',
    'concurrent-distinct',
    'revision-conflict',
  ])
    await run(`R1-payout-record-${kind}`, async () => {
      const state = await seed('dodo');
      const body = {
        referralId: state.creator._id,
        packageType: 'vertex',
        amount: 2,
        paidOn: '2026-10-23T10:00:00.000Z',
        note: 'Fixture transfer',
        payoutId: `transfer-${state.key}`,
      };
      if (kind === 'retry-no-date') delete body.paidOn;
      const submit = (value) => {
        if (kind !== 'header')
          return post('/api/ref/updatePayments', value, {
            'x-admin-key': 'fixture-admin',
          });
        const {payoutId, ...payload} = value;
        return post('/api/ref/updatePayments', payload, {
          'x-admin-key': 'fixture-admin',
          'idempotency-key': payoutId,
        });
      };
      if (kind === 'missing-key') {
        delete body.payoutId;
        const response = await submit(body);
        assert.equal(response.status, 400);
        assert.equal(
          (await documents.getDocument(state.creator._id)).vertexPayments
            ?.length || 0,
          0
        );
        return {response};
      }
      let conflicted = false;
      if (kind === 'revision-conflict')
        fixture.setRequestHook(async (phase, request) => {
          if (
            phase !== 'before' ||
            conflicted ||
            !request.body?.p_mutations?.some(
              (mutation) => mutation.document?._type === 'creatorPayout'
            )
          )
            return;
          conflicted = true;
          await documents
            .patch(state.creator._id)
            .set({notes: 'Fixture concurrent write'})
            .commit();
        });
      let responses;
      if (['concurrent', 'concurrent-distinct'].includes(kind))
        responses = await Promise.all([
          submit(body),
          submit({
            ...body,
            payoutId:
              kind === 'concurrent-distinct'
                ? `${body.payoutId}-second`
                : body.payoutId,
          }),
        ]);
      else {
        responses = [await submit(body)];
        if (kind === 'cross-creator') {
          const other = await seed('dodo');
          responses.push(
            await submit({...body, referralId: other.creator._id})
          );
          current = state;
        } else
          responses.push(
            await submit({
              ...body,
              ...(kind === 'conflict' ? {amount: 3} : {}),
              ...(kind === 'distinct'
                ? {payoutId: `${body.payoutId}-second`}
                : {}),
            })
          );
      }
      assert.equal(responses[0].status, 200, JSON.stringify(responses));
      assert.equal(
        responses[1].status,
        ['conflict', 'cross-creator'].includes(kind) ? 409 : 200,
        JSON.stringify(responses)
      );
      const creator = await documents.getDocument(state.creator._id);
      const expected = ['distinct', 'concurrent-distinct'].includes(kind)
        ? 2
        : 1;
      assert.equal(creator.vertexPayments.length, expected);
      assert.equal(creator.paidTotal, 2 * expected);
      assert.equal(creator.owedTotal, 5.5 - 2 * expected);
      const receipts =
        await sql`select payload from migration.source_documents where document_type='creatorPayout' and not tombstoned and payload->>'referralId'=${state.creator._id}`;
      assert.equal(receipts.length, expected);
      const ledger =
        await sql`select legacy_sanity_id, amount_subunits, currency from commerce.referral_ledger where legacy_sanity_id=any(${receipts.map((receipt) => receipt.payload._id)})`;
      assert.equal(ledger.length, expected);
      assert.ok(
        ledger.every(
          (entry) =>
            String(entry.amount_subunits) === '200' && entry.currency === 'USD'
        )
      );
      if (kind === 'revision-conflict') assert.equal(conflicted, true);
      return {responses, creator, receipts, ledger, conflicted};
    });

  for (const kind of ['identical', 'changed', 'missing']) {
    await run(`payout-final-conflict-${kind}`, async () => {
      const state = await seed('dodo');
      const body = {
        referralId: state.creator._id,
        packageType: 'vertex',
        amount: 2,
        paidOn: '2026-10-23T10:00:00.000Z',
        payoutId: `transfer-${state.key}`,
      };
      const submit = (value) =>
        post('/api/ref/updatePayments', value, {
          'x-admin-key': 'fixture-admin',
        });
      let races = 0;
      let concurrentResponse;
      fixture.setRequestHook(async (phase, request) => {
        if (
          phase !== 'before' ||
          !request.body?.p_mutations?.some(
            (mutation) => mutation.document?._type === 'creatorPayout'
          )
        )
          return;
        races += 1;
        if (races < 3 || kind === 'missing') {
          await documents
            .patch(state.creator._id)
            .set({
              notes: `Fixture concurrent revision ${races}`,
            })
            .commit();
        } else {
          fixture.setRequestHook(null);
          concurrentResponse = await submit({
            ...body,
            amount: kind === 'changed' ? 3 : 2,
          });
          assert.equal(
            concurrentResponse.status,
            200,
            JSON.stringify(concurrentResponse)
          );
        }
      });
      const response = await submit(body);
      assert.equal(races, 3);
      assert.equal(
        response.status,
        kind === 'identical' ? 200 : 409,
        JSON.stringify(response)
      );
      if (kind !== 'identical') {
        assert.equal(
          response.body.error,
          kind === 'changed'
            ? 'This payoutId already records a different transfer.'
            : 'Payment data changed while saving. Please try again.'
        );
      }
      const creator = await documents.getDocument(state.creator._id);
      const count = kind === 'missing' ? 0 : 1;
      const amount = kind === 'changed' ? 3 : kind === 'identical' ? 2 : 0;
      assert.equal(creator.vertexPayments?.length || 0, count);
      assert.equal(creator.paidTotal || 0, amount);
      if (count) assert.equal(creator.owedTotal, 5.5 - amount);
      const receipts =
        await sql`select payload from migration.source_documents where document_type='creatorPayout' and not tombstoned and payload->>'referralId'=${state.creator._id}`;
      assert.equal(receipts.length, count);
      const ledger =
        await sql`select amount_subunits, currency from commerce.referral_ledger where legacy_sanity_id=any(${receipts.map((receipt) => receipt.payload._id)})`;
      assert.equal(ledger.length, count);
      if (count) {
        assert.equal(String(ledger[0].amount_subunits), String(amount * 100));
        assert.equal(ledger[0].currency, 'USD');
      }
      return {response, concurrentResponse, races, creator, receipts, ledger};
    });
  }

  const legacyCases = moneyCases.filter(
    (row) => row.legacyOriginal !== undefined
  );
  const seedLegacy = async (provider, row, stored) => {
    const state = await seed(provider, row);
    const pricingSnapshot = {...state.record.pricingSnapshot};
    delete pricingSnapshot.commissionAmount;
    current.record = await commerce
      .patch(state.record._id)
      .set({pricingSnapshot})
      .commit();
    let patch = commerce
      .patch(state.record.bookingId)
      .unset([
        'commissionCalculationVersion',
        'dodoOriginalCommissionAmount',
        'originalCommissionAmount',
      ]);
    patch =
      stored === 'missing'
        ? patch.unset(['commissionAmount'])
        : patch.set({commissionAmount: stored === 'null' ? null : 0});
    await patch.commit();
    await documents
      .patch(state.creator._id)
      .set({
        vertexPayments: [
          {
            _key: 'historical',
            _type: 'paymentLogVertex',
            amount: 0.01,
            paidOn: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
      .commit();
    return state;
  };
  for (const provider of ['paypal', 'razorpay', 'dodo'])
    for (const row of legacyCases)
      for (const stored of ['zero', 'null', 'missing'])
        await run(
          `legacy-original-refund-${provider}-${row.name}-${stored}`,
          async () => {
            const state = await seedLegacy(provider, row, stored);
            const before = await summary(state.creator, row.legacyOriginal);
            const response = await refundCurrent(row.refund, 'legacy');
            assert.equal(response.status, 200, JSON.stringify(response));
            const booking = await read(state.record.bookingId);
            assert.equal(
              booking[
                provider === 'dodo'
                  ? 'dodoOriginalCommissionAmount'
                  : 'originalCommissionAmount'
              ],
              row.legacyOriginal
            );
            assert.equal(booking.commissionAmount, row.legacyRetained);
            const replay = await webhook(
              provider === 'paypal'
                ? 'PAYMENT.CAPTURE.REFUNDED'
                : provider === 'razorpay'
                  ? 'refund.processed'
                  : 'refund.succeeded'
            );
            assert.equal(replay.status, 200, JSON.stringify(replay));
            assert.equal(
              (await read(booking._id)).commissionAmount,
              row.legacyRetained
            );
            return {
              row,
              before,
              booking,
              earnings: await summary(state.creator, row.legacyRetained),
            };
          }
        );
  for (const row of legacyCases)
    for (const stored of ['zero', 'null', 'missing'])
      for (const restored of ['dispute_won', 'dispute_cancelled'])
        await run(
          `legacy-original-dispute-${row.name}-${stored}-${restored}`,
          async () => {
            const state = await seedLegacy('dodo', row, stored);
            const before = await summary(state.creator, row.legacyOriginal);
            current.payment.disputes = [dispute('dispute_opened')];
            assert.equal((await webhook('dispute.opened')).status, 200);
            const opened = await read(state.record.bookingId);
            assert.equal(opened.dodoOriginalCommissionAmount, row.legacyExact);
            assert.equal(opened.commissionAmount, 0);
            await summary(state.creator, 0);
            current.payment.disputes = [dispute(restored)];
            assert.equal((await webhook('dispute.resolved')).status, 200);
            const booking = await read(state.record.bookingId);
            assert.equal(booking.commissionAmount, row.legacyExact);
            assert.equal(booking.commissionCalculationVersion, undefined);
            return {
              row,
              before,
              opened,
              booking,
              earnings: await summary(state.creator, row.legacyOriginal),
            };
          }
        );
  for (const provider of ['paypal', 'razorpay', 'dodo'])
    await run(`legacy-original-v2-zero-${provider}`, async () => {
      const state = await seed(provider);
      const pricingSnapshot = {...state.record.pricingSnapshot};
      delete pricingSnapshot.commissionAmount;
      current.record = await commerce
        .patch(state.record._id)
        .set({pricingSnapshot})
        .commit();
      await commerce
        .patch(state.record.bookingId)
        .set({commissionAmount: 0})
        .commit();
      assert.equal((await refundCurrent(20, 'zero')).status, 200);
      const booking = await read(state.record.bookingId);
      assert.equal(booking.commissionAmount, 0);
      return {booking, earnings: await summary(state.creator, 0)};
    });
  for (const marker of [0, null])
    for (const mode of ['refund', 'dispute'])
      await run(`legacy-original-frozen-dodo-${marker}-${mode}`, async () => {
        const state = await seedLegacy('dodo', legacyCases[0], 'zero');
        await commerce
          .patch(state.record.bookingId)
          .set({dodoOriginalCommissionAmount: marker})
          .commit();
        await summary(state.creator, 0);
        if (mode === 'refund')
          assert.equal((await refundCurrent(20, 'zero')).status, 200);
        else {
          current.payment.disputes = [dispute('dispute_opened')];
          assert.equal((await webhook('dispute.opened')).status, 200);
          current.payment.disputes = [dispute('dispute_won')];
          assert.equal((await webhook('dispute.won')).status, 200);
        }
        const booking = await read(state.record.bookingId);
        assert.equal(booking.dodoOriginalCommissionAmount, 0);
        assert.equal(booking.commissionAmount, 0);
        return {booking, earnings: await summary(state.creator, 0)};
      });

  for (const restored of ['dispute_won', 'dispute_cancelled'])
    await run(`legacy-original-fraction-restoration-${restored}`, async () => {
      const first = await seedLegacy(
        'dodo',
        {amount: 9.99, rate: 0.04},
        'zero'
      );
      const second = await seedLegacy(
        'dodo',
        {amount: 9.99, rate: 0.04},
        'zero'
      );
      await commerce
        .patch(second.record.bookingId)
        .set({
          referral: {_type: 'reference', _ref: first.creator._id},
          referralCode: first.key,
        })
        .commit();
      current = first;
      const sync = async () => {
        const response = await fetch(`${origin}/api/ref/cronSyncAll`, {
          headers: {authorization: 'Bearer fixture'},
        });
        assert.equal(response.status, 200);
        const creator = await documents.getDocument(first.creator._id);
        return {
          earned: creator.earnedTotal,
          paid: creator.paidTotal,
          owed: creator.owedTotal,
        };
      };
      const before = await sync();
      assert.deepEqual(before, {earned: 0.01, paid: 0.01, owed: 0});
      current.payment.disputes = [dispute('dispute_opened')];
      assert.equal((await webhook('dispute.opened')).status, 200);
      await summary(first.creator, 0);
      current.payment.disputes = [dispute(restored)];
      assert.equal((await webhook('dispute.resolved')).status, 200);
      const after = await sync();
      assert.deepEqual(after, before);
      return {
        before,
        after,
        booking: await read(first.record.bookingId),
        earnings: await summary(first.creator, 0.01),
      };
    });

  await run('R1-migration-preserves-settled-source-and-cron', async () => {
    const {functionDefinition} = await import(
      './lib/sweep-postgres-fixture.mjs'
    );
    await sql.unsafe(
      functionDefinition(
        '20260712092342_close_supabase_port_and_unified_auth.sql',
        'public.roo_referral_earnings_summary'
      ).replace(
        "and (booking.booking_payload->>'commissionAmount')::numeric <> 0",
        "and ((booking.booking_payload->>'commissionAmount')::numeric <> 0 or booking.booking_payload ? 'dodoOriginalCommissionAmount')"
      )
    );
    const cohorts = [];
    for (const settled of [true, false]) {
      const first = await seed('dodo', {amount: 12.51, rate: 0.04});
      const second = await seed('dodo', {amount: 12.51, rate: 0.04});
      await commerce
        .patch(first.record.bookingId)
        .unset(['commissionAmount', 'commissionCalculationVersion'])
        .commit();
      await commerce
        .patch(second.record.bookingId)
        .unset(['commissionAmount', 'commissionCalculationVersion'])
        .set({
          referral: {_type: 'reference', _ref: first.creator._id},
          referralCode: first.key,
        })
        .commit();
      if (settled)
        await documents
          .patch(first.creator._id)
          .set({
            vertexPayments: [
              {
                _key: 'historical',
                _type: 'paymentLogVertex',
                amount: 0.01,
                paidOn: '2026-01-01T00:00:00.000Z',
              },
            ],
          })
          .commit();
      cohorts.push({
        settled,
        first,
        ids: [first.record.bookingId, second.record.bookingId],
      });
    }
    const cron = async () => {
      const response = await fetch(`${origin}/api/ref/cronSyncAll`, {
        headers: {authorization: 'Bearer fixture'},
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    await cron();
    const settled = cohorts[0];
    const historicalIds = cohorts.flatMap(({first, ids}) => [
      first.creator._id,
      ...ids,
    ]);
    const before =
      await sql`select legacy_sanity_id, source_revision, source_hash, payload from migration.source_documents where legacy_sanity_id=any(${historicalIds}) order by legacy_sanity_id`;
    const versionsBefore =
      await sql`select legacy_sanity_id, payload->>'commissionCalculationVersion' as version from migration.source_documents where document_type='booking' and not tombstoned order by legacy_sanity_id`;
    const projection = await applyCommissionMigration({traceProjections: true});
    const versionsAfter =
      await sql`select legacy_sanity_id, payload->>'commissionCalculationVersion' as version from migration.source_documents where document_type='booking' and not tombstoned order by legacy_sanity_id`;
    assert.deepEqual(versionsAfter, versionsBefore);
    assert.equal(projection.calls.length, 0);
    await cron();
    const after =
      await sql`select legacy_sanity_id, source_revision, source_hash, payload from migration.source_documents where legacy_sanity_id=any(${historicalIds}) order by legacy_sanity_id`;
    assert.deepEqual(after, before);
    const paidCreator = await documents.getDocument(settled.first.creator._id);
    assert.equal(paidCreator.earnedTotal, 0.01);
    assert.equal(paidCreator.owedTotal, 0);
    await summary(settled.first.creator, 0.01);
    const unpaidCreator = await documents.getDocument(
      cohorts[1].first.creator._id
    );
    assert.equal(unpaidCreator.earnedTotal, 0.01);
    assert.equal(unpaidCreator.paidTotal, 0);
    assert.equal(unpaidCreator.owedTotal, 0.01);
    await summary(cohorts[1].first.creator, 0.01);
    const newBookings = [];
    for (let index = 0; index < 2; index++) {
      const next = await seed('dodo', {amount: 9.99, rate: 0.04});
      newBookings.push(
        await commerce
          .patch(next.record.bookingId)
          .set({
            referral: {_type: 'reference', _ref: settled.first.creator._id},
            referralCode: settled.first.key,
          })
          .commit()
      );
    }
    await summary(settled.first.creator, 0.01);
    current = cohorts[1].first;
    return {before, after, paidCreator, unpaidCreator, newBookings, projection};
  });

  await run('review-r2-unpaid-historical-balance', async () => {
    const first = await seed('dodo', {amount: 12.51, rate: 0.04});
    const second = await seed('dodo', {amount: 12.51, rate: 0.04});
    await commerce
      .patch(first.record.bookingId)
      .unset(['commissionAmount', 'commissionCalculationVersion'])
      .commit();
    await commerce
      .patch(second.record.bookingId)
      .unset(['commissionAmount', 'commissionCalculationVersion'])
      .set({
        referral: {_type: 'reference', _ref: first.creator._id},
        referralCode: first.key,
      })
      .commit();
    const {functionDefinition} = await import(
      './lib/sweep-postgres-fixture.mjs'
    );
    await sql.unsafe(
      functionDefinition(
        '20260712092342_close_supabase_port_and_unified_auth.sql',
        'public.roo_referral_earnings_summary'
      ).replace(
        "and (booking.booking_payload->>'commissionAmount')::numeric <> 0",
        "and ((booking.booking_payload->>'commissionAmount')::numeric <> 0 or booking.booking_payload ? 'dodoOriginalCommissionAmount')"
      )
    );
    const cron = async () => {
      const response = await fetch(`${origin}/api/ref/cronSyncAll`, {
        headers: {authorization: 'Bearer fixture'},
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const ids = [first.record.bookingId, second.record.bookingId];
    const bookings = () =>
      sql`select legacy_sanity_id, source_revision, source_hash, payload from migration.source_documents where legacy_sanity_id=any(${ids}) order by legacy_sanity_id`;
    const preSync = await cron();
    const before = await documents.getDocument(first.creator._id);
    assert.equal(before.earnedTotal, 0.01);
    assert.equal(before.paidTotal, 0);
    assert.equal(before.owedTotal, 0.01);
    const beforeEarnings = await summary(first.creator, 0.01);
    const beforeBookings = await bookings();
    await applyCommissionMigration();
    const postSync = await cron();
    const after = await documents.getDocument(first.creator._id);
    const afterBookings = await bookings();
    const exactCents = {
      beforeEarned: Math.round(before.earnedTotal * 100),
      beforePaid: Math.round(before.paidTotal * 100),
      beforeOwed: Math.round(before.owedTotal * 100),
      afterEarned: Math.round(after.earnedTotal * 100),
      afterPaid: Math.round(after.paidTotal * 100),
      afterOwed: Math.round(after.owedTotal * 100),
    };
    evidence.unpaidHistoricalBalance = {
      preSync,
      postSync,
      before,
      after,
      beforeEarnings,
      beforeBookings,
      afterBookings,
      exactCents,
    };
    assert.equal(exactCents.afterEarned, exactCents.beforeEarned);
    assert.equal(exactCents.afterPaid, exactCents.beforePaid);
    assert.equal(exactCents.afterOwed, exactCents.beforeOwed);
    assert.deepEqual(afterBookings, beforeBookings);
    assert.deepEqual(after, before);
    evidence.unpaidHistoricalBalance.afterEarnings = await summary(
      first.creator,
      0.01
    );
    return evidence.unpaidHistoricalBalance;
  });

  await run('R1-paid-legacy-zero-preserves-marker-presence', async () => {
    const first = await seed('dodo', {amount: 12.51, rate: 0.04});
    const second = await seed('dodo', {amount: 12.51, rate: 0.04});
    await documents
      .patch(first.creator._id)
      .set({
        vertexPayments: [
          {
            _key: 'historical',
            _type: 'paymentLogVertex',
            amount: 0.01,
            paidOn: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
      .commit();
    await commerce
      .patch(first.record.bookingId)
      .unset(['commissionCalculationVersion', 'dodoOriginalCommissionAmount'])
      .set({commissionAmount: 0})
      .commit();
    await commerce
      .patch(second.record.bookingId)
      .unset(['commissionCalculationVersion'])
      .set({
        commissionAmount: 0,
        dodoOriginalCommissionAmount: null,
        referral: {_type: 'reference', _ref: first.creator._id},
        referralCode: first.key,
      })
      .commit();
    return {
      bookings: [
        await read(first.record.bookingId),
        await read(second.record.bookingId),
      ],
      earnings: await summary(first.creator, 0.01),
    };
  });

  await run('empty-code-review-history', async () => {
    const {functionDefinition} = await import(
      './lib/sweep-postgres-fixture.mjs'
    );
    const historical = [await seed('dodo'), await seed('dodo')];
    const creatorId = historical[0].creator._id;
    for (const state of historical) {
      await commerce
        .patch(state.record.bookingId)
        .unset(['commissionCalculationVersion'])
        .set({referralCode: ''})
        .commit();
    }
    await documents
      .patch(creatorId)
      .set({
        slug: {_type: 'slug', current: ''},
        vertexPayments: [
          {
            _key: 'historical-empty-code-payment',
            _type: 'paymentLogVertex',
            amount: 2,
            paidOn: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
      .commit();
    await sql.unsafe(
      functionDefinition(
        '20260712092342_close_supabase_port_and_unified_auth.sql',
        'public.roo_referral_earnings_summary'
      )
    );
    const cron = async () => {
      const response = await fetch(`${origin}/api/ref/cronSyncAll`, {
        headers: {authorization: 'Bearer fixture'},
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(
        result.results.find((row) => row.id === creatorId).pending,
        undefined
      );
      return result;
    };
    const historicalIds = [
      creatorId,
      ...historical.map((state) => state.record.bookingId),
    ];
    const snapshot = () => sql`
      select legacy_sanity_id, source_revision, source_hash, payload
      from migration.source_documents
      where legacy_sanity_id=any(${historicalIds}) order by legacy_sanity_id`;
    const preSync = await cron();
    const before = await snapshot();
    const creatorBefore = await documents.getDocument(creatorId);
    assert.equal(creatorBefore.earnedTotal, 11);
    assert.equal(creatorBefore.paidTotal, 2);
    assert.equal(creatorBefore.owedTotal, 9);

    const newBookings = [];
    for (const code of ['', null, undefined]) {
      for (const version of [2, '2']) {
        const state = await seed('dodo');
        const patch = commerce.patch(state.record.bookingId).set({
          commissionCalculationVersion: version,
          status: version === 2 ? 'captured' : 'completed',
        });
        if (code === undefined) patch.unset(['referralCode']);
        else patch.set({referralCode: code});
        await patch.commit();
        newBookings.push(await read(state.record.bookingId));
      }
    }
    const recovery = await seed('dodo', {booking: false});
    await commerce
      .patch(recovery.record._id)
      .set({
        bookingPayload: {...recovery.record.bookingPayload, referralCode: ''},
        pricingSnapshot: {
          ...recovery.record.pricingSnapshot,
          effectiveReferralCode: '',
        },
      })
      .commit();
    const capture = await webhook();
    assert.equal(capture.status, 200, JSON.stringify(capture));
    const recovered = await read((await read(recovery.record._id)).bookingId);
    assert.equal(recovered.commissionCalculationVersion, 2);
    assert.equal(recovered.referralCode, '');
    assert.equal(recovered.referral._ref, recovery.creator._id);
    assert.equal(recovered.commissionAmount, 5.5);
    newBookings.push(recovered);
    const projection = await applyCommissionMigration({traceProjections: true});
    assert.equal(projection.calls.length, 0);
    const summaries = [];
    for (const code of ['', null, undefined]) {
      const args = {referralId: creatorId, referralCode: code};
      const native = await earnings.fetchReferralEarnings({
        client: commerce,
        ...args,
      });
      assert.equal(native.total, 5.5);
      for (const result of [null, undefined]) {
        const fallback = await earnings.fetchReferralEarnings({
          client: {
            fetch: commerce.fetch.bind(commerce),
            referralEarnings: async () => result,
          },
          ...args,
        });
        assert.deepEqual(fallback, native);
        summaries.push({requestedCode: code ?? null, native, fallback});
      }
    }
    const postSync = await cron();
    const after = await snapshot();
    assert.notDeepEqual(after, before);
    const rebuilt = {};
    for (const rpc of [
      'roo_project_operational_shadow',
      'roo_refresh_operational_shadow',
    ]) {
      assert.equal((await fixture.client.rpc(rpc)).error, null);
      await cron();
      rebuilt[rpc] = await snapshot();
      assert.deepEqual(rebuilt[rpc], after);
    }

    const idOnly = await seed('dodo');
    await commerce
      .patch(idOnly.record.bookingId)
      .set({
        referralCode: '',
        referral: {_type: 'reference', _ref: creatorId},
      })
      .commit();
    const idControl = await summary(
      {...historical[0].creator, slug: {current: ''}},
      11
    );
    await commerce
      .patch(idOnly.record.bookingId)
      .set({
        referral: {_type: 'reference', _ref: idOnly.creator._id},
      })
      .commit();
    await commerce
      .patch(idOnly.record.bookingId)
      .unset(['referral'])
      .set({referralCode: idOnly.key.toUpperCase()})
      .commit();
    const codeControl = await summary(idOnly.creator, 5.5);
    await cron();
    assert.deepEqual(await snapshot(), after);
    const creatorAfter = await documents.getDocument(creatorId);
    current = historical[0];
    return {
      before,
      after,
      creatorBefore,
      creatorAfter,
      newBookings,
      preSync,
      postSync,
      projection,
      summaries,
      rebuilt,
      idControl,
      codeControl,
      historicalCorrection: 'ROO-729 unpaid review hold; paid logs preserved',
    };
  });

  await run('money-rules-511-self-booking-and-recovery', async () => {
    const saved = [];
    for (const buyer of ['C.Reator+games@GMAIL.COM', 'creator@gmail.com', 'c.rea.tor+play@googlemail.com']) {
      const state = await seed('dodo', {booking: false, discount: 10});
      await documents.patch(state.creator._id).set({creatorEmail: 'creator@gmail.com'}).commit();
      current.record = await commerce.patch(state.record._id).set({
        bookingPayload: {...state.record.bookingPayload, email: buyer},
      }).commit();
      if (buyer === 'creator@gmail.com') await startCheckout(state, buyer);
      const result = await webhook();
      assert.equal(result.status, 200, JSON.stringify(result));
      const booking = await read((await read(current.record._id)).bookingId);
      if (buyer === 'creator@gmail.com') assert.equal(booking.requiresReschedule, undefined);
      assert.equal(booking.commissionAmount, 0);
      assert.equal(booking.commissionPercent, 0);
      assert.equal(booking.netAmount, state.quote.effectiveNetAmount);
      assert.equal((await webhook()).status, 200);
      current.payment.refund_status = 'partial';
      current.payment.refunds = [{refund_id: 'self-refund-' + state.key,
        payment_id: current.payment.payment_id, amount: 100, currency: 'USD', status: 'succeeded'}];
      assert.equal((await webhook('refund.succeeded')).status, 200);
      const refunded = await read(booking._id);
      assert.equal(refunded.commissionAmount, 0);
      assert.equal(refunded.dodoOriginalCommissionAmount, 0);
      saved.push({booking, refunded});
    }
    return {saved};
  });

  await run('money-rules-512-pending-creator-and-code-reuse', async () => {
    const state = await seed('dodo', {booking: false, count: 0});
    await documents.patch(state.creator._id).set({registrationStatus: 'pending_email', creatorEmail: 'creator@example.invalid'}).commit();
    const validResponse = await fetch(`${origin}/api/ref/validateReferral?code=${state.key}`);
    const valid = {status: validResponse.status, body: await validResponse.json()};
    assert.equal(valid.body.ok, true, JSON.stringify(valid));
    const quoted = await post('/api/payment/quote', {bookingPayload: state.record.bookingPayload});
    assert.equal(quoted.status, 200, JSON.stringify(quoted));
    assert.equal(quoted.body.quote.commissionPercent, 10);
    const {resolvePaymentQuote} = await import('../src/server/api/ref/pricing.js');
    const quote = await resolvePaymentQuote({...state.record.bookingPayload, client: commerce});
    assert.equal(quote.effectiveReferralId, state.creator._id);
    assert.equal(quote.commissionAmount, 5.5);
    current.record = await commerce.patch(state.record._id).set({pricingSnapshot: {
      ...state.record.pricingSnapshot, ...quote, commissionPercent: quote.effectiveCommissionPercent,
    }}).commit();
    assert.equal((await webhook()).status, 200);
    const booking = await read((await read(state.record._id)).bookingId);
    assert.equal(booking.referral._ref, state.creator._id);
    assert.equal(booking.commissionAmount, 5.5);
    const sync = () => post('/api/ref/syncPayouts', {referralId: state.creator._id}, {'x-admin-key': 'fixture-admin'});
    const pending = await sync();
    assert.equal(pending.body.owed.total, 0, JSON.stringify(pending));
    assert.equal(pending.body.underReview.total, 5.5);
    const payout = await post('/api/ref/updatePayments', {referralId: state.creator._id, packageType: 'vertex', amount: 1, payoutId: 'pending-fixture-transfer'}, {'x-admin-key': 'fixture-admin'});
    assert.equal(payout.status, 409);
    await documents.patch(state.creator._id).set({registrationStatus: 'active', currentCommissionPercent: 30, slug: {current: ''}}).commit();
    const verified = await sync();
    assert.equal(verified.body.owed.total, 5.5);
    const replacement = await documents.create({_id: `referral.reused-${state.key}`, _type: 'referral', registrationStatus: 'active', slug: {current: state.key}, currentCommissionPercent: 50});
    const replacementEarnings = await summary(replacement, 0);
    const expired = await seed('dodo', {booking: false, count: 0});
    await documents.patch(expired.creator._id).set({registrationStatus: 'pending_email'}).commit();
    await documents.delete(expired.creator._id);
    const reused = await documents.create({_id: 'referral.reclaimed-' + expired.key, _type: 'referral', registrationStatus: 'active', slug: {current: expired.key}});
    assert.equal((await webhook()).status, 200);
    const expiredBooking = await read((await read(expired.record._id)).bookingId);
    assert.equal(expiredBooking.referral._ref, expired.creator._id);
    assert.equal(expiredBooking.commissionAmount, 5.5);
    await summary(reused, 0);

    return {booking, pending: pending.body, verified: verified.body, payout, replacementEarnings};
  });

  await run('money-rules-543-late-coupon-alert', async () => {
    const state = await seed('dodo', {booking: false, count: 0, coupon: 20});
    await startCheckout(state);
    const {releaseCouponReservation} = await import('../src/server/api/ref/couponReservations.js');
    const redemptionSource = await read(current.record.couponReservationId);
    const reserved = {redemption: redemptionSource, coupon: await read(redemptionSource.coupon._ref)};
    await releaseCouponReservation({client: commerce, redemptionId: reserved.redemption._id});
    await documents.patch(reserved.coupon._id).set({maxUses: 1, timesUsed: 1, isActive: false}).commit();
    const before = emailRequests.length;
    failCouponAlert = true;
    const result = await webhook();
    assert.equal(result.status, 200, JSON.stringify(result));
    const record = await read(current.record._id), booking = await read(record.bookingId);
    assert.equal(booking.requiresReschedule, undefined);
    assert.equal(booking.netAmount, state.quote.effectiveNetAmount);
    const pendingAlert = await read(reserved.redemption._id);
    assert.equal(pendingAlert.ownerAlertRequired, true);
    assert.equal(pendingAlert.ownerAlertSentAt, undefined);
    const failedRetry = await post('/api/payment/reconcile', {}, {authorization: 'Bearer fixture'});
    assert.equal(failedRetry.status, 200, JSON.stringify(failedRetry));
    assert.equal((await read(reserved.redemption._id)).ownerAlertSentAt, undefined);
    failCouponAlert = false;
    const retry = await post('/api/payment/reconcile', {}, {authorization: 'Bearer fixture'});
    assert.equal(retry.status, 200, JSON.stringify(retry));
    const redemption = await read(reserved.redemption._id);
    assert.equal(redemption.capacityExceededAtRecovery, true);
    assert.ok(redemption.ownerAlertSentAt, JSON.stringify(redemption));
    const alerts = emailRequests.slice(before).filter(row => row.body?.subject === 'Paid checkout exceeded a coupon limit');
    assert.equal(alerts.length, 2);
    assert.equal(alerts[0].headers['idempotency-key'], alerts[1].headers['idempotency-key']);
    assert.equal(alerts[0].body.to, 'owner@example.invalid');
    assert.equal((await webhook()).status, 200);
    assert.equal(emailRequests.filter(row => row.body?.subject === 'Paid checkout exceeded a coupon limit').length, 2);
    return {booking, redemption, alerts};
  });

  await run('money-rules-543-alert-backlog', async () => {
    const state = await seed('dodo', {coupon: 20});
    const couponId = 'coupon.' + state.key;
    const history = Array.from({length: 1001}, (_, index) => ({
      _id: 'couponRedemption.000' + String(index).padStart(4, '0'),
      _rev: 'seed', _type: 'couponRedemption', status: 'consumed',
      coupon: {_ref: couponId}, ownerId: 'old-' + index,
      ownerAlertRequired: false,
    }));
    const pending = Array.from({length: 201}, (_, index) => ({
      _id: 'couponRedemption.zzz' + String(index).padStart(4, '0'),
      _type: 'couponRedemption', status: 'consumed',
      coupon: {_ref: couponId}, ownerId: 'pending-' + index,
      bookingId: state.record.bookingId, ownerAlertRequired: true,
      capacityExceededAtRecovery: true,
    }));
    for (const document of history) await sql`
      insert into migration.source_documents(legacy_sanity_id, document_type, source_revision, source_hash, payload)
      values(${document._id}, 'couponRedemption', 'seed', ${'0'.repeat(64)}, ${sql.json(document)})`;
    for (let index = 0; index < pending.length; index += 50) {
      const transaction = commerce.transaction();
      for (const document of pending.slice(index, index + 50)) transaction.create(document);
      await transaction.commit();
    }
    try {
      const {dispatchCouponAlerts} = await import('../src/server/api/ref/couponAlerts.js');
      if (!baseline) {
        const [permissions] = await sql`select
          has_function_privilege('anon', 'public.roo_pending_coupon_alerts(integer)', 'execute') as anon,
          has_function_privilege('authenticated', 'public.roo_pending_coupon_alerts(integer)', 'execute') as authenticated,
          has_function_privilege('service_role', 'public.roo_pending_coupon_alerts(integer)', 'execute') as service`;
        assert.deepEqual(permissions, {anon: false, authenticated: false, service: true});
      }
      failCouponAlert = true;
      await dispatchCouponAlerts({client: commerce, redemptionId: pending.at(-1)._id});
      assert.equal((await read(pending.at(-1)._id)).ownerAlertSentAt, undefined);
      failCouponAlert = false;
      failCouponAlertKey = 'coupon-capacity/' + crypto.createHash('sha256').update(pending[0]._id).digest('hex');
      for (let batch = 0; batch < Math.ceil(pending.length / 25); batch++) {
        const beforeBatch = emailRequests.length;
        const retry = await post('/api/payment/reconcile', {}, {authorization: 'Bearer fixture'});
        assert.equal(retry.status, 200, JSON.stringify(retry));
        const count = emailRequests.slice(beforeBatch).filter(row => row.body.subject === 'Paid checkout exceeded a coupon limit').length;
        assert.ok(count <= 25, 'Reconciliation attempted ' + count + ' alerts in one invocation');
      }
      assert.equal((await read(pending[0]._id)).ownerAlertSentAt, undefined);
      assert.ok((await read(pending.at(-1)._id)).ownerAlertSentAt);
      failCouponAlertKey = '';
      assert.equal((await post('/api/payment/reconcile', {}, {authorization: 'Bearer fixture'})).status, 200);
      const sent = [];
      for (const document of pending) {
        const row = await read(document._id);
        assert.ok(row.ownerAlertSentAt, document._id + ' was not delivered');
        assert.equal(row.ownerAlertRequired, false);
        sent.push(row._id);
      }
      return {historicalRows: history.length, deliveredPendingRows: sent.length,
        first: sent[0], last: sent.at(-1), firstAttemptFailed: true};
    } finally {
      failCouponAlert = false;
      failCouponAlertKey = '';
      for (const document of pending) await commerce.delete(document._id);
      await sql`delete from migration.source_documents where legacy_sanity_id=any(${history.map(row => row._id)})`;
    }
  });

  await run('money-rules-543-slow-alert-payment-recovery', async () => {
    const payments = [];
    for (let index = 0; index < 3; index++) {
      const payment = await seed('dodo', {booking: false, count: 0, coupon: 20});
      await startCheckout(payment);
      payment.record = await commerce.patch(payment.record._id).set({lastAttemptAt: new Date(Date.now() - 120000).toISOString()}).commit();
      const {releaseCouponReservation} = await import('../src/server/api/ref/couponReservations.js');
      await releaseCouponReservation({client: commerce, redemptionId: payment.record.couponReservationId});
      await documents.patch(`coupon.${payment.key}`).set({maxUses: 1, timesUsed: 1, isActive: false}).commit();
      payments.push(payment);
    }
    await documents.patch('6d8a3646-0ed2-44b5-ad45-c5c9d578126a').set({
      dateSlots: payments.map(payment => ({date: payment.record.bookingPayload.startTimeUTC.slice(0, 10), times: ['15:30']})),
    }).commit();
    const pending = ['first', 'second'].map(label => ({
      _id: `couponRedemption.slow-${current.key}-${label}`, _type: 'couponRedemption',
      status: 'consumed', coupon: {_ref: 'coupon.slow-fixture'},
      ownerId: label, bookingId: `booking.alert-${label}`, ownerAlertRequired: true,
    }));
    for (const row of pending) await commerce.create(row);
    const before = emailRequests.length;
    const abortedBefore = abortedCouponAlerts;
    let reconciliation;
    try {
      pauseCouponAlerts = true;
      const started = Date.now();
      reconciliation = post('/api/payment/reconcile', {}, {authorization: 'Bearer fixture'});
      const deadline = Date.now() + 15000;
      while (!pausedCouponAlerts.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(pausedCouponAlerts.size, 1, 'The local email provider must hold the alert response open.');
      const recovered = [];
      for (const payment of payments) {
        const record = await read(payment.record._id);
        assert.ok(record.bookingId, 'Every paid booking must be committed before the stalled alert response is released.');
        const booking = await read(record.bookingId);
        assert.equal(booking.status, 'captured');
        assert.equal(booking.requiresReschedule, undefined);
        assert.equal(booking.netAmount, payment.quote.effectiveNetAmount);
        recovered.push({record, booking});
      }
      const paymentRecoveryObservedMs = Date.now() - started;
      assert.ok(paymentRecoveryObservedMs < 20000);
      const result = await reconciliation;
      const elapsedMs = Date.now() - started;
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.ok(elapsedMs < 20000, `Email delivery blocked reconciliation for ${elapsedMs}ms.`);
      assert.equal(abortedCouponAlerts - abortedBefore, 1, 'The HTTP email attempt must be cancelled, not left running.');
      const alertIds = [...pending.map(row => row._id), ...payments.map(payment => payment.record.couponReservationId)];
      const held = await Promise.all(alertIds.map(read));
      assert.ok(held.every(row => row.ownerAlertRequired && !row.ownerAlertSentAt));
      assert.equal(emailRequests.slice(before).filter(row => row.body.subject === 'Paid checkout exceeded a coupon limit').length, 1,
        'A timed-out batch must not start another send after its total budget is spent.');
      const attempted = held.find(row => row.ownerAlertLastAttemptAt);
      assert.ok(attempted?.ownerAlertFrom);
      assert.equal(attempted.ownerAlertGeneration, undefined);
      pauseCouponAlerts = false;
      const retried = await post('/api/payment/reconcile', {}, {authorization: 'Bearer fixture'});
      assert.equal(retried.status, 200, JSON.stringify(retried));
      const delivered = await Promise.all(alertIds.map(read));
      assert.ok(delivered.every(row => row.ownerAlertSentAt));
      const attempts = emailRequests.slice(before).filter(row => row.body.subject === 'Paid checkout exceeded a coupon limit');
      const duplicate = attempts.filter(row => row.headers['idempotency-key'] === attempts[0].headers['idempotency-key']);
      assert.equal(duplicate.length, 2);
      assert.deepEqual(duplicate[0].body, duplicate[1].body);
      return {recovered, paymentRecoveryObservedMs, elapsedMs, held, delivered, attempts, cancelledRequests: abortedCouponAlerts - abortedBefore};
    } finally {
      pauseCouponAlerts = false;
      for (const resume of [...pausedCouponAlerts]) resume();
      if (reconciliation) await reconciliation;
      for (const row of pending) await commerce.delete(row._id);
    }
  });

  await run('money-rules-543-rejected-sender-recovery', async () => {
    const state = await seed('dodo', {coupon: 20});
    const {dispatchCouponAlerts} = await import('../src/server/api/ref/couponAlerts.js');
    const id = 'couponRedemption.sender-' + state.key;
    await commerce.create({_id: id, _type: 'couponRedemption', status: 'consumed',
      coupon: {_ref: 'coupon.' + state.key}, ownerId: id,
      bookingId: state.record.bookingId, ownerAlertRequired: true});
    const originalFrom = process.env.FROM_EMAIL;
    const before = emailRequests.length;
    try {
      process.env.FROM_EMAIL = 'unverified@example.invalid';
      await dispatchCouponAlerts({client: commerce, redemptionId: id});
      const rejected = await read(id);
      assert.equal(rejected.ownerAlertRequired, true);
      assert.equal(rejected.ownerAlertFrom, undefined);
      assert.equal(rejected.ownerAlertGeneration, 1);
      process.env.FROM_EMAIL = originalFrom;
      await dispatchCouponAlerts({client: commerce, redemptionId: id});
      const delivered = await read(id);
      assert.ok(delivered.ownerAlertSentAt);
      const attempts = emailRequests.slice(before);
      assert.equal(attempts.length, 2);
      assert.notEqual(attempts[0].headers['idempotency-key'], attempts[1].headers['idempotency-key']);
      const uncertainId = id + '-uncertain';
      await commerce.create({_id: uncertainId, _type: 'couponRedemption', status: 'consumed',
        coupon: {_ref: 'coupon.' + state.key}, ownerId: uncertainId,
        bookingId: state.record.bookingId, ownerAlertRequired: true});
      failCouponAlert = true;
      await dispatchCouponAlerts({client: commerce, redemptionId: uncertainId});
      const uncertain = await read(uncertainId);
      assert.equal(uncertain.ownerAlertFrom, originalFrom);
      process.env.FROM_EMAIL = 'changed@example.invalid';
      failCouponAlert = false;
      await dispatchCouponAlerts({client: commerce, redemptionId: uncertainId});
      const retried = emailRequests.slice(before + 2);
      assert.equal(retried[0].headers['idempotency-key'], retried[1].headers['idempotency-key']);
      assert.equal(retried[0].body.from, retried[1].body.from);
      return {rejected, delivered, uncertain, attempts, uncertainRetry: retried};
    } finally {
      process.env.FROM_EMAIL = originalFrom;
      failCouponAlert = false;
    }
  });

  await run('money-rules-729-seeded-balance-report', async () => {
    const rows = [];
    for (const paid of [0, 2, 8, 15]) {
      const own = await seed('dodo'), foreign = await seed('dodo');
      await commerce.patch(own.record.bookingId).unset(['commissionCalculationVersion']).set({referralCode: ''}).commit();
      await commerce.patch(foreign.record.bookingId).unset(['commissionCalculationVersion']).set({referralCode: ''}).commit();
      const payments = [{_key: `paid-${own.key}`, amount: paid, paidOn: '2026-01-01T00:00:00.000Z'}];
      await documents.patch(own.creator._id).set({slug: {current: ''}, vertexPayments: payments, earnedVertex: 11, earnedXoc: 0, earnedTotal: 11, paidTotal: paid, owedTotal: Math.max(0, 11 - paid)}).commit();
      rows.push({creatorId: own.creator._id, before: {earned: 11, paid, owed: Math.max(0, 11 - paid)}, payments});
    }
    const migrationConnection = await sql.reserve();
    try { if (!baseline) await migrationConnection.unsafe(fs.readFileSync('supabase/migrations/20261024000000_creator_money_rules.sql', 'utf8')); } finally { migrationConnection.release(); }
    for (const row of rows) {
      const result = await post('/api/ref/syncPayouts', {referralId: row.creatorId}, {'x-admin-key': 'fixture-admin'});
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.body.earnings.total, 5.5);
      assert.equal(result.body.payments.total, row.before.paid);
      assert.equal(result.body.owed.total, Math.max(0, 5.5 - row.before.paid));
      assert.equal(result.body.underReview.total, Math.min(5.5, Math.max(0, 11 - row.before.paid)));
      assert.deepEqual((await documents.getDocument(row.creatorId)).vertexPayments, row.payments);
      row.after = {earned: result.body.earnings.total, paid: result.body.payments.total, owed: result.body.owed.total, underReview: result.body.underReview.total};
    }
    for (const rpc of ['roo_project_operational_shadow', 'roo_refresh_operational_shadow']) {
      assert.equal((await fixture.client.rpc(rpc)).error, null);
      const res = await fetch(`${origin}/api/ref/cronSyncAll`, {headers: {authorization: 'Bearer fixture'}});
      assert.equal(res.status, 200);
      for (const row of rows) {
        const creator = await documents.getDocument(row.creatorId);
        assert.equal(creator.paidTotal, row.before.paid);
        assert.equal(creator.owedTotal, row.after.owed);
        assert.equal(creator.underReviewTotal, row.after.underReview);
      }
    }
    const paidCreator = rows.find(row => row.before.paid === 8);
    await commerce.create({_id: 'booking.future-valid-' + paidCreator.creatorId, _type: 'booking',
      status: 'captured', packageTitle: 'Vertex future', commissionCalculationVersion: 2,
      commissionAmount: 1, referral: {_ref: paidCreator.creatorId}, referralCode: ''});
    const future = await post('/api/ref/syncPayouts', {referralId: paidCreator.creatorId}, {'x-admin-key': 'fixture-admin'});
    assert.equal(future.body.owed.total, 1);
    assert.equal(future.body.payments.total, 8);
    return {report: rows, futureValidEarnings: future.body, source: 'Synthetic local PostgreSQL 17 schema copy; no production data'};
  });

  await run('all-payouts-projection-rebuilds', async () => {
    const snapshot = async () => ({
      bookings:
        await sql`select legacy_sanity_id, booking_payload, status from commerce.bookings order by legacy_sanity_id`,
      creators:
        await sql`select legacy_sanity_id, payload from migration.source_documents where document_type='referral' and tombstoned=false order by legacy_sanity_id`,
      earnings:
        await sql`select legacy_sanity_id, public.roo_referral_earnings_summary(legacy_sanity_id, payload#>>'{slug,current}') as earnings from migration.source_documents where document_type='referral' and tombstoned=false order by legacy_sanity_id`,
      payoutLedger:
        await sql`select legacy_sanity_id, creator_user_id, entry_type, amount_subunits, currency, idempotency_key, payload, source_revision, source_hash from commerce.referral_ledger order by legacy_sanity_id`,
    });
    const before = await snapshot();
    const after = {};
    for (const rpc of [
      'roo_project_operational_shadow',
      'roo_refresh_operational_shadow',
    ]) {
      assert.equal((await fixture.client.rpc(rpc)).error, null);
      after[rpc] = await snapshot();
      assert.deepEqual(after[rpc], before);
    }
    return {before, after};
  });
} catch (error) {
  evidence.fatal = error.stack;
  process.exitCode = 1;
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (fixture) {
    evidence.databaseRequests = fixture.requestLog;
    await fixture.stop();
  }
  evidence.providerResponses = responses;
  evidence.ownerAlertRequests = emailRequests.filter(row => row.body?.subject === 'Paid checkout exceeded a coupon limit');
  if (!evidence.fatal && evidence.scenarios.length === 0) {
    evidence.fatal = 'No payout scenarios selected';
    process.exitCode = 1;
  }
  fs.writeFileSync(artifact, JSON.stringify(evidence, null, 2));
  console.log(artifact);
}
