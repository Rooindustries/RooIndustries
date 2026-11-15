import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import { createBookingContactFixture } from './fixtures/booking-contact.mjs';
import { scenarios } from '../scripts/lib/conflict-code-scenarios.mjs';

assert.ok(process.env.POSTGREST_14_BIN, 'POSTGREST_14_BIN must point to PostgREST 14.5');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(process.env.POSTGREST_14_BIN)).digest('hex'), '39ce04b0597c6b3c3eb4c5f34fe6ab590a2d0172616eeaccf1e4c659b822295a');
process.env.POSTGREST_BIN = process.env.POSTGREST_14_BIN;

const within = async (promise, milliseconds) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Request exceeded ${milliseconds} ms`)), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
};

test('write conflicts return through the application', async (t) => {
  const runCase = (name, run) => t.test(name, async () => {
    const fixture = await createBookingContactFixture({ artifactName: 'write-conflicts' });
    const { commerce, database } = fixture;
    const tag = crypto.randomBytes(6).toString('hex');
    const stopRequests = async () => {
      await database.sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name like 'PostgREST%' and query not like 'LISTEN%' and state <> 'idle'`;
    };
    try { await run({ fixture, commerce, database, tag, stopRequests }); }
    finally {
      await fixture.stop();
    }
  });
  await runCase('concurrent finalizations return the booked state', async ({ fixture, commerce, database, stopRequests }) => {
      const payload = await fixture.hold();
      const started = await fixture.start(payload);
      assert.equal(started.status, 200, JSON.stringify(started));
      const record = await fixture.recordFor(payload);
      let release, reached;
      const paused = new Promise((resolve) => { reached = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      let held = false, conflict = false;
      database.setRequestHook(async (phase, request) => {
        const mutation = request.body?.p_mutations?.find((item) => item.document?._id === record._id);
        if (phase === 'after' && mutation && request.status === 409 && request.response?.code === 'PT409') conflict = true;
        if (phase === 'before' && mutation && !held) { held = true; reached(); await gate; }
      });
      const first = within(fixture.post('/api/payment/finalize', {}, started.body.paymentAccessToken), 2000);
      try {
        await within(paused, 2000);
        const second = await within(fixture.post('/api/payment/finalize', {}, started.body.paymentAccessToken), 2000);
        release();
        const loser = await first;
        assert.equal(second.status, 200, JSON.stringify(second));
        assert.equal(loser.status, 200, JSON.stringify(loser));
        assert.ok(second.body.bookingId);
        assert.equal(loser.body.bookingId, second.body.bookingId);
        assert.equal((await commerce.getDocument(record._id)).status, 'booked');
        assert.equal(conflict, true, 'the losing write must reach the database conflict');
      } finally { release(); database.setRequestHook(null); await stopRequests(); }
    });

  await runCase('suppressed booking ledger reads return promptly', async ({ commerce, database, tag, stopRequests }) => {
      const { readTerminalBookingEmailDispatches } = await import('../src/server/supabase/emailDispatchLedger.js');
      const id = `booking.conflict-${tag}`;
      await commerce.create({ _id: id, _type: 'booking', status: 'cancelled', backendOwner: 'supabase', cutoverGeneration: 0 });
      const [{ booking_id }] = await database.sql`select id booking_id from commerce.bookings where legacy_sanity_id = ${id}`;
      await database.sql`delete from commerce.email_dispatches where booking_id = ${booking_id}`;
      for (const recipient of ['customer', 'owner']) {
        const key = `booking-${id}-${recipient === 'customer' ? 'client' : 'owner'}`;
        await database.sql`insert into commerce.email_dispatches (booking_id, recipient_type, recipient_email_hash, idempotency_key, status, last_error_code) values (${booking_id}, ${recipient}, 'fixture', ${key}, 'failed', 'booking_inactive')`;
      }
      try {
        const result = await within(readTerminalBookingEmailDispatches({ client: commerce, bookingId: id }), 1000);
        assert.equal(result.customer.inactive, true);
        assert.equal(result.owner.inactive, true);
      } finally { await stopRequests(); }
    });

  await runCase('referral email source conflict sets the source-state flag', async ({ database, tag, stopRequests }) => {
      const { enqueueReferralEmailMutation, isReferralEmailSourceStateConflict } = await import('../src/server/api/ref/referralEmailDispatches.js');
      const scenario = scenarios.find((item) => item.id === 'S13');
      for (const seed of scenario.seed) await database.sql.unsafe(seed(tag).sql);
      const { body } = scenario.call(tag);
      try {
        await assert.rejects(within(enqueueReferralEmailMutation({
          mutations: body.p_mutations, referralId: body.p_referral_id, dispatchKind: body.p_dispatch_kind,
          recipientEmail: body.p_recipient_email, token: `tok-${tag}`, expiresAt: body.p_expires_at,
          adminClient: database.client, env: { NEXT_PUBLIC_BASE_URL: 'http://127.0.0.1' },
        }), 2000), (error) => error.code === 'PT409' && isReferralEmailSourceStateConflict(error));
      } finally { await stopRequests(); }
    });

  await runCase('repeated reset conflicts stop after three attempts', async ({ fixture, database, tag, stopRequests }) => {
      process.env.REF_SESSION_SECRET = 'fixture-only-referral-session-secret-for-conflict-test';
      const { default: handler } = await import('../src/server/api/ref/forgot.js');
      const { runLegacyApiHandler } = await import('../src/lib/nextApiAdapter.js');
      const id = `referral.reset-${tag}`;
      const email = `reset-${tag}@example.test`;
      await fixture.content.create({ _id: id, _type: 'referral', creatorEmail: email, registrationStatus: 'active' });
      let attempts = 0, conflicts = 0;
      database.setRequestHook(async (phase, request) => {
        if (!request.path.endsWith('/roo_enqueue_referral_email_mutation')) return;
        if (phase === 'before') {
          attempts++;
          const revision = crypto.randomUUID();
          await database.sql`update migration.source_documents set source_revision = ${revision}, payload = jsonb_set(payload, '{_rev}', to_jsonb(${revision}::text)) where legacy_sanity_id = ${id}`;
        } else if (request.status === 409 && request.response?.code === 'PT409') conflicts++;
      });
      try {
        const request = new Request('http://127.0.0.1/api/ref/forgot', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
        });
        const response = await within(runLegacyApiHandler({ request, handler }), 2000);
        assert.equal(response.status, 200);
        assert.equal(attempts, 3);
        assert.equal(conflicts, 3);
        const [{ count }] = await database.sql`select count(*)::int count from accounts.referral_email_dispatches where referral_id = ${id}`;
        assert.equal(count, 0);
      } finally { database.setRequestHook(null); await stopRequests(); }
    });

  await runCase('credential source conflict is recorded as deterministic', async ({ database, tag, stopRequests }) => {
      const scenario = scenarios.find((item) => item.id === 'S18');
      for (const seed of scenario.seed) await database.sql.unsafe(seed(tag).sql);
      try {
        const result = await within(database.client.rpc(scenario.call(tag).rpc, scenario.call(tag).body), 2000);
        assert.equal(result.error?.code, 'PT409');
        const recorded = await database.client.rpc('roo_record_credential_recovery_failure', {
          p_operation_key: `op-${tag}-s18`, p_expected_status: 'auth_applied', p_error_code: result.error.code,
          p_error_message: null, p_error_class: null,
        });
        assert.equal(recorded.error, null);
        const [{ last_error_class, last_error_code }] = await database.sql`select last_error_class, last_error_code from accounts.credential_operations where operation_key = ${`op-${tag}-s18`}`;
        assert.equal(last_error_code, 'PT409');
        assert.equal(last_error_class, 'deterministic');
      } finally { await stopRequests(); }
    });
  await runCase('credential recovery records an RPC conflict as deterministic', async ({ database, tag, stopRequests }) => {
      const { reconcileCredentialOperations } = await import('../src/server/supabase/credentialRecovery.js');
      const scenario = scenarios.find((item) => item.id === 'S18');
      const localTag = `${tag}c`;
      for (const seed of scenario.seed) await database.sql.unsafe(seed(localTag).sql);
      const operationKey = `op-${localTag}-s18`;
      await database.sql`update accounts.credential_operations set source_preconditions = ${database.sql.json({ resetTokenHash: 'new' })}, source_mutation = ${database.sql.json({ set: { resetTokenHash: 'updated' }, unset: [] })}, sessions_revoked_at = now() where operation_key = ${operationKey}`;
      await database.sql.unsafe(`create function public.zz_credential_conflict() returns trigger language plpgsql as $$
        begin
          if new.operation_key = 'op-${localTag}-s18' and old.source_applied_at is null and new.source_applied_at is not null then
            perform public.roo_set_commerce_starts_paused(7, false, 'scenario');
          end if;
          return new;
        end $$;
        create trigger zz_credential_conflict before update on accounts.credential_operations for each row execute function public.zz_credential_conflict()`);
      try {
        const result = await within(reconcileCredentialOperations({ adminClient: database.client }), 2000);
        assert.equal(result.pending, 1);
        const [{ last_error_class, last_error_code }] = await database.sql`select last_error_class, last_error_code from accounts.credential_operations where operation_key = ${operationKey}`;
        assert.equal(last_error_code, 'PT409');
        assert.equal(last_error_class, 'deterministic');
      } finally {
        await stopRequests();
        await database.sql.unsafe('drop trigger zz_credential_conflict on accounts.credential_operations; drop function public.zz_credential_conflict()');
      }
    });
});
