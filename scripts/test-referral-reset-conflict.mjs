import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSweepPostgresFixture } from './lib/sweep-postgres-fixture.mjs';
import { freeTcpPort } from './lib/free-tcp-port.mjs';
import { startChildOnPorts, stopChild } from './lib/start-on-port.mjs';
import { installNetworkGuard, refuseEnvFiles } from './lib/test-target-safety.mjs';
import { sealReferralEmailToken, unsealReferralEmailToken } from '../src/server/api/ref/referralEmailTokenSeal.js';

refuseEnvFiles();
const binary = process.env.POSTGREST_14_BIN;
assert.ok(binary, 'POSTGREST_14_BIN must point to PostgREST 14.5');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), '39ce04b0597c6b3c3eb4c5f34fe6ab590a2d0172616eeaccf1e4c659b822295a');
const host = '127.0.0.1';
const port = await freeTcpPort(host);
const origin = `http://${host}:${port}`;
const tag = crypto.randomBytes(6).toString('hex');
const dist = `.next-e2e-reset-${tag}`;
assert.equal(fs.existsSync(dist), false, 'Test build directory already exists');
const secret = 'fixture-only-referral-session-secret-for-conflict-test';
const token = `winner-${tag}`;
const email = `reset-${tag}@example.test`;
const id = `referral.reset-${tag}`;
const expiresAt = new Date(Date.now() + 3600000).toISOString();
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
let fixture, server, restoreNetwork;
const pending = [];
let releaseConflict, releaseCompletion;
const conflictSeen = new Promise((resolve) => { releaseConflict = resolve; });
const completionSeen = new Promise((resolve) => { releaseCompletion = resolve; });
let forced = false, conflicts = 0, delivered = 0;
const within = async (promise) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Reset conflict did not complete in two seconds')), 2000); })]);
  } finally { clearTimeout(timer); }
};

