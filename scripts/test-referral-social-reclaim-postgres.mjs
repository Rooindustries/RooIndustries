#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import postgres from "postgres";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const pgConfig = spawnSync(process.env.PG_CONFIG || "pg_config", ["--bindir"], {
  encoding: "utf8",
});
const pgBin = String(process.env.PG_BIN || "").trim() ||
  (pgConfig.status === 0 ? pgConfig.stdout.trim() : "/opt/homebrew/bin");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roo-referral-reclaim-"));
const dataDir = path.join(tempRoot, "pgdata");
const socketDir = path.join(tempRoot, "socket");
const port = 56332 + Math.floor(Math.random() * 600);
const migration = path.join(
  root,
  "supabase/migrations/20260717231518_harden_referral_social_orphan_reclaim.sql"
);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} failed`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result.stdout;
};

const writeTemp = (name, contents) => {
  const file = path.join(tempRoot, name);
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return file;
};

const bootstrapSql = `
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create schema auth;
create schema accounts;
create table auth.users(
  id uuid primary key,
  email text,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table auth.identities(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  provider text not null,
  provider_id text not null,
  identity_data jsonb not null default '{}'::jsonb,
  email text,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, provider_id),
  unique(user_id, provider)
);
create table auth.sessions(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id)
);
create table accounts.principals(
  id uuid primary key,
  status text not null default 'active'
);
create table accounts.principal_auth_users(
  principal_id uuid not null references accounts.principals(id),
  user_id uuid not null unique references auth.users(id),
  is_primary boolean not null default false,
  source text not null default 'migration',
  primary key(principal_id, user_id)
);
create table accounts.oauth_intents(
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  flow text not null,
  action text not null,
  provider text not null,
  target_user_id uuid references auth.users(id),
  claimed_user_id uuid references auth.users(id),
  principal_id uuid references accounts.principals(id),
  domain_subject text,
  return_path text not null,
  provider_subject text,
  status text not null default 'pending',
  expires_at timestamptz not null,
  completed_at timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint oauth_intents_action_check
    check(action in ('signin','signup','link','reauth','merge')),
  constraint oauth_intents_target_action_check
    check((action in ('link','reauth','merge')) = (target_user_id is not null))
);
create table accounts.reauth_grants(
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references auth.users(id),
  principal_id uuid not null references accounts.principals(id),
  purpose text not null,
  provider text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table accounts.oauth_intents add column reauth_grant_id uuid
  references accounts.reauth_grants(id) on delete set null;
alter table accounts.oauth_intents add column reauth_purpose text;
create unique index oauth_intents_one_active_sensitive_action_idx
  on accounts.oauth_intents(target_user_id, provider, action)
  where action in ('link','reauth','merge') and status='pending';
create table accounts.creator_profiles(
  user_id uuid primary key references auth.users(id),
  principal_id uuid not null unique references accounts.principals(id),
  referral_code text not null unique,
  active boolean not null default true
);
create table accounts.tourney_accounts(
  user_id uuid primary key references auth.users(id),
  principal_id uuid not null unique references accounts.principals(id),
  username text not null unique,
  role text not null,
  active boolean not null default true
);
create table accounts.account_roles(
  user_id uuid not null references auth.users(id),
  principal_id uuid not null references accounts.principals(id),
  role text not null,
  primary key(user_id, role),
  unique(principal_id, role)
);
create table accounts.identity_links(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  principal_id uuid not null references accounts.principals(id),
  provider text not null,
  provider_subject text not null,
  provider_email text,
  email_verified boolean not null default false,
  linked_at timestamptz not null default now(),
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  backend_owner text not null default 'supabase',
  unique(provider, provider_subject),
  unique(principal_id, provider)
);
create or replace function public.roo_reconcile_auth_identity_links(p_user_id uuid)
returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('user_id', p_user_id)
$$;
create or replace function accounts.principal_account_json(
  p_principal_id uuid,
  p_login_user_id uuid default null
)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'principal_id', p_principal_id,
    'user_id', p_login_user_id
  )
