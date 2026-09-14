#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import postgres from "postgres";

const migrations = new URL("../supabase/migrations/", import.meta.url);
const repair = await fs.readFile(new URL("20260914000000_repair_referral_orphan_reclaim_prerequisites.sql", migrations), "utf8");
const retirement = await fs.readFile(new URL("20260914010000_preserve_retired_tourney_identity_domains.sql", migrations), "utf8");
const history = await fs.readFile(new URL("20260712092342_close_supabase_port_and_unified_auth.sql", migrations), "utf8");
const start = history.indexOf("create or replace function public.roo_create_oauth_intent(p_intent jsonb)");
assert.ok(start >= 0);
const predecessor = history.slice(start, history.indexOf("$$;", start) + 3);
const id = () => crypto.randomUUID();
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function localUrl(value) {
  assert.ok(value, "Set SUPABASE_TEST_DATABASE_URL to an explicit local fixture database.");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid local test database URL."); }
  assert.ok(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.port && url.pathname.length > 1 && !url.search && !url.hash,
    "Only an explicit loopback database without URL options is permitted."
  );
  return url;
}

async function functionsState(sql, excludeFeature = false) {
  const rows = await sql`select namespace.nspname, procedure.proname,
      pg_get_function_identity_arguments(procedure.oid) arguments,
      procedure.prosrc,procedure.prosecdef,procedure.provolatile,procedure.proconfig,procedure.proacl::text
    from pg_proc procedure join pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname in ('public','accounts')
      and (${!excludeFeature} or procedure.proname not in (
        'roo_create_oauth_intent','roo_read_reauth_grant','roo_fail_oauth_intent',
        'roo_reclaim_referral_orphan_identity','reject_orphan_identity_reclaim_audit_mutation'))
    order by namespace.nspname,procedure.proname,arguments`;
  return digest(JSON.stringify(rows));
}

async function catalogState(sql) {
  const constraints = await sql`select conrelid::regclass::text relation,conname,
      pg_get_constraintdef(oid) definition,convalidated from pg_constraint
    where connamespace='accounts'::regnamespace order by relation,conname`;
  const columns = await sql`select table_name,column_name,data_type,is_nullable,column_default
    from information_schema.columns where table_schema='accounts'
    order by table_name,ordinal_position`;
  const indexes = await sql`select indexname,indexdef from pg_indexes
    where schemaname='accounts' order by indexname`;
  const triggers = await sql`select tgrelid::regclass::text relation,tgname,tgenabled,pg_get_triggerdef(oid) definition
    from pg_trigger where tgrelid in (select oid from pg_class where relnamespace='accounts'::regnamespace)
      and not tgisinternal order by relation,tgname`;
  const relations = await sql`select relname,relkind,relrowsecurity,relforcerowsecurity,relacl::text
    from pg_class where relnamespace='accounts'::regnamespace order by relname`;
  return digest(JSON.stringify({ functions: await functionsState(sql), constraints, columns, indexes, triggers, relations }));
}

async function rowsState(sql) {
  const state = {};
  for (const table of [
    "auth.users", "auth.identities", "auth.sessions", "auth.refresh_tokens", "public.profiles",
    "accounts.principals", "accounts.principal_auth_users", "accounts.account_roles",
    "accounts.login_aliases", "accounts.creator_profiles", "accounts.tourney_accounts",
    "accounts.identity_links", "accounts.credential_operations", "commerce.bookings",
    "commerce.payment_records", "tourney.external_operations", "accounts.oauth_intents", "accounts.reauth_grants",
    "accounts.orphan_identity_reclaim_audit",
  ]) {
    if (!(await sql`select to_regclass(${table}) relation`)[0].relation) {
      state[table] = digest("");
      continue;
    }
    const rows = await sql`select (to_jsonb(row_data)-'bound_intent_id'-'bound_at'-'recovery_for_intent_id')::text data
      from ${sql(table)} row_data`;
    state[table] = digest(rows.map(({ data }) => data).sort().join("\n"));
  }
  return state;
}

async function simulateMissingFeature(sql) {
  await sql.unsafe(`
    drop function public.roo_reclaim_referral_orphan_identity(text,uuid,text);
    drop function public.roo_read_reauth_grant(text,uuid,text);
    drop function public.roo_fail_oauth_intent(uuid,text,text);
    drop table accounts.orphan_identity_reclaim_audit;
    drop function accounts.reject_orphan_identity_reclaim_audit_mutation();
    alter table accounts.reauth_grants drop column bound_intent_id, drop column bound_at;
    alter table accounts.oauth_intents drop column recovery_for_intent_id;
    alter table accounts.oauth_intents drop constraint oauth_intents_action_check;
    alter table accounts.oauth_intents add constraint oauth_intents_action_check
      check (action in ('signin','signup','link','reauth','merge'));
    alter table accounts.oauth_intents drop constraint oauth_intents_target_action_check;
    alter table accounts.oauth_intents add constraint oauth_intents_target_action_check
      check ((action in ('link','reauth','merge'))=(target_user_id is not null));
    drop index accounts.oauth_intents_one_active_sensitive_action_idx;
    create unique index oauth_intents_one_active_sensitive_action_idx
      on accounts.oauth_intents(target_user_id,provider,action)
      where action in ('link','reauth','merge') and status='pending';
  `);
  await sql.unsafe(predecessor);
}

