import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { completeRetirement, resolveRetirementSanityToken, writeVerifiedBackup } from '../scripts/retire-tourney-people.mjs';

test('backup readback rejects malformed or non-object raw rows before recording a manifest', async () => {
  for (const row of ['null', '[]', '1', 'true', '"text"', '{', '{"a":1},{"b":2}']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'roo-retirement-invalid-'));
    try {
      await assert.rejects(writeVerifiedBackup(directory, { version: 1, tables: { fixture: [row] } }));
      await assert.rejects(fs.access(path.join(directory, 'manifest.json')));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test('backup encoding preserves quoted table names and nested JSON data', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'roo-retirement-json-'));
  const name = 'fixture."quoted"';
  const row = { note: 'quote " and slash \\ and newline\n', nested: [null, { values: [] }] };
  try {
    const manifest = await writeVerifiedBackup(directory, {
      version: 1, legacyDocuments: [{ accountsJson: '[]' }], tables: { [name]: [JSON.stringify(row)], empty: [] },
    });
    const restored = JSON.parse(await fs.readFile(manifest.file, 'utf8'));
    assert.deepEqual(restored, { version: 1, legacyDocuments: [{ accountsJson: '[]' }], tables: { [name]: [row], empty: [] } });
    assert.deepEqual(manifest.counts, { [name]: 1, empty: 0 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('plan mode can use a read-only token and prefers a configured write token', () => {
  assert.equal(resolveRetirementSanityToken({ SANITY_READ_TOKEN: 'read-token' }), 'read-token');
  assert.equal(resolveRetirementSanityToken({ SANITY_WRITE_TOKEN: 'write-token', SANITY_READ_TOKEN: 'read-token' }), 'write-token');
});

test('apply mode requires a configured write token without falling back to a read token', () => {
  for (const token of [undefined, '', '  ', '[SENSITIVE]']) {
    assert.throws(() => resolveRetirementSanityToken({ SANITY_WRITE_TOKEN: token, SANITY_READ_TOKEN: 'read-token' }, true), /SANITY_WRITE_TOKEN/);
  }
  assert.equal(resolveRetirementSanityToken({ SANITY_WRITE_TOKEN: ' write-token ', SANITY_READ_TOKEN: 'read-token' }, true), 'write-token');
});

test('plan mode rejects missing or redacted credentials', () => {
  assert.throws(() => resolveRetirementSanityToken({}), /private Sanity token/);
  assert.throws(() => resolveRetirementSanityToken({ SANITY_READ_TOKEN: '[SENSITIVE]' }), /private Sanity token/);
});

const run = (failAt) => {
  const events = [];
  const step = async (name) => {
    events.push(name);
    if (failAt === name) throw new Error(`Injected ${name} failure`);
  };
  return { events, result: completeRetirement({
    commitSql: () => step('sql'),
    commitLegacy: () => step('legacy'),
    recordPhase: step,
  }) };
};

test('SQL rollback never clears legacy staff data or records a completed phase', async () => {
  const scenario = run('sql');
  await assert.rejects(scenario.result, /Injected sql failure/);
  assert.deepEqual(scenario.events, ['sql']);
});

test('legacy failure preserves the durable SQL phase and reports the partial completion', async () => {
  const scenario = run('legacy');
  await assert.rejects(scenario.result, /Native SQL retirement committed.*Injected legacy failure/);
  assert.deepEqual(scenario.events, ['sql', 'sql-completed', 'legacy']);
});

test('failure to persist the SQL receipt stops before changing legacy data', async () => {
  const scenario = run('sql-completed');
  await assert.rejects(scenario.result, /Native SQL retirement committed/);
  assert.deepEqual(scenario.events, ['sql', 'sql-completed']);
});

test('completed receipt is written only after both stores commit', async () => {
  const scenario = run();
  await scenario.result;
  assert.deepEqual(scenario.events, ['sql', 'sql-completed', 'legacy', 'completed']);
});

test('completion-receipt failure remains an explicit partial-completion error', async () => {
  const scenario = run('completed');
  await assert.rejects(scenario.result, /Native SQL retirement committed.*Injected completed failure/);
  assert.deepEqual(scenario.events, ['sql', 'sql-completed', 'legacy', 'completed']);
});
