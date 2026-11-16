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
const freshEmail = `fresh-reset-${tag}@example.test`;
const freshId = `referral.fresh-reset-${tag}`;
const expiresAt = new Date(Date.now() + 3600000).toISOString();
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
let fixture, server, restoreNetwork, lock, releaseFreshWinner, releaseFreshLoser;
const pending = [];
let releaseConflict, releaseCompletion;
const conflictSeen = new Promise((resolve) => { releaseConflict = resolve; });
const completionSeen = new Promise((resolve) => { releaseCompletion = resolve; });
let forced = false, conflicts = 0, delivered = 0;
let casePhase = 'fresh', freshCompletion, freshArrived, freshClaimsComplete;
const freshCompleted = new Promise((resolve) => { freshCompletion = resolve; });
const bothFreshArrived = new Promise((resolve) => { freshArrived = resolve; });
const bothFreshClaims = new Promise((resolve) => { freshClaimsComplete = resolve; });
const freshWinnerGate = new Promise((resolve) => { releaseFreshWinner = resolve; });
const freshLoserGate = new Promise((resolve) => { releaseFreshLoser = resolve; });
const freshAttempts = [], freshResults = [], freshClaims = [], emails = [];
let freshKey, projectionAttempts = 0;
const within = async (promise, label = 'Reset conflict') => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not complete in two seconds`)), 2000); })]);
  } finally { clearTimeout(timer); }
};

try {
  fixture = await createSweepPostgresFixture({ fullMigrationChain: true });
  fixture.setProviderHandler(async (request) => {
    assert.equal(request.path, '/emails');
    emails.push(request.body);
    delivered++;
    return { body: { id: `fixture-email-${tag}` } };
  });
  const seeded = await fixture.client.rpc('roo_apply_document_mutations', { p_mutations: [{ operation: 'create', document: {
    _id: id, _type: 'referral', creatorEmail: email, registrationStatus: 'active',
    resetTokenHash: hash(token), resetTokenExpiresAt: expiresAt,
    resetDeliveryToken: sealReferralEmailToken(token, { REF_SESSION_SECRET: secret }),
  } }] });
  assert.equal(seeded.error, null);
  const freshSeed = await fixture.client.rpc('roo_apply_document_mutations', { p_mutations: [{ operation: 'create', document: {
    _id: freshId, _type: 'referral', creatorEmail: freshEmail, registrationStatus: 'active',
  } }] });
  assert.equal(freshSeed.error, null);
  fixture.setRequestHook(async (phase, request) => {
    if (phase === 'before' && request.path.endsWith('/roo_refresh_operational_shadow')) { projectionAttempts++; throw new Error('Projection unavailable'); }
    if (phase === 'before' && request.path.endsWith('/roo_claim_referral_email_dispatch') && casePhase === 'fresh') {
      freshClaims.push(request.body.p_idempotency_key);
      if (freshClaims.length === 2) freshClaimsComplete();
    }
    if (phase === 'after' && request.path.endsWith('/roo_complete_referral_email_dispatch') && request.response?.sent === true) {
      if (request.body.p_idempotency_key === freshKey) freshCompletion();
      else releaseCompletion();
    }
    if (request.path.endsWith('/roo_enqueue_referral_email_mutation') && request.body?.p_referral_id === freshId) {
      if (phase === 'before') {
        freshAttempts.push(request.body);
        if (freshAttempts.length === 1) await freshWinnerGate;
        else if (freshAttempts.length === 2) { freshArrived(); await freshLoserGate; }
      } else {
        freshResults.push({ status: request.status, response: request.response });
        if (request.status === 200 && !freshKey) freshKey = request.response?.idempotency_key;
      }
      return;
    }
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
  const request = (address = email, clientAddress) => {
    const promise = fetch(`${origin}/api/ref/forgot`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, ...(clientAddress ? { 'x-forwarded-for': clientAddress } : {}) }, body: JSON.stringify({ email: address }),
    }).then((response) => ({ response }), (error) => ({ error }));
    pending.push(promise);
    return promise;
  };
  const [initial] = await fixture.sql`select source_revision, payload from migration.source_documents where legacy_sanity_id = ${freshId}`;
  assert.equal(initial.payload.resetTokenHash, undefined);
  assert.equal(initial.payload.resetDeliveryToken, undefined);
  assert.equal(initial.payload.resetTokenExpiresAt, undefined);
  lock = await fixture.sql.reserve();
  await lock`begin`;
  const [{ pid: lockPid }] = await lock`select pg_backend_pid() pid`;
  await lock`select 1 from migration.source_documents where legacy_sanity_id = ${freshId} for update`;
  const firstFresh = request(freshEmail, '192.0.2.41');
  const secondFresh = request(freshEmail, '192.0.2.41');
  try {
    await within(bothFreshArrived, 'Fresh writes');
    assert.equal(freshAttempts.length, 2);
    assert.equal(freshAttempts[0].p_mutations[0].expected_revision, initial.source_revision);
    assert.equal(freshAttempts[1].p_mutations[0].expected_revision, initial.source_revision);
    assert.notEqual(freshAttempts[0].p_delivery_payload.token, freshAttempts[1].p_delivery_payload.token);
    for (const attempt of freshAttempts) assert.equal(attempt.p_token_hash, hash(attempt.p_delivery_payload.token));
    releaseFreshWinner();
    let blocked = false;
    const deadline = Date.now() + 2000;
    while (!blocked && Date.now() < deadline) {
      const [{ count }] = await fixture.sql`select count(*)::int count from pg_stat_activity where application_name like 'PostgREST%' and wait_event_type = 'Lock' and ${lockPid} = any(pg_blocking_pids(pid))`;
      blocked = count > 0;
    }
    assert.equal(blocked, true, 'the first enqueue must wait on the source row lock');
    await lock`commit`;
    lock.release();
    lock = null;
    await within(freshCompleted, 'Winning delivery');
    const [{ source_revision: winnerRevision }] = await fixture.sql`select source_revision from migration.source_documents where legacy_sanity_id = ${freshId}`;
    assert.notEqual(winnerRevision, initial.source_revision);
    releaseFreshLoser();
    const freshOutcomes = await within(Promise.all([firstFresh, secondFresh]), 'Fresh responses');
    for (const outcome of freshOutcomes) {
      if (outcome.error) throw outcome.error;
      assert.equal(outcome.response.status, 200);
      assert.deepEqual(await outcome.response.json(), { ok: true, message: 'If email exists, link sent.' });
    }
    await within(bothFreshClaims, 'Fresh delivery claims');
    assert.equal(freshAttempts.length, 3);
    assert.deepEqual(freshResults.map((result) => result.status), [200, 409, 200]);
    assert.equal(freshResults[1].response.code, 'PT409');
    const winner = freshAttempts[0].p_delivery_payload.token;
    const loser = freshAttempts[1].p_delivery_payload.token;
    assert.ok(freshAttempts[2].p_delivery_payload.token === winner, 'the losing request must adopt the winning token');
    assert.equal(freshAttempts[2].p_token_hash, hash(winner));
    assert.equal(freshAttempts[2].p_mutations[0].expected_revision, winnerRevision);
    assert.equal(freshResults[2].response.idempotency_key, freshKey);
    assert.equal(freshResults[2].response.replayed, true);
    assert.deepEqual(freshClaims, [freshKey, freshKey]);
    const [{ payload: stored, source_revision: storedRevision }] = await fixture.sql`select payload, source_revision from migration.source_documents where legacy_sanity_id = ${freshId}`;
    assert.equal(storedRevision, winnerRevision);
    assert.equal(stored.resetTokenHash, hash(winner));
    assert.notEqual(stored.resetTokenHash, hash(loser));
    assert.equal(unsealReferralEmailToken(stored.resetDeliveryToken, { REF_SESSION_SECRET: secret }), winner);
    const [dispatch] = await fixture.sql`select count(*)::int count, max(token_hash) token_hash, max(status) status from accounts.referral_email_dispatches where referral_id = ${freshId}`;
    assert.equal(dispatch.count, 1);
    assert.equal(dispatch.token_hash, hash(winner));
    assert.equal(dispatch.status, 'sent');
    const freshEmails = emails.filter((message) => message.to.includes(freshEmail));
    assert.equal(freshEmails.length, 1);
    assert.ok(freshEmails[0].html.includes(`/referrals/reset#token=${winner}`));
  } finally {
    releaseFreshWinner();
    releaseFreshLoser();
    if (lock) { await lock`rollback`; lock.release(); lock = null; }
  }
  const [freshBucket] = await fixture.sql`select legacy_sanity_id from migration.source_documents where document_type = 'rateLimitBucket'`;
  assert.ok(freshBucket);
  casePhase = 'same';
  let firstComplete = false;
  const first = request().then((result) => { firstComplete = true; return result; });
  await within(conflictSeen);
  assert.equal(firstComplete, false);
  const [firstBucket] = await fixture.sql`select payload from migration.source_documents where document_type = 'rateLimitBucket' and legacy_sanity_id <> ${freshBucket.legacy_sanity_id}`;
  assert.equal(firstBucket.payload._type, 'rateLimitBucket');
  assert.equal(firstBucket.payload.count, 1);
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
  assert.equal(delivered, 2);
  const sameEmails = emails.filter((message) => message.to.includes(email));
  assert.equal(sameEmails.length, 1);
  assert.ok(sameEmails[0].html.includes(`/referrals/reset#token=${token}`));
  const [bucket] = await fixture.sql`select legacy_sanity_id, source_revision, payload from migration.source_documents where document_type = 'rateLimitBucket' and legacy_sanity_id <> ${freshBucket.legacy_sanity_id}`;
  assert.equal(bucket.payload.count, 2);
  for (let index = 0; index < 3; index++) {
    const outcome = await request(`unknown-${tag}@example.test`);
    if (outcome.error) throw outcome.error;
    assert.equal(outcome.response.status, 200);
  }
  const [atLimit] = await fixture.sql`select source_revision, payload from migration.source_documents where legacy_sanity_id = ${bucket.legacy_sanity_id}`;
  assert.equal(atLimit.payload._type, 'rateLimitBucket');
  assert.equal(atLimit.payload.count, 5);
  const beforeBlock = Date.now();
  const blocked = await request(`unknown-${tag}@example.test`);
  const afterBlockTime = Date.now();
  if (blocked.error) throw blocked.error;
  assert.equal(blocked.response.status, 429);
  const retryAfter = Number(blocked.response.headers.get('retry-after'));
  const resetAt = Date.parse(atLimit.payload.resetAt);
  assert.ok(retryAfter >= Math.max(1, Math.ceil((resetAt - afterBlockTime) / 1000)));
  assert.ok(retryAfter <= Math.max(1, Math.ceil((resetAt - beforeBlock) / 1000)));
  const [afterBlock] = await fixture.sql`select source_revision, payload from migration.source_documents where legacy_sanity_id = ${bucket.legacy_sanity_id}`;
  assert.deepEqual(afterBlock, atLimit);
  const { payload: limited } = afterBlock;
  assert.equal(limited.count, 5);
  const stale = await within(fixture.client.rpc('roo_apply_document_mutations', { p_mutations: [{
    operation: 'replace', id: bucket.legacy_sanity_id, expected_revision: bucket.source_revision, document: bucket.payload,
  }] }));
  assert.equal(stale.error?.code, 'PT409');
  const [afterStale] = await fixture.sql`select source_revision, payload from migration.source_documents where legacy_sanity_id = ${bucket.legacy_sanity_id}`;
  assert.deepEqual(afterStale, atLimit);
  assert.equal(projectionAttempts, 0);
  console.log('Fresh and existing reset tokens survived conflicts; durable rate limits preserved their count and revision.');
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
