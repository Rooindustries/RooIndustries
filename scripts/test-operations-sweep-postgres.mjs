const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createSweepPostgresFixture, functionDefinition, root } from "./lib/sweep-postgres-fixture.mjs";
import { buildMigrationAccounts, accountRpcPayload } from "./lib/supabase-shadow-migration.mjs";
import { verifyFullLogicalSnapshotRestore } from "./lib/logical-snapshot-restore.mjs";
import * as snapshotContract from "../src/server/archive/snapshotContract.js";

const stage = process.argv.find((arg) => arg.startsWith("--stage="))?.split("=")[1] || "final";
const baseline = process.argv.includes("--baseline");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.split("=")[1];
const evidence = { stage, baseline, productionRequests: 0, scenarios: [], standIns: [
  "Sanity query HTTP returns a synthetic empty source inventory. Actual SDK and requests; hosted Sanity engine is not exercised.",
  "Local Auth/storage bootstrap and broad service-role grants from the shared fixture. Hosted RLS, migration history and GoTrue are not proved.",
  "Baseline command source is HEAD; linked application dependencies are the current worktree. Native SQL definitions are checked-in repository definitions.",
] };
const selected = (name) => !only || only.split(",").includes(name);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
let fixture, server;
try {
  fixture = await createSweepPostgresFixture();
  const { sql, client } = fixture;
  await fixture.apply("20260710214534_add_shadow_verification_rpc.sql");
  const tourneyFoundation = "20260710223408_create_tourney_shadow_foundation.sql";
  const tourneyDdl = fs.readFileSync(path.join(root, "supabase/migrations", tourneyFoundation), "utf8").split("create unique index tourney_players_discord_user_id_unique")[0];
  await fixture.apply(tourneyFoundation, tourneyDdl, "actual Tourney schema and players DDL for current account summary");
  await fixture.apply("20260711011253_extend_account_shadow_summary.sql");
  await fixture.apply("20260710234800_resolve_verified_drift_findings.sql");
  await fixture.apply("20260711203306_scope_commerce_shadow_sync.sql");
  await fixture.apply("20260710211428_add_account_and_licensing_rpc.sql", functionDefinition("20260710211428_add_account_and_licensing_rpc.sql", "public.roo_import_account"), "actual account import RPC definition");
  await sql`notify pgrst,'reload schema'`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.rpc("roo_record_drift_findings", { p_run_id: "a0000000-0000-4000-8000-000000000000", p_findings: [] });
    if (result.error?.code !== "PGRST202") { assert.equal(result.error?.code, "P0002"); break; }
    assert(attempt < 99);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const run = await client.rpc("roo_start_sync_run", { p_direction: "compare", p_mode: "shadow", p_source_cursor: null });
  assert.equal(run.error, null);
  const record = await client.rpc("roo_record_drift_findings", { p_run_id: run.data, p_findings: [{ category: "count_mismatch", severity: "error", details: { synthetic: true } }] });
  assert.equal(record.error, null);
  const finish = await client.rpc("roo_finish_sync_run", { p_run_id: run.data, p_status: "completed", p_counters: {}, p_error_summary: null });
  assert.equal(finish.error, null);
  const state = async () => {
    const [row] = await sql`select jsonb_build_object(
      'runs',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from migration.sync_runs t),
      'findings',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from migration.drift_findings t),
      'sources',(select coalesce(jsonb_agg(to_jsonb(t) order by t.legacy_sanity_id),'[]') from migration.source_documents t)
    )::text snapshot`;
    return { hash: hash(row.snapshot), ...JSON.parse(row.snapshot) };
  };
  const scratch = path.join(fixture.scratch, "commands");
  await fsPromises.mkdir(path.join(scratch, "scripts"), { recursive: true, mode: 0o700 });
  for (const name of ["src", "node_modules", "supabase"]) await fsPromises.symlink(path.join(root, name), path.join(scratch, name));
  await fsPromises.symlink(path.join(root, "scripts/lib"), path.join(scratch, "scripts/lib"));
  const nativeFetch = globalThis.fetch;
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url.includes("/data/query/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ result: [] }));
      return;
    }
    assert(req.url.startsWith("/rest/v1/"));
    const headers = { ...req.headers };
    delete headers.host; delete headers.connection; delete headers["content-length"];
    const response = await nativeFetch(`${fixture.origin}${req.url}`, { method: req.method, headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks), signal: AbortSignal.timeout(15000) });
    res.writeHead(response.status, { "Content-Type": "application/json" });
    res.end(await response.text());
  });
  await new Promise((resolve) => server.listen(0, testHost, resolve));
  const trace = path.join(scratch, "trace.jsonl");
  const manifest = path.join(scratch, "fixture.json");
  await fsPromises.writeFile(manifest, JSON.stringify({ origin: `http://${testHost}:${server.address().port}`, trace }));
  await fsPromises.writeFile(trace, "");
  const envText = `SANITY_PROJECT_ID=targetb\nSANITY_DATASET=fixtureb\nSANITY_READ_TOKEN=fixture-targetb\nSUPABASE_URL=https://targetb.supabase.co\nSUPABASE_SECRET_KEY=${fixture.token}\nDATA_PRIMARY_BACKEND=sanity\nCOMMERCE_PRIMARY_BACKEND=sanity\n`;
  const envPath = path.join(scratch, "selected.env");
  await fsPromises.writeFile(envPath, envText, { mode: 0o600 });
  await fsPromises.writeFile(path.join(scratch, ".env.local"), envText, { mode: 0o600 });
  for (const script of ["migrate-sanity-to-supabase.mjs", "sync-sanity-commerce-to-supabase.mjs"]) {
    const name = `native-read-only:${script}`;
    if (!selected(name)) continue;
    try {
      const source = baseline ? spawnSync("git", ["show", `HEAD:scripts/${script}`], { cwd: root, encoding: "utf8" }) : null;
      if (baseline) {
        assert.equal(source.status, 0);
        await fsPromises.writeFile(path.join(scratch, "scripts", script), source.stdout);
      }
      const entry = baseline ? path.join(scratch, "scripts", script) : path.join(root, "scripts", script);
      const before = await state();
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", path.join(root, "scripts/test-operations-sweep-network.mjs"), entry,
          "--env", envPath, "--verify-only", "--skip-assets"], { cwd: scratch,
          env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "test", ROO_TEST_HOST: testHost, OPERATIONS_TEST_MANIFEST: manifest } });
        let stdout = "", stderr = "";
        child.stdout.on("data", (data) => { stdout += data; });
        child.stderr.on("data", (data) => { stderr += data; });
        child.on("error", reject);
        const timeout = setTimeout(() => child.kill("SIGKILL"), 20000); timeout.unref();
        child.on("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
      });
      const after = await state();
      const proof = { cliExitCode: result.code, stderr: result.stderr, beforeHash: before.hash, afterHash: after.hash,
        beforeRuns: before.runs.length, afterRuns: after.runs.length,
        beforeFinding: before.findings[0]?.status, afterFinding: after.findings[0]?.status };
      evidence.scenarios.push({ name, passed: result.code === 0 && before.hash === after.hash, proof });
      assert.equal(result.code, 0);
      assert.equal(before.hash, after.hash);
    } catch (cause) {
      if (!evidence.scenarios.some((row) => row.name === name)) evidence.scenarios.push({ name, passed: false, error: cause.message });
    }
  }
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
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (fixture) await fixture.stop();
  await fsPromises.mkdir(path.join(root, "test-results"), { recursive: true });
  const artifact = path.join(root, "test-results", `operations-postgres-${stage}.json`);
  await fsPromises.writeFile(artifact, JSON.stringify(evidence, null, 2));
  process.stdout.write(`${JSON.stringify({ artifact, passed: evidence.scenarios.filter((row) => row.passed).length, total: evidence.scenarios.length, failure: evidence.failure })}\n`);
  if (evidence.failure || evidence.scenarios.some((row) => !row.passed)) process.exitCode = 1;
}
