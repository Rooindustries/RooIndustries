import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { after, before, beforeEach, test } from 'node:test';
import { evaluate, parse } from 'groq-js';
import { createBookingContactFixture } from './fixtures/booking-contact.mjs';
import {
  RECOVERY_RECORDS_GROQ,
  RESUMABLE_WATCH_REASONS,
} from '../src/server/api/payment/lateCaptureRecovery.js';

let fixture;
before(async () => {
  fixture = await createBookingContactFixture({ artifactName: 'payment-recovery-hold-sql' });
});
beforeEach(() => {
  fixture.setPaymentAmountOverrides({});
  fixture.setCheckoutPaymentStarted(true);
  fixture.setProviderLookupFailure(false);
  fixture.setRequestHook(null);
});
after(async () => {
  fixture?.setRequestHook(null);
  await fixture?.stop();
});

const cron = () => fixture.post('/api/payment/reconcile', {}, 'fixture-only-cron');
const holdFor = payload => fixture.commerce.getDocument(payload.slotHoldId);
const recordFor = started =>
  fixture.commerce.fetch('*[_type == "paymentRecord" && providerOrderId == $id][0]', {
    id: started.body.providerPayload.orderId,
  });

const startCheckout = async () => {
  const payload = await fixture.hold();
  const started = await fixture.start(payload);
  assert.equal(started.status, 200, JSON.stringify(started));
  const record = await recordFor(started);
  return { payload, started, record };
};

const ageHoldPast24h = async (slotHoldId, hours = 25) => {
  const expiresAt = new Date(Date.now() - hours * 60 * 60_000).toISOString();
  await fixture.database.sql.begin(async sql => {
    await sql`set local session_replication_role = replica`;
    await sql`update migration.source_documents set payload = jsonb_set(payload, '{expiresAt}', to_jsonb(${expiresAt}::text)) where legacy_sanity_id = ${slotHoldId}`;
    await sql`update commerce.slot_holds set expires_at = ${expiresAt} where legacy_sanity_id = ${slotHoldId}`;
    await sql`update commerce.slot_claims set expires_at = ${expiresAt} where hold_id = (select id from commerce.slot_holds where legacy_sanity_id = ${slotHoldId})`;
  });
};

const cleanFencedState = async () => {
  await fixture.database.sql`delete from commerce.reconcile_hold_cleanup_blocks`;
  await fixture.database.sql`delete from commerce.reconcile_cleanup_runs`;
};

const seedPaymentDoc = async (id, overrides = {}) => {
  const doc = {
    _id: id,
    _type: 'paymentRecord',
    backendOwner: 'supabase',
    cutoverGeneration: 0,
    provider: 'dodo',
    status: 'needs_recovery',
    providerOrderId: `sess_${id.replace(/[^a-zA-Z0-9]/g, '_')}`,
    providerIdempotencyKey: `idem_${id.replace(/[^a-zA-Z0-9]/g, '_')}`,
    sessionScope: `scope:${id}`,
    startClaimId: `claim.${id}`,
    updatedAt: '2026-09-10T00:00:00.000Z',
    nextRecoveryAt: '2026-09-10T00:00:00.000Z',
    pricingSnapshot: { currency: 'USD', grossAmount: 29.95, netAmount: 29.95 },
    providerPublicData: { currency: 'USD', productId: 'pdt_fixture', environment: 'test_mode', taxInclusive: false },
    ...overrides,
  };
  await fixture.commerce.create(doc);
  return fixture.commerce.getDocument(id);
};

const runGroqRecovery = async (docs, { dodoEnabled, now }) => {
  const tree = parse(RECOVERY_RECORDS_GROQ);
  const res = await evaluate(tree, {
    dataset: docs,
    params: {
      type: 'paymentRecord',
      terminalCurrencyReasons: ['payment_currency_mismatch', 'payment_currency_invalid'],
      resumableWatchReasons: RESUMABLE_WATCH_REASONS,
      dodoEnabled,
      statuses: ['started', 'captured_client', 'captured_webhook', 'finalizing', 'email_partial', 'needs_recovery'],
      emailPartialStatus: 'email_partial',
      bookedStatus: 'booked',
      abandonedStatus: 'abandoned',
      now,
    },
  });
  return (await res.get()).map(d => d._id);
};

