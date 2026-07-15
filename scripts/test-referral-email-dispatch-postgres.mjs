#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import {
  buildReferralEmailIdempotencyKey,
  deliverReferralEmailDispatch,
  enqueueReferralEmailMutation,
} from "../src/server/api/ref/referralEmailDispatches.js";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const pgBin = String(process.env.PG_BIN || "").trim() || spawnSync(
  process.env.PG_CONFIG || "pg_config",
  ["--bindir"],
  { encoding: "utf8" }
).stdout.trim();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roo-referral-email-"));
const dataDir = path.join(tempRoot, "pgdata");
const port = 56832 + Math.floor(Math.random() * 400);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      [`${command} ${args.join(" ")} failed`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
    );
  }
  return result.stdout;
};

const bootstrap = String.raw`
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create schema accounts;
create schema migration;
create schema extensions;
create extension pgcrypto with schema extensions;
grant usage on schema accounts, migration, extensions to service_role;
create table migration.source_documents (
  legacy_sanity_id text primary key,
  source_revision text not null,
  payload jsonb not null
);
create table migration.mutation_audit (
  id bigserial primary key,
  document_id text not null,
  operation text not null,
  created_at timestamptz not null default now()
);
create or replace function public.roo_apply_document_mutations(p_mutations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mutation jsonb;
  v_operation text;
  v_id text;
  v_expected text;
  v_payload jsonb;
  v_revision text;
  v_results jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_mutations) <> 'array' then
    raise exception 'p_mutations must be an array' using errcode='22023';
  end if;
  for v_mutation in select value from jsonb_array_elements(p_mutations)
  loop
    v_operation := v_mutation->>'operation';
    v_id := coalesce(v_mutation->>'id', v_mutation->'document'->>'_id');
    v_expected := nullif(v_mutation->>'expected_revision', '');
    if v_operation not in ('create', 'replace', 'delete') or nullif(v_id, '') is null then
      raise exception 'invalid fixture mutation' using errcode='22023';
    end if;
    if v_operation = 'delete' then
      delete from migration.source_documents
      where legacy_sanity_id=v_id
        and (v_expected is null or source_revision=v_expected);
      if not found then raise exception 'revision conflict' using errcode='40001'; end if;
    elsif v_operation = 'create' then
      v_revision := replace(extensions.gen_random_uuid()::text, '-', '');
      v_payload := v_mutation->'document' || jsonb_build_object('_rev', v_revision);
      insert into migration.source_documents(legacy_sanity_id,source_revision,payload)
      values(v_id,v_revision,v_payload);
      v_results := v_results || jsonb_build_array(v_payload);
    else
      v_revision := replace(extensions.gen_random_uuid()::text, '-', '');
      v_payload := v_mutation->'document' || jsonb_build_object('_rev', v_revision);
      update migration.source_documents
      set source_revision=v_revision,payload=v_payload
      where legacy_sanity_id=v_id
        and (v_expected is null or source_revision=v_expected);
      if not found then raise exception 'revision conflict' using errcode='40001'; end if;
      v_results := v_results || jsonb_build_array(v_payload);
    end if;
    insert into migration.mutation_audit(document_id,operation)
    values(v_id,v_operation);
  end loop;
  return v_results;
end;
$$;
revoke all on function public.roo_apply_document_mutations(jsonb)
  from public, anon, authenticated;
grant execute on function public.roo_apply_document_mutations(jsonb)
  to service_role;
`;

