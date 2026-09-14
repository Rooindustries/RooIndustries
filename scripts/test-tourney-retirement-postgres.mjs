#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { applySqlRetirement, protectedState, readDatabaseRowJson, writeVerifiedBackup } from "./retire-tourney-people.mjs";

const migrationUrl = new URL(
  "../supabase/migrations/20260914010000_preserve_retired_tourney_identity_domains.sql",
  import.meta.url
);
const fakePasswordHash = "$2b$12$6584hc9FBR7p989gOkedS.vPcNBNo89i4Inr1NKZPvdlqMwuNzKfi";
const newId = () => crypto.randomUUID();
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const socialSubject = () => String(
  800000000000000000n + BigInt(`0x${crypto.randomBytes(8).toString("hex")}`) % 100000000000000000n
);

function localDatabaseUrl(value) {
  assert.ok(value, "Set SUPABASE_TEST_DATABASE_URL to an explicit disposable local database.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SUPABASE_TEST_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  assert.ok(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.port && url.pathname.length > 1 && !url.search && !url.hash,
    "The test database must use an explicit loopback host, port and database, without URL options."
  );
  return url;
}

async function tableDigest(sql, table) {
  const rows = await sql`select to_jsonb(row_data)::text data from ${sql(table)} row_data`;
  return digest(rows.map(({ data }) => data).sort().join("\n"));
}

async function retirementState(sql) {
  const state = await protectedState(sql);
  const tables = await sql`select table_schema || '.' || table_name as name
    from information_schema.tables where table_type='BASE TABLE' and (
      table_schema='tourney' or
      (table_schema='migration' and table_name like 'tourney_%')
    ) order by table_schema,table_name`;
  for (const table of [
    ...tables.map(({ name }) => name),
    "accounts.tourney_accounts", "accounts.account_roles", "accounts.login_aliases",
    "accounts.oauth_intents", "accounts.reauth_grants", "accounts.orphan_identity_reclaim_audit",
  ]) {
    state[table] = await tableDigest(sql, table);
  }
  return state;
}

async function authState(sql) {
  const state = {};
  for (const table of ["auth.users", "auth.identities", "auth.sessions", "auth.refresh_tokens"]) {
    state[table] = await tableDigest(sql, table);
  }
  return state;
}

async function migrationState(sql) {
  const [{ domain, reclaim, role_check }] = await sql`select
    pg_get_functiondef('accounts.principal_domain(uuid)'::regprocedure) domain,
    pg_get_functiondef('public.roo_reclaim_referral_orphan_identity(text,uuid,text)'::regprocedure) reclaim,
    (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid='accounts.account_roles'::regclass and conname='account_roles_role_check') role_check`;
  return digest(JSON.stringify({ domain, reclaim, role_check }));
}

async function createAccount(sql, { creator = false, tourneyRole = "" } = {}) {
  const id = newId();
  const email = `retirement.${id}@example.test`;
  const code = `retire-${id}`;
  const legacyId = `referral.${code}`;
  await sql`insert into auth.users (
      id,email,encrypted_password,aud,role,email_confirmed_at,raw_app_meta_data,raw_user_meta_data
    ) values (${id},${email},${fakePasswordHash},'authenticated','authenticated',now(),'{}','{}')`;
  const [{ principal }] = await sql`select accounts.ensure_principal_for_user(${id},'signup') principal`;
  await sql`insert into public.profiles (user_id,principal_id,primary_email,display_name)
    values (${id},${principal},${email},'Retirement fixture')
    on conflict (user_id) do nothing`;
  if (creator) {
    await sql`insert into accounts.creator_profiles (user_id,principal_id,referral_code,legacy_sanity_id)
      values (${id},${principal},${code},${legacyId})`;
    await sql`insert into accounts.account_roles (user_id,principal_id,role)
      values (${id},${principal},'creator')`;
    await sql`insert into accounts.login_aliases (user_id,principal_id,alias_type,normalized_value,verified)
      values (${id},${principal},'email',${email},true),
             (${id},${principal},'referral_code',${code},true)`;
  }
  if (tourneyRole) {
    await sql`insert into accounts.tourney_accounts (user_id,principal_id,username,role)
      values (${id},${principal},${code},${tourneyRole})`;
    await sql`insert into accounts.account_roles (user_id,principal_id,role)
      values (${id},${principal},${tourneyRole})`;
    await sql`insert into accounts.login_aliases (user_id,principal_id,alias_type,normalized_value,verified)
      values (${id},${principal},'tourney_username',${code},true),
             (${id},${principal},'tourney_email',${email},true)`;
  }
  return { id, principal, email, code, legacyId };
}