test('20261118000000 rollback and reapply cleanly reverses and restores migration', async () => {
  await cleanFencedState();
  const rbSql = fs.readFileSync(path.join(process.cwd(), 'supabase/rollbacks/20261118000000_harden_payment_recovery_and_hold_cleanup.sql'), 'utf8');
  const upSql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261118000000_harden_payment_recovery_and_hold_cleanup.sql'), 'utf8');
  await fixture.database.apply('rollback-20261118', rbSql);
  const [gone] = await fixture.database.sql`select to_regclass('commerce.reconcile_cleanup_runs') as t, to_regprocedure('commerce.payment_protects_expired_hold(text,jsonb)') as f`;
  assert.equal(gone.t, null);
  assert.equal(gone.f, null);
  await fixture.database.apply('reapply-20261118', upSql);
  const [back] = await fixture.database.sql`select to_regclass('commerce.reconcile_cleanup_runs') as t, to_regprocedure('commerce.payment_protects_expired_hold(text,jsonb)') as f`;
  assert.ok(back.t);
  assert.ok(back.f);
});

test('SQL-vs-GROQ mixed-due >50-row ID parity and Dodo-disabled processing+release overlap zero starvation', async () => {
  await cleanFencedState();
  const now = '2026-09-10T12:00:00.000Z';
  const ids = [];
  for (let i = 0; i < 55; i += 1) {
    const id = `paymentRecord.parity.ord.${String(i).padStart(3, '0')}`;
    ids.push(id);
    await seedPaymentDoc(id, {
      provider: i % 3 === 0 ? 'paypal' : 'dodo',
      status: 'needs_recovery',
      nextRecoveryAt: i % 5 === 0 ? '' : `2026-09-10T0${i % 9}:00:00.000Z`,
      updatedAt: `2026-09-10T00:${String(i).padStart(2, '0')}:00.000Z`,
    });
  }
  const hiId = 'paymentRecord.parity.ex_cleanup';
  const liveId = 'paymentRecord.parity.ex_live';
  const overlapId = 'paymentRecord.parity.proc_overlap';
  ids.push(hiId, liveId, overlapId);
  await seedPaymentDoc(hiId, {
    status: 'failed',
    reconciliationRecoveryTerminal: true,
    resourceReleasePending: true,
    recoveryFailureCount: 12,
    providerPaymentState: 'failed',
    nextRecoveryAt: '9999-12-31T23:59:59.999Z',
    updatedAt: '2026-09-10T11:59:00.000Z',
  });
  await seedPaymentDoc(liveId, {
    status: 'needs_recovery',
    reconciliationRecoveryTerminal: true,
    resourceReleasePending: false,
    providerPaymentState: 'processing',
    nextRecoveryAt: '9999-12-31T23:59:59.999Z',
    updatedAt: '2026-09-10T11:58:00.000Z',
  });
  await seedPaymentDoc(overlapId, {
    status: 'failed',
    reconciliationRecoveryTerminal: true,
    resourceReleasePending: true,
    providerPaymentState: 'processing',
    lateCaptureWatchUntil: '2099-01-01T00:00:00.000Z',
    nextRecoveryAt: '9999-12-31T23:59:59.999Z',
  });
  await fixture.commerce.patch(hiId).set({ nextRecoveryAt: '2026-09-10T01:30:00.000Z' }).commit();

  const allDocs = (await fixture.database.sql`select payload from migration.source_documents where document_type = 'paymentRecord' and not tombstoned`).map(r => r.payload);
  for (const dodoEnabled of [true, false]) {
    const [{ rows: sqlRows }] = await fixture.database.sql`
      select public.roo_fetch_recovery_payment_documents(
        'supabase', array['started','captured_client','captured_webhook','finalizing','email_partial','needs_recovery'],
        'refunded', 'booked', 'abandoned', ${now}::timestamptz, 50, ${dodoEnabled}, null
      ) as rows`;
    const sqlIds = (sqlRows || []).map(r => r._id);
    const groqIds = await runGroqRecovery(allDocs, { dodoEnabled, now });
    assert.deepEqual(sqlIds, groqIds);
    assert.equal(sqlIds.includes(hiId), true);
    assert.equal(sqlIds.includes(liveId), dodoEnabled);
    assert.equal(sqlIds.includes(overlapId), dodoEnabled);
  }
  await fixture.database.sql`delete from commerce.payment_records where legacy_sanity_id like 'paymentRecord.parity.%'`;
  await fixture.database.sql`delete from migration.source_documents where legacy_sanity_id like 'paymentRecord.parity.%'`;
});

