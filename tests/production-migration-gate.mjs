import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { createSweepPostgresFixture, root } from '../scripts/lib/sweep-postgres-fixture.mjs';
import { freeTcpPort } from '../scripts/lib/free-tcp-port.mjs';
import { withNodeOption } from '../scripts/lib/node-options.mjs';
import { productionRelease } from '../scripts/lib/payment-sweep-env-scenarios.mjs';

const historyMigration = '20261128000000_expose_migration_history_to_service_role.sql';
const files = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(file => file.endsWith('.sql')).sort();
const applied = files.map(file => ({ version: file.slice(0, 14), name: file.slice(15, -4) }));
const productionOnly = { version: '20261114113410', name: 'analytics_hex_readonly_views' };
const without = (...missing) => applied.filter(row => !missing.includes(`${row.version}_${row.name}.sql`));
const distDir = '.next-e2e-migration-gate';

let fixture;
before(async () => {
  fixture = await createSweepPostgresFixture({ fullMigrationChain: true });
});
after(async () => {
  await fixture?.stop();
  fs.rmSync(path.join(root, distDir), { recursive: true, force: true });
});

const record = async history => {
  await fixture.sql.begin(async sql => {
    await sql`delete from supabase_migrations.schema_migrations`;
    await sql`insert into supabase_migrations.schema_migrations ${sql([...history, productionOnly], 'version', 'name')}`;
  });
};

const historyReads = () => fixture.requestLog.filter(request => request.rpc === 'roo_migration_history').length;

const run = async (script, env = {}, supabaseOrigin = fixture.origin) => {
  const key = env.SUPABASE_SECRET_KEY ?? fixture.token;
  const guarded = withNodeOption({
    ROO_TEST_NETWORK_ORIGINS: JSON.stringify([supabaseOrigin]),
    ROO_TEST_SUPABASE_ORIGIN: supabaseOrigin,
  }, '--import', path.join(root, 'scripts/lib/test-target-safety.mjs'), path.join(root, 'tests/fixtures/supabase-host-route.mjs'));
  const child = spawn('npm', ['run', script], {
    cwd: root,
    timeout: 300_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      npm_config_update_notifier: 'false',
      ...productionRelease,
      ...guarded,
      NEXT_DIST_DIR: distDir,
      SUPABASE_SECRET_KEY: key,
      ...env,
    },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.ok(!output.includes(key), 'The build printed the Supabase key');
  return { status, output };
};

const assertBlocked = ({ status, output }, ...expected) => {
  assert.notEqual(status, 0, output);
  assert.match(output, /\[migrations\] Production build blocked: /);
  for (const text of expected) assert.ok(output.includes(text), `Missing "${text}" in:\n${output}`);
  assert.ok(!output.includes('> next build'), `next build started:\n${output}`);
};

test('a production build passes when every migration is in the history', async () => {
  const legacy = '20260714000000_harden_tourney_external_authority.sql';
  assert.ok(files.includes(legacy));
  await record([...without(legacy), { version: '20260714193833', name: 'harden_tourney_external_authority' }]);
  const reads = historyReads();
  const result = await run('prebuild');
  assert.equal(result.status, 0, result.output);
  assert.ok(result.output.includes(`[migrations] All ${files.length} migrations are in production's history.`), result.output);
  assert.equal(historyReads(), reads + 1);
});

test('a production build fails before next build when the newest migration is missing', async () => {
  await record(without(files.at(-1)));
  assertBlocked(await run('build'), `- ${files.at(-1)}\n`);
});

test('a production build lists each missing older migration', async () => {
  const older = ['20261113000000_stop_computing_retired_readiness_keys.sql', '20261118000000_harden_payment_recovery_and_hold_cleanup.sql'];
  await record(without(...older));
  assertBlocked(await run('build'), ...older.map(file => `- ${file}\n`));
});

test('a production build fails when a version is recorded under another name', async () => {
  const file = '20261118000000_harden_payment_recovery_and_hold_cleanup.sql';
  await record([...without(file), { version: '20261118000000', name: 'other_name' }]);
  assertBlocked(await run('build'), `- ${file} (production records 20261118000000 as other_name)`);
});

test('the history function is service-role only, and its rollback and reapply round-trip on the full chain', async () => {
  await record(applied);
  const [grants] = await fixture.sql`
    select has_function_privilege('anon', 'public.roo_migration_history()', 'execute') as anon,
      has_function_privilege('authenticated', 'public.roo_migration_history()', 'execute') as authenticated,
      has_function_privilege('service_role', 'public.roo_migration_history()', 'execute') as service_role,
      (select prosecdef from pg_proc where oid = 'public.roo_migration_history()'::regprocedure) as definer`;
  assert.deepEqual({ ...grants }, { anon: false, authenticated: false, service_role: true, definer: true });
  const schemaReady = async missing => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { error } = await fixture.client.rpc('roo_migration_history');
      if ((error?.code === 'PGRST202') === missing) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.fail(`PostgREST did not reload its schema (function missing: ${missing})`);
  };
  await fixture.apply('rollback', fs.readFileSync(path.join(root, 'supabase/rollbacks', historyMigration), 'utf8'));
  await schemaReady(true);
  assertBlocked(await run('build'), `public.roo_migration_history() is missing. Apply supabase/migrations/${historyMigration} to production first.`);
  await fixture.apply(historyMigration);
  await schemaReady(false);
  assert.equal((await run('prebuild')).status, 0);
});

test('a production build fails when Supabase refuses the key', async () => {
  const forged = `${fixture.token.slice(0, -6)}AAAAAA`;
  assertBlocked(await run('build', { SUPABASE_SECRET_KEY: forged }), 'Supabase refused the service key (HTTP 401');
});

test('a production build fails when Supabase cannot be reached', async () => {
  const port = await freeTcpPort('127.0.0.1');
  assertBlocked(await run('build', {}, `http://127.0.0.1:${port}`), 'Supabase could not be reached (', 'ECONNREFUSED');
});

test('a production build fails on a history it cannot read', async () => {
  let body;
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (body of [{ version: files.at(-1).slice(0, 14) }, [...applied, { version: files.at(-1).slice(0, 14) }]]) {
      assertBlocked(await run('build', {}, `http://127.0.0.1:${server.address().port}`), 'Supabase returned an unexpected migration history.');
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('preview, development, CI and local builds never read the history', async () => {
  await record([]);
  const reads = historyReads();
  for (const env of [
    { VERCEL_ENV: 'preview' },
    { VERCEL_ENV: 'development' },
    { VERCEL: '', VERCEL_ENV: '', CI: 'true' },
    { VERCEL: '', VERCEL_ENV: '', CI: '' },
  ]) {
    const result = await run('prebuild', env);
    assert.equal(result.status, 0, `${JSON.stringify(env)}:\n${result.output}`);
    assert.ok(!result.output.includes('[migrations]'), result.output);
  }
  assert.equal(historyReads(), reads);
});
