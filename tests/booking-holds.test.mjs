import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createLegacyApiFixture } from './fixtures/legacy-api.mjs';
import { createToolingContentFixture } from './fixtures/tooling-content.mjs';
import { apiFixtureOrigin, apiRouteSecrets, configureApiFixture, readApiFixture, requestRoute } from './fixtures/api-routes.mjs';
import { installNetworkGuard, localOrigin, refuseEnvFiles } from '../scripts/lib/test-target-safety.mjs';

const host = process.env.ROO_TEST_HOST || '127.0.0.1';
const baseURL = localOrigin(`http://${host}:${process.env.BOOKING_ROUTE_PORT || process.env.PW_PORT || 4173}`);
const routeOrigin = baseURL;
const contentOrigin = apiFixtureOrigin(baseURL);
const artifact = process.env.BOOKING_HOLDS_ARTIFACT || 'test-results/api-routes/booking-holds.jsonl';
const startTimeUTC = '2099-01-05T04:30:00.000Z';
const startMs = Date.parse(startTimeUTC);
const packageTitle = 'Performance Vertex Overhaul';
let route;
let content;
let restoreGuard;
let issueHoldToken;
let buildSlotHoldId;

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
  ({ issueHoldToken } = await import('../src/server/booking/holdToken.js'));
  ({ buildSlotHoldId } = await import('../src/server/booking/slotIdentity.js'));
  route = await createLegacyApiFixture({ origin: routeOrigin, pathname: '/api/holdSlot', handler });
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, '');
});

after(async () => {
  await route?.close();
  await content?.close();
  restoreGuard?.();
});

const reset = async (values = {}) => configureApiFixture(baseURL, { reset: true, ...values });
const holds = state => state.documents.filter(row => row._type === 'slotHold');
const writes = state => state.requests.filter(row => row.path.endsWith('/roo_apply_commerce_document_mutations'));
const clock = (t, value = startMs - 60_000) => t.mock.method(Date, 'now', () => value);
const submit = async (values = {}) => {
  const response = await requestRoute(routeOrigin, '/api/holdSlot', { data: { startTimeUTC, packageTitle, ...values } });
  const body = await response.json();
  fs.appendFileSync(artifact, JSON.stringify({ now: Date.now(), input: values, status: response.status, body }) + '\n');
  return { response, body };
};
const storedHold = ({ phase = 'active', expiresAt = new Date(startMs + 600_000).toISOString() } = {}) => ({
  _id: buildSlotHoldId(startTimeUTC),
  _type: 'slotHold',
  startTimeUTC,
  packageTitle,
  phase,
  expiresAt,
  holdNonce: 'synthetic-hold-nonce',
  backendOwner: 'supabase',
  cutoverGeneration: 0,
});

for (const offset of [0, 1]) {
  test(`a configured start ${offset === 0 ? 'equal to' : 'before'} server time is rejected without a hold write`, async t => {
    clock(t, startMs + offset);
    await reset();
    const { response } = await submit();
    assert.equal(response.status, 400);
    const state = await readApiFixture(baseURL);
    assert.deepEqual(holds(state), []);
    assert.deepEqual(writes(state), []);
  });
}

test('a configured start one millisecond after server time remains eligible', async t => {
  clock(t, startMs - 1);
  await reset();
  const { response, body } = await submit();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(holds(await readApiFixture(baseURL)).length, 1);
});

test('a start reached during availability reads is rejected without a hold write', async t => {
  await reset();
  t.mock.method(Date, 'now', () => content.evidence.requests.some(call =>
    call.path.endsWith('/roo_fetch_shadow_documents_targeted') &&
    call.body.p_document_types?.includes('slotHold') && call.status === 200
  ) ? startMs : startMs - 1);
  assert.equal((await submit()).response.status, 400);
  const state = await readApiFixture(baseURL);
  assert.deepEqual(holds(state), []);
  assert.deepEqual(writes(state), []);
});

test('an owned hold refresh at its start is rejected and leaves the stored hold untouched', async t => {
  let now = startMs - 60_000;
  t.mock.method(Date, 'now', () => now);
  await reset();
  const first = await submit();
  assert.equal(first.response.status, 200);
  const before = await readApiFixture(baseURL);
  now = startMs;
  const refreshed = await submit({ previousHoldId: first.body.holdId, previousHoldToken: first.body.holdToken });
  assert.equal(refreshed.response.status, 400);
  const after = await readApiFixture(baseURL);
  assert.deepEqual(holds(after), holds(before));
  assert.deepEqual(writes(after), writes(before));
});