test('>25h exhaustion-owned hold backstop protects failed, blank, and unknown Dodo states', async () => {
  await cleanFencedState();
  for (const pState of ['failed', '', 'unknown']) {
    const checkout = await startCheckout();
    await fixture.commerce.patch(checkout.record._id).set({
      status: 'needs_recovery',
      resourceReleasePending: true,
      reconciliationRecoveryTerminal: true,
      recoveryFailureCount: 12,
      recoveryReason: 'resource_release_exhausted',
      providerPaymentState: pState,
      nextRecoveryAt: '2099-01-01T00:00:00.000Z',
    }).commit();
    await ageHoldPast24h(checkout.payload.slotHoldId, 26);
    const [{ res }] = await fixture.database.sql`select public.roo_cleanup_expired_supabase_holds(0, 100) as res`;
    assert.equal(res.expired_holds, 0, JSON.stringify({ pState, res }));
    assert.equal((await holdFor(checkout.payload)).phase, 'payment_pending');
  }
});

test('legacy unverified reversal reverification handles missing/blank/sentinel timestamps across all 3 outcomes', async () => {
  await cleanFencedState();
  const cases = [
    { label: 'verified', ts: undefined, overrides: { refund_status: 'full', refunds: [{ refund_id: 'rev_ok_1', amount: 2995, currency: 'USD', status: 'succeeded' }] }, expectState: 'refunded', expectVerified: true },
    { label: 'won_dispute', ts: '', overrides: { disputes: [{ dispute_id: 'rev_won_1', dispute_stage: 'dispute', dispute_status: 'dispute_won', amount: '29.95' }] }, expectState: 'succeeded', expectVerified: false },
    { label: 'unavailable', ts: '9999-12-31T23:59:59.999Z', lookupFail: true, overrides: {}, expectState: 'refunded', expectVerified: false },
  ];
  for (const c of cases) {
    fixture.setProviderLookupFailure(Boolean(c.lookupFail));
    const checkout = await startCheckout();
    const paymentId = `payment_${checkout.record.providerOrderId}`;
    const ov = c.overrides.refunds
      ? { ...c.overrides, refunds: c.overrides.refunds.map(r => ({ ...r, payment_id: paymentId })) }
      : c.overrides;
    fixture.setPaymentAmountOverrides(ov);
    const patch = {
      status: 'needs_recovery',
      providerRecoveryTerminal: true,
      reconciliationRecoveryTerminal: true,
      providerPaymentState: 'refunded',
      nextRecoveryAt: '9999-12-31T23:59:59.999Z',
    };
    if (c.ts !== undefined) patch.providerStateCheckedAt = c.ts;
    await fixture.commerce.patch(checkout.record._id).set(patch).commit();
    if (c.ts === undefined) await fixture.commerce.patch(checkout.record._id).unset(['providerStateCheckedAt']).commit();
    const res = await cron();
    assert.equal(res.status, 200, JSON.stringify({ c: c.label, res }));
    const updated = await fixture.commerce.getDocument(checkout.record._id);
    assert.equal(updated.providerPaymentState, c.expectState, c.label);
    assert.equal(updated.providerReversalVerified, c.expectVerified, c.label);
    await fixture.commerce.patch(checkout.record._id).set({ providerReversalVerified: true, providerPaymentState: 'refunded', providerStateCheckedAt: '9999-12-31T23:59:59.999Z' }).commit();
  }
});