try {
  fixture = await createSweepPostgresFixture({ fullMigrationChain: true, postgrestBin: binary });
  assert.equal(fixture.postgrestVersion, 'PostgREST 14.5');
  fixture.setProviderHandler(async (request) => {
    assert.equal(request.path, '/emails');
    delivered++;
    return { body: { id: `fixture-email-${tag}` } };
  });
  const seeded = await fixture.client.rpc('roo_apply_document_mutations', { p_mutations: [{ operation: 'create', document: {
    _id: id, _type: 'referral', creatorEmail: email, registrationStatus: 'active',
    resetTokenHash: hash(token), resetTokenExpiresAt: expiresAt,
    resetDeliveryToken: sealReferralEmailToken(token, { REF_SESSION_SECRET: secret }),
  } }] });
  assert.equal(seeded.error, null);
  fixture.setRequestHook(async (phase, request) => {
    if (phase === 'before' && request.path.endsWith('/roo_refresh_operational_shadow')) throw new Error('Projection unavailable');
    if (phase === 'after' && request.path.endsWith('/roo_complete_referral_email_dispatch') && request.response?.sent === true) releaseCompletion();
    if (!request.path.endsWith('/roo_enqueue_referral_email_mutation') || request.body?.p_referral_id !== id) return;
    if (phase === 'before' && !forced) {
      forced = true;
      const revision = crypto.randomUUID();
      await fixture.sql`update migration.source_documents set source_revision = ${revision}, payload = jsonb_set(payload, '{_rev}', to_jsonb(${revision}::text)) where legacy_sanity_id = ${id}`;
    } else if (phase === 'after' && request.status === 409 && request.response?.code === 'PT409') {
      conflicts++;
      releaseConflict();
    }
  });
  restoreNetwork = installNetworkGuard([origin, fixture.origin, fixture.postgrestUrl]);
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'development', VERCEL_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
    ROO_TEST_HOST: host, NEXT_DIST_DIR: dist,
    DATA_PRIMARY_BACKEND: 'supabase', COMMERCE_PRIMARY_BACKEND: 'supabase', COMMERCE_FAILOVER_GENERATION: '0',
    SUPABASE_CUTOVER_ENABLED: '1', COMMERCE_CUTOVER_ENABLED: '1',
    SUPABASE_URL: fixture.origin, NEXT_PUBLIC_SUPABASE_URL: fixture.origin,
    SUPABASE_SECRET_KEY: fixture.token, SUPABASE_SERVICE_ROLE_KEY: fixture.token, NEXT_PUBLIC_SUPABASE_ANON_KEY: fixture.token,
    REF_SESSION_SECRET: secret, RATE_LIMIT_HASH_SECRET: 'fixture-only-rate-secret-for-conflict-test',
    RESEND_API_KEY: 'fixture-only', RESEND_BASE_URL: `${fixture.origin}/provider`,
    FROM_EMAIL: 'sender@example.test', NEXT_PUBLIC_BASE_URL: origin,
  };
  const log = path.join(fixture.scratch, 'next.log');
  ({ child: server } = await startChildOnPorts({
    host, requested: [port],
    output: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
    isReady: async () => {
      try { return (await fetch(`${origin}/api/ref/forgot`)).status === 405; } catch { return false; }
    },
    spawnChild: ([bound], launch) => {
      const fd = fs.openSync(log, 'w');
      const child = launch.spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', host, '--port', String(bound)], { env, stdio: ['ignore', fd, fd] });
      fs.closeSync(fd);
      return child;
    },
  }));
  const request = (address = email) => {
    const promise = fetch(`${origin}/api/ref/forgot`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email: address }),
    }).then((response) => ({ response }), (error) => ({ error }));
    pending.push(promise);
    return promise;
  };
  let firstComplete = false;
  const first = request().then((result) => { firstComplete = true; return result; });
  await within(conflictSeen);
  assert.equal(firstComplete, false);
  const second = request();
  const outcomes = await Promise.all([first, second]);
  for (const outcome of outcomes) if (outcome.error) throw outcome.error;
  const responses = outcomes.map((outcome) => outcome.response);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  for (const response of responses) assert.deepEqual(await response.json(), { ok: true, message: 'If email exists, link sent.' });
  await within(completionSeen);
  const [{ payload }] = await fixture.sql`select payload from migration.source_documents where legacy_sanity_id = ${id}`;
  assert.equal(payload.resetTokenHash, hash(token));
  assert.equal(unsealReferralEmailToken(payload.resetDeliveryToken, { REF_SESSION_SECRET: secret }), token);
  const [{ count, token_hash }] = await fixture.sql`select count(*)::int count, max(token_hash) token_hash from accounts.referral_email_dispatches where referral_id = ${id}`;
  assert.equal(count, 1);
  assert.equal(token_hash, hash(token));
  assert.equal(conflicts, 1);
  assert.equal(delivered, 1);
  const [bucket] = await fixture.sql`select legacy_sanity_id, source_revision, payload from migration.source_documents where document_type = 'rateLimitBucket'`;
  assert.equal(bucket.payload.count, 2);
  for (let index = 0; index < 4; index++) {
    const outcome = await request(`unknown-${tag}@example.test`);
    if (outcome.error) throw outcome.error;
    assert.equal(outcome.response.status, index === 3 ? 429 : 200);
    if (index === 3) assert.ok(Number(outcome.response.headers.get('retry-after')) > 0);
  }
  const [{ payload: limited }] = await fixture.sql`select payload from migration.source_documents where legacy_sanity_id = ${bucket.legacy_sanity_id}`;
  assert.equal(limited.count, 5);
  const stale = await within(fixture.client.rpc('roo_apply_document_mutations', { p_mutations: [{
    operation: 'replace', id: bucket.legacy_sanity_id, expected_revision: bucket.source_revision, document: bucket.payload,
  }] }));
  assert.equal(stale.error?.code, 'PT409');
  console.log('Two reset requests recovered the committed token; durable rate limits preserved their count.');
} catch (error) {
  if (!fixture && error.scratch) fs.rmSync(error.scratch, { recursive: true, force: true });
  throw error;
} finally {
  if (server) await stopChild(server);
  await Promise.all(pending);
  if (fixture) { await fixture.stop(); fs.rmSync(fixture.scratch, { recursive: true, force: true }); }
  restoreNetwork?.();
  fs.rmSync(dist, { recursive: true, force: true });
}