let started = false;
let sql = null;
try {
  run(path.join(pgBin, "initdb"), ["-D", dataDir, "--auth=trust", "--no-locale"]);
  run(
    path.join(pgBin, "pg_ctl"),
    ["-D", dataDir, "-o", `-p ${port} -h 127.0.0.1`, "-w", "start"],
    { stdio: "ignore" }
  );
  started = true;
  run(path.join(pgBin, "psql"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    bootstrap,
  ]);
  run(path.join(pgBin, "psql"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    path.join(
      root,
      "supabase/migrations/20260715110000_add_referral_email_dispatch_ledger.sql"
    ),
  ]);

  sql = postgres(`postgres://127.0.0.1:${port}/postgres`, {
    max: 8,
    prepare: false,
  });
  const rpc = async (name, params) => {
    try {
      let rows;
      if (name === "roo_enqueue_referral_email_mutation") {
        rows = await sql`select public.roo_enqueue_referral_email_mutation(
          ${sql.json(params.p_mutations)},
          ${params.p_referral_id},
          ${params.p_dispatch_kind},
          ${params.p_recipient_email},
          ${params.p_recipient_hash},
          ${params.p_token_hash},
          ${sql.json(params.p_delivery_payload)},
          ${params.p_expires_at}
        ) result`;
      } else if (name === "roo_claim_referral_email_dispatch") {
        rows = await sql`select public.roo_claim_referral_email_dispatch(
          ${params.p_idempotency_key},
          ${params.p_lease_id},
          ${params.p_lease_seconds}
        ) result`;
      } else if (name === "roo_claim_referral_email_dispatches") {
        rows = await sql`select public.roo_claim_referral_email_dispatches(
          ${params.p_lease_id},
          ${params.p_limit},
          ${params.p_lease_seconds}
        ) result`;
      } else if (name === "roo_complete_referral_email_dispatch") {
        rows = await sql`select public.roo_complete_referral_email_dispatch(
          ${params.p_idempotency_key},
          ${params.p_lease_id},
          ${params.p_success},
          ${params.p_provider_message_id},
          ${params.p_error_code},
          ${params.p_retry_delay_seconds}
        ) result`;
      } else if (name === "roo_requeue_referral_email_dispatch") {
        rows = await sql`select public.roo_requeue_referral_email_dispatch(
          ${params.p_referral_id},
          ${params.p_dispatch_kind}
        ) result`;
      } else if (name === "roo_referral_email_readiness") {
        rows = await sql`select public.roo_referral_email_readiness() result`;
      } else {
        throw new Error(`Unexpected RPC ${name}`);
      }
      return { data: rows[0]?.result ?? null, error: null };
    } catch (error) {
      return {
        data: null,
        error: { code: error.code || "fixture_error", status: 500 },
      };
    }
  };
  const adminClient = { rpc };
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const registrationToken = "R".repeat(43);
  const registrationTokenHash = crypto
    .createHash("sha256")
    .update(registrationToken)
    .digest("hex");
  const registrationDocuments = [
    { _id: "referralIdentityClaim.email.fixture", _type: "referralIdentityClaim" },
    { _id: "referralIdentityClaim.slug.fixture", _type: "referralIdentityClaim" },
    {
      _id: "referral.fixture",
      _type: "referral",
      name: "Fixture Creator",
      creatorEmail: "fixture@example.com",
      slug: { current: "fixture" },
      registrationStatus: "pending_email",
      registrationVerificationTokenHash: registrationTokenHash,
      registrationVerificationExpiresAt: expiresAt,
    },
  ];
  const registrationMutations = registrationDocuments.map((document) => ({
    operation: "create",
    document,
  }));
  const registration = await enqueueReferralEmailMutation({
    mutations: registrationMutations,
    referralId: "referral.fixture",
    dispatchKind: "registration_verification",
    recipientEmail: "fixture@example.com",
    token: registrationToken,
    name: "Fixture Creator",
    expiresAt,
    adminClient,
  });
  assert.match(registration.idempotency_key, /^referral-email-[0-9a-f]{64}$/);
  assert.equal(
    registration.idempotency_key,
    buildReferralEmailIdempotencyKey({
      dispatchKind: "registration_verification",
      referralId: "referral.fixture",
      recipientEmail: "fixture@example.com",
      token: registrationToken,
    })
  );
  const replay = await enqueueReferralEmailMutation({
    mutations: registrationMutations,
    referralId: "referral.fixture",
    dispatchKind: "registration_verification",
    recipientEmail: "fixture@example.com",
    token: registrationToken,
    name: "Fixture Creator",
    expiresAt,
    adminClient,
  });
  assert.equal(replay.idempotency_key, registration.idempotency_key);
  assert.equal(replay.replayed, true);
  const [initialCounts] = await sql`
    select
      (select count(*)::integer from migration.source_documents) document_count,
      (select count(*)::integer from migration.mutation_audit) mutation_count,
      (select count(*)::integer from accounts.referral_email_dispatches) dispatch_count
  `;
  assert.deepEqual(initialCounts, {
    document_count: 3,
    mutation_count: 3,
    dispatch_count: 1,
  });

  const rollbackResult = await rpc("roo_enqueue_referral_email_mutation", {
    p_mutations: [
      {
        operation: "create",
        document: {
          _id: "referral.rollback",
          _type: "referral",
          creatorEmail: "rollback@example.com",
          registrationStatus: "pending_email",
          registrationVerificationTokenHash: crypto
            .createHash("sha256")
            .update("X".repeat(43))
            .digest("hex"),
          registrationVerificationExpiresAt: expiresAt,
        },
      },
      { operation: "unsupported", id: "broken" },
    ],
    p_referral_id: "referral.rollback",
    p_dispatch_kind: "registration_verification",
    p_recipient_email: "rollback@example.com",
    p_recipient_hash: crypto.createHash("sha256").update("rollback@example.com").digest("hex"),
    p_token_hash: crypto.createHash("sha256").update("X".repeat(43)).digest("hex"),
    p_delivery_payload: { token: "X".repeat(43), name: "Rollback" },
    p_expires_at: expiresAt,
  });
  assert.equal(rollbackResult.error.code, "22023");
  const [rollbackCounts] = await sql`
    select
      count(*) filter (where legacy_sanity_id='referral.rollback')::integer document_count,
      (select count(*)::integer from accounts.referral_email_dispatches
        where referral_id='referral.rollback') dispatch_count
    from migration.source_documents
  `;
  assert.deepEqual(rollbackCounts, { document_count: 0, dispatch_count: 0 });

  await sql`update migration.source_documents
    set payload=payload || jsonb_build_object('registrationStatus','active')
    where legacy_sanity_id='referral.fixture'`;
  const [currentReferral] = await sql`
    select source_revision,payload
    from migration.source_documents
    where legacy_sanity_id='referral.fixture'
  `;
  const resetCandidates = ["A".repeat(64), "B".repeat(64)];
  const concurrentResets = await Promise.all(
    resetCandidates.map((resetToken) => {
      const resetHash = crypto.createHash("sha256").update(resetToken).digest("hex");
      return enqueueReferralEmailMutation({
        mutations: [
          {
            operation: "replace",
            expected_revision: currentReferral.source_revision,
            document: {
              ...currentReferral.payload,
              resetTokenHash: resetHash,
              resetTokenExpiresAt: expiresAt,
            },
          },
        ],
        referralId: "referral.fixture",
        dispatchKind: "password_reset",
        recipientEmail: "fixture@example.com",
        token: resetToken,
        name: "Fixture Creator",
        expiresAt,
        adminClient,
      });
    })
  );
  assert.equal(concurrentResets[0].idempotency_key, concurrentResets[1].idempotency_key);
  const [resetState] = await sql`
    select
      (select count(*)::integer from accounts.referral_email_dispatches
        where referral_id='referral.fixture' and dispatch_kind='password_reset') dispatch_count,
      (select count(*)::integer from migration.mutation_audit) mutation_count,
      (select payload->>'resetTokenHash' from migration.source_documents
        where legacy_sanity_id='referral.fixture') document_token_hash,
      (select token_hash from accounts.referral_email_dispatches
        where referral_id='referral.fixture' and dispatch_kind='password_reset') dispatch_token_hash
  `;
  assert.deepEqual(resetState, {
    dispatch_count: 1,
    mutation_count: 4,
    document_token_hash: resetState.dispatch_token_hash,
    dispatch_token_hash: resetState.dispatch_token_hash,
  });

  const firstLease = crypto.randomUUID();
  const secondLease = crypto.randomUUID();
  const [firstBatch, secondBatch] = await Promise.all([
    rpc("roo_claim_referral_email_dispatches", {
      p_lease_id: firstLease,
      p_limit: 1,
      p_lease_seconds: 120,
    }),
    rpc("roo_claim_referral_email_dispatches", {
      p_lease_id: secondLease,
      p_limit: 1,
      p_lease_seconds: 120,
    }),
  ]);
  assert.equal(firstBatch.data.length, 1);
  assert.equal(secondBatch.data.length, 1);
  assert.notEqual(
    firstBatch.data[0].idempotency_key,
    secondBatch.data[0].idempotency_key
  );
  const wrongLease = await rpc("roo_complete_referral_email_dispatch", {
    p_idempotency_key: firstBatch.data[0].idempotency_key,
    p_lease_id: crypto.randomUUID(),
    p_success: true,
    p_provider_message_id: "wrong-lease",
    p_error_code: null,
    p_retry_delay_seconds: 60,
  });
  assert.equal(wrongLease.error.code, "40001");
  const firstCompletion = await rpc("roo_complete_referral_email_dispatch", {
    p_idempotency_key: firstBatch.data[0].idempotency_key,
    p_lease_id: firstLease,
    p_success: true,
    p_provider_message_id: "provider-batch-1",
    p_error_code: null,
    p_retry_delay_seconds: 60,
  });
  assert.equal(firstCompletion.data.status, "sent");
  await sql`update accounts.referral_email_dispatches
    set updated_at=updated_at
    where idempotency_key=${firstBatch.data[0].idempotency_key}`;
  await assert.rejects(
    sql`update accounts.referral_email_dispatches
      set next_attempt_at=next_attempt_at+interval '1 second'
      where idempotency_key=${firstBatch.data[0].idempotency_key}`,
    (error) => error.code === "23514"
  );
  await assert.rejects(
    sql`update accounts.referral_email_dispatches
      set status='retry',sent_at=null,provider_message_id=null
      where idempotency_key=${firstBatch.data[0].idempotency_key}`,
    (error) => error.code === "23514"
  );
  const secondCompletion = await rpc("roo_complete_referral_email_dispatch", {
    p_idempotency_key: secondBatch.data[0].idempotency_key,
    p_lease_id: secondLease,
    p_success: false,
    p_provider_message_id: null,
    p_error_code: "provider_unavailable",
    p_retry_delay_seconds: 60,
  });
  assert.equal(secondCompletion.data.status, "retry");

  const timeoutToken = "T".repeat(43);
  const timeoutDispatch = await enqueueReferralEmailMutation({
    mutations: [
      {
        operation: "create",
        document: {
          _id: "referral.timeout",
          _type: "referral",
          creatorEmail: "timeout@example.com",
          registrationStatus: "pending_email",
          registrationVerificationTokenHash: crypto
            .createHash("sha256")
            .update(timeoutToken)
            .digest("hex"),
          registrationVerificationExpiresAt: expiresAt,
        },
      },
    ],
    referralId: "referral.timeout",
    dispatchKind: "registration_verification",
    recipientEmail: "timeout@example.com",
    token: timeoutToken,
    name: "Timeout Fixture",
    expiresAt,
    adminClient,
  });
  const accepted = new Map();
  const providerKeys = [];
  let timeoutResponse = true;
  const resendClient = {
    emails: {
      send: async (_message, options) => {
        providerKeys.push(options.idempotencyKey);
        if (!accepted.has(options.idempotencyKey)) {
          accepted.set(options.idempotencyKey, "provider-timeout-1");
        }
        if (timeoutResponse) {
          timeoutResponse = false;
          const error = new Error("provider accepted before timeout");
          error.code = "provider_timeout";
          throw error;
        }
        return {
          data: { id: accepted.get(options.idempotencyKey) },
          error: null,
        };
      },
    },
  };
  const firstDelivery = await deliverReferralEmailDispatch({
    idempotencyKey: timeoutDispatch.idempotency_key,
    adminClient,
    resendClient,
  });
  assert.equal(firstDelivery.retry, 1);
  await sql`update accounts.referral_email_dispatches
    set next_attempt_at=now()
    where idempotency_key=${timeoutDispatch.idempotency_key}`;
  const secondDelivery = await deliverReferralEmailDispatch({
    idempotencyKey: timeoutDispatch.idempotency_key,
    adminClient,
    resendClient,
  });
  assert.equal(secondDelivery.sent, 1);
  assert.deepEqual(providerKeys, [
    timeoutDispatch.idempotency_key,
    timeoutDispatch.idempotency_key,
  ]);
  assert.equal(accepted.size, 1);
  const [timeoutState] = await sql`
    select
      status,
      attempt_count,
      provider_message_id,
      delivery_payload ? 'token' has_delivery_token,
      (select count(*)::integer from migration.mutation_audit
        where document_id='referral.timeout') mutation_count
    from accounts.referral_email_dispatches
    where idempotency_key=${timeoutDispatch.idempotency_key}
  `;
  assert.deepEqual(timeoutState, {
    status: "sent",
    attempt_count: 2,
    provider_message_id: "provider-timeout-1",
    has_delivery_token: false,
    mutation_count: 1,
  });

  const freshReadiness = await rpc("roo_referral_email_readiness", {});
  assert.equal(freshReadiness.data.ready, true);
  assert.equal(freshReadiness.data.healthy, true);
  await sql`update accounts.referral_email_dispatches
    set created_at=now()-interval '6 minutes',
        next_attempt_at=now()-interval '6 minutes'
    where status='retry'`;
  const staleReadiness = await rpc("roo_referral_email_readiness", {});
  assert.equal(staleReadiness.data.ready, false);
  assert.equal(Number(staleReadiness.data.stale_actionable), 1);
  assert.equal(Number(staleReadiness.data.overdue_over_300_seconds), 1);
  await sql`update accounts.referral_email_dispatches
    set created_at=now(),next_attempt_at=now()+interval '60 seconds'
    where status='retry'`;
  const [exhaustedCandidate] = await sql`update accounts.referral_email_dispatches
    set attempt_count=max_attempts,next_attempt_at=now()
    where status='retry'
    returning idempotency_key,referral_id,dispatch_kind`;
  assert.ok(exhaustedCandidate?.idempotency_key);
  const exhaustedClaim = await rpc("roo_claim_referral_email_dispatches", {
    p_lease_id: crypto.randomUUID(),
    p_limit: 10,
    p_lease_seconds: 120,
  });
  assert.deepEqual(exhaustedClaim.data, []);
  const [exhaustedState] = await sql`
    select status,last_error_code,delivery_payload ? 'token' has_delivery_token
    from accounts.referral_email_dispatches
    where idempotency_key=${exhaustedCandidate.idempotency_key}
  `;
  assert.deepEqual(exhaustedState, {
    status: "dead_letter",
    last_error_code: "retry_exhausted",
    has_delivery_token: true,
  });
  const recoveredDispatch = await rpc("roo_requeue_referral_email_dispatch", {
    p_referral_id: exhaustedCandidate.referral_id,
    p_dispatch_kind: exhaustedCandidate.dispatch_kind,
  });
  assert.deepEqual(recoveredDispatch.error, null);
  assert.equal(recoveredDispatch.data.status, "retry");
  assert.equal(recoveredDispatch.data.requeued, true);
  assert.equal(recoveredDispatch.data.idempotent, false);
  const activeRecoveryReplay = await rpc("roo_requeue_referral_email_dispatch", {
    p_referral_id: exhaustedCandidate.referral_id,
    p_dispatch_kind: exhaustedCandidate.dispatch_kind,
  });
  assert.equal(activeRecoveryReplay.data.status, "retry");
  assert.equal(activeRecoveryReplay.data.requeued, false);
  assert.equal(activeRecoveryReplay.data.idempotent, true);
  const [recoveredState] = await sql`
    select status, attempt_count, last_error_code,
      delivery_payload ? 'token' has_delivery_token,
      (select count(*)::integer
       from accounts.referral_email_dispatch_actions action
       where action.dispatch_id=dispatch.id) action_count
    from accounts.referral_email_dispatches dispatch
    where idempotency_key=${exhaustedCandidate.idempotency_key}
  `;
  assert.deepEqual(recoveredState, {
    status: "retry",
    attempt_count: 0,
    last_error_code: null,
    has_delivery_token: true,
    action_count: 1,
  });
  await sql`update accounts.referral_email_dispatches
    set attempt_count=max_attempts,next_attempt_at=now()
    where idempotency_key=${exhaustedCandidate.idempotency_key}`;
  await rpc("roo_claim_referral_email_dispatches", {
    p_lease_id: crypto.randomUUID(),
    p_limit: 10,
    p_lease_seconds: 120,
  });

  const expiredToken = "E".repeat(43);
  const expiredDispatch = await enqueueReferralEmailMutation({
    mutations: [
      {
        operation: "create",
        document: {
          _id: "referral.expired",
          _type: "referral",
          creatorEmail: "expired@example.com",
          registrationStatus: "pending_email",
          registrationVerificationTokenHash: crypto
            .createHash("sha256")
            .update(expiredToken)
            .digest("hex"),
          registrationVerificationExpiresAt: expiresAt,
        },
      },
    ],
    referralId: "referral.expired",
    dispatchKind: "registration_verification",
    recipientEmail: "expired@example.com",
    token: expiredToken,
    name: "Expired Fixture",
    expiresAt,
    adminClient,
  });
  await sql`update accounts.referral_email_dispatches
    set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour'
    where idempotency_key=${expiredDispatch.idempotency_key}`;
  await rpc("roo_claim_referral_email_dispatches", {
    p_lease_id: crypto.randomUUID(),
    p_limit: 10,
    p_lease_seconds: 120,
  });
  const expiredRecovery = await rpc("roo_requeue_referral_email_dispatch", {
    p_referral_id: "referral.expired",
    p_dispatch_kind: "registration_verification",
  });
  assert.equal(expiredRecovery.data.status, "dead_letter");
  assert.equal(expiredRecovery.data.requeued, false);
  assert.equal(expiredRecovery.data.recovery_blocked_reason, "link_expired");
  const [expiredTokenState] = await sql`
    select delivery_payload ? 'token' has_delivery_token
    from accounts.referral_email_dispatches
    where idempotency_key=${expiredDispatch.idempotency_key}
  `;
  assert.equal(expiredTokenState.has_delivery_token, true);
  const readinessResult = await rpc("roo_referral_email_readiness", {});
  assert.equal(Number(readinessResult.data.dead_letters), 2);
  assert.equal(readinessResult.data.ready, false);
  assert.equal(readinessResult.data.healthy, false);
  assert.equal(
    JSON.stringify(readinessResult.data).includes("expired@example.com"),
    false
  );
  assert.equal(JSON.stringify(readinessResult.data).includes(expiredToken), false);

  const [security] = await sql`
    select
      (select relrowsecurity from pg_class where oid='accounts.referral_email_dispatches'::regclass) rls,
      has_table_privilege('anon','accounts.referral_email_dispatches','select') anon_select,
      has_table_privilege('authenticated','accounts.referral_email_dispatches','select') authenticated_select,
      has_table_privilege('service_role','accounts.referral_email_dispatches','select') service_select,
      has_table_privilege('service_role','accounts.referral_email_dispatches','insert') service_insert,
      has_table_privilege('service_role','accounts.referral_email_dispatches','update') service_update,
      has_table_privilege('service_role','accounts.referral_email_dispatches','delete') service_delete,
      has_table_privilege('service_role','accounts.referral_email_dispatch_actions','select') service_action_select,
      has_function_privilege(
        'anon',
        'public.roo_referral_email_readiness()',
        'execute'
      ) anon_execute,
      has_function_privilege(
        'service_role',
        'public.roo_referral_email_readiness()',
        'execute'
      ) service_execute,
      has_function_privilege(
        'anon',
        'public.roo_requeue_referral_email_dispatch(text,text)',
        'execute'
      ) anon_requeue_execute,
      has_function_privilege(
        'service_role',
        'public.roo_requeue_referral_email_dispatch(text,text)',
        'execute'
      ) service_requeue_execute
  `;
  assert.deepEqual(security, {
    rls: true,
    anon_select: false,
    authenticated_select: false,
    service_select: false,
    service_insert: false,
    service_update: false,
    service_delete: false,
    service_action_select: false,
    anon_execute: false,
    service_execute: true,
    anon_requeue_execute: false,
    service_requeue_execute: true,
  });

  await sql.end();
  sql = null;
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        postgres: run(path.join(pgBin, "postgres"), ["--version"]).trim(),
        checks: 32,
      },
      null,
      2
    ) + "\n"
  );
} finally {
  if (sql) await sql.end({ timeout: 1 });
  if (started) {
    spawnSync(
      path.join(pgBin, "pg_ctl"),
      ["-D", dataDir, "-m", "fast", "-w", "stop"],
      { encoding: "utf8" }
    );
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
