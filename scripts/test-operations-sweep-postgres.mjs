import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createSweepPostgresFixture, root } from "./lib/sweep-postgres-fixture.mjs";
import { buildMigrationAccounts, accountRpcPayload } from "./lib/supabase-shadow-migration.mjs";
import { verifyFullLogicalSnapshotRestore } from "./lib/logical-snapshot-restore.mjs";
import * as snapshotContract from "../src/server/archive/snapshotContract.js";
const stage=process.argv.find(arg=>arg.startsWith('--stage='))?.split('=')[1]||'final';
const only=process.argv.find(arg=>arg.startsWith('--only='))?.split('=')[1];
const selected=name=>!only||only.split(',').includes(name);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const evidence={stage,productionRequests:0,scenarios:[],standIns:['D6: retired vendor import/verification checks removed; native account and logical restore checks retained against full-chain local PG17/PostgREST. Platform bootstrap is local. No hosted Auth/storage claim.']};
let fixture;
try {
  fixture=await createSweepPostgresFixture({fullMigrationChain:true});
  const {sql,client}=fixture;
  const zeroName = "native-import-preserves-zero-commission";
  if (selected(zeroName)) {
    try {
      const document = { _id: "fixture-zero-commission", _type: "referral", _rev: "zero-r1", creatorEmail: "zero@fixture.invalid",
        creatorPassword: "$2b$10$7EqJtq98hPqEX7fNZaFWoO5YraAdMEeKGKVFYqbIxCZHTYBBm7nS6", slug: { current: "fixture-zero" }, currentCommissionPercent: 0, currentDiscountPercent: 0 };
      const [account] = buildMigrationAccounts([document]);
      await sql`insert into auth.users(id,email) values(${account.userId},${account.primaryEmail})`;
      const imported = await client.rpc("roo_import_account", { p_account: accountRpcPayload(account) });
      assert.equal(imported.error, null);
      const [row] = await sql`select commission_basis_points,discount_basis_points from accounts.creator_profiles where user_id=${account.userId}`;
      const proof = { sourceCommission: 0, preparedCommission: account.creatorProfile.commission_basis_points, persistedCommission: row.commission_basis_points, persistedDiscount: row.discount_basis_points };
      evidence.scenarios.push({ name: zeroName, passed: row.commission_basis_points === 0, proof });
      assert.equal(row.commission_basis_points, 0);
    } catch (cause) { if (!evidence.scenarios.some((row) => row.name === zeroName)) evidence.scenarios.push({ name: zeroName, passed: false, error: cause.message }); }
  }
  const restoreName = "native-logical-restore-canonical-rows";
  if (selected(restoreName)) {
    try {
      const relations = [...snapshotContract.SUPABASE_FULL_CAPTURE_REQUIRED_RELATIONS];
      const [sample] = await sql`select '[{"amount":0.01,"precise":12345678901234567890.123456789,"text":"synthetic"}]'::jsonb::text rows`;
      const relationPayloads = Object.fromEntries(relations.map((name) => [name, name === "commerce.payment_records" ? sample.rows : "[]"]));
      const full_logical = { format: "roo-supabase-full-logical-snapshot-v1", sourceSnapshotId: "a0000000-0000-4000-8000-000000000001", capturedAt: "2026-10-05T00:00:00.000Z",
        schemas: snapshotContract.SUPABASE_FULL_SNAPSHOT_SCHEMAS, catalogRelations: relations,
        catalogSha256: hash(snapshotContract.stableSnapshotJson([...relations].sort())), relationPayloads,
        relationCounts: Object.fromEntries(relations.map((name) => [name, name === "commerce.payment_records" ? 1 : 0])),
        relationHashes: Object.fromEntries(relations.map((name) => [name, hash(relationPayloads[name])])),
        requiredRelations: relations, deferredRelations: [], contractProfile: snapshotContract.SUPABASE_FULL_COMPACT_EXPANDED_PROFILE,
        sourceMigrationVersion: "20260729120000", sourceMigrationNames: snapshotContract.SUPABASE_FULL_EXPANDED_MIGRATION_NAMES,
      };
      const proof = await verifyFullLogicalSnapshotRestore({ sql, payload: { full_logical } });
      assert.equal(proof.rowCount, 1);
      await assert.rejects(verifyFullLogicalSnapshotRestore({ sql, payload: { full_logical: { ...full_logical, relationCounts: { ...full_logical.relationCounts, "commerce.payment_records": 2 } } } }));
      evidence.scenarios.push({ name: restoreName, passed: true, proof });
    } catch (cause) { evidence.scenarios.push({ name: restoreName, passed: false, error: cause.message }); }
  }
  evidence.fixture = { postgresVersion: fixture.postgresVersion, postgrestVersion: fixture.postgrestVersion, scratch: fixture.scratch,
    sqlManifest: fixture.manifest, requests: fixture.requestLog };
} catch (cause) { evidence.failure = { message: cause.message, scratch: cause.scratch }; }
finally {
  if (fixture) await fixture.stop();
  await fsPromises.mkdir(path.join(root, "test-results"), { recursive: true });
  const artifact = path.join(root, "test-results", `operations-postgres-${stage}.json`);
  await fsPromises.writeFile(artifact, JSON.stringify(evidence, null, 2));
  process.stdout.write(`${JSON.stringify({ artifact, passed: evidence.scenarios.filter((row) => row.passed).length, total: evidence.scenarios.length, failure: evidence.failure })}\n`);
  if (evidence.failure || evidence.scenarios.some((row) => !row.passed)) process.exitCode = 1;
}
