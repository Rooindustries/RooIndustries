import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeVerifiedBackup } from './fixtures/retirement-state.mjs';

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
