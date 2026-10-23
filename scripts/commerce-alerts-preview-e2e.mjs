import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { installNetworkGuard, localOrigin, refuseEnvFiles, validateDistDir } from './lib/test-target-safety.mjs';
import { localMonitoringEnv } from './lib/local-monitoring-env.mjs';

refuseEnvFiles();
const artifact = resolve(process.env.ROO_COMMERCE_PREVIEW_ARTIFACT || 'test-results/commerce-alerts-preview');
await mkdir(artifact, { recursive: true });
const host = process.env.ROO_TEST_HOST || '127.0.0.1';
const events = [];
const checks = [];
const processes = [];
const envelopes = [];
const compileWaits = [];
const selectedMode = process.argv.find(arg => arg.startsWith('--mode='))?.slice(7);
if (selectedMode && !['disabled', 'external', 'local'].includes(selectedMode)) throw new Error('Unknown preview fixture mode.');
let error;
let restoreGuard;
const check = (name, fn) => {
  try { fn(); checks.push({ name, passed: true }); }
  catch (cause) { checks.push({ name, passed: false, error: cause.message }); throw cause; }
};
const request = async (url, options) => {
  const deadline = Date.now() + 300000;
  let timeouts = 0;
  for (;;) {
    try {
      const response = await fetch(url, options);
      if (timeouts) compileWaits.push({ route: new URL(url).pathname, timeouts });
      return response;
    } catch (cause) {
      if (!['TimeoutError', 'AbortError'].includes(cause.name) || Date.now() >= deadline) throw cause;
      timeouts++;
    }
  }
};
const fixture = http.createServer(async (request, response) => {
  if (request.url.startsWith('/api/42/envelope/')) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = (request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString();
    envelopes.push(body);
    const lines = body.split('\n');
    for (let index = 1; index + 1 < lines.length; index += 2) {
      if (JSON.parse(lines[index]).type === 'event') events.push(JSON.parse(lines[index + 1]));
    }
    response.end('{}');
  } else {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end('{"error":"local database fixture unavailable"}');
  }
});
const stop = async (entry) => {
  if (entry.stopped) return;
  try { process.kill(-entry.pid, 'SIGTERM'); } catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
  await Promise.race([entry.exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  try { process.kill(-entry.pid, 'SIGKILL'); } catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
  await entry.exited;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { process.kill(-entry.pid, 0); }
    catch (cause) { if (cause.code === 'ESRCH') { entry.stopped = true; return; } throw cause; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Owned Next process group did not stop.');
};

try {
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const fixtureOrigin = localOrigin(`http://127.0.0.1:${fixture.address().port}`);
  const dsn = `http://fixturekey@127.0.0.1:${fixture.address().port}/42`;
  for (const mode of selectedMode ? [selectedMode] : ['disabled', 'external', 'local']) {
    const reservation = http.createServer();
    reservation.listen(0, host);
    await once(reservation, 'listening');
    const port = reservation.address().port;
    const origin = localOrigin(`http://${host}:${port}`);
    await new Promise(resolve => reservation.close(resolve));
    restoreGuard = installNetworkGuard([origin, fixtureOrigin]);
    const aliases = ['SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN', 'PUBLIC_SENTRY_DSN', 'VITE_SENTRY_DSN', 'REACT_APP_SENTRY_DSN'];
    const inherited = Object.fromEntries(aliases.map(name => [name, 'https://fixturekey@ingest.invalid/42']));
    const env = localMonitoringEnv({
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      ...inherited,
      NODE_ENV: 'development', VERCEL_ENV: 'preview', NEXT_PUBLIC_VERCEL_ENV: 'preview',
      NEXT_DIST_DIR: validateDistDir(`.next-e2e-commerce-preview-${mode}-${port}`, { isolated: true }),
      NEXT_TELEMETRY_DISABLED: '1',
      SUPABASE_URL: fixtureOrigin, NEXT_PUBLIC_SUPABASE_URL: fixtureOrigin, NEXT_PUBLIC_SUPABASE_ASSET_URL: fixtureOrigin,
      SUPABASE_SECRET_KEY: 'fixture-only-key', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'fixture-only-public-key',
      DATA_PRIMARY_BACKEND: 'supabase', COMMERCE_PRIMARY_BACKEND: 'supabase',
      SUPABASE_CUTOVER_ENABLED: '1', COMMERCE_CUTOVER_ENABLED: '1', COMMERCE_STARTS_PAUSED: '1',
      ALLOW_LIVE_PAYMENTS: '0', SALES_PREVIEW_READ_ONLY: '0', ENABLE_PREVIEW_PAYMENTS: '1',
      DODO_PAYMENTS_ENVIRONMENT: 'test_mode', DODO_PAYMENTS_API_KEY: 'fixture-only-dodo',
      DODO_PAYMENTS_WEBHOOK_KEY: 'whsec_' + Buffer.from('fixture-only-webhook').toString('base64'),
      PAYMENT_SESSION_SECRET: 'fixture-only-session-secret', REF_SESSION_SECRET: 'fixture-only-ref-secret',
      ROO_TEST_NETWORK_ORIGINS: JSON.stringify([origin, fixtureOrigin]),
      NODE_OPTIONS: `--import=${fileURLToPath(new URL('./lib/test-target-safety.mjs', import.meta.url))}`,
    }, mode === 'local' ? dsn : inherited.NEXT_PUBLIC_SENTRY_DSN);
    check(`${mode}: inherited server and public/client DSN aliases are removed`, () => {
      assert.deepEqual(Object.keys(env).filter(name => /SENTRY.*DSN/i.test(name)), ['NEXT_PUBLIC_SENTRY_DSN']);
      assert.equal(env.NEXT_PUBLIC_SENTRY_DSN, mode === 'local' ? dsn : '');
    });
    if (mode === 'external') env.NEXT_PUBLIC_SENTRY_DSN = inherited.NEXT_PUBLIC_SENTRY_DSN;
    const log = join(artifact, `${mode}-next.log`);
    const fd = openSync(log, 'w');
    const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', host, '--port', String(port)], {
      env, detached: true, stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    const entry = { mode, pid: child.pid, exited: once(child, 'exit'), stopped: false, origin };
    processes.push(entry);
    const deadline = Date.now() + 180000;
    while (!(await readFile(log, 'utf8')).includes('Ready in')) {
      assert.equal(child.exitCode, null, `Next ${mode} failed to start`);
      assert.ok(Date.now() < deadline, `Next ${mode} startup timed out`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const before = events.length;
    if (mode === 'local') {
      const quote = await request(`${origin}/api/payment/quote`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      check('local: actual Next checkout returns its expected server error', () => assert.equal(quote.status, 503));
      await quote.body?.cancel();
      const booking = await request(`${origin}/api/holdSlot`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      check('local: actual Next booking returns its expected server error', () => assert.equal(booking.status, 503));
      await booking.body?.cancel();
      const id = 'fixture-local-webhook', timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ type: 'payment.succeeded', data: { payment_id: 'payment-fixture' } });
      const signature = createHmac('sha256', 'fixture-only-webhook').update(`${id}.${timestamp}.${body}`).digest('base64');
      const webhook = await request(`${origin}/api/payment/webhook/dodo`, { method: 'POST', body, headers: {
        'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}`,
      } });
      check('local: signed Dodo webhook exercises the actual Next failure path', () => assert.equal(webhook.status, 500));
      await webhook.body?.cancel();
      check('local collector receives all three actual route failures with sanitized metadata', () => {
        for (const [route, surface] of [['/api/payment/quote', 'checkout'], ['/api/holdSlot', 'booking'], ['/api/payment/webhook/dodo', 'webhook']]) {
          const event = events.find(event => event.tags?.commerce_route === route);
          assert.ok(event, `missing ${route}`);
          assert.equal(event.tags.commerce_surface, surface);
          assert.equal(event.environment, 'preview');
          assert.equal(event.request?.data, undefined);
          assert.deepEqual(event.request?.cookies || {}, {});
          assert.deepEqual(event.request?.headers || {}, {});
          assert.equal(event.request?.query_string || '', '');
        }
      });
    }
    const envelope = `${JSON.stringify({ dsn })}\n{"type":"event"}\n{"message":"Local browser relay fixture"}\n`;
    const relay = await request(`${origin}/api/client-report`, { method: 'POST', headers: { origin, 'content-type': 'application/x-sentry-envelope' }, body: envelope });
    check(`${mode}: browser relay stays disabled or sends only to the local collector`, () => {
      assert.equal(relay.status, mode === 'local' ? 200 : 404);
      if (mode !== 'local') assert.equal(events.length, before);
      else assert.ok(events.some(event => event.message === 'Local browser relay fixture'));
    });
    await relay.body?.cancel();
    await stop(entry);
    restoreGuard();
    restoreGuard = undefined;
  }
} catch (cause) { error = cause.stack; }
finally {
  for (const entry of processes) await stop(entry).catch(cause => { error ||= cause.stack; });
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  restoreGuard?.();
  const ok = !error && checks.every(check => check.passed);
  await writeFile(join(artifact, 'report.json'), JSON.stringify({ ok, error, checks, events, compileWaits,
    networkPolicy: 'Only owned Next origins and loopback collector/database fixture are allowed; no external ingest',
    processes: processes.map(({ exited, ...entry }) => entry), servicesStopped: processes.every(entry => entry.stopped),
  }, null, 2));
  await writeFile(join(artifact, 'envelopes.ndjson'), envelopes.join('\n'));
  console.log(JSON.stringify({ ok, checks: checks.length, error, artifact: join(artifact, 'report.json') }));
  process.exitCode = ok ? 0 : 1;
}
