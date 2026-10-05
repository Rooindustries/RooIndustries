const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import bcrypt from 'bcryptjs';
import { updateSupabaseAccountPassword, buildCredentialSourceMutation } from '../src/server/supabase/accounts.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const pgBin = process.env.PG_BIN || '/tmp/roo-request-pg17/runtime/usr/lib/postgresql/17/bin';
const host = testHost;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'roo-auth-sweep-pg-'));
const dataDir = path.join(scratch, 'data');
const port = 58100 + Math.floor(Math.random() * 500);
const userId = '11111111-1111-4111-8111-111111111111';
const evidence = { pgBin, networkHost: host, productionRequests: 0, migration: 'supabase/migrations/20260715130000_harden_credential_recovery_saga.sql', scenarios: [] };
const run = (name, arguments_) => {
  const result = spawnSync(path.join(pgBin, name), arguments_, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr}`);
  return result.stdout;
};
const migration = fs.readFileSync(path.join(root, evidence.migration), 'utf8');
const definition = migration.match(/create or replace function public\.roo_prepare_credential_operation_v2\([\s\S]*?\n\$\$;/)?.[0];
assert.ok(definition, 'Actual credential preparation SQL must be found');
let started = false;
let sql;
let authUpdates = 0;
let failAuth = true;
const account = { creator_legacy_sanity_id: 'referral.fixture', user_id: userId, principal_id: userId, status: 'active', roles: ['creator'] };
try {
  evidence.postgres = run('postgres', ['--version']).trim();
  assert.match(evidence.postgres, /PostgreSQL\) 17\./);
  run('initdb', ['-D', dataDir, '--auth=trust', '--no-locale']);
  fs.appendFileSync(path.join(dataDir, 'pg_hba.conf'), '\nhost all all samehost trust\n');
  run('pg_ctl', ['-D', dataDir, '-l', path.join(scratch, 'postgres.log'), '-o', `-p ${port} -h ${host} -k ${scratch}`, '-w', 'start']);
  started = true;
  evidence.postgresPid = Number(fs.readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  sql = postgres({ host, port, database: 'postgres', max: 4, prepare: false });
  await sql.unsafe(`
    create schema accounts;
    create table accounts.principals(id uuid primary key, status text not null);
    create table accounts.principal_auth_users(user_id uuid primary key, principal_id uuid not null);
    create table accounts.credential_operations(
      id bigint generated always as identity primary key,
      operation_key text unique not null,
      user_id uuid not null,
      principal_id uuid not null,
      password_hash text not null,
      source_revision text,
      source_backend text,
      source_document_id text,
      source_expected_revision text,
      source_preconditions jsonb,
      source_mutation jsonb,
      status text not null default 'prepared',
      updated_at timestamptz not null default now()
    );
  `);
  await sql.unsafe(definition);
  await sql`insert into accounts.principals values(${userId}, 'active')`;
  await sql`insert into accounts.principal_auth_users values(${userId}, ${userId})`;
  const adminClient = {
    auth: { admin: { async updateUserById() { authUpdates++; return failAuth ? { error: {status: 503} } : {error: null}; } } },
    async rpc(name, parameters) {
      try {
        if (name === 'roo_resolve_account_alias') return { data: account, error: null };
        if (name === 'roo_get_credential_operation_v2') {
          const rows = await sql`select * from accounts.credential_operations where operation_key = ${parameters.p_operation_key}`;
          return { data: rows[0] || null, error: null };
        }
        if (name === 'roo_mark_credential_operation_v2') {
          const rows = await sql`update accounts.credential_operations set status = ${parameters.p_status} where operation_key = ${parameters.p_operation_key} returning *`;
          return { data: rows[0], error: null };
        }
        if (name !== 'roo_prepare_credential_operation_v2') throw new Error('Unexpected RPC');
        const [row] = await sql`select public.roo_prepare_credential_operation_v2(
          ${parameters.p_operation_key}, ${parameters.p_user_id}::uuid, ${parameters.p_password_hash},
          ${parameters.p_source_backend}, ${parameters.p_source_document_id}, ${parameters.p_source_expected_revision},
          ${sql.json(parameters.p_source_preconditions)}, ${sql.json(parameters.p_source_mutation)}
        ) as data`;
        return { data: row.data, error: null };
      } catch (failure) { return { data: null, error: { code: failure.code || 'FIXTURE_ERROR', status: 409 } }; }
    },
  };
  const password = 'fixture-password-one';
  const input = async (operationKey = 'credential:pg:retry') => {
    const passwordHash = await bcrypt.hash(password, 4);
    return { identifier: 'fixture', password, passwordHash, sourceBackend: 'supabase', sourceDocumentId: 'referral.fixture', sourceRevision: 'r1', sourcePreconditions: {creatorPassword: 'old', credentialVersion: 2}, sourceMutation: buildCredentialSourceMutation({passwordHash, passwordChangedAt: new Date().toISOString(), consumeResetToken: true}), operationKey, adminClient };
  };
  await assert.rejects(updateSupabaseAccountPassword(await input()));
  const [saved] = await sql`select * from accounts.credential_operations`;
  failAuth = false;
  const retried = await updateSupabaseAccountPassword(await input());
  assert.equal(retried.updated, true);
  assert.equal(retried.passwordHash, saved.password_hash);
  assert.deepEqual(retried.sourceMutation, saved.source_mutation);
  assert.equal(authUpdates, 2);
  evidence.scenarios.push({ scenario: 'prepared-retry-actual-sql', passed: true });
  await assert.rejects(updateSupabaseAccountPassword({...await input(), password: 'fixture-password-two'}), (failure) => failure.code === '23505');
  assert.equal(authUpdates, 2);
  evidence.scenarios.push({ scenario: 'different-password-actual-sql', passed: true });
  await assert.rejects(updateSupabaseAccountPassword({...await input(), sourceRevision: 'r2'}), (failure) => failure.code === '23505');
  await assert.rejects(updateSupabaseAccountPassword({...await input(), sourcePreconditions: {credentialVersion: 1}}), (failure) => failure.code === '23505');
  evidence.scenarios.push({ scenario: 'changed-source-actual-sql', passed: true });
  await sql`truncate accounts.credential_operations`;
  const concurrent = await Promise.allSettled([updateSupabaseAccountPassword(await input('credential:pg:concurrent')), updateSupabaseAccountPassword(await input('credential:pg:concurrent'))]);
  assert.ok(concurrent.every((result) => result.status === 'fulfilled'));
  const [count] = await sql`select count(*)::int as count from accounts.credential_operations`;
  assert.equal(count.count, 1);
  assert.equal(concurrent[0].value.passwordHash, concurrent[1].value.passwordHash);
  evidence.scenarios.push({ scenario: 'concurrent-same-password-actual-sql', passed: true });
  await sql`truncate accounts.credential_operations`;
  await sql`update accounts.principals set status = 'disabled'`;
  const before = authUpdates;
  await assert.rejects(updateSupabaseAccountPassword(await input('credential:pg:disabled')), (failure) => failure.code === 'P0002');
  assert.equal(authUpdates, before);
  evidence.scenarios.push({ scenario: 'disabled-principal-actual-sql', passed: true });
  evidence.passed = true;
} catch (failure) {
  evidence.passed = false; evidence.failure = failure.message; process.exitCode = 1;
} finally {
  if (sql) await sql.end({ timeout: 5 });
  if (started) { run('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop']); started = false; }
  evidence.servicesStopped = !started;
  const artifact = path.resolve(process.env.AUTH_SWEEP_ARTIFACT || '/tmp/roo-auth-sweep-postgres.json');
  evidence.scratch = scratch;
  fs.mkdirSync(path.dirname(artifact), {recursive: true});
  fs.writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