async function addIdentity(sql, account, provider = "discord") {
  const subject = socialSubject();
  await sql`insert into auth.identities (provider_id,user_id,identity_data,provider,created_at,updated_at)
    values (${subject},${account.id},${sql.json({ sub: subject, email: account.email, email_verified: true })},
      ${provider},now(),now())`;
  await sql`select public.roo_reconcile_auth_identity_links(${account.id},null)`;
  return subject;
}

async function createPlayer(sql, account) {
  const id = `retirement-player-${newId()}`;
  await sql`insert into tourney.tourney_players (
      id,principal_id,username,email,password_hash,discord,discord_key,battlenet,rank_name,role_play
    ) values (${id},${account.principal},${account.code},${account.email},${fakePasswordHash},
      ${account.code},${account.code},'Fixture#1234','Fixture','damage')`;
  return id;
}

async function createSnapshot(sql) {
  const data = ["player", "viewer", "caster", "owner"].map((role) => ({
    username: `fixture-${role}`, role, passwordHash: fakePasswordHash,
  }));
  await sql`insert into tourney.account_snapshots (version,accounts_json,canonical_hash,created_by)
    select coalesce(max(version),0)+1,${sql.json(data)},${digest(JSON.stringify(data))},'retirement-fixture'
    from tourney.account_snapshots`;
}

