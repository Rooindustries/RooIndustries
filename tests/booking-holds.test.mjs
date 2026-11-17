import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createLegacyApiFixture } from './fixtures/legacy-api.mjs';
import { createToolingContentFixture } from './fixtures/tooling-content.mjs';
import { apiFixtureOrigin, apiRouteSecrets, configureApiFixture, readApiFixture, requestRoute } from './fixtures/api-routes.mjs';
import { installNetworkGuard, localOrigin, refuseEnvFiles } from '../scripts/lib/test-target-safety.mjs';
import { portFromEnv, reserveTcpPorts } from '../scripts/lib/free-tcp-port.mjs';

const host = process.env.ROO_TEST_HOST || '127.0.0.1';
const [routePort, contentPort] = await reserveTcpPorts(host, [portFromEnv('BOOKING_ROUTE_PORT') || portFromEnv('PW_PORT') || 4173, portFromEnv('TOOLING_CONTENT_PORT')]);
const baseURL = localOrigin(`http://${host}:${routePort}`);
const routeOrigin = baseURL;
process.env.TOOLING_CONTENT_PORT = String(contentPort);
const contentOrigin = apiFixtureOrigin(baseURL);
const startTimeUTC = '2099-01-05T04:30:00.000Z';
const startMs = Date.parse(startTimeUTC);
const packageTitle = 'Performance Vertex Overhaul';
let route;
let content;
let restoreGuard;

before(async () => {
  refuseEnvFiles();
  restoreGuard = installNetworkGuard([baseURL, contentOrigin, routeOrigin]);
  Object.assign(process.env, apiRouteSecrets, {
    NODE_ENV: 'development',
    DATA_PRIMARY_BACKEND: 'supabase',
    COMMERCE_PRIMARY_BACKEND: 'supabase',
    SUPABASE_CUTOVER_ENABLED: '1',
    COMMERCE_CUTOVER_ENABLED: '1',
    COMMERCE_STARTS_PAUSED: '0',
    COMMERCE_FAILOVER_GENERATION: '0',
    SUPABASE_URL: contentOrigin,
    NEXT_PUBLIC_SUPABASE_URL: contentOrigin,
    SUPABASE_SECRET_KEY: 'fixture-only-tooling-server-secret-key',
    SALES_PREVIEW_READ_ONLY: '0',
    ALLOW_LIVE_PAYMENTS: '0',
  });
  content = await createToolingContentFixture({ origin: contentOrigin, apiRoutes: true });
  const { default: handler } = await import('../src/server/booking/holdSlot.js');
  route = await createLegacyApiFixture({ origin: routeOrigin, pathname: '/api/holdSlot', handler });
});

after(async () => {
  await route?.close();
  await content?.close();
  restoreGuard?.();
});

const reset = async (values = {}) => configureApiFixture(baseURL, { reset: true, ...values });
const holds = state => state.documents.filter(row => row._type === 'slotHold');
const clock = (t, value = startMs - 60_000) => t.mock.method(Date, 'now', () => value);

test('method, origin, malformed-body and body-size guards retain their statuses', async t => {
  clock(t);
  await reset();
  for (const [options, expected] of [
    [{ method: 'GET' }, 405],
    [{ data: { startTimeUTC, packageTitle }, headers: { Origin: 'https://other.fixture.invalid' } }, 403],
    [{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }, 400],
    [{ method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }, 415],
    [{ data: { value: 'a'.repeat(128 * 1024) } }, 413],
  ]) {
    const response = await requestRoute(routeOrigin, '/api/holdSlot', options);
    assert.equal(response.status, expected);
    await response.text();
  }
  assert.deepEqual(holds(await readApiFixture(baseURL)), []);
});

test('a stalled JSON request retains its 408 response', { timeout: 12_000 }, async t => {
  clock(t);
  await reset();
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; value.enqueue(new TextEncoder().encode('{')); } });
  try {
    const response = await requestRoute(routeOrigin, '/api/holdSlot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' });
    assert.equal(response.status, 408);
    await response.text();
  } finally {
    try { controller.close(); } catch {}
  }
  assert.deepEqual(holds(await readApiFixture(baseURL)), []);
});