$$;
`;

const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

const expectSqlState = (code) => (error) => {
  assert.equal(error.code, code);
  return true;
};

const seedScenario = async (sql, { ownerDomain = "none", provider = "discord" } = {}) => {
  const targetUserId = crypto.randomUUID();
  const targetPrincipalId = crypto.randomUUID();
  const ownerUserId = crypto.randomUUID();
  const ownerPrincipalId = crypto.randomUUID();
  const providerSubject = `${provider}-${crypto.randomUUID()}`;
  const originalIntentId = crypto.randomUUID();
  const grantHash = sha256(crypto.randomUUID());

  await sql`insert into auth.users(id,email,raw_app_meta_data) values
    (${targetUserId},'creator@example.invalid','{"providers":["email"]}'::jsonb),
    (${ownerUserId},${`${provider}@auth.rooindustries.invalid`},${sql.json({ provider, providers: [provider] })})`;
  await sql`insert into accounts.principals(id) values
    (${targetPrincipalId}),(${ownerPrincipalId})`;
  await sql`insert into accounts.principal_auth_users(principal_id,user_id,is_primary,source) values
    (${targetPrincipalId},${targetUserId},true,'migration'),
    (${ownerPrincipalId},${ownerUserId},true,'signup')`;
  await sql`insert into accounts.creator_profiles(user_id,principal_id,referral_code,active)
    values(${targetUserId},${targetPrincipalId},${`creator-${targetUserId}`},true)`;
  await sql`insert into accounts.account_roles(user_id,principal_id,role)
    values(${targetUserId},${targetPrincipalId},'creator')`;
  await sql`insert into auth.identities(user_id,provider,provider_id,identity_data)
    values(${ownerUserId},${provider},${providerSubject},${sql.json({ sub: providerSubject })})`;
  await sql`insert into auth.sessions(user_id) values(${ownerUserId})`;
  await sql`insert into accounts.identity_links(
    user_id,principal_id,provider,provider_subject,metadata
  ) values(${ownerUserId},${ownerPrincipalId},${provider},${providerSubject},'{}'::jsonb)`;

  if (ownerDomain === "creator") {
    await sql`insert into accounts.creator_profiles(user_id,principal_id,referral_code,active)
      values(${ownerUserId},${ownerPrincipalId},${`owner-${ownerUserId}`},true)`;
    await sql`insert into accounts.account_roles(user_id,principal_id,role)
      values(${ownerUserId},${ownerPrincipalId},'creator')`;
  }
  if (["active_tourney", "inactive_tourney"].includes(ownerDomain)) {
    await sql`insert into accounts.tourney_accounts(
      user_id,principal_id,username,role,active
    ) values(
      ${ownerUserId},${ownerPrincipalId},${`player-${ownerUserId}`},
      'tourney_player',${ownerDomain === "active_tourney"}
    )`;
  }

  await sql`insert into accounts.oauth_intents(
    id,token_hash,flow,action,provider,target_user_id,principal_id,
    domain_subject,return_path,status,expires_at,failure_code,completed_at
  ) values(
    ${originalIntentId},${sha256(originalIntentId)},'referral','link',${provider},
    ${targetUserId},${targetPrincipalId},'creator','/referrals/dashboard',
    'failed',now()+interval '10 minutes','identity_already_exists',now()
  )`;
  await sql`insert into accounts.reauth_grants(
    token_hash,user_id,principal_id,purpose,expires_at
  ) values(${grantHash},${targetUserId},${targetPrincipalId},'link_identity',now()+interval '10 minutes')`;
  return {
    grantHash,
    originalIntentId,
    ownerPrincipalId,
    ownerUserId,
    provider,
    providerSubject,
    targetPrincipalId,
    targetUserId,
  };
};

const createReclaimIntent = async (sql, scenario) => {
  const tokenHash = sha256(crypto.randomUUID());
  const payload = {
    action: "reclaim",
    domain_subject: "creator",
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    flow: "referral",
    provider: scenario.provider,
    reauth_purpose: null,
    reauth_token_hash: scenario.grantHash,
    recovery_for_intent_id: scenario.originalIntentId,
    return_path: "/referrals/dashboard",
    target_user_id: scenario.targetUserId,
    token_hash: tokenHash,
  };
  const [row] = await sql`select public.roo_create_oauth_intent(${sql.json(payload)}::jsonb) result`;
  assert.ok(row.result.id);
  return { id: row.result.id, tokenHash };
};

const exerciseScenario = async (sql, options) => {
  const scenario = await seedScenario(sql, options);
  const intent = await createReclaimIntent(sql, scenario);
  const [proof] = await sql`select public.roo_read_reauth_grant(
    ${scenario.grantHash},${scenario.targetUserId},'link_identity'
  ) result`;
  assert.equal(proof.result, null, "a bound grant must no longer appear reusable");

  const reusedPayload = {
    action: "link",
    domain_subject: "creator",
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    flow: "referral",
    provider: scenario.provider,
    reauth_token_hash: scenario.grantHash,
    return_path: "/referrals/dashboard",
    target_user_id: scenario.targetUserId,
    token_hash: sha256(crypto.randomUUID()),
  };
  await assert.rejects(
    sql`select public.roo_create_oauth_intent(${sql.json(reusedPayload)}::jsonb)`,
    expectSqlState("42501")
  );
  const [result] = await sql`select public.roo_reclaim_referral_orphan_identity(
    ${intent.tokenHash},${scenario.ownerUserId},${scenario.provider}
  ) result`;
  return { ...scenario, ...intent, result: result.result };
};

const assertReclaimed = async (sql, scenario) => {
  assert.equal(scenario.result.reclaimed, true);
  const [identity] = await sql`select user_id from auth.identities
    where provider=${scenario.provider} and provider_id=${scenario.providerSubject}`;
  assert.equal(identity.user_id, scenario.targetUserId);
  const [mapping] = await sql`select principal_id from accounts.principal_auth_users
    where user_id=${scenario.ownerUserId}`;
  assert.equal(mapping.principal_id, scenario.ownerPrincipalId, "principals must not merge");
  const [sessionCount] = await sql`select count(*)::integer count from auth.sessions
    where user_id=${scenario.ownerUserId}`;
  assert.equal(sessionCount.count, 0);
  const [audit] = await sql`select outcome from accounts.orphan_identity_reclaim_audit
    where oauth_intent_id=${scenario.id}`;
  assert.equal(audit.outcome, "reclaimed");
  await assert.rejects(
    sql`update accounts.orphan_identity_reclaim_audit set reason='changed'
      where oauth_intent_id=${scenario.id}`,
    expectSqlState("55000")
  );
};

const assertBlocked = async (sql, scenario) => {
  assert.deepEqual(scenario.result, { reason: "active_account", reclaimed: false });
  const [identity] = await sql`select user_id from auth.identities
    where provider=${scenario.provider} and provider_id=${scenario.providerSubject}`;
  assert.equal(identity.user_id, scenario.ownerUserId);
  const [audit] = await sql`select outcome from accounts.orphan_identity_reclaim_audit
    where oauth_intent_id=${scenario.id}`;
  assert.equal(audit.outcome, "blocked_active_account");
};

let started = false;
let sql;
try {
  const version = run(path.join(pgBin, "postgres"), ["--version"]);
  assert.match(version, /PostgreSQL\) 17\./, "PostgreSQL 17 is required");
  fs.mkdirSync(socketDir, { mode: 0o700 });
  run(path.join(pgBin, "initdb"), ["-D", dataDir, "--auth=trust", "--no-locale"]);
  run(path.join(pgBin, "pg_ctl"), [
    "-D", dataDir, "-o", `-p ${port} -h 127.0.0.1 -k ${socketDir}`, "-w", "start",
  ], { stdio: "ignore" });
  started = true;
  run(path.join(pgBin, "createdb"), [
    "-h", "127.0.0.1", "-p", String(port), "referral_reclaim_fixture",
  ]);
  const bootstrap = writeTemp("bootstrap.sql", bootstrapSql);
  run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(port), "-d", "referral_reclaim_fixture",
    "-v", "ON_ERROR_STOP=1", "-f", bootstrap, "-f", migration,
  ]);

  sql = postgres(`postgres://127.0.0.1:${port}/referral_reclaim_fixture`, {
    max: 1,
    prepare: false,
  });
  await assertReclaimed(sql, await exerciseScenario(sql, { provider: "discord" }));
  await assertBlocked(sql, await exerciseScenario(sql, {
    ownerDomain: "creator",
    provider: "google",
  }));
  await assertBlocked(sql, await exerciseScenario(sql, {
    ownerDomain: "active_tourney",
    provider: "discord",
  }));
  await assertReclaimed(sql, await exerciseScenario(sql, {
    ownerDomain: "inactive_tourney",
    provider: "google",
  }));
  await sql`update accounts.oauth_intents
    set updated_at=now()-interval '8 days'
    where status in ('completed','failed')`;
  await sql`delete from accounts.oauth_intents
    where status in ('completed','failed')
      and updated_at < now()-interval '7 days'`;
  const [retention] = await sql`select
    (select count(*)::integer from accounts.oauth_intents) intent_count,
    (select count(*)::integer from accounts.reauth_grants) grant_count,
    (select count(*)::integer from accounts.orphan_identity_reclaim_audit) audit_count`;
  assert.deepEqual(retention, {
    audit_count: 4,
    grant_count: 0,
    intent_count: 0,
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    postgres: version.trim(),
    verified: [
      "one-grant-one-intent binding",
      "provider-only orphan reclaim",
      "active creator protection",
      "active Tourney protection",
      "inactive Tourney orphan eligibility",
      "principal separation",
      "immutable audit rows",
      "seven-day OAuth cleanup compatibility",
    ],
  }, null, 2) + "\n");
} finally {
  await sql?.end({ timeout: 1 }).catch(() => {});
  if (started) {
    spawnSync(path.join(pgBin, "pg_ctl"), [
      "-D", dataDir, "-m", "fast", "-w", "stop",
    ], { encoding: "utf8" });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