async function proveRetirement(sql) {
  const source = await createAccount(sql, { tourneyRole: "tourney_player" });
  const creator = await createAccount(sql, { creator: true });
  const orphan = await createAccount(sql, { tourneyRole: "tourney_viewer" });
  const orphanTarget = await createAccount(sql, { creator: true });
  const dual = await createAccount(sql, { creator: true, tourneyRole: "tourney_caster" });
  const owner = await createAccount(sql, { tourneyRole: "tourney_owner" });
  const subject = await addIdentity(sql, source);
  const orphanSubject = await addIdentity(sql, orphan);
  await addIdentity(sql, dual, "google");
  await sql`select public.roo_link_domain_social_identity(
    ${creator.principal},'referral','discord',${subject},${source.email},'{}'::jsonb)`;
  await createPlayer(sql, source);
  await createSnapshot(sql);
  const sessionId = newId();
  await sql`insert into auth.sessions (id,user_id,created_at,updated_at)
    values (${sessionId},${orphan.id},now(),now())`;
  const refreshId = -Number(BigInt(`0x${crypto.randomBytes(6).toString("hex")}`)) - 1;
  await sql`insert into auth.refresh_tokens (id,token,user_id,revoked,session_id,created_at,updated_at)
    values (${refreshId},${newId()},${orphan.id},false,${sessionId},now(),now())`;

  const [{ result: beforeSecurity }] = await sql`select public.roo_reconcile_account_security(null) result`;
  const protectedBefore = await protectedState(sql);
  const authBefore = await authState(sql);
  const result = await applySqlRetirement(sql);
  assert.equal(result.protectedRecordsUnchanged, true);
  assert.deepEqual(await protectedState(sql), protectedBefore, "Retirement changed protected rows.");
  for (const table of ["accounts.tourney_accounts", "tourney.tourney_players", "tourney.account_snapshots"]) {
    const [{ count }] = await sql`select count(*)::int count from ${sql(table)}`;
    assert.equal(count, 0, `${table} still holds native tournament data.`);
  }
  for (const account of [source, orphan, dual, owner]) {
    const [{ domain, roles, profile_count, alias_count }] = await sql`select
      accounts.principal_domain(${account.principal}) domain,
      (select jsonb_agg(role order by role) from accounts.account_roles
        where principal_id=${account.principal}) roles,
      (select count(*)::int from accounts.tourney_accounts where user_id=${account.id}) profile_count,
      (select count(*)::int from accounts.login_aliases where principal_id=${account.principal}
        and alias_type like 'tourney_%') alias_count`;
    assert.equal(domain, account === dual ? "referral" : "tourney");
    assert.deepEqual(roles, account === dual ? ["creator", "tourney_retired"] : ["tourney_retired"]);
    assert.equal(profile_count, 0);
    assert.equal(alias_count, 0);
  }
  const [{ account: dualAccount }] = await sql`select public.roo_resolve_account_alias(${dual.code}) account`;
  assert.equal(dualAccount.principal_id, dual.principal);
  assert.equal(dualAccount.creator_legacy_sanity_id, dual.legacyId);
  assert.equal(dualAccount.creator_active, true);

  await sql`select public.roo_reconcile_auth_identity_links(${source.id},null)`;
  const [{ result: afterSecurity }] = await sql`select public.roo_reconcile_account_security(null) result`;
  assert.equal(afterSecurity.failed, beforeSecurity.failed, "Retirement introduced account-security failures.");
  assert.equal((await sql`select user_id from auth.identities
    where provider='discord' and provider_id=${subject}`)[0].user_id, source.id);
  assert.equal((await sql`select principal_id from accounts.identity_links
    where domain='referral' and provider='discord' and provider_subject=${subject}`)[0].principal_id, creator.principal);

  const signinHash = digest(newId());
  await sql`select public.roo_create_oauth_intent(${sql.json({
    action: "signin", expires_at: new Date(Date.now() + 600_000).toISOString(),
    flow: "referral", provider: "discord", return_path: "/referrals/dashboard", token_hash: signinHash,
  })})`;
  const [{ result: signin }] = await sql`select public.roo_finalize_oauth_intent_v2(
    ${signinHash},${source.id},'discord',null) result`;
  assert.equal(signin.completed, true);

  const originalIntent = newId();
  await sql`insert into accounts.oauth_intents (
      id,token_hash,flow,action,provider,target_user_id,principal_id,domain_subject,
      return_path,status,expires_at,failure_code,completed_at
    ) values (${originalIntent},${digest(originalIntent)},'referral','link','discord',
      ${orphanTarget.id},${orphanTarget.principal},${orphanTarget.legacyId},'/referrals/dashboard',
      'failed',now()+interval '10 minutes','identity_already_exists',now())`;
  const grantHash = digest(newId());
  await sql`select public.roo_create_reauth_grant(${orphanTarget.id},${grantHash},'link_identity',null)`;
  const reclaimHash = digest(newId());
  await sql`select public.roo_create_oauth_intent(${sql.json({
    action: "reclaim", domain_subject: orphanTarget.legacyId,
    expires_at: new Date(Date.now() + 600_000).toISOString(), flow: "referral", provider: "discord",
    reauth_token_hash: grantHash, recovery_for_intent_id: originalIntent,
    return_path: "/referrals/dashboard", target_user_id: orphanTarget.id, token_hash: reclaimHash,
  })})`;
  const [{ result: reclaim }] = await sql`select public.roo_reclaim_referral_orphan_identity(
    ${reclaimHash},${orphan.id},'discord') result`;
  assert.deepEqual(reclaim, { reclaimed: false, reason: "active_account" });
  assert.equal((await sql`select user_id from auth.identities
    where provider='discord' and provider_id=${orphanSubject}`)[0].user_id, orphan.id);
  const [{ status, failure_code }] = await sql`select status,failure_code from accounts.oauth_intents
    where token_hash=${reclaimHash}`;
  assert.equal(status, "failed");
  assert.equal(failure_code, "active_domain_account");
  assert.equal((await sql`select outcome from accounts.orphan_identity_reclaim_audit
    where source_user_id=${orphan.id} and target_user_id=${orphanTarget.id}`)[0].outcome, "blocked_active_account");
  assert.deepEqual(await authState(sql), authBefore, "Auth credentials, identities or sessions changed.");
}

