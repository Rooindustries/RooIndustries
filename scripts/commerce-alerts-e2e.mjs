import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { installNetworkGuard, refuseEnvFiles } from './lib/test-target-safety.mjs';

refuseEnvFiles();
const require = createRequire(import.meta.url);
const sdkEntry = pathToFileURL(join(dirname(require.resolve('@sentry/nextjs/package.json')), 'build/esm/index.server.js')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@sentry/nextjs') return next(sdkEntry, context);
    try { return next(specifier, context); } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return next(`${specifier}.js`, context);
      }
      throw error;
    }
  },
});

const artifact = resolve(process.env.ROO_COMMERCE_ALERTS_ARTIFACT || 'test-results/commerce-alerts');
await mkdir(artifact, { recursive: true });
const checks = [];
const envelopes = [];
const events = [];
const privateValues = ['buyer@example.invalid', 'fixture-private-token', '4242-4242-4242-4242'];
let ingestStatus = 200;
let runLegacyApiHandler;
let reportPaymentMismatches;
let sdk;
let restoreGuard;
let error;
let origin;
let nativeReport;
const check = (name, fn) => {
  try { fn(); checks.push({ name, passed: true }); }
  catch (cause) { checks.push({ name, passed: false, error: cause.message }); throw cause; }
};
const child = async (script, args, env, log) => {
  const process = spawn(globalThis.process.execPath, [script, ...args], {
    env: { ...globalThis.process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  process.stdout.on('data', chunk => { output += chunk; });
  process.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(process, 'exit');
  await writeFile(join(artifact, log), output);
  assert.equal(code, 0, `${script} failed; see ${log}`);
};

const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (request.url.startsWith('/api/1/envelope/')) {
    const body = (request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString();
    envelopes.push(body);
    const lines = body.split('\n');
    for (let i = 1; i + 1 < lines.length; i += 2) {
      if (JSON.parse(lines[i]).type === 'event') events.push(JSON.parse(lines[i + 1]));
    }
    response.writeHead(ingestStatus);
    response.end('{}');
    return;
  }
  const requestUrl = new URL(request.url, origin);
  try {
    if (requestUrl.pathname === '/reconciliation') {
      await reportPaymentMismatches(JSON.parse(raw));
      response.end('{}');
      return;
    }
    const status = Number(request.headers['x-fixture-status'] || 503);
    const result = await runLegacyApiHandler({
      request: new Request(requestUrl, { method: 'POST', body: raw, headers: {
        'content-type': 'application/json', authorization: 'Bearer fixture-private-token',
      } }),
      handler: (_req, res) => {
        if (request.headers['x-fixture-throw']) throw new Error('buyer@example.invalid fixture-private-token');
        return res.status(status).json({ ok: status < 400, private: privateValues });
      },
    });
    response.writeHead(result.status);
    response.end(await result.text());
  } catch {
    response.writeHead(500);
    response.end('{}');
  }
});

try {
  if (!process.argv.includes('--routes')) {
    const nativeArtifact = join(artifact, 'payment-persistence.json');
    await child('scripts/test-payment-persistence-sweep.mjs', [
      '--full-chain', '--scenario=reconcile-report-payment-without-booking,reconcile-report-late-capture-without-booking,reconcile-report-late-capture-without-record',
    ], { ROO_PAYMENT_PERSISTENCE_ARTIFACT: nativeArtifact }, 'payment-persistence.log');
    const result = JSON.parse(await readFile(nativeArtifact, 'utf8'));
    assert.equal(result.ok, true);
    check('late captures without a booking or a payment record remain visible', () => {
      assert.equal(result.scenarios.length, 3);
      assert.ok(result.scenarios.every(scenario => scenario.passed));
    });
    nativeReport = result.scenarios[0].proof.report;
    await writeFile(join(artifact, 'seeded-report.json'), JSON.stringify(nativeReport, null, 2));
    await child('scripts/fixtures/reconcile-payments.mjs', ['--case=seeded-payment-alert'], {
      ROO_RECONCILE_SEED_REPORT: join(artifact, 'seeded-report.json'),
      ROO_RECONCILE_TEST_ARTIFACT: join(artifact, 'daily-check'),
    }, 'daily-check.log');
    const daily = JSON.parse(await readFile(join(artifact, 'daily-check/results.json'), 'utf8'));
    check('seeded test-mode payment reaches the daily check and one owner issue on both attempts', () => {
      assert.equal(daily.ok, true);
      assert.equal(daily.results[0].issues.length, 1);
      assert.equal(daily.results[0].runs.length, 2);
      assert.equal(daily.externalRequests, 0);
    });
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  restoreGuard = installNetworkGuard([origin]);
  Object.assign(process.env, { NEXT_PUBLIC_VERCEL_ENV: 'preview', NEXT_RUNTIME: 'nodejs' });
  sdk = await import('@sentry/nextjs');
  const { startServerMonitoring } = await import('../src/lib/monitoring/server.js');
  ({ runLegacyApiHandler } = await import('../src/lib/nextApiAdapter.js'));
  ({ reportPaymentMismatches } = await import('../src/lib/monitoring/commerce.js'));
  startServerMonitoring(`http://fixture@127.0.0.1:${server.address().port}/1`);
  const send = (route, status, throws = false) => fetch(`${origin}${route}?token=fixture-private-token`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-status': String(status),
      ...(throws ? { 'x-fixture-throw': '1' } : {}) }, body: JSON.stringify({ email: privateValues[0] }),
  });
  for (const [route, surface] of [
    ['/api/payment/quote', 'checkout'], ['/api/payment/start', 'checkout'],
    ['/api/payment/finalize', 'checkout'], ['/api/payment/cancel', 'checkout'],
    ['/api/payment/status', 'checkout'], ['/api/payment/providers', 'checkout'],
    ['/api/payment/report', 'checkout'], ['/api/payment/reconcile', 'checkout'],
    ['/api/payment/webhook/dodo', 'webhook'], ['/api/payment/webhook/paypal', 'webhook'],
    ['/api/payment/webhook/razorpay', 'webhook'], ['/api/ref/createBooking', 'booking'],
    ['/api/razorpay/createOrder', 'checkout'], ['/api/razorpay/verify', 'checkout'],
    ['/api/ref/getUpgradeInfo', 'checkout'], ['/api/ref/validateCoupon', 'checkout'],
    ['/api/ref/validateReferral', 'checkout'], ['/api/ref/sendBookingEmails', 'booking'],
    ['/api/ref/updateBookingStatus', 'booking'],
    ['/api/holdSlot', 'booking'], ['/api/releaseHold', 'booking'], ['/api/bookingAvailability', 'booking'],
  ]) {
    const before = events.length;
    const response = await send(route, 503);
    const body = await response.json();
    check(`${route}: handled failure reaches Sentry with unchanged response`, () => {
      assert.equal(response.status, 503);
      assert.deepEqual(body.private, privateValues);
      assert.equal(events.length, before + 1);
      assert.equal(events.at(-1).tags.commerce_surface, surface);
      assert.equal(events.at(-1).tags.commerce_route, route);
    });
  }
  for (const status of [200, 202, 400, 401, 403, 404, 409, 429]) {
    const before = events.length;
    await (await send('/api/payment/start', status)).body.cancel();
    check(`expected HTTP ${status} does not alert`, () => assert.equal(events.length, before));
  }
  await send('/api/payment/quote', 500, true);
  check('a thrown route failure alerts and preserves HTTP 500', () => {
    assert.equal(events.at(-1).tags.error_status, '500');
  });
  const beforeUnknown = events.length;
  await send('/api/payment/customer@example.invalid', 503);
  check('unknown paths cannot become event tags', () => assert.equal(events.length, beforeUnknown));
  const report = nativeReport || { items: [{ key: 'payment:fixture', reason: 'payment_without_booking' }] };
  for (let attempt = 0; attempt < 2; attempt++) {
    await fetch(`${origin}/reconciliation`, { method: 'POST', body: JSON.stringify(report) });
  }
  const mismatchEvents = events.filter(event => event.tags?.commerce_surface === 'reconciliation');
  check('the paid-customer mismatch reaches one stable Sentry group on retries', () => {
    assert.ok(mismatchEvents.length >= 1 && mismatchEvents.length <= 2);
    for (const event of mismatchEvents) assert.deepEqual(event.fingerprint, mismatchEvents[0].fingerprint);
    assert.equal(mismatchEvents[0].tags.reconciliation_reason, 'payment_without_booking');
    assert.equal(JSON.stringify(mismatchEvents).includes(report.items[0].key), false);
  });
  const count = events.length;
  await fetch(`${origin}/reconciliation`, { method: 'POST', body: JSON.stringify({ items: [] }) });
  check('clean reports produce no mismatch alert', () => assert.equal(events.length, count));
  for (const reason of [
    'payment_without_record', 'payment_record_mismatch',
    'owner_review_dodo_currency_mismatch', 'owner_review_dodo_amount_mismatch',
    'owner_review_dodo_dispute_lost_owner_review', 'owner_review_dodo_dispute_accepted_owner_review',
    'owner_review_dodo_dispute_expired_owner_review', 'owner_review_dodo_refund_details_incomplete',
    'owner_review_upgrade_credit_changed_after_quote',
  ]) {
    const before = events.length;
    await fetch(`${origin}/reconciliation`, { method: 'POST', body: JSON.stringify({
      items: [{ key: 'record:owner-review-fixture', reason }],
    }) });
    check(`${reason} reaches Sentry`, () => {
      assert.equal(events.length, before + 1);
      assert.equal(events.at(-1).tags.reconciliation_reason, reason);
    });
  }
  ingestStatus = 503;
  const failedIngest = await send('/api/payment/quote', 599);
  check('Sentry outage does not change the route response', () => assert.equal(failedIngest.status, 599));
  check('all events have preview environment and no personal data', () => {
    for (const event of events) assert.equal(event.environment, 'preview');
    for (const value of privateValues) assert.equal(JSON.stringify(events).includes(value), false);
  });
} catch (cause) {
  error = cause.stack;
} finally {
  await sdk?.close(2000);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  restoreGuard?.();
  const sourceHashes = Object.fromEntries(await Promise.all([
    'src/lib/monitoring/server.js', 'src/lib/monitoring/commerce.js', 'src/lib/nextApiAdapter.js',
    'src/server/api/payment/reconcileReport.js', 'scripts/commerce-alerts-e2e.mjs',
  ].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
  const ok = !error && checks.length > 0 && checks.every(check => check.passed);
  await writeFile(join(artifact, 'report.json'), JSON.stringify({ ok, error, checks, events, sourceHashes,
    servicesStopped: true, mode: process.argv.includes('--routes') ? 'routes' : 'full' }, null, 2));
  await writeFile(join(artifact, 'envelopes.ndjson'), envelopes.join('\n'));
  console.log(JSON.stringify({ ok, checks: checks.length, error, artifact: join(artifact, 'report.json') }));
  process.exitCode = ok ? 0 : 1;
}
