import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freeTcpPort } from '../scripts/lib/free-tcp-port.mjs';

test('the alignment rehearsal starts and cleans up PostgreSQL from a long output path', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'alignment-postgres-'));
  const pgBin = process.env.PG_BIN || '/usr/lib/postgresql/17/bin';
  let run;
  try {
    const input = path.join(scratch, 'input');
    const output = path.join(scratch, 'long-output-directory-'.repeat(6));
    const sunshine = path.join(scratch, 'sunshine');
    for (const directory of [input, output, sunshine]) fs.mkdirSync(directory);
    const inputs = {
      'hosted-full-catalog.sql': "select '{}'::json;",
      'hosted-full-catalog.raw.json': JSON.stringify({ rows: [{ catalog: {} }] }),
      'ledger-statements.raw.json': JSON.stringify({ rows: [] }),
      'stub.sql': "do $$ begin raise exception 'LOCAL_ALIGNMENT_STARTUP_REACHED'; end $$;",
      'local-branch.json': '{}',
      'hosted-alignment-extra.raw.json': JSON.stringify({ rows: [{ capture: {} }] }),
      'tourney-state.raw.json': JSON.stringify({ rows: [{ state: {} }] }),
      'missing-capture-read-only.sql': '',
      'commerce-preimage.sql': '',
    };
    for (const [name, body] of Object.entries(inputs)) fs.writeFileSync(path.join(input, name), body);
    const port = String(await freeTcpPort(process.env.ROO_TEST_HOST || '127.0.0.1'));
    const result = spawnSync('python3', [
      'scripts/test-hosted-alignment-rehearsal.py',
      '--input-dir', input,
      '--output-dir', output,
      '--release-dir', path.join(scratch, 'release'),
      '--pg-bin', pgBin,
      '--pg-library-dir', process.env.LD_LIBRARY_PATH || '/usr/lib',
      '--port', port,
      '--sunshine-migrations-dir', sunshine,
      '--commerce-preimage', path.join(input, 'commerce-preimage.sql'),
    ], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, TMPDIR: output } });
    const marker = path.join(output, 'alignment-latest-path');
    if (fs.existsSync(marker)) run = fs.readFileSync(marker, 'utf8').trim();
    assert.ifError(result.error);
    assert.ok(run, result.stderr + result.stdout);
    assert.ok(Buffer.byteLength(path.join(run, `.s.PGSQL.${port}`)) > 107);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const log = fs.readFileSync(path.join(run, 'postgres.log'), 'utf8');
    assert.match(fs.readFileSync(path.join(run, 'error.txt'), 'utf8'), /LOCAL_ALIGNMENT_STARTUP_REACHED/, log);
    const version = JSON.parse(fs.readFileSync(path.join(run, 'postgres-version.json'), 'utf8'));
    assert.match(version.server_version, /^17\./);
    assert.equal(version.listen_addresses, '');
    assert.ok(Buffer.byteLength(path.join(version.unix_socket, `.s.PGSQL.${port}`)) <= 107);
    assert.equal(fs.statSync(run).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(version.unix_socket), false);
    assert.equal(fs.existsSync(path.join(run, 'pgdata')), false);
    assert.match(log, /database system is shut down/);
  } finally {
    const data = run && path.join(run, 'pgdata');
    if (data && fs.existsSync(path.join(data, 'postmaster.pid'))) {
      const stopped = spawnSync(path.join(pgBin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], {
        encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