test('HTTP reconcile-cleanup rows (i)..(viii): fenced blocks, batch overflow, overlap, SIGKILL, sequence order, owner-review failure, and expired-lease refusal', async () => {
  await cleanFencedState();

  const checkoutI = await startCheckout();
  await ageHoldPast24h(checkoutI.payload.slotHoldId, 26);
  fixture.setPaymentAmountOverrides({ status: 'succeeded' });
  let failOnce = true;
  fixture.setRequestHook(async (phase, req) => {
    if (failOnce && phase === 'before' && req.path.startsWith('/rest/v1/rpc/roo_apply_commerce_document_mutations')) {
      failOnce = false;
      throw new Error('Synthetic capture write failure');
    }
  });
  const cronA = await cron();
  fixture.setRequestHook(null);
  assert.equal(cronA.status, 503, JSON.stringify(cronA));
  assert.equal(cronA.body.summary.expiredSupabaseHoldCleanup.skipped, true);
  assert.equal((await holdFor(checkoutI.payload)).phase, 'payment_pending');
  const [blockI] = await fixture.database.sql`select b.run_id, r.state, r.fenced_seq from commerce.reconcile_hold_cleanup_blocks b join commerce.reconcile_cleanup_runs r on r.run_id = b.run_id where b.payment_record_id = ${checkoutI.record._id}`;
  assert.equal(blockI.state, 'failed');
  assert.ok(blockI.fenced_seq);

  const fillerIds = [];
  for (let i = 0; i < 55; i += 1) {
    const fid = `paymentRecord.row2.main.${String(i).padStart(3, '0')}`;
    fillerIds.push(fid);
    await seedPaymentDoc(fid, { provider: 'paypal', status: 'needs_recovery', nextRecoveryAt: '2020-01-01T00:00:00.000Z', updatedAt: `2020-01-01T00:${String(i).padStart(2, '0')}:00.000Z` });
  }
  const [{ run_id: oldFencedRun }] = await fixture.database.sql`insert into commerce.reconcile_cleanup_runs (state, lease_expires_at, started_at, finished_at, fenced_seq) values ('failed', now() - interval '1 hour', now() - interval '2 hours', now() - interval '1 hour', nextval('commerce.reconcile_fence_seq')) returning run_id`;
  const blockedFillers = [];
  for (let i = 0; i < 22; i += 1) {
    const bc = await startCheckout();
    blockedFillers.push(bc);
    await fixture.database.sql`insert into commerce.reconcile_hold_cleanup_blocks (payment_record_id, run_id, blocked_at) values (${bc.record._id}, ${oldFencedRun}, '2020-01-01T00:00:00Z'::timestamptz + (${i} || ' seconds')::interval)`;
  }
  const [{ main_rows: mainPicked }] = await fixture.database.sql`select public.roo_fetch_recovery_payment_documents('supabase', array['started','captured_client','captured_webhook','finalizing','email_partial','needs_recovery'], 'refunded', 'booked', 'abandoned', now(), 50, true, null) as main_rows`;
  const [{ rev_rows: revPicked }] = await fixture.database.sql`select public.roo_fetch_owner_review_dodo_documents(null, now(), 20) as rev_rows`;
  assert.equal(mainPicked.some(r => r._id === checkoutI.record._id), false);
  assert.equal(revPicked.some(r => r._id === checkoutI.record._id), false);
  const [{ cleanup_res: row2Cleanup }] = await fixture.database.sql`select public.roo_cleanup_expired_supabase_holds(0, 100) as cleanup_res`;
  assert.equal(row2Cleanup.expired_holds, 0);
  assert.equal((await holdFor(checkoutI.payload)).phase, 'payment_pending');
  await fixture.database.sql`delete from commerce.reconcile_hold_cleanup_blocks where run_id = ${oldFencedRun}`;
  await fixture.database.sql`delete from commerce.payment_records where legacy_sanity_id like 'paymentRecord.row2.%'`;
  await fixture.database.sql`delete from migration.source_documents where legacy_sanity_id like 'paymentRecord.row2.%'`;
  for (const bc of blockedFillers) {
    await fixture.commerce.patch(bc.record._id).set({ status: 'abandoned', providerRecoveryTerminal: true, reconciliationRecoveryTerminal: true, providerPaymentState: 'failed', nextRecoveryAt: '9999-12-31T23:59:59.999Z' }).commit();
  }

  const checkoutIII = await startCheckout();
  await fixture.commerce.patch(checkoutIII.record._id).set({ status: 'failed', providerPaymentState: 'failed', reconciliationRecoveryTerminal: true, providerRecoveryTerminal: true, nextRecoveryAt: '9999-12-31T23:59:59.999Z' }).commit();
  await ageHoldPast24h(checkoutIII.payload.slotHoldId, 26);
  const [{ started: activeRun }] = await fixture.database.sql`select public.roo_start_reconcile_cleanup_run(180) as started`;
  const [{ cleanup_iii: cIII }] = await fixture.database.sql`select public.roo_cleanup_expired_supabase_holds(0, 100) as cleanup_iii`;
  assert.equal(cIII.expired_holds, 0);
  assert.equal((await holdFor(checkoutIII.payload)).phase, 'payment_pending');
  await fixture.database.sql`select public.roo_complete_reconcile_cleanup_run(${activeRun.run_id}::uuid)`;

  const spawnKillWorker = async (mode) => {
    const workerCode = `
      import postgres from 'postgres';
      const sql = postgres({ host: ${JSON.stringify(fixture.database.host)}, port: ${fixture.database.pgPort}, database: 'postgres', max: 2, prepare: false });
      const [{ r }] = await sql\`select public.roo_start_reconcile_cleanup_run(1) as r\`;
      if (${JSON.stringify(mode)} === 'before_fetch') {
        process.send({ phase: 'ready', runId: r.run_id });
        setInterval(() => {}, 1000);
      } else {
        await sql\`select public.roo_fetch_recovery_payment_documents('supabase', array['started','needs_recovery'], 'refunded', 'booked', 'abandoned', now(), 50, true, \${r.run_id}::uuid)\`;
        process.send({ phase: 'ready', runId: r.run_id });
        setInterval(() => {}, 1000);
      }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerCode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const msg = await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Worker exited early: ${code}`)));
    });
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    return msg.runId;
  };
  const runBeforeFetch = await spawnKillWorker('before_fetch');
  await fixture.database.sql`update commerce.reconcile_cleanup_runs set lease_expires_at = clock_timestamp() - interval '5 seconds' where run_id = ${runBeforeFetch}::uuid`;
  await fixture.database.sql`select commerce.expire_timed_out_reconcile_runs(clock_timestamp())`;
  const [rBefore] = await fixture.database.sql`select state, fenced_seq from commerce.reconcile_cleanup_runs where run_id = ${runBeforeFetch}::uuid`;
  assert.equal(rBefore.state, 'timed_out');
  assert.ok(rBefore.fenced_seq);

  const checkoutIV = await startCheckout();
  await ageHoldPast24h(checkoutIV.payload.slotHoldId, 26);
  const runAfterFetch = await spawnKillWorker('after_fetch', checkoutIV.record._id);
  await fixture.database.sql`update commerce.reconcile_cleanup_runs set lease_expires_at = clock_timestamp() - interval '5 seconds' where run_id = ${runAfterFetch}::uuid`;
  const [{ cleanup_iv: cIV }] = await fixture.database.sql`select public.roo_cleanup_expired_supabase_holds(0, 100) as cleanup_iv`;
  const [rAfter] = await fixture.database.sql`select state, fenced_seq from commerce.reconcile_cleanup_runs where run_id = ${runAfterFetch}::uuid`;
  assert.equal(rAfter.state, 'timed_out');
  assert.ok(rAfter.fenced_seq);
  assert.equal((await holdFor(checkoutIV.payload)).phase, 'payment_pending');
  assert.equal((await holdFor(checkoutIII.payload)).phase, 'expired');
  assert.equal(cIV.expired_holds, 1);

  await cleanFencedState();
  const checkoutV = await startCheckout();
  await fixture.commerce.patch(checkoutV.record._id).set({ status: 'failed', providerPaymentState: 'failed', reconciliationRecoveryTerminal: true, providerRecoveryTerminal: true, nextRecoveryAt: '9999-12-31T23:59:59.999Z' }).commit();
  await ageHoldPast24h(checkoutV.payload.slotHoldId, 26);
  const [{ s: runB }] = await fixture.database.sql`select public.roo_start_reconcile_cleanup_run(180) as s`;
  const [{ s: runA }] = await fixture.database.sql`select public.roo_start_reconcile_cleanup_run(180) as s`;
  const [{ b: begB }] = await fixture.database.sql`select public.roo_begin_reconcile_record_inspection(${runB.run_id}::uuid, ${checkoutV.record._id}) as b`;
  const [{ b: begA }] = await fixture.database.sql`select public.roo_begin_reconcile_record_inspection(${runA.run_id}::uuid, ${checkoutV.record._id}) as b`;
  assert.ok(Number(begA.inspection_started_seq) > Number(begB.inspection_started_seq));
  const [{ f: failA }] = await fixture.database.sql`select public.roo_fail_reconcile_cleanup_run(${runA.run_id}::uuid) as f`;
  assert.ok(Number(failA.fenced_seq) > Number(begB.inspection_started_seq));
  const [{ cl: clearB }] = await fixture.database.sql`select public.roo_clear_reconcile_cleanup_block(${runB.run_id}::uuid, ${checkoutV.record._id}, true) as cl`;
  assert.equal(clearB.fenced_cleared, 0);
  await fixture.database.sql`select public.roo_complete_reconcile_cleanup_run(${runB.run_id}::uuid)`;

  fixture.setProviderLookupFailure(true);
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkoutV.payload)).phase, 'payment_pending');

  fixture.setProviderLookupFailure(false);
  fixture.setPaymentAmountOverrides({ status: 'mystery_unknown_status' });
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkoutV.payload)).phase, 'payment_pending');

  fixture.setPaymentAmountOverrides({});
  const savedApiKey = process.env.DODO_PAYMENTS_API_KEY;
  fixture.setRequestHook(async (phase, req) => {
    if (phase === 'before' && req.path.startsWith('/rest/v1/rpc/roo_begin_reconcile_record_inspection')) {
      process.env.DODO_PAYMENTS_API_KEY = '';
    }
  });
  try {
    const cronDisabled = await cron();
    assert.equal(cronDisabled.status, 200, JSON.stringify(cronDisabled));
  } finally {
    process.env.DODO_PAYMENTS_API_KEY = savedApiKey;
    fixture.setRequestHook(null);
  }
  assert.equal((await holdFor(checkoutV.payload)).phase, 'payment_pending');

  fixture.setPaymentAmountOverrides({ status: 'failed' });
  assert.equal((await cron()).status, 200);
  assert.equal((await holdFor(checkoutV.payload)).phase, 'expired');

  await cleanFencedState();
  const checkoutVI = await startCheckout();
  await fixture.commerce.patch(checkoutVI.record._id).set({
    status: 'needs_recovery',
    reconciliationRecoveryTerminal: true,
    providerRecoveryTerminal: true,
    providerPaymentState: 'unknown',
    providerStateCheckedAt: '2000-01-01T00:00:00.000Z',
    nextRecoveryAt: '9999-12-31T23:59:59.999Z',
  }).commit();
  await ageHoldPast24h(checkoutVI.payload.slotHoldId, 26);
  fixture.setPaymentAmountOverrides({ status: 'succeeded' });
  let failOwnerWrite = true;
  fixture.setRequestHook(async (phase, req) => {
    if (failOwnerWrite && phase === 'before' && req.path.startsWith('/rest/v1/rpc/roo_apply_commerce_document_mutations')) {
      failOwnerWrite = false;
      throw new Error('Synthetic owner-review write failure');
    }
  });
  const cronVI = await cron();
  fixture.setRequestHook(null);
  assert.equal(cronVI.status, 503, JSON.stringify(cronVI));
  assert.equal(cronVI.body.summary.expiredSupabaseHoldCleanup.skipped, true);
  assert.equal((await holdFor(checkoutVI.payload)).phase, 'payment_pending');

  await cleanFencedState();
  const checkoutVII = await startCheckout();
  await fixture.commerce.patch(checkoutVII.record._id).set({
    status: 'failed',
    reconciliationRecoveryTerminal: true,
    providerRecoveryTerminal: true,
    providerPaymentState: 'unknown',
    providerStateCheckedAt: '2000-01-01T00:00:00.000Z',
    nextRecoveryAt: '9999-12-31T23:59:59.999Z',
  }).commit();
  await ageHoldPast24h(checkoutVII.payload.slotHoldId, 26);
  const [{ s: runVII }] = await fixture.database.sql`select public.roo_start_reconcile_cleanup_run(1) as s`;
  await fixture.database.sql`select public.roo_fetch_owner_review_dodo_documents(${runVII.run_id}::uuid, now(), 20)`;
  await fixture.commerce.patch(checkoutVII.record._id).set({ providerPaymentState: 'failed', providerStateCheckedAt: '9999-12-31T23:59:59.999Z' }).commit();
  await fixture.database.sql`update commerce.reconcile_cleanup_runs set lease_expires_at = clock_timestamp() - interval '5 seconds' where run_id = ${runVII.run_id}::uuid`;
  fixture.setPaymentAmountOverrides({ status: 'failed' });
  const cronVII = await cron();
  assert.equal(cronVII.status, 200, JSON.stringify(cronVII));
  assert.equal(cronVII.body.summary.expiredSupabaseHoldCleanup.expired_holds, 1);
  assert.equal((await holdFor(checkoutVII.payload)).phase, 'expired');

  await cleanFencedState();
  const checkoutVIII = await startCheckout();
  await fixture.commerce.patch(checkoutVIII.record._id).set({
    status: 'failed',
    providerPaymentState: 'failed',
    reconciliationRecoveryTerminal: true,
    providerRecoveryTerminal: true,
    nextRecoveryAt: '9999-12-31T23:59:59.999Z',
  }).commit();
  await ageHoldPast24h(checkoutVIII.payload.slotHoldId, 26);
  const [{ s: runVIII }] = await fixture.database.sql`select public.roo_start_reconcile_cleanup_run(1) as s`;
  await fixture.database.sql`select public.roo_begin_reconcile_record_inspection(${runVIII.run_id}::uuid, ${checkoutVIII.record._id})`;
  await fixture.database.sql`update commerce.reconcile_cleanup_runs set lease_expires_at = clock_timestamp() - interval '5 seconds' where run_id = ${runVIII.run_id}::uuid`;
  await fixture.database.sql`select commerce.expire_timed_out_reconcile_runs(clock_timestamp())`;
  const [{ cl: refusedClear }] = await fixture.database.sql`select public.roo_clear_reconcile_cleanup_block(${runVIII.run_id}::uuid, ${checkoutVIII.record._id}, true) as cl`;
  assert.equal(refusedClear.ok, false);
  assert.equal(refusedClear.reason, 'run_not_active');
  const [{ comp: refusedComp }] = await fixture.database.sql`select public.roo_complete_reconcile_cleanup_run(${runVIII.run_id}::uuid) as comp`;
  assert.equal(refusedComp.completed, false);
  const [{ cl_viii: cVIII }] = await fixture.database.sql`select public.roo_cleanup_expired_supabase_holds(0, 100) as cl_viii`;
  assert.equal(cVIII.expired_holds, 0);
  assert.equal((await holdFor(checkoutVIII.payload)).phase, 'payment_pending');
  fixture.setPaymentAmountOverrides({ status: 'failed' });
  const cronVIII = await cron();
  assert.equal(cronVIII.status, 200);
  assert.equal((await holdFor(checkoutVIII.payload)).phase, 'expired');
});

