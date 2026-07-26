#!/usr/bin/env node

// Executable regression for migration
// 20260726185500_scope_account_import_identity_link_conflict_by_domain.sql.
//
// Migration 20260726051500 replaced the global unique index on
// accounts.identity_links -- (provider, provider_subject) -- with a domain-scoped
// (domain, provider, provider_subject), and rewrote the two functions it defines.
// It missed two older ones that still named the dropped target, so every tourney
// admin credential sync and every native creator signup raised 42P10
// (invalid_column_reference) on its trailing metadata write. The Supabase Auth
// write had already landed by then, so the operation could never be marked
// applied and kept reissuing a credential change that had already taken effect.
//
// Production proved the imported-admin half drains, but the tourney hardening
// harness stops at 20260726173000 and has neither accounts.creator_profiles nor
// accounts.principal_domain, so roo_upsert_native_creator_account had no
// executable coverage anywhere. This runs both against the real domain-scoped
// index on a throwaway PostgreSQL 17 cluster.
//
// The schema comes from scripts/fixtures/account-domain-schema.sql, dumped
// straight out of production with pg_dump --schema-only, so the fixture cannot
// quietly drift from the constraint the functions actually run against.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import postgres from "postgres";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const pgBin = String(process.env.PG_BIN || "").trim() || spawnSync(
  process.env.PG_CONFIG || "pg_config",
  ["--bindir"],
  { encoding: "utf8" }
).stdout.trim();
// Honours a job-scoped scratch root when the runner sets one, so a sandboxed
// build writes its throwaway cluster inside its own workspace instead of /tmp.
const temporaryBase = process.env.ROO_JOB_DIR
  ? path.join(process.env.ROO_JOB_DIR, "tmp")
  : os.tmpdir();
const tempRoot = fs.mkdtempSync(path.join(temporaryBase, "roo-account-domain-"));
const dataDir = path.join(tempRoot, "pgdata");
const port = 57832 + Math.floor(Math.random() * 300);

// LC_ALL is pinned because a macOS shell inheriting an unset/UTF-8-only locale
// makes the postmaster abort at startup with "postmaster became multithreaded
// during startup", which reads like a cluster fault rather than a locale problem.
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
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

// Only what the migration's two functions actually touch. auth.users and
// tourney.external_operations are stubs; everything under accounts and
// public.profiles is the production dump.
const bootstrap = String.raw`
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists(select 1 from pg_roles where rolname='supabase_admin') then create role supabase_admin nologin; end if;
end $$;
create schema accounts;
create schema auth;
create schema extensions;
create schema migration;
create schema tourney;
create extension pgcrypto with schema extensions;
create extension "uuid-ossp" with schema extensions;
grant usage on schema public, accounts, auth, extensions, tourney to service_role;

create table auth.users (
  id uuid primary key,
  email text,
  encrypted_password text not null default '',
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

-- The dumped public.profiles policies reference auth.uid(), which Supabase
-- supplies from the request JWT. Nothing here authenticates as a browser role,
-- so a null-returning stub with the real signature is enough to let the DDL load.
create function auth.uid() returns uuid language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$fn$;

create table tourney.external_operations (
  operation_key text primary key,
  operation_kind text not null,
  status text not null default 'pending',
  desired_state jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  last_error_code text
);
`;

// accounts.principal_domain is created by 20260726051500. Reproduced here rather
// than applying that whole migration, which assumes a populated live database.
const principalDomain = String.raw`
create or replace function accounts.principal_domain(p_principal_id uuid)
returns text language sql stable security definer set search_path to '' as $$
  select case
    when exists (
      select 1 from accounts.creator_profiles creator
      where creator.principal_id = p_principal_id
    ) then 'referral'
    when exists (
      select 1 from accounts.tourney_accounts tourney
      where tourney.principal_id = p_principal_id
    ) then 'tourney'
    else 'referral'
  end;
$$;
`;

const newId = () => crypto.randomUUID();