test('an owned expired hold for a past start cannot be reclaimed', async t => {
  clock(t);
  await reset({ bookingDocuments: [storedHold({ expiresAt: new Date(startMs - 120_000).toISOString() })] });
  const before = await readApiFixture(baseURL);
  const hold = holds(before)[0];
  const token = issueHoldToken({ holdId: hold._id, startTimeUTC, expiresAt: hold.expiresAt, holdNonce: hold.holdNonce, backend: 'supabase', cutoverGeneration: 0 });
  t.mock.method(Date, 'now', () => startMs + 1);
  const reclaimed = await submit({ previousHoldId: hold._id, previousHoldToken: token });
  assert.equal(reclaimed.response.status, 400);
  const after = await readApiFixture(baseURL);
  assert.deepEqual(holds(after), holds(before));
  assert.deepEqual(writes(after), []);
});

test('an owned active future hold still refreshes', async t => {
  clock(t);
  await reset();
  const first = await submit();
  const second = await submit({ previousHoldId: first.body.holdId, previousHoldToken: first.body.holdToken });
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.holdId, first.body.holdId);
  assert.notEqual(second.body.holdToken, first.body.holdToken);
  assert.equal(holds(await readApiFixture(baseURL)).length, 1);
});

for (const phase of ['active', 'payment_pending']) {
  test(`someone else's future ${phase} hold remains a conflict`, async t => {
    clock(t);
    await reset({ bookingDocuments: [storedHold({ phase })] });
    const before = await readApiFixture(baseURL);
    assert.equal((await submit()).response.status, 409);
    assert.deepEqual(holds(await readApiFixture(baseURL)), holds(before));
  });
}

for (const phase of ['expired', 'released', 'consumed']) {
  test(`a future slot with an ${phase} hold remains reusable`, async t => {
    clock(t);
    await reset({ bookingDocuments: [storedHold({
      phase: phase === 'expired' ? 'active' : phase,
      expiresAt: new Date(startMs + (phase === 'expired' ? -120_000 : 600_000)).toISOString(),
    })] });
    assert.equal((await submit()).response.status, 200);
    const saved = holds(await readApiFixture(baseURL));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].phase, 'active');
  });
}

test('a blocking booking still returns a conflict', async t => {
  clock(t);
  await reset({ bookingDocuments: [{ _id: 'tooling-blocking-booking', _type: 'booking', status: 'captured', startTimeUTC, originalOrderId: '' }] });
  assert.equal((await submit()).response.status, 409);
  assert.deepEqual(holds(await readApiFixture(baseURL)), []);
});

test('unconfigured and sub-minute starts remain invalid', async t => {
  clock(t);
  await reset();
  for (const value of ['2099-01-05T04:31:00.000Z', '2099-01-05T04:30:00.001Z', 'invalid']) {
    assert.equal((await submit({ startTimeUTC: value })).response.status, 400);
  }
  assert.deepEqual(holds(await readApiFixture(baseURL)), []);
});

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

for (const [failure, status] of [['settings', 500], ['hold_write', 500], ['limiter', 503], ['commerce_control', 503]]) {
  test(`${failure} keeps its ${status} guard response`, async t => {
    clock(t);
    await reset({ failure });
    assert.equal((await submit()).response.status, status);
    assert.deepEqual(holds(await readApiFixture(baseURL)), []);
  });
}

for (const key of ['COMMERCE_STARTS_PAUSED']) {
  test(`${key} still refuses a new hold with 503`, async t => {
    clock(t);
    await reset();
    process.env[key] = '1';
    try { assert.equal((await submit()).response.status, 503); }
    finally { process.env[key] = '0'; }
    assert.deepEqual(holds(await readApiFixture(baseURL)), []);
  });
}

test('the hold admission limit still returns 429', async t => {
  clock(t);
  await reset();
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await submit()).response.status, index === 0 ? 200 : 409);
  }
  assert.equal((await submit()).response.status, 429);
  assert.equal(holds(await readApiFixture(baseURL)).length, 1);
});