async function provePendingGuard(sql, kind, status) {
  const account = await createAccount(sql, { creator: true, tourneyRole: "tourney_caster" });
  await createSnapshot(sql);
  const operationKey = `retirement-fixture:${newId()}`;
  if (kind === "external") {
    await sql`insert into tourney.external_operations (
        operation_key,operation_kind,entity_type,entity_id,serialization_key,desired_state,
        desired_state_hash,status,lease_id,lease_expires_at
      ) values (${operationKey},'supabase_admin_auth','account',${account.id},${operationKey},
        '{}'::jsonb,${digest("{}")},${status},${status === "processing" ? newId() : null},
        ${status === "processing" ? new Date(Date.now() + 60_000) : null})`;
  } else if (kind === "player_auth") {
    const playerId = await createPlayer(sql, account);
    await sql`insert into tourney.tourney_player_auth_operations (
        operation_key,player_id,operation_kind,operation_status
      ) values (${operationKey},${playerId},'player_sync',${status})`;
  } else {
    await sql`insert into accounts.credential_operations (
        operation_key,user_id,principal_id,password_hash,status,source_recovery_blocked,next_retry_at
      ) values (${operationKey},${account.id},${account.principal},${fakePasswordHash},${status},
        true,now()+interval '1 day')`;
  }
  const before = await retirementState(sql);
  await assert.rejects(
    applySqlRetirement(sql),
    (error) => error.code === "TOURNEY_RETIREMENT_PENDING_OPERATIONS" && error.message.includes(`"${kind}":1`),
    `${kind}/${status} must block retirement before any mutation.`
  );
  assert.deepEqual(await retirementState(sql), before, `${kind}/${status} refusal changed rows.`);
}

async function rolledBackCase(sql, migration, name, callback) {
  const rollback = new Error("Successful fixture must roll back.");
  let passed = false;
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(migration);
      await tx`select set_config('roo.tourney_command_id',${`retirement-fixture:${newId()}`},true)`;
      await callback(tx);
      passed = true;
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  assert.ok(passed, `${name} did not finish.`);
  console.log(`PASS ${name} (rolled back)`);
}

async function proveProtectedPrecision(sql) {
  const account = await createAccount(sql, { creator: true });
  const token = newId();
  await sql`insert into auth.refresh_tokens (id,token,user_id,revoked,created_at,updated_at)
    values ('-9007199254740992'::bigint,${token},${account.id},false,now(),now())`;
  const before = await protectedState(sql);
  assert.deepEqual(await protectedState(sql), before);
  const exactBefore = await tableDigest(sql, "auth.refresh_tokens");
  const [otherBefore] = await sql`select (to_jsonb(t)-'id')::text data from auth.refresh_tokens t where token=${token}`;
  await sql`update auth.refresh_tokens set id='-9007199254740993'::bigint where token=${token}`;
  const [otherAfter] = await sql`select (to_jsonb(t)-'id')::text data from auth.refresh_tokens t where token=${token}`;
  assert.equal(otherAfter.data, otherBefore.data, "Only the large integer must change.");
  assert.notEqual(await tableDigest(sql, "auth.refresh_tokens"), exactBefore);
  assert.notEqual((await protectedState(sql))["auth.refresh_tokens"], before["auth.refresh_tokens"],
    "The protection guard missed a one-unit change outside JavaScript's safe integer range.");
  const changedAliases = await sql`update accounts.login_aliases set verified=false
    where principal_id=${account.principal} and alias_type='email'`;
  assert.equal(changedAliases.count, 1);
  assert.notEqual((await protectedState(sql))["accounts.login_aliases"], before["accounts.login_aliases"],
    "The filtered protection guard missed a changed login alias.");
}

