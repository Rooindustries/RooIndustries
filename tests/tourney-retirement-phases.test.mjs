import assert from 'node:assert/strict';
import test from 'node:test';
import { completeRetirement, resolveRetirementSanityToken } from '../scripts/retire-tourney-people.mjs';

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