test('3 forced-order Postgres lock-alignment and post-lock-recheck rows protect expired payment holds', async () => {
  await cleanFencedState();

  const c1 = await startCheckout();
  await fixture.commerce.patch(c1.record._id).set({ status: 'failed', providerPaymentState: 'failed', reconciliationRecoveryTerminal: true, providerRecoveryTerminal: true, nextRecoveryAt: '9999-12-31T23:59:59.999Z' }).commit();
  await ageHoldPast24h(c1.payload.slotHoldId, 26);
  let releaseAdvisory;
  const advHeld = new Promise(resolve => { releaseAdvisory = resolve; });
  let advAcquired;
  const advReady = new Promise(resolve => { advAcquired = resolve; });
  const txAdv = fixture.database.sql.begin(async sql => {
    await sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity', 0))`;
    advAcquired();
    await advHeld;
    await sql`update migration.source_documents set payload = jsonb_set(payload, '{providerPaymentState}', '"succeeded"'::jsonb) where legacy_sanity_id = ${c1.record._id}`;
  });
  await advReady;
  const cleanup1Promise = fixture.database.sql`select public.roo_cleanup_expired_supabase_holds(0, 100) as res`;
  await new Promise(r => setTimeout(r, 150));
  releaseAdvisory();
  await txAdv;
  const [{ res: r1 }] = await cleanup1Promise;
  assert.equal(r1.expired_holds, 0);
  assert.equal((await holdFor(c1.payload)).phase, 'payment_pending');

  const c2 = await startCheckout();
  await fixture.commerce.patch(c2.record._id).set({ status: 'failed', providerPaymentState: 'failed', reconciliationRecoveryTerminal: true, providerRecoveryTerminal: true, nextRecoveryAt: '9999-12-31T23:59:59.999Z' }).commit();
  await ageHoldPast24h(c2.payload.slotHoldId, 26);
  let releaseRowLock;
  const rowHeld = new Promise(resolve => { releaseRowLock = resolve; });
  let rowAcquired;
  const rowReady = new Promise(resolve => { rowAcquired = resolve; });
  const txRow = fixture.database.sql.begin(async sql => {
    await sql`select 1 from migration.source_documents where legacy_sanity_id = ${c2.record._id} for update`;
    rowAcquired();
    await rowHeld;
  });
  await rowReady;
  const [{ res: r2 }] = await fixture.database.sql`select public.roo_cleanup_expired_supabase_holds(0, 100) as res`;
  releaseRowLock();
  await txRow;
  assert.equal(r2.expired_holds, 0);
  assert.equal((await holdFor(c2.payload)).phase, 'payment_pending');
  await fixture.commerce.patch(c2.record._id).set({ providerPaymentState: 'succeeded' }).commit();

  const c3a = await startCheckout();
  const c3b = await startCheckout();
  for (const cx of [c3a, c3b]) {
    await fixture.commerce.patch(cx.record._id).set({ status: 'failed', providerPaymentState: 'failed', reconciliationRecoveryTerminal: true, providerRecoveryTerminal: true, nextRecoveryAt: '9999-12-31T23:59:59.999Z' }).commit();
  }
  await ageHoldPast24h(c3a.payload.slotHoldId, 27);
  await ageHoldPast24h(c3b.payload.slotHoldId, 26);
  await fixture.database.sql.unsafe(`
    create or replace function migration.test_barrier_promote_second_payment()
    returns trigger language plpgsql as $$
    begin
      if new.legacy_sanity_id = '${c3a.payload.slotHoldId}' and new.payload->>'phase' = 'expired' then
        update migration.source_documents
        set payload = jsonb_set(payload, '{providerPaymentState}', '"succeeded"'::jsonb)
        where legacy_sanity_id = '${c3b.record._id}';
      end if;
      return new;
    end;
    $$;
    drop trigger if exists trg_test_barrier_promote on migration.source_documents;
    create trigger trg_test_barrier_promote before update on migration.source_documents
    for each row execute function migration.test_barrier_promote_second_payment();
  `);
  try {
    const [{ res: r3 }] = await fixture.database.sql`select public.roo_cleanup_expired_supabase_holds(0, 100) as res`;
    assert.equal(r3.expired_holds, 1);
    assert.equal((await holdFor(c3a.payload)).phase, 'expired');
    assert.equal((await holdFor(c3b.payload)).phase, 'payment_pending');
  } finally {
    await fixture.database.sql.unsafe(`
      drop trigger if exists trg_test_barrier_promote on migration.source_documents;
      drop function if exists migration.test_barrier_promote_second_payment();
    `);
  }
});
