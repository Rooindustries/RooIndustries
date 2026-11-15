import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createSweepPostgresFixture } from './lib/sweep-postgres-fixture.mjs';
import { scenarios, controls } from './lib/conflict-code-scenarios.mjs';
import { retrySqlPositions } from './lib/retry-sql-scan.mjs';

const binary = process.env.POSTGREST_14_BIN;
assert.ok(binary, 'POSTGREST_14_BIN must point to PostgREST 14.5');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), '39ce04b0597c6b3c3eb4c5f34fe6ab590a2d0172616eeaccf1e4c659b822295a');
const tag = crypto.randomBytes(6).toString('hex');
let fixture;

try {
  fixture = await createSweepPostgresFixture({ fullMigrationChain: true, postgrestBin: binary });
  assert.equal(fixture.postgrestVersion, 'PostgREST 14.5');
  const { sql, scratch, token, postgrestUrl } = fixture;
  const logPath = `${scratch}/postgres.log`;
  const logSize = () => fs.statSync(logPath).size;
  const logRuns = (message, start, fn) => {
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      let position = start, remainder = '', count = 0, verified = 0, pending = false, size;
      const inspect = (line) => {
        if (line.includes('ERROR:')) {
          pending = line.includes(message);
          if (pending) count++;
        } else if (pending && line.includes('CONTEXT:')) {
          const context = line.slice(line.indexOf('CONTEXT:') + 'CONTEXT:'.length).trim();
          const name = fn?.startsWith('public.') ? fn.slice(7) : fn;
          if (fn && (context.startsWith(`PL/pgSQL function ${fn}(`) || context.startsWith(`PL/pgSQL function ${name}(`))) verified++;
          pending = false;
        }
      };
      while ((size = fs.readSync(fd, buffer, 0, buffer.length, position))) {
        position += size;
        const lines = (remainder + buffer.toString('utf8', 0, size)).split('\n');
        remainder = lines.pop();
        lines.forEach(inspect);
      }
      if (remainder) inspect(remainder);
      return { count, verified };
    } finally { fs.closeSync(fd); }
  };
  const rpc = async (name, body, budget = 2000) => {
    try {
      const response = await fetch(`${postgrestUrl}/rpc/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(budget),
      });
      return { status: response.status, body: await response.json() };
    } catch (error) {
      if (error.name === 'TimeoutError') return { status: 'none' };
      throw error;
    }
  };
  const unstick = async () => {
    let quiet = 0;
    const deadline = Date.now() + 10000;
    while (quiet < 5 && Date.now() < deadline) {
      const [{ n }] = await sql`select count(pg_terminate_backend(pid))::int n from pg_stat_activity where application_name like 'PostgREST%' and query not like 'LISTEN%' and state <> 'idle'`;
      quiet = n ? 0 : quiet + 1;
    }
    assert.equal(quiet, 5, 'PostgREST backends did not settle');
  };
  const healthy = async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const results = await Promise.all(Array.from({ length: 10 }, () =>
        rpc('roo_commerce_canonical_manifest_for_types', { p_document_types: ['coupon'] }, 1000)));
      if (results.every((result) => result.status === 200)) return;
    }
    throw new Error('PostgREST did not recover');
  };
  const step = async (entry) => {
    if (entry.sql) return sql.unsafe(entry.sql);
    const result = await rpc(entry.rpc, entry.body, 5000);
    assert.ok([200, 204].includes(result.status), `seed ${entry.rpc}: ${JSON.stringify(result)}`);
    return result;
  };
  const functions = await sql.unsafe(`select ns.nspname||'.'||p.proname as name, p.prosrc as source
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname not in ('pg_catalog','information_schema')
    order by 1`);
  const census = functions.filter(({ source }) => retrySqlPositions(source, { handlers: false }).length > 0);
  const covered = new Set([...scenarios.map((scenario) => scenario.fn),
    'migration.block_legacy_discord_reauth', 'migration.finalize_inactive_noop_discord_assignments']);
  const missing = census.filter(({ name }) => !covered.has(name));
  let wrong = missing.length;
  const counts = { hang: 0, rerun: 0, conflict: 0 };
  for (const scenario of scenarios) {
    let result, count = 0;
    try {
      for (const seed of scenario.seed || []) await step(typeof seed === 'function' ? seed(tag) : seed);
      await healthy();
      const start = logSize();
      if (scenario.race) result = await scenario.race({ sql, rpc, tag });
      else { const call = scenario.call(tag); result = await rpc(call.rpc, call.body); }
      if (result.status === 'none') await unstick();
      const logged = logRuns(scenario.msg, start, scenario.fn);
      count = logged.count;
      const expectedMessage = ['S01', 'S03', 'S04'].includes(scenario.id)
        ? `${scenario.msg}${tag}-${scenario.id.toLowerCase()}` : scenario.msg;
      let verdict;
      if (result.status === 'none' && count > 0) verdict = 'hang';
      else if (scenario.guard === 'race' && result.status === 200 && count === 1) verdict = 'rerun';
      else if (result.status === 409 && result.body?.code === 'PT409' && result.body.message === expectedMessage && count === 1) verdict = 'conflict';
      else verdict = 'wrong';
      if (logged.verified !== count) verdict = 'wrong';
      if (verdict === 'conflict' && scenario.id === 'S05') {
        const [{ source_revision }] = await sql`select source_revision from migration.source_documents where legacy_sanity_id = ${`rateLimitBucket.${tag}-s05`}`;
        if (JSON.parse(result.body.details || '{}').currentRevision !== source_revision) verdict = 'wrong';
      }
      if (verdict === 'wrong') wrong++; else counts[verdict]++;
      console.log(JSON.stringify({ id: scenario.id, verdict, status: result.status, code: result.body?.code, runs: count }));
    } catch (error) {
      wrong++;
      console.error(`${scenario.id}: ${error.message}`);
      await unstick();
    } finally {
      if (scenario.after) await step(scenario.after);
    }
  }
  for (const control of controls) {
    const controlTag = `${tag}c`;
    try {
      for (const seed of control.seed || []) await step(typeof seed === 'function' ? seed(controlTag) : seed);
      const start = logSize();
      let result;
      if (control.race) result = await control.race({ sql, rpc, tag: controlTag });
      else { const call = control.call(controlTag); result = await rpc(call.rpc, call.body); }
      if (control.race) {
        assert.equal(result.status, 500);
        assert.equal(result.body?.code, '55000');
        assert.equal(logRuns(control.msg, start).count, 1);
      } else assert.equal(result.status, 200);
      if (control.id === 'C12') {
        assert.equal(result.body?.status, 'resolved');
        assert.equal(result.body?.resolved, true);
      }
      if (control.id === 'C16') {
        const [{ moved }] = await sql`select exists(select 1 from auth.identities i join accounts.oauth_intents o on o.token_hash = ${crypto.createHash('sha256').update(controlTag + 's16token').digest('hex')} where i.provider_id = ${`discord-${controlTag}-s16`} and i.user_id = o.target_user_id) moved`;
        assert.equal(moved, true);
      }
    } catch (error) { wrong++; console.error(`${control.id}: ${error.message}`); }
  }
  if (missing.length) console.error(`Uncovered functions: ${missing.map(({ name }) => name).join(', ')}`);
  console.log(`CENSUS N=${census.length}`);
  console.log(`SUMMARY hang=${counts.hang} rerun=${counts.rerun} conflict=${counts.conflict} wrong=${wrong} of ${scenarios.length}`);
  if (census.length !== 0 || counts.hang !== 0 || counts.rerun !== 0 || counts.conflict !== 22 || wrong !== 0) process.exitCode = 1;
} finally {
  if (fixture) {
    await fixture.stop();
    fs.rmSync(fixture.scratch, { recursive: true, force: true });
  }
}