async function createAccount(sql, creator = false) {
  const userId = id();
  const email = `orphan-repair.${userId}@example.test`;
  const legacyId = `referral.repair-${userId}`;
  await sql`insert into auth.users(id,email,aud,role,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values (${userId},${email},'authenticated','authenticated',now(),'{}','{}')`;
  const [{ principal }] = await sql`select accounts.ensure_principal_for_user(${userId},'signup') principal`;
  await sql`insert into public.profiles(user_id,principal_id,primary_email)
    values (${userId},${principal},${email})`;
  if (creator) {
    await sql`insert into accounts.creator_profiles(user_id,principal_id,referral_code,legacy_sanity_id)
      values (${userId},${principal},${`repair-${userId}`},${legacyId})`;
    await sql`insert into accounts.account_roles(user_id,principal_id,role)
      values (${userId},${principal},'creator')`;
  }
  return { userId, principal, email, legacyId };
}

async function identity(sql, account, provider) {
  const subject = String(800000000000000000n + BigInt(`0x${crypto.randomBytes(8).toString("hex")}`) % 100000000000000000n);
  await sql`insert into auth.identities(provider_id,user_id,provider,identity_data,created_at,updated_at)
    values (${subject},${account.userId},${provider},
      ${sql.json({ sub: subject, email: account.email, email_verified: true })},now(),now())`;
  await sql`select public.roo_reconcile_auth_identity_links(${account.userId},null)`;
  return subject;
}

async function intent(sql, account, overrides = {}) {
  const tokenHash = digest(id());
  const payload = {
    action: "link", flow: "referral", provider: "google", target_user_id: account.userId,
    domain_subject: account.legacyId, return_path: "/referrals/dashboard",
    token_hash: tokenHash, expires_at: new Date(Date.now() + 600_000).toISOString(), ...overrides,
  };
  const [{ result }] = await sql`select public.roo_create_oauth_intent(${sql.json(payload)}) result`;
  return { ...result, tokenHash };
}

async function refusesWithoutMutation(sql, migration, message) {
  const before = { rows: await rowsState(sql), catalog: await catalogState(sql) };
  await assert.rejects(sql.savepoint((tx) => tx.unsafe(migration)), { code: "55000" }, message);
  assert.deepEqual({ rows: await rowsState(sql), catalog: await catalogState(sql) }, before, message);
}