// Both functions reject a hash that is not exactly 64 lowercase hex characters,
// so the fixtures have to be real digests rather than readable placeholders.
const digest = (label) => crypto.createHash("sha256").update(label).digest("hex");

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

  const psql = (args) =>
    run(path.join(pgBin, "psql"), [
      "-h", "127.0.0.1", "-p", String(port), "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", ...args,
    ]);

  psql(["-c", bootstrap]);
  psql(["-f", path.join(root, "scripts/fixtures/account-domain-schema.sql")]);
  psql(["-c", principalDomain]);

  sql = postgres(`postgres://127.0.0.1:${port}/postgres`, { max: 4, prepare: false });

  // The dumped index is the whole point: if the fixture had the old global unique
  // index instead, both functions would pass while production still failed.
  const [{ indexdef }] = await sql`
    select indexdef from pg_indexes
    where schemaname='accounts' and indexname='identity_links_domain_provider_subject_key'
  `;
  assert.equal(
    indexdef.includes("(domain, provider, provider_subject)"),
    true,
    "fixture is missing the domain-scoped identity link index"
  );
  const globalUnique = await sql`
    select 1 from pg_indexes
    where schemaname='accounts' and indexname='identity_links_provider_subject_key'
  `;
  assert.equal(globalUnique.length, 0, "fixture still has the dropped global unique index");
  process.stderr.write("[account-domain] fixture carries the production index shape\n");

  // Seeded before the migration so the reproduction below runs against the exact
  // pre-fix function bodies, then again after. The functions are only defined by
  // the migration itself, so "before" means calling them must fail as undefined.
  // principal_id is deliberately never supplied. Every one of these tables carries
  // an assign_principal_id BEFORE-INSERT trigger that overwrites whatever is passed
  // with ensure_principal_for_user(user_id), which mints principals.id = user_id.
  // Seeding a separate principal would be silently discarded and make the later
  // lookups miss, so the fixture follows the trigger instead of fighting it.
  const importedUser = newId();
  await sql`
    insert into auth.users(id, email, email_confirmed_at)
    values (${importedUser}, 'admin-import@example.com', now())
  `;
  await sql`
    insert into public.profiles(user_id, primary_email, display_name, status)
    values (${importedUser}, 'admin-import@example.com', 'Imported Admin', 'active')
  `;
  await sql`
    insert into accounts.tourney_accounts(
      user_id, username, role, active, lifecycle_status
    ) values (${importedUser}, 'imported-admin', 'tourney_caster', true, 'approved')
  `;
  const [{ principal_id: importedPrincipal }] = await sql`
    select principal_id from public.profiles where user_id = ${importedUser}
  `;

  await assert.rejects(
    () => sql`select public.roo_finalize_imported_account_metadata(
      ${importedUser}::uuid, 'rev-1', ${digest("hash-1")}, true
    )`,
    /does not exist/,
    "the finalize function should not exist before the migration"
  );

  psql([
    "-f",
    path.join(
      root,
      "supabase/migrations/20260726185500_scope_account_import_identity_link_conflict_by_domain.sql"
    ),
  ]);
  process.stderr.write("[account-domain] migration applied, self-check passed\n");

  // The migration ends with a do-block that fails outright if any function still
  // names the dropped index, so reaching this line is itself the assertion. Prove
  // it independently rather than trusting the migration's own verdict.
  const stale = await sql`
    select p.oid::regprocedure::text as name
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','accounts','tourney') and p.prokind='f'
      and pg_get_functiondef(p.oid) like '%on conflict (provider, provider_subject)%'
  `;
  // Compared by name rather than deepEqual: postgres.js returns a Result, whose
  // prototype never strict-equals a plain array even when both are empty.
  assert.deepEqual(
    stale.map((row) => row.name),
    [],
    "a function still targets the dropped unique index"
  );

  // 1. Imported tourney admin. This is the exact call that raised 42P10 on every
  //    admin credential sync, and the domain must resolve to 'tourney' from the
  //    tourney_accounts row rather than the column's 'referral' default.
  await sql`select public.roo_finalize_imported_account_metadata(
    ${importedUser}::uuid, 'rev-1', ${digest("hash-1")}, true
  )`;
  const [imported] = await sql`
    select domain, provider, provider_subject
    from accounts.identity_links where principal_id = ${importedPrincipal}
  `;
  assert.equal(imported.domain, "tourney", "an imported admin must land in the tourney domain");
  assert.equal(imported.provider, "email");
  process.stderr.write("[account-domain] imported admin metadata resolves to the tourney domain\n");

  // Idempotent: the retry that used to fail must now update in place, because the
  // whole defect was an operation that could never be marked applied.
  await sql`select public.roo_finalize_imported_account_metadata(
    ${importedUser}::uuid, 'rev-2', ${digest("hash-2")}, true
  )`;
  const importedLinks = await sql`
    select count(*)::int as count from accounts.identity_links
    where principal_id = ${importedPrincipal}
  `;
  assert.equal(importedLinks[0].count, 1, "the retry inserted a duplicate instead of updating");
  process.stderr.write("[account-domain] finalize is idempotent across retries\n");

  // 2. Native creator signup -- the half with no coverage anywhere until now.
  const creatorEmail = "creator-native@example.com";
  // The function takes an already-minted auth user and reads `primary_email`, not
  // `email`; both are enforced, so a wrong key surfaces as 'account is incomplete'.
  const creatorUser = newId();
  await sql`insert into auth.users(id, email) values (${creatorUser}, ${creatorEmail})`;
  const creatorPayload = {
    user_id: creatorUser,
    primary_email: creatorEmail,
    display_name: "Native Creator",
    referral_code: "NATIVE1",
    paypal_email: "payouts@example.com",
    contact_discord: "native#0001",
  };
  const creatorResult = await sql`
    select public.roo_upsert_native_creator_account(${sql.json(creatorPayload)}) as result
  `;
  assert.equal(
    creatorResult[0].result?.user_id,
    creatorUser,
    "the creator upsert returned no user id"
  );
  // referral_code is stored lower(btrim(...)), and provider_subject is derived as
  // 'email:' || user_id rather than the address itself.
  const [creatorLink] = await sql`
    select il.domain, il.provider, il.provider_subject, il.provider_email
    from accounts.identity_links il
    join accounts.creator_profiles cp on cp.principal_id = il.principal_id
    where cp.referral_code = 'native1'
  `;
  assert.equal(creatorLink.domain, "referral", "a native creator must land in the referral domain");
  assert.equal(creatorLink.provider_subject, `email:${creatorUser}`);
  assert.equal(creatorLink.provider_email, creatorEmail);
  process.stderr.write("[account-domain] native creator signup resolves to the referral domain\n");

  // Re-running the signup is the real retry path: same email, same conflict target.
  await sql`
    select public.roo_upsert_native_creator_account(${sql.json({
      ...creatorPayload,
      display_name: "Native Creator Renamed",
    })})
  `;
  const creatorLinks = await sql`
    select count(*)::int as count from accounts.identity_links
    where provider_subject = ${`email:${creatorUser}`}
  `;
  assert.equal(creatorLinks[0].count, 1, "the creator retry inserted a duplicate link");
  process.stderr.write("[account-domain] creator upsert is idempotent across retries\n");

  // 3. Why the index was scoped at all. Both functions derive provider_subject
  //    from the user id, so they can never collide with each other -- the real
  //    cross-domain subject is a Discord id, which one person legitimately holds
  //    on both the referral and the tourney side. Under the dropped global unique
  //    index the second link was rejected; it must now coexist. This is the shape
  //    commit 13d8b3c7 depends on, so it is asserted directly on the index.
  const discordSubject = "discord-subject-4471";
  const tourneyUser = newId();
  await sql`insert into auth.users(id, email) values (${tourneyUser}, 'dual-domain@example.com')`;
  await sql`
    insert into public.profiles(user_id, primary_email, display_name, status)
    values (${tourneyUser}, 'dual-domain@example.com', 'Dual Domain', 'active')
  `;
  await sql`
    insert into accounts.tourney_accounts(
      user_id, username, role, active, lifecycle_status
    ) values (${tourneyUser}, 'dual-domain', 'tourney_viewer', true, 'approved')
  `;
  await sql`
    insert into accounts.identity_links(user_id, provider, provider_subject, domain)
    values (${creatorUser}, 'discord', ${discordSubject}, 'referral')
  `;
  await sql`
    insert into accounts.identity_links(user_id, provider, provider_subject, domain)
    values (${tourneyUser}, 'discord', ${discordSubject}, 'tourney')
  `;
  const bothDomains = await sql`
    select domain from accounts.identity_links
    where provider = 'discord' and provider_subject = ${discordSubject}
    order by domain
  `;
  assert.deepEqual(
    bothDomains.map((row) => row.domain),
    ["referral", "tourney"],
    "one subject must be able to hold a link in each domain"
  );
  process.stderr.write("[account-domain] one subject coexists across both domains\n");

  // 4. Within a single domain the uniqueness still has to bite, or the scoping
  //    would have traded a false failure for a silent duplicate.
  await assert.rejects(
    () => sql`
      insert into accounts.identity_links(user_id, provider, provider_subject, domain)
      values (${tourneyUser}, 'discord', ${discordSubject}, 'tourney')
    `,
    /duplicate key value/,
    "the domain-scoped index failed to reject a same-domain duplicate"
  );

  // And the imported-admin path still resolves to 'tourney' for an account that
  // was never touched by the creator upsert, independent of case 1's fixture.
  await sql`select public.roo_finalize_imported_account_metadata(
    ${tourneyUser}::uuid, 'rev-1', ${digest("hash-3")}, true
  )`;
  const [tourneyEmailLink] = await sql`
    select domain from accounts.identity_links
    where provider = 'email' and provider_subject = ${`email:${tourneyUser}`}
  `;
  assert.equal(
    tourneyEmailLink.domain,
    "tourney",
    "a second imported admin must also resolve to the tourney domain"
  );
  process.stderr.write("[account-domain] same-domain duplicates are still rejected\n");

  const grants = await sql`
    select p.proname, has_function_privilege('service_role', p.oid, 'execute') as granted
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'roo_finalize_imported_account_metadata', 'roo_upsert_native_creator_account'
      )
    order by p.proname
  `;
  assert.equal(grants.length, 2, "both rewritten functions should be present");
  for (const grant of grants) {
    assert.equal(grant.granted, true, `${grant.proname} lost its service_role execute grant`);
  }
  process.stderr.write("[account-domain] both functions retain service_role execute\n");

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        postgres: (await sql`show server_version`)[0].server_version,
        migration: "20260726185500_scope_account_import_identity_link_conflict_by_domain",
        verified: [
          "production-dumped domain-scoped unique index, dropped global index absent",
          "imported tourney admin metadata resolves to the tourney domain",
          "native creator signup resolves to the referral domain",
          "both functions idempotent across the retry that used to raise 42P10",
          "one provider_subject coexists in both domains",
          "same-domain duplicates still rejected",
          "no function retains the dropped conflict target",
          "service_role execute preserved on both rewritten functions",
        ],
      },
      null,
      2
    )}\n`
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