async function proveBackupPrecision(sql) {
  const account = await createAccount(sql);
  const token = newId();
  await sql`insert into auth.refresh_tokens (id,token,user_id,revoked,created_at,updated_at)
    values ('-9007199254740993'::bigint,${token},${account.id},false,now(),now())`;
  await sql`update auth.users set raw_user_meta_data=jsonb_build_object(
    'large',9007199254740993::bigint,'precise',0.123456789012345678901234567891::numeric,
    'nested',jsonb_build_array(9007199254740995::bigint,null,${'quote " and slash \\ and newline\n'}::text)
  ) where id=${account.id}`;
  const [expected] = await sql`select raw_user_meta_data::text data from auth.users where id=${account.id}`;
  const tables = {
    "auth.users": await readDatabaseRowJson(sql, "auth.users"),
    "auth.refresh_tokens": await readDatabaseRowJson(sql, "auth.refresh_tokens"),
    empty: [],
  };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roo-retirement-precision-"));
  try {
    const manifest = await writeVerifiedBackup(directory, { version: 1, project: "local-fixture", legacyDocuments: [], tables });
    const bytes = await fs.readFile(manifest.file);
    assert.equal(manifest.sha256, digest(bytes));
    assert.equal((await fs.stat(manifest.file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal(manifest.counts.empty, 0);
    assert.equal(manifest.counts["auth.users"], tables["auth.users"].length);
    const payload = bytes.toString("utf8");
    const [backedToken] = await sql`select entry->>'id' id,jsonb_typeof(entry) kind
      from jsonb_array_elements(${payload}::text::jsonb->'tables'->'auth.refresh_tokens') entry
      where entry->>'token'=${token}`;
    assert.equal(backedToken?.kind, "object", "Backups must retain object rows, not encoded row strings.");
    assert.equal(backedToken.id, "-9007199254740993", "The backup rounded a PostgreSQL bigint.");
    const [backedUser] = await sql`select (entry->'raw_user_meta_data')::text data
      from jsonb_array_elements(${payload}::text::jsonb->'tables'->'auth.users') entry
      where entry->>'id'=${account.id}`;
    assert.equal(backedUser.data, expected.data, "The backup changed nested numbers or escaped text.");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const url = localDatabaseUrl(String(process.env.SUPABASE_TEST_DATABASE_URL || "").trim());
  const migration = await fs.readFile(migrationUrl, "utf8");
  const sql = postgres(url.href, { max: 1, prepare: false, connect_timeout: 5, onnotice: () => {} });
  try {
    const dataBefore = await retirementState(sql);
    const schemaBefore = await migrationState(sql);
    await rolledBackCase(sql, migration, "protected row digests retain bigint precision", proveProtectedPrecision);
    await rolledBackCase(sql, migration, "backup JSON preserves PostgreSQL numeric values", proveBackupPrecision);
    await rolledBackCase(sql, migration, "retirement preserves account and social identity ownership", proveRetirement);
    for (const [kind, statuses] of [
      ["external", ["pending", "processing", "retry", "dead_letter"]],
      ["player_auth", ["pending", "auth_applied", "retry"]],
      ["credentials", ["prepared", "auth_applied"]],
    ]) {
      for (const status of statuses) {
        await rolledBackCase(sql, migration, `${kind}/${status} blocks retirement`,
          (tx) => provePendingGuard(tx, kind, status));
      }
    }
    assert.deepEqual(await retirementState(sql), dataBefore, "A fixture persisted changes after rollback.");
    assert.equal(await migrationState(sql), schemaBefore, "The test migration persisted after rollback.");
    console.log("PASS all 12 PostgreSQL retirement cases; database rows and migration definitions unchanged.");
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(`Retirement regression failed: ${error.message}`);
  process.exitCode = 1;
});