const cases = [
  ["complete history is a no-op and keeps strict link reauthentication", async (sql) => {
    const before = { rows: await rowsState(sql), catalog: await catalogState(sql) };
    await sql.unsafe(repair);
    assert.deepEqual({ rows: await rowsState(sql), catalog: await catalogState(sql) }, before);
    const target = await createAccount(sql, true);
    await assert.rejects(sql.savepoint((tx) => intent(tx, target)), { code: "42501" });
  }],
  ["missing feature is repaired without changing optional ordinary links or newer RPCs", async (sql) => {
    await simulateMissingFeature(sql);
    const target = await createAccount(sql, true);
    await identity(sql, target, "google");
    const inFlight = await intent(sql, target);
    const before = { rows: await rowsState(sql), otherFunctions: await functionsState(sql, true) };
    await sql.unsafe(repair);
    assert.deepEqual({ rows: await rowsState(sql), otherFunctions: await functionsState(sql, true) }, before);
    const [{ result: finalized }] = await sql`select public.roo_finalize_oauth_intent_v2(
      ${inFlight.tokenHash},${target.userId},'google',null) result`;
    assert.equal(finalized.completed, true, "Existing optional-proof link stopped finalizing.");
    const ordinary = await intent(sql, target);
    assert.ok(ordinary.id, "An ordinary link without proof must remain accepted.");

    const source = await createAccount(sql);
    const subject = await identity(sql, source, "discord");
    const failedLink = await intent(sql, target, { provider: "discord" });
    await sql`select public.roo_fail_oauth_intent(${failedLink.id},${failedLink.tokenHash},'identity_already_exists')`;
    const reclaimOptions = { action: "reclaim", provider: "discord", recovery_for_intent_id: failedLink.id };
    await assert.rejects(sql.savepoint((tx) => intent(tx, target, reclaimOptions)), { code: "42501" });
    const grantHash = digest(id());
    await sql`select public.roo_create_reauth_grant(${target.userId},${grantHash},'link_identity',null)`;
    const recovery = await intent(sql, target, { ...reclaimOptions, reauth_token_hash: grantHash });
    const [{ result: availableProof }] = await sql`select public.roo_read_reauth_grant(
      ${grantHash},${target.userId},'link_identity') result`;
    assert.equal(availableProof, null, "A bound proof must not be advertised as reusable.");
    await assert.rejects(sql.savepoint((tx) => intent(tx, target,
      { ...reclaimOptions, reauth_token_hash: grantHash })), { code: "42501" });
    assert.equal((await sql`select status from accounts.oauth_intents where id=${recovery.id}`)[0].status, "pending");
    const [{ result: reclaimed }] = await sql`select public.roo_reclaim_referral_orphan_identity(
      ${recovery.tokenHash},${source.userId},'discord') result`;
    assert.equal(reclaimed.reclaimed, true);
    assert.equal((await sql`select user_id from auth.identities
      where provider='discord' and provider_id=${subject}`)[0].user_id, target.userId);
    assert.equal((await sql`select outcome from accounts.orphan_identity_reclaim_audit
      where oauth_intent_id=${recovery.id}`)[0].outcome, "reclaimed");
    await assert.rejects(sql.savepoint((tx) => tx`update accounts.orphan_identity_reclaim_audit
      set reason='fixture-change' where oauth_intent_id=${recovery.id}`), { code: "55000" });
    const [{ anonymous, authenticated }] = await sql`select
      has_function_privilege('anon','public.roo_reclaim_referral_orphan_identity(text,uuid,text)','EXECUTE') anonymous,
      has_table_privilege('authenticated','accounts.orphan_identity_reclaim_audit','SELECT') authenticated`;
    assert.equal(anonymous, false);
    assert.equal(authenticated, false);

    const repaired = { rows: await rowsState(sql), catalog: await catalogState(sql) };
    await sql.unsafe(repair);
    assert.deepEqual({ rows: await rowsState(sql), catalog: await catalogState(sql) }, repaired);
    await sql.unsafe(retirement);
    const retired = { rows: await rowsState(sql), catalog: await catalogState(sql) };
    await sql.unsafe(repair);
    assert.deepEqual({ rows: await rowsState(sql), catalog: await catalogState(sql) }, retired);
    assert.ok((await intent(sql, target)).id, "Retirement prerequisite replay tightened optional link policy.");
  }],
  ["partial binding installation refuses without mutation", async (sql) => {
    await simulateMissingFeature(sql);
    await sql`alter table accounts.reauth_grants add column bound_at timestamptz`;
    await refusesWithoutMutation(sql, repair, "Partial binding must fail closed.");
  }],
  ["unknown predecessor policy refuses without overwriting it", async (sql) => {
    await simulateMissingFeature(sql);
    await sql.unsafe(predecessor.replace("begin\n", "begin\n  -- Newer policy; requires review.\n"));
    await refusesWithoutMutation(sql, repair, "Unknown intent implementation must be preserved.");
  }],
  ["unknown action constraints refuse without removing them", async (sql) => {
    await simulateMissingFeature(sql);
    await sql`alter table accounts.oauth_intents drop constraint oauth_intents_action_check`;
    await sql`alter table accounts.oauth_intents add constraint oauth_intents_action_check
      check (action in ('signin','signup','link','reauth','merge','future_action'))`;
    await refusesWithoutMutation(sql, repair, "Newer action constraints must not be replaced.");
  }],
  ["incomplete RPC installation refuses without replacing the remaining feature", async (sql) => {
    await sql`drop function public.roo_read_reauth_grant(text,uuid,text)`;
    await refusesWithoutMutation(sql, repair, "Missing feature RPC must not be treated as healthy.");
  }],
  ["unsafe existing audit exposure refuses without changing grants", async (sql) => {
    await sql`grant select on accounts.orphan_identity_reclaim_audit to anon`;
    await refusesWithoutMutation(sql, repair, "Unexpected existing permissions require review.");
  }],
  ["disabled audit immutability refuses without silently trusting the trigger name", async (sql) => {
    await sql.unsafe(`create or replace function accounts.reject_orphan_identity_reclaim_audit_mutation()
      returns trigger language plpgsql set search_path='' as $$ begin return new; end; $$;`);
    await refusesWithoutMutation(sql, repair, "An altered audit trigger implementation requires review.");
  }],
  ["incompatible audit columns refuse without replacing the audit table", async (sql) => {
    await sql`alter table accounts.orphan_identity_reclaim_audit alter column reason drop not null`;
    await refusesWithoutMutation(sql, repair, "Unexpected audit schema requires review.");
  }],
];

async function main() {
  const url = localUrl(String(process.env.SUPABASE_TEST_DATABASE_URL || "").trim());
  const sql = postgres(url.href, { max: 1, prepare: false, connect_timeout: 5, onnotice: () => {} });
  try {
    const before = { rows: await rowsState(sql), catalog: await catalogState(sql) };
    for (const [name, run] of cases) {
      const rollback = new Error("Successful fixture must roll back.");
      let passed = false;
      try {
        await sql.begin(async (tx) => {
          await tx`set local lock_timeout='5s'`;
          await tx`set local statement_timeout='30s'`;
          await run(tx);
          passed = true;
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      assert.ok(passed);
      assert.deepEqual({ rows: await rowsState(sql), catalog: await catalogState(sql) }, before,
        "Fixture changes persisted after rollback.");
      console.log(`PASS ${name} (rolled back)`);
    }
    console.log(`PASS all ${cases.length} orphan prerequisite cases; native schema and rows unchanged.`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(`Orphan prerequisite regression failed: ${error.message}`);
  process.exitCode = 1;
});
