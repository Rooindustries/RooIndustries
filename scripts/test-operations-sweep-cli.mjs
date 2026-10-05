const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = process.argv.find((arg) => arg.startsWith("--stage="))?.split("=")[1] || "final";
const only = process.argv.find((arg) => arg.startsWith("--only="))?.split("=")[1];
const baseline = process.argv.includes("--baseline");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "roo-operations-cli-"));
await fs.chmod(temp, 0o700);
if (baseline) {
  await fs.mkdir(path.join(temp, "scripts"));
  for (const name of ["src", "node_modules"]) await fs.symlink(path.join(root, name), path.join(temp, name));
  await fs.symlink(path.join(root, "scripts/lib"), path.join(temp, "scripts/lib"));
  await fs.symlink(path.join(root, "scripts/download-blob-integrity.cjs"), path.join(temp, "scripts/download-blob-integrity.cjs"));
}
const results = [];
let current = {};
const server = http.createServer(async (req, res) => {
  let text = "";
  for await (const bytes of req) text += bytes;
  const url = new URL(req.url, "http://fixture.invalid");
  let body = null;
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = { syntheticBinaryBytes: Buffer.byteLength(text) }; }
  }
  const entry = { host: req.headers["x-operations-fixture-target"], method: req.method, path: url.pathname,
    token: req.headers.authorization === "Bearer fixture-targetb" ? "B" : req.headers.authorization === "Bearer fixture-targeta" ? "A" : "other", body,
    blobOperation: req.headers["x-mpu-action"] || null, blobApiVersion: req.headers["x-api-version"] || null, query: url.search };
  current.requests.push(entry);
  let data = [];
  if (url.pathname.includes("/data/query/")) {
    const query = url.searchParams.get("query") || entry.body?.query || "";
    if (query.includes("count(")) data = 0;
    else if (current.paymentRepair) data = [{ _id: "fixture-booking", _type: "booking", _rev: "r2", status: "canceled", startTimeUTC: "2020-01-01T00:00:00.000Z" }];
    else if (current.hash) {
      data = [{ _id: "fixture-referral", _type: "referral", _rev: "r1", resetToken: "fixture-token-A" }];
      current.stored = { resetToken: "fixture-token-B", revision: "r2" };
    } else if (current.faq) {
      data = [{ _id: "faq", _type: "faqSection", _rev: "r1", questions: [{ _key: "fixture", question: "Synthetic", answer: [] }] }];
      if (current.faqConcurrent) {
        data.push({ _id: "faq-source", _type: "faqSection", _rev: "r1", questions: [{ _key: "source", question: "Synthetic source", answer: [] }] });
        current.sections = { faq: "r1", "faq-source": "r2" };
      }
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ result: data }));
    return;
  }
  if (url.pathname.includes("/data/mutate/")) {
    current.mutations.push(entry.body);
    if (current.faqConcurrent && entry.body?.mutations?.some((mutation) => mutation.patch?.ifRevisionID && mutation.patch.ifRevisionID !== current.sections[mutation.patch.id])) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "mutationError", description: "fixture-private-diagnostic-do-not-print" } }));
      return;
    }
    const patch = entry.body?.mutations?.[0]?.patch;
    if (current.hash && patch?.ifRevisionID && patch.ifRevisionID !== current.stored.revision) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "mutationError", description: "Fixture revision changed" } }));
      return;
    }
    if (current.hash && patch) {
      current.stored.resetTokenHash = patch.set.resetTokenHash;
      delete current.stored.resetToken;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ transactionId: "fixture", results: [{ id: "fixture-referral", operation: "update" }] }));
    return;
  }
  const rpc = url.pathname.split("/").at(-1);
  if (rpc === "fixture-reconcile") data = { ok: true, summary: { scanned: 0 } };
  else if (rpc === "roo_commerce_control") data = { primary_backend: "supabase", generation: 7, starts_paused: true };
  else if (rpc === "roo_start_sync_run") data = "a0000000-0000-4000-8000-000000000001";
  else if (rpc.includes("summary")) data = {
    source_documents: 0, cms_documents: 0, auth_users: 0, profiles: 0, creator_profiles: 0,
    tourney_accounts: 0, tourney_shadow_players: 0, tourney_player_accounts: 0,
    source_operational_documents: 0, operational_imported: 0, bookings: 0,
    payment_records: 0, payment_proof_claims: 0, coupons: 0, assets: 0, document_asset_links: 0,
  };
  else if (rpc === "roo_commerce_readiness") data = {};
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
});
await new Promise((resolve) => server.listen(0, testHost, resolve));
const origin = `http://${testHost}:${server.address().port}`;
const envFor = (target) => ({
  SANITY_PROJECT_ID: `target${target}`, SANITY_PRIVATE_PROJECT_ID: `target${target}`,
  SANITY_DATASET: `fixture${target}`, SANITY_PRIVATE_DATASET: `fixture${target}`,
  SANITY_WRITE_TOKEN: `fixture-target${target}`, SANITY_PRIVATE_WRITE_TOKEN: `fixture-target${target}`,
  SANITY_READ_TOKEN: `fixture-target${target}`, SUPABASE_URL: `https://target${target}.supabase.co`,
  SUPABASE_SECRET_KEY: `fixture-target${target}`, DATA_PRIMARY_BACKEND: "sanity", COMMERCE_PRIMARY_BACKEND: "sanity",
});
const envText = (env) => Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n");
const envPath = path.join(temp, "selected-B.env");
await fs.writeFile(envPath, envText(envFor("b")), { mode: 0o600 });
await fs.writeFile(path.join(temp, ".env.local"), envText(envFor("a")), { mode: 0o600 });
const trace = path.join(temp, "trace.jsonl");
const manifest = path.join(temp, "fixture.json");
await fs.writeFile(manifest, JSON.stringify({ origin, trace }));
const zipPath = path.join(temp, "fixture.zip");
await new Promise((resolve, reject) => {
  const child = spawn("python3", ["-c", "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as archive: archive.writestr('synthetic.txt', 'fixture bytes')", zipPath], { env: { PATH: process.env.PATH }, stdio: "ignore" });
  child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error("Synthetic ZIP creation failed")));
});
const execute = (script, args, ambient = "a") => new Promise((resolve, reject) => {
  let entry = path.join(root, "scripts", script);
  if (baseline) {
    const source = spawnSync("git", ["show", `HEAD:scripts/${script}`], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(source.status, 0);
    entry = path.join(temp, "scripts", script);
    fsSync.writeFileSync(entry, source.stdout);
  }
  const inherited = envFor(ambient === "missing-dataset" ? "b" : ambient);
  if (ambient === "missing-dataset") { delete inherited.SANITY_DATASET; delete inherited.SANITY_PRIVATE_DATASET; }
  const child = spawn(process.execPath, ["--import", path.join(root, "scripts/test-operations-sweep-network.mjs"), entry, ...args], {
    cwd: temp, env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "test", ROO_TEST_HOST: testHost, OPERATIONS_TEST_MANIFEST: manifest,
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_fixture_AAAAAAAAAAAAAAAA", VERCEL_BLOB_API_URL: "https://targeta.supabase.co", VERCEL_BLOB_RETRIES: "0",
      DOWNLOAD_CATALOG_JSON: '[{"slug":"fixture","fileName":"fixture.zip","blobPath":"downloads/fixture.zip"}]', ...inherited },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (bytes) => { stdout += bytes; });
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  child.on("error", reject);
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  timer.unref();
  child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});
const check = async (name, callback) => {
  if (only && !only.split(",").includes(name)) return;
  current = { requests: [], mutations: [] };
  await fs.writeFile(trace, "");
  let error = "", ok = false;
  try { await callback(); ok = true; }
  catch (cause) { error = `${cause.name}: ${cause.message}`; }
  const attempts = (await fs.readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  results.push({ name, ok, ...current, attempts, ...(error ? { error } : {}) });
};
try {
  for (const [script, args] of [
    ["backfill-referral-identities.mjs", []], ["check-payment-booking-integrity.mjs", []],
    ["migrate-payment-booking-repair.mjs", []], ["migrate-sanity-to-supabase.mjs", []],
    ["sync-sanity-commerce-to-supabase.mjs", []], ["repair-supabase-commerce-integrity.mjs", ["--expected-generation", "7"]],
  ]) {
    await check(`env-binding:${script}`, async () => {
      current.cli = await execute(script, ["--env", envPath, ...args]);
      assert.equal(current.cli.code, 0);
      assert(current.requests.length > 0);
      assert(current.requests.every((row) => row.host.startsWith("targetb.") && row.token === "B"));
      assert.equal(current.mutations.length, 0);
    });
    await check(`missing-env:${script}`, async () => {
      current.cli = await execute(script, args);
      assert.notEqual(current.cli.code, 0);
      assert.match(current.cli.stderr, /--env must name the exact private operator environment file/);
      assert.equal(current.requests.length, 0);
    });
    await check(`missing-selected-dataset:${script}`, async () => {
      const incomplete = path.join(temp, "missing-dataset.env");
      const text = (await fs.readFile(envPath, "utf8")).replace(/^(?:SANITY_DATASET|SANITY_PRIVATE_DATASET)=.*(?:\n|$)/gm, "");
      await fs.writeFile(incomplete, text, { mode: 0o600 });
      await fs.writeFile(path.join(temp, ".env.local"), text, { mode: 0o600 });
      current.cli = await execute(script, ["--env", incomplete, ...args], "missing-dataset");
      await fs.writeFile(path.join(temp, ".env.local"), envText(envFor("a")), { mode: 0o600 });
      assert.notEqual(current.cli.code, 0);
      assert.match(current.cli.stderr, /name its dataset explicitly/);
      assert.equal(current.requests.length, 0);
    });
    await check(`missing-selected-dataset-with-ambient-a:${script}`, async () => {
      const incomplete = path.join(temp, "missing-dataset-selected-b.env");
      const text = (await fs.readFile(envPath, "utf8")).replace(/^(?:SANITY_DATASET|SANITY_PRIVATE_DATASET)=.*(?:\n|$)/gm, "");
      await fs.writeFile(incomplete, text, { mode: 0o600 });
      current.cli = await execute(script, ["--env", incomplete, ...args]);
      assert.notEqual(current.cli.code, 0);
      assert.match(current.cli.stderr, /name its dataset explicitly/);
      assert.equal(current.requests.length, 0);
      assert.equal(current.mutations.length, 0);
    });
  }
  for (const script of ["migrate-sanity-to-supabase.mjs", "sync-sanity-commerce-to-supabase.mjs"]) {
    await check(`read-only:${script}`, async () => {
      current.cli = await execute(script, ["--env", envPath, "--verify-only", "--skip-assets"]);
      assert.equal(current.cli.code, 0);
      current.mutatingRpcs = current.requests.filter((row) => /roo_(start_sync_run|finish_sync_run|record_drift_findings|resolve_verified_drift_findings)$/.test(row.path));
      assert.equal(current.mutatingRpcs.length, 0);
    });
  }
  await check("backfill-private-dataset-selection", async () => {
    const selected = path.join(temp, "private-dataset-only.env");
    await fs.writeFile(selected, (await fs.readFile(envPath, "utf8")).replace(/^SANITY_DATASET=.*(?:\n|$)/m, ""), { mode: 0o600 });
    current.cli = await execute("backfill-referral-identities.mjs", ["--env", selected]);
    assert.equal(current.cli.code, 0);
    assert(current.requests.length > 0);
    assert(current.requests.every((row) => row.path.endsWith("/data/query/fixtureb")));
  });
  for (const changed of [true, false]) {
    await check(`payment-repair-confirmed-preimage:${changed ? "changed" : "unchanged"}`, async () => {
      current.paymentRepair = true;
      const documents = [{ _id: "fixture-booking", _type: "booking", _rev: changed ? "r1" : "r2", status: changed ? "pending" : "canceled", startTimeUTC: "2020-01-01T00:00:00.000Z" }];
      const confirmed = path.join(temp, "confirmed-snapshot.json");
      await fs.writeFile(confirmed, JSON.stringify({ generatedAt: new Date().toISOString(), projectId: "targetb", dataset: "fixtureb",
        documentCount: documents.length, documentDigest: crypto.createHash("sha256").update(JSON.stringify(documents)).digest("hex"), documents }), { mode: 0o600 });
      const selected = path.join(temp, "payment-repair.env");
      await fs.writeFile(selected, `${await fs.readFile(envPath, "utf8")}\nCRON_SECRET=fixture-only-cron-secret\n`, { mode: 0o600 });
      current.cli = await execute("migrate-payment-booking-repair.mjs", ["--env", selected, "--apply", "--inspect-providers", "--confirmed-snapshot", confirmed, "--reconcile-url", "https://targetb.supabase.co/fixture-reconcile"]);
      if (changed) {
        assert.notEqual(current.cli.code, 0);
        assert.equal(current.mutations.length, 0);
        assert(!current.requests.some((row) => row.path === "/fixture-reconcile"));
      } else {
        assert(current.mutations.length > 0);
        assert(current.requests.some((row) => row.path === "/fixture-reconcile"));
      }
    });
  }
  await check("reset-hash-default-read-only", async () => {
    current.hash = true;
    current.cli = await execute("migrate-ref-reset-token-hashes.js", ["--env", envPath], "b");
    assert.equal(current.mutations.length, 0);
    assert.equal(current.stored.resetToken, "fixture-token-B");
  });
  await check("reset-hash-concurrent-new-token", async () => {
    current.hash = true;
    current.cli = await execute("migrate-ref-reset-token-hashes.js", ["--env", envPath, "--apply"], "b");
    assert.equal(current.stored.resetToken, "fixture-token-B");
    assert.equal(current.stored.resetTokenHash, undefined);
    assert.equal(current.mutations[0]?.mutations[0]?.patch?.ifRevisionID, "r1");
    assert.notEqual(current.cli.code, 0);
  });
  await check("faq-default-read-only-target", async () => {
    current.faq = true;
    current.cli = await execute("merge-faq-sections.js", ["--env", envPath], "b");
    assert.equal(current.cli.code, 0);
    assert(current.requests.length > 0);
    assert(current.requests.every((row) => row.host === "targetb.api.sanity.io"));
    assert.equal(current.mutations.length, 0);
  });
  await check("faq-stale-source-keeps-sections-and-private-error", async () => {
    current.faq = true;
    current.faqConcurrent = true;
    current.cli = await execute("merge-faq-sections.js", ["--env", envPath, "--apply", "--delete-old"], "b");
    assert.notEqual(current.cli.code, 0);
    assert.deepEqual(current.sections, { faq: "r1", "faq-source": "r2" });
    assert.equal(current.mutations.length, 1);
    assert.deepEqual(current.mutations[0].mutations.map((mutation) => mutation.patch?.ifRevisionID || mutation.delete?.id), ["r1", "r1", "faq-source"]);
    assert(!current.cli.stderr.includes("fixture-private-diagnostic-do-not-print"));
  });
  await check("blob-default-read-only", async () => {
    current.cli = await execute("upload-download-blob.mjs", ["fixture", zipPath]);
    assert.equal(current.cli.code, 0);
    assert.equal(current.requests.length, 0);
    assert.equal(JSON.parse(current.cli.stdout).mode, "dry-run");
  });
  await check("supabase-upload-missing-env", async () => {
    current.cli = await execute("upload-download-supabase.mjs", ["fixture", zipPath, "--apply"]);
    assert.notEqual(current.cli.code, 0);
    assert.match(current.cli.stderr, /--env must name the exact private operator environment file/);
    assert.equal(current.requests.length, 0);
  });
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
await fs.mkdir(path.join(root, "test-results"), { recursive: true });
const artifact = path.join(root, "test-results", `operations-cli-${stage}.json`);
await fs.writeFile(artifact, JSON.stringify({ stage, results }, null, 2));
process.stdout.write(`${JSON.stringify({ artifact, passed: results.filter((row) => row.ok).length, total: results.length })}\n`);
if (results.some((row) => !row.ok)) process.exitCode = 1;
