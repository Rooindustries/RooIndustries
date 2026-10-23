import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { installNetworkGuard, refuseEnvFiles } from './lib/test-target-safety.mjs';
import { localMonitoringEnv } from './lib/local-monitoring-env.mjs';

const cleanEnv = localMonitoringEnv(process.env);
for (const key of Object.keys(process.env)) if (!(key in cleanEnv)) delete process.env[key];
Object.assign(process.env, cleanEnv);

const artifact = resolve(process.env.ROO_COMMERCE_GATE_ARTIFACT || 'test-results/commerce-monitoring-gate');
await mkdir(artifact, { recursive: true });
const mode = process.argv.find(arg => arg.startsWith('--mode='))?.slice(7);
const modes = ['hosted-preview', 'ci', 'local-start', 'production'];
if (!mode) {
  const results = [];
  for (const selected of modes) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--mode=' + selected], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'exit');
    await writeFile(join(artifact, selected + '.log'), output);
    results.push({ mode: selected, code, ...JSON.parse(await readFile(join(artifact, selected + '.json'), 'utf8')) });
  }
  const report = { ok: results.every(result => result.code === 0 && result.ok), results };
  await writeFile(join(artifact, 'report.json'), JSON.stringify(report, null, 2));
  assert.equal(report.ok, true, 'Monitoring gate failed; see per-mode artifacts.');
} else {
  assert.ok(modes.includes(mode));
  for (const key of Object.keys(process.env)) if (/^(VERCEL|NEXT_PUBLIC_VERCEL|NEXT_PUBLIC_SENTRY_HOSTED|CI|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy|NODE_USE_ENV_PROXY)/.test(key)) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: 'production', NEXT_RUNTIME: 'nodejs', NEXT_PUBLIC_VERCEL_ENV: 'production' });
  if (mode === 'hosted-preview') Object.assign(process.env, { VERCEL: '1', VERCEL_ENV: 'preview', NEXT_PUBLIC_VERCEL_ENV: 'preview', NEXT_PUBLIC_SENTRY_HOSTED: '1' });
  if (mode === 'ci') process.env.CI = 'true';
  if (mode === 'production') Object.assign(process.env, { VERCEL: '1', VERCEL_ENV: 'production' });
  refuseEnvFiles();
  const attempts = [];
  const events = [];
  let sdk, runLegacyApiHandler, onRequestError, logSafeError, restoreGuard, error;
  const fixture = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url.startsWith('/api/42/envelope/')) {
      const raw = Buffer.concat(chunks);
      const body = (request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString();
      const lines = body.split('\n');
      for (let index = 1; index + 1 < lines.length; index += 2) if (JSON.parse(lines[index]).type === 'event') events.push(JSON.parse(lines[index + 1]));
      response.end('{}');
      return;
    }
    const failure = new Error('buyer@example.invalid private-fixture-token');
    const result = await runLegacyApiHandler({ request: new Request('http://127.0.0.1' + request.url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), handler: (_req, res) => {
      logSafeError('Fixture route error', failure);
      return res.status(503).json({ ok: false, fixture: true });
    } });
    if (mode !== 'production') await onRequestError(failure, { path: new URL(request.url, 'http://fixture.invalid').pathname, method: 'POST', headers: {} }, { routerKind: 'App Router', routePath: request.url, routeType: 'route' });
    response.writeHead(result.status);
    response.end(await result.text());
  });
  const originals = [];
  try {
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    const origin = 'http://127.0.0.1:' + fixture.address().port;
    restoreGuard = installNetworkGuard([origin]);
    const local = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
    const refuse = (kind, host) => { if (!local(host)) { attempts.push({ kind, host }); throw new Error('External monitoring fixture transport refused'); } };
    const lookup = dns.lookup;
    dns.lookup = function(host, ...args) { refuse('dns', host); return lookup.call(this, host, ...args); };
    originals.push(() => { dns.lookup = lookup; });
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function(...args) {
      const options = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (options && typeof options === 'object' && options.host) refuse('connect', options.host);
      return connect.apply(this, args);
    };
    originals.push(() => { net.Socket.prototype.connect = connect; });
    for (const module of [http, https]) {
      const request = module.request;
      module.request = function(input, ...args) {
        const host = typeof input === 'string' || input instanceof URL ? new URL(input).hostname : input.hostname || input.host || 'localhost';
        refuse('http', host);
        return request.call(this, input, ...args);
      };
      originals.push(() => { module.request = request; });
    }
    syncBuiltinESMExports();
    const require = createRequire(import.meta.url);
    const sdkEntry = pathToFileURL(join(dirname(require.resolve('@sentry/nextjs/package.json')), 'build/esm/index.server.js')).href;
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === '@sentry/nextjs') return next(sdkEntry, context);
      try { return next(specifier, context); } catch (cause) {
        if (cause.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.js') && !specifier.endsWith('.mjs')) return next(specifier + '.js', context);
        throw cause;
      }
    } });
    process.env.NEXT_PUBLIC_SENTRY_DSN = mode === 'production' ? `http://fixturekey@127.0.0.1:${fixture.address().port}/42` : 'https://fixturekey@ingest.invalid/42';
    sdk = await import('@sentry/nextjs');
    const { startServerMonitoring } = await import('../src/lib/monitoring/server.js');
    ({ runLegacyApiHandler } = await import('../src/lib/nextApiAdapter.js'));
    ({ onRequestError } = await import('../instrumentation.js'));
    ({ logSafeError } = await import('../src/server/safeErrorLog.js'));
    startServerMonitoring(process.env.NEXT_PUBLIC_SENTRY_DSN);
    for (const route of ['/api/payment/quote', '/api/payment/webhook/dodo', '/api/holdSlot']) {
      const response = await fetch(origin + route + '?token=private-fixture-token', { method: 'POST', body: '{}' });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { ok: false, fixture: true });
    }
    await sdk.close(2000);
    assert.deepEqual(attempts, []);
    if (mode === 'production') {
      assert.equal(events.length, 3);
      for (const surface of ['checkout', 'webhook', 'booking']) assert.equal(events.filter(event => event.tags?.commerce_surface === surface).length, 1);
      assert.ok(events.every(event => event.environment === 'production' && event.exception?.values?.[0]?.stacktrace?.frames?.length > 0));
      assert.ok(!JSON.stringify(events).includes('buyer@example.invalid') && !JSON.stringify(events).includes('private-fixture-token'));
    } else {
      assert.equal(events.length, 0);
      assert.equal(sdk.getClient(), undefined);
    }
  } catch (cause) { error = cause.stack; }
  finally {
    await sdk?.close(2000);
    fixture.closeAllConnections();
    await new Promise(done => fixture.close(done));
    originals.reverse().forEach(restore => restore());
    restoreGuard?.();
    syncBuiltinESMExports();
    await writeFile(join(artifact, mode + '.json'), JSON.stringify({ ok: !error, mode, attempts, events, servicesStopped: !fixture.listening, error }, null, 2));
  }
  if (error) throw new Error(error);
}
