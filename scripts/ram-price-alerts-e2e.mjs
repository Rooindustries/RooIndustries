import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire, registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createRamPriceFixture } from '../tests/fixtures/ram-price.mjs';
import { installNetworkGuard, refuseEnvFiles } from './lib/test-target-safety.mjs';

refuseEnvFiles();
const require = createRequire(import.meta.url);
const sdkEntry = pathToFileURL(join(dirname(require.resolve('@sentry/nextjs/package.json')), 'build/esm/index.server.js')).href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@sentry/nextjs') return next(sdkEntry, context);
  try { return next(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.js')) return next(`${specifier}.js`, context);
    throw error;
  }
} });

const events = [];
const host = '127.0.0.1';
const documents = [{ _id: 'fixture-hero', _type: 'hero', _rev: 'fixture-revision', headingLine1: 'Fixture heading' }];
const fixture = createRamPriceFixture({ documents, cronSecret: 'fixture-only-cron' });
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (request.url.startsWith('/api/26/envelope')) {
    const text = (request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString();
    const lines = text.split('\n');
    for (let index = 1; index + 1 < lines.length; index += 2) if (JSON.parse(lines[index]).type === 'event') events.push(JSON.parse(lines[index + 1]));
    response.writeHead(200); response.end('{}'); return;
  }
  const url = new URL(request.url, `http://${host}`);
  const body = raw.length ? JSON.parse(raw) : {};
  if (await fixture({ url, body, res: response })) return;
  if (url.pathname === '/rest/v1/rpc/roo_fetch_shadow_documents_targeted') {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(documents)); return;
  }
  response.writeHead(404); response.end();
});
server.listen(0, host);
await once(server, 'listening');
const origin = `http://${host}:${server.address().port}`;
installNetworkGuard([origin]);
process.env.NEXT_PUBLIC_SENTRY_DSN = `http://fixture@${host}:${server.address().port}/26`;
delete process.env.SENTRY_DSN;
const { createSupabaseAdminClient } = await import('../src/server/supabase/adminClient.js');
const { refreshRamPrice, reportRamPriceFailure } = await import('../src/server/content/refreshRamPrice.js');
const { startServerMonitoring } = await import('../src/lib/monitoring/server.js');
const { flush, close } = await import('@sentry/nextjs');
try {
  const env = { SUPABASE_URL: origin, SUPABASE_SECRET_KEY: 'fixture-only-secret', VERCEL_ENV: 'preview', TOOLING_NETWORK_GUARD: '1', HERO_RAM_PRICE_SOURCE_URL: `${origin}/storefront`, CRON_SECRET: 'fixture-only-cron', CMS_WRITES_PAUSED: '0' };
  const client = createSupabaseAdminClient({ env });
  for (const deployment of [
    { NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview' },
    { NODE_ENV: 'development', VERCEL: '', VERCEL_ENV: 'development' },
    { NODE_ENV: 'production', VERCEL: '', VERCEL_ENV: 'production' },
  ]) {
    Object.assign(process.env, deployment);
    startServerMonitoring(process.env.NEXT_PUBLIC_SENTRY_DSN);
    await fetch(`${origin}/__ram-price`, { method: 'POST', body: JSON.stringify({ reset: true, mode: 'failed', previousPrice: 49000 }) });
    await assert.rejects(refreshRamPrice({ client, env, signal: AbortSignal.timeout(5000) }), error => { reportRamPriceFailure(error); return true; });
    await flush(1000);
    assert.equal(events.length, 0);
  }
  Object.assign(process.env, { NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production' });
  startServerMonitoring(process.env.NEXT_PUBLIC_SENTRY_DSN);
  await fetch(`${origin}/__ram-price`, { method: 'POST', body: JSON.stringify({ reset: true, mode: 'failed', previousPrice: 49000 }) });
  const before = structuredClone(documents[0]);
  for (const [overrides, code] of [
    [{ VERCEL_ENV: 'production', CI: '1' }, 'RAM_PRICE_PRODUCTION_GUARD'],
    [{ VERCEL_ENV: 'production' }, 'RAM_PRICE_PRODUCTION_GUARD'],
    [{ HERO_RAM_PRICE_SOURCE_URL: undefined }, 'RAM_PRICE_PREVIEW_DISABLED'],
    [{ HERO_RAM_PRICE_SOURCE_URL: 'https://v-color.net/api/2026-07/graphql.json' }, 'RAM_PRICE_FIXTURE_GUARD'],
  ]) {
    await assert.rejects(refreshRamPrice({ client, env: { ...env, ...overrides } }), error => error.code === code);
  }
  const guarded = await (await fetch(`${origin}/__ram-price`)).json();
  assert.equal(guarded.reads, 0);
  assert.equal(guarded.publishes.length, 0);
  await assert.rejects(refreshRamPrice({ client, env, signal: AbortSignal.timeout(5000) }), error => {
    assert.equal(error.code, 'RAM_PRICE_SOURCE_UNAVAILABLE');
    reportRamPriceFailure(error);
    return true;
  });
  await flush(5000);
  assert.deepEqual(documents[0], before);
  assert.equal(events.length, 1);
  assert.equal(events[0].level, 'warning');
  assert.equal(events[0].tags.error_code, 'RAM_PRICE_SOURCE_UNAVAILABLE');
  assert.equal(events[0].exception.values[0].value, 'RAM price refresh failed; last verified price retained');
  assert.equal(events[0].user, undefined);
  process.env.VERCEL_ENV = 'preview';
  reportRamPriceFailure(Object.assign(new Error('Synthetic preview failure'), { code: 'RAM_PRICE_SOURCE_UNAVAILABLE' }));
  await flush(1000);
  assert.equal(events.length, 1);
  await mkdir('test-results/ram-price-alerts', { recursive: true });
  await writeFile('test-results/ram-price-alerts/report.json', JSON.stringify({ passed: true, productionAndCiGuards: true, previewAndLocalSilent: true, storedPriceUnchanged: true, alertCount: events.length, level: events[0].level, errorCode: events[0].tags.error_code, source: 'local fixture only' }, null, 2));
  console.log('RAM refresh failure retains its quote and reaches the local warning sink.');
} finally {
  await close(1000);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
