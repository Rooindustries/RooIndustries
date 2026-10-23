import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { installNetworkGuard, localOrigin, refuseEnvFiles, validateDistDir } from './lib/test-target-safety.mjs';
import { localMonitoringEnv } from './lib/local-monitoring-env.mjs';
import { createToolingContentFixture } from '../tests/fixtures/tooling-content.mjs';

refuseEnvFiles();
const artifact = resolve(process.env.ROO_COMMERCE_PREVIEW_ARTIFACT || 'test-results/commerce-alerts-preview');
await mkdir(artifact, { recursive: true });
const networkLog = join(artifact, 'network.log');
await writeFile(networkLog, '');
const versionLog = join(artifact, 'next-version.log');
await writeFile(versionLog, '');
const host = 'localhost';
const events = [];
const checks = [];
const processes = [];
const envelopes = [];
const compileWaits = [];
const productionMatrix = process.argv.includes('--production');
const modes = productionMatrix ? ['local-start', 'ci', 'hosted-preview', 'production'] : ['disabled', 'external', 'local'];
const selectedMode = process.argv.find(arg => arg.startsWith('--mode='))?.slice(7);
if (selectedMode && !modes.includes(selectedMode)) throw new Error('Unknown preview fixture mode.');
let error;
let restoreGuard;
let contentFixture;
let productionDist;
let work;
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
  const contentReservation = http.createServer();
  contentReservation.listen(0, '127.0.0.1');
  await once(contentReservation, 'listening');
  const contentOrigin = localOrigin(`http://127.0.0.1:${contentReservation.address().port}`);
  await new Promise(resolve => contentReservation.close(resolve));
  contentFixture = await createToolingContentFixture({ origin: contentOrigin });
  work = await mkdtemp(join(process.env.TMPDIR || artifact, 'roo-commerce-deployment-'));
  for (const name of ['app', 'src', 'public', 'scripts/lib', 'instrumentation.js', 'instrumentation-client.js',
    'middleware.js', 'jsconfig.json', 'postcss.config.js', 'tailwind.config.js', 'package.json'])
    await cp(resolve(name), join(work, name), { recursive: true });
  await cp(resolve('next.config.mjs'), join(work, 'next.base.mjs'));
  await writeFile(join(work, 'next.config.mjs'), `import config from './next.base.mjs';
export * from './next.base.mjs';
config.experimental = { ...config.experimental, cpus: 1 };
export default config;
`);
  await symlink(resolve('node_modules'), join(work, 'node_modules'), 'dir');
  const providerConfig = 'src/server/api/payment/providerConfig.js';
  await cp(resolve(providerConfig), join(work, 'src/server/api/payment/providerConfig.fixture.cjs'));
  await writeFile(join(work, providerConfig), `const config = require('./providerConfig.fixture.cjs');
module.exports = { ...config, allowProviderModeInRuntime: mode => mode === 'test' };
`);
  for (const mode of selectedMode ? [selectedMode] : modes) {
    const enabled = mode === 'local' || mode === 'production';
    const productionStart = productionMatrix || enabled;
    const reservation = http.createServer();
    reservation.listen(0, host);
    await once(reservation, 'listening');
    const port = reservation.address().port;
    const origin = localOrigin(`http://${host}:${port}`);
    await new Promise(resolve => reservation.close(resolve));
    restoreGuard = installNetworkGuard([origin, fixtureOrigin, contentOrigin]);
    const aliases = ['SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN', 'PUBLIC_SENTRY_DSN', 'VITE_SENTRY_DSN', 'REACT_APP_SENTRY_DSN'];
    const inherited = { ...Object.fromEntries(aliases.map(name => [name, 'https://fixturekey@ingest.invalid/42'])),
      VERCEL: '1', NEXT_PUBLIC_SENTRY_HOSTED: '1' };
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
      ROO_TEST_NETWORK_ORIGINS: JSON.stringify([origin, fixtureOrigin, contentOrigin]),
      ROO_SOURCEMAPS_NETWORK_LOG: networkLog,
      ROO_NEXT_VERSION_FIXTURE_LOG: versionLog,
      NODE_OPTIONS: `--import=${fileURLToPath(new URL('./lib/test-target-safety.mjs', import.meta.url))} --import=${fileURLToPath(new URL('./fixtures/sourcemaps-network-guard.mjs', import.meta.url))} --import=${fileURLToPath(new URL('./fixtures/next-version-fixture.mjs', import.meta.url))}`,
    }, productionMatrix || enabled ? dsn : inherited.NEXT_PUBLIC_SENTRY_DSN);
    check(`${mode}: inherited server and public/client DSN aliases are removed`, () => {
      assert.deepEqual(Object.keys(env).filter(name => /SENTRY.*DSN/i.test(name)), ['NEXT_PUBLIC_SENTRY_DSN']);
      assert.equal(env.NEXT_PUBLIC_SENTRY_DSN, productionMatrix || enabled ? dsn : '');
      assert.equal(env.VERCEL, undefined);
      assert.equal(env.NEXT_PUBLIC_SENTRY_HOSTED, undefined);
    });
    if (mode === 'external') env.NEXT_PUBLIC_SENTRY_DSN = inherited.NEXT_PUBLIC_SENTRY_DSN;
    if (productionStart) Object.assign(env, {
      NODE_ENV: 'production', VERCEL: enabled || mode === 'hosted-preview' ? '1' : '',
      VERCEL_ENV: enabled || mode === 'ci' ? 'production' : mode === 'hosted-preview' ? 'preview' : '',
      NEXT_PUBLIC_VERCEL_ENV: enabled ? 'production' : mode === 'hosted-preview' ? 'preview' : 'production',
      ...(mode === 'ci' ? { CI: '1' } : {}),
    });
    if (productionStart) {
      if (!productionDist) {
        productionDist = env.NEXT_DIST_DIR;
        const buildLog = join(artifact, 'production-build.log');
        const buildFd = openSync(buildLog, 'w');
        const build = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'build'], {
          cwd: work,
          env: { ...env, NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production', NEXT_PUBLIC_VERCEL_ENV: 'production',
            NEXT_PUBLIC_SENTRY_DSN: dsn, SENTRY_CLI_NO_TELEMETRY: '1',
            SUPABASE_URL: contentOrigin, NEXT_PUBLIC_SUPABASE_URL: contentOrigin, NEXT_PUBLIC_SUPABASE_ASSET_URL: contentOrigin },
          detached: true, stdio: ['ignore', buildFd, buildFd],
        });
        closeSync(buildFd);
        const buildEntry = { mode: 'production-build', pid: build.pid, exited: once(build, 'exit'), stopped: false };
        processes.push(buildEntry);
        const timer = setTimeout(() => { void stop(buildEntry); }, 480000);
        try {
          const [code] = await buildEntry.exited;
          assert.equal(code, 0, 'Production build failed; see production-build.log');
          check('actual Next production build completes with only local content and Sentry collectors', () => assert.equal(code, 0));
        } finally { clearTimeout(timer); await stop(buildEntry); }
      }
      env.NEXT_DIST_DIR = productionDist;
    }
    const log = join(artifact, `${mode}-next.log`);
    const fd = openSync(log, 'w');
    const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', productionStart ? 'start' : 'dev', '--hostname', host, '--port', String(port)], {
      env, cwd: productionStart ? work : process.cwd(), detached: true, stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    const entry = { mode, pid: child.pid, exited: once(child, 'exit'), stopped: false, origin,
      deployment: { nodeEnv: env.NODE_ENV, vercel: env.VERCEL || '', vercelEnv: env.VERCEL_ENV || '', ci: env.CI || '' } };
    processes.push(entry);
    const deadline = Date.now() + 180000;
    while (!(await readFile(log, 'utf8')).includes('Ready in')) {
      assert.equal(child.exitCode, null, `Next ${mode} failed to start`);
      assert.ok(Date.now() < deadline, `Next ${mode} startup timed out`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const before = events.length;
    {
      const quote = await request(`${origin}/api/payment/start`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      check(`${mode}: actual Next checkout start returns its expected server error`, () => assert.equal(quote.status, 503));
      await quote.body?.cancel();
      const booking = await request(`${origin}/api/holdSlot`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      check(`${mode}: actual Next booking returns its expected server error`, () => assert.equal(booking.status, 503));
      await booking.body?.cancel();
      const id = 'fixture-' + mode + '-webhook', timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ type: 'payment.succeeded', data: { payment_id: 'payment-fixture' } });
      const signature = createHmac('sha256', 'fixture-only-webhook').update(`${id}.${timestamp}.${body}`).digest('base64');
      const webhook = await request(`${origin}/api/payment/webhook/dodo`, { method: 'POST', body, headers: {
        'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}`,
      } });
      check(`${mode}: signed Dodo webhook exercises the actual Next failure path`, () => assert.equal(webhook.status, 500));
      await webhook.body?.cancel();
      check(`${mode}: production gate controls all three actual route failures`, () => {
        if (!enabled) { assert.equal(events.length, before); return; }
        for (const [route, surface] of [['/api/payment/start', 'checkout'], ['/api/holdSlot', 'booking'], ['/api/payment/webhook/dodo', 'webhook']]) {
          const event = events.slice(before).find(event => event.tags?.commerce_route === route);
          assert.ok(event, `missing ${route}`);
          assert.equal(event.tags.commerce_surface, surface);
          assert.equal(event.environment, 'production');
          assert.equal(event.request?.data, undefined);
          assert.deepEqual(event.request?.cookies || {}, {});
          assert.deepEqual(event.request?.headers || {}, {});
          assert.equal(event.request?.query_string || '', '');
        }
      });
    }
    if (!productionMatrix) {
      const envelope = `${JSON.stringify({ dsn })}\n{"type":"event"}\n{"message":"Local browser relay fixture"}\n`;
      const relay = await request(`${origin}/api/client-report`, { method: 'POST', headers: { origin, 'content-type': 'application/x-sentry-envelope' }, body: envelope });
      check(`${mode}: browser relay stays disabled or sends only to the local collector`, () => {
        assert.equal(relay.status, enabled ? 200 : 404);
        if (!enabled) assert.equal(events.length, before);
        else assert.ok(events.some(event => event.message === 'Local browser relay fixture'));
      });
      await relay.body?.cancel();
    }
    await stop(entry);
    if (!enabled) check(`${mode}: no delayed event arrives during shutdown`, () => assert.equal(events.length, before));
    if (enabled) check('each actual commerce route failure sends one event alongside separate metric-store errors', () => {
      const routeEvents = events.slice(before).filter(event => event.message !== 'Local browser relay fixture' &&
        event.exception?.values?.[0]?.value !== 'Commerce metric recording failed');
      assert.equal(routeEvents.length, 3);
      assert.ok(routeEvents.every(event => event.tags?.commerce_route));
    });
    restoreGuard();
    restoreGuard = undefined;
  }
} catch (cause) { error = cause.stack; }
finally {
  for (const entry of processes) await stop(entry).catch(cause => { error ||= cause.stack; });
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  await contentFixture?.close();
  if (work) await rm(work, { recursive: true, force: true });
  restoreGuard?.();
  const networkAudit = await readFile(networkLog, 'utf8');
  const versionRequests = (await readFile(versionLog, 'utf8')).split('\n').filter(Boolean).length;
  const expectedVersionRequests = productionMatrix ? 0 : selectedMode ? Number(selectedMode !== 'local') : 2;
  checks.push({ name: 'builds and servers use the declared version stand-in and make no blocked Node transport attempt',
    passed: networkAudit === '' && versionRequests === expectedVersionRequests });
  const ok = !error && checks.every(check => check.passed);
  const sourceHashes = Object.fromEntries(await Promise.all(['src/lib/monitoring/deployment.mjs', 'src/lib/monitoring/scrub.js', 'src/lib/monitoring/server.js',
    'src/lib/monitoring/commerce.js', 'src/lib/nextApiAdapter.js', 'src/server/api/payment/start.js', 'instrumentation.js', 'next.config.mjs',
    'scripts/commerce-alerts-preview-e2e.mjs', 'scripts/fixtures/sourcemaps-network-guard.mjs', 'scripts/fixtures/next-version-fixture.mjs'].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  await writeFile(join(artifact, 'report.json'), JSON.stringify({ ok, error, checks, events, compileWaits, productionMatrix, sourceHashes, networkAudit,
    standIns: [
      { boundary: 'Provider runtime policy', scope: 'The isolated copied site accepts only Dodo test mode under production hosting markers; the original production policy is unchanged. Actual routes, webhook signature verification and monitoring execute; no financial outcome is asserted.' },
      { boundary: 'Framework update metadata', scope: 'Only the exact Next development version-check GET receives installed-version metadata in process. Every other request uses the local network guard.', requests: versionRequests },
    ],
    networkPolicy: 'Only owned Next origins and loopback collector/database fixture are allowed; no external ingest',
    processes: processes.map(({ exited, ...entry }) => entry), servicesStopped: processes.every(entry => entry.stopped) && (!contentFixture || contentFixture.evidence.stopped),
  }, null, 2));
  await writeFile(join(artifact, 'envelopes.ndjson'), envelopes.join('\n'));
  console.log(JSON.stringify({ ok, checks: checks.length, error, artifact: join(artifact, 'report.json') }));
  process.exitCode = ok ? 0 : 1;
}
