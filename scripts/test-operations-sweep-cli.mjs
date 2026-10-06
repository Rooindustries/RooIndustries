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
  if (url.pathname.endsWith("/roo_fetch_shadow_documents_targeted")) {
    const query = "";
    if (query.includes("count(")) data = 0;
    if (current.boundedInventory) data = Array.from({length:500},(_,i)=>({_id:`bound.${i}`,_type:"booking",status:"pending"}));
    else if (current.paymentRepair) data = [current.booking || { _id: "fixture-booking", _type: "booking", _rev: "r2", status: "canceled", startTimeUTC: "2020-01-01T00:00:00.000Z" }];
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
    res.end(JSON.stringify(data));
    return;
  }
  if (/\/roo_apply_(?:commerce_)?document_mutations$/.test(url.pathname)) {
    current.mutations.push(entry.body);const mutations=entry.body.p_mutations||[];
    if(current.faqConcurrent&&mutations.some(m=>m.expected_revision&&m.expected_revision!==current.sections[m.id])) {res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'40001',message:'fixture-private-diagnostic-do-not-print'}));return;}
    const patch=mutations.find(m=>['patch','replace'].includes(m.operation));
    if(current.hash&&patch?.expected_revision&&patch.expected_revision!==current.stored.revision){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'40001',message:'Fixture revision changed'}));return;}
    if(current.hash&&patch){current.stored.resetTokenHash=patch.set?.resetTokenHash||patch.document?.resetTokenHash;delete current.stored.resetToken;}
    if(current.paymentRepair&&patch?.document?._type==='booking')current.booking=patch.document;
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(mutations.map(m=>({_id:m.id||m.document?._id,_type:m.document?._type||'referral',_rev:'native-result-r2'}))));return;
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
const envFor = target => ({SUPABASE_URL:`https://target${target}.supabase.co`,SUPABASE_SECRET_KEY:`fixture-target${target}`,DATA_PRIMARY_BACKEND:'supabase',COMMERCE_PRIMARY_BACKEND:'supabase',COMMERCE_FAILOVER_GENERATION:'7',SUPABASE_CUTOVER_ENABLED:'1',COMMERCE_CUTOVER_ENABLED:'1'});
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
  const inherited = envFor(ambient === "missing-supabase-url" ? "b" : ambient);
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
    ["check-payment-booking-integrity.mjs", []],
    ["migrate-payment-booking-repair.mjs", []], ["repair-supabase-commerce-integrity.mjs", ["--expected-generation", "7"]],
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
    await check(`missing-selected-supabase-url:${script}`, async () => {
      const incomplete = path.join(temp, "missing-supabase-url.env");
      const text = (await fs.readFile(envPath, "utf8")).replace(/^(?:SUPABASE_URL|NEXT_PUBLIC_SUPABASE_URL)=.*(?:\n|$)/gm, "");
      await fs.writeFile(incomplete, text, { mode: 0o600 });
      await fs.writeFile(path.join(temp, ".env.local"), text, { mode: 0o600 });
      current.cli = await execute(script, ["--env", incomplete, ...args], "missing-supabase-url");
      await fs.writeFile(path.join(temp, ".env.local"), envText(envFor("a")), { mode: 0o600 });
      assert.notEqual(current.cli.code, 0);
      assert.match(current.cli.stderr, /Supabase URL|Supabase.*required/i);
      assert.equal(current.requests.length, 0);
    });
    await check(`missing-selected-supabase-url-with-ambient-a:${script}`, async () => {
      const incomplete = path.join(temp, "missing-supabase-url-selected-b.env");
      const text = (await fs.readFile(envPath, "utf8")).replace(/^(?:SUPABASE_URL|NEXT_PUBLIC_SUPABASE_URL)=.*(?:\n|$)/gm, "");
      await fs.writeFile(incomplete, text, { mode: 0o600 });
      current.cli = await execute(script, ["--env", incomplete, ...args]);
      assert.notEqual(current.cli.code, 0);
      assert.match(current.cli.stderr, /Supabase URL|Supabase.*required/i);
      assert.equal(current.requests.length, 0);
      assert.equal(current.mutations.length, 0);
    });
  }
  for (const changed of [true, false]) {
    await check(`payment-repair-confirmed-preimage:${changed ? "changed" : "unchanged"}`, async () => {
      current.paymentRepair = true;
      const documents = [{ _id: "fixture-booking", _type: "booking", _rev: changed ? "r1" : "r2", status: changed ? "pending" : "canceled", startTimeUTC: "2020-01-01T00:00:00.000Z" }];
      const confirmed = path.join(temp, "confirmed-snapshot.json");
      await fs.writeFile(confirmed, JSON.stringify({ generatedAt: new Date().toISOString(), backend: "supabase", supabaseOrigin: "https://targetb.supabase.co",
        documentCount: documents.length, documentDigest: crypto.createHash("sha256").update(JSON.stringify(documents)).digest("hex"), documents }), { mode: 0o600 });
      const selected = path.join(temp, "payment-repair.env");
      await fs.writeFile(selected, `${await fs.readFile(envPath, "utf8")}\nCRON_SECRET=fixture-only-cron-secret\n`, { mode: 0o600 });
      current.cli = await execute("migrate-payment-booking-repair.mjs", ["--env", selected, "--apply", "--inspect-providers", "--confirmed-snapshot", confirmed, "--reconcile-url", "https://targetb.supabase.co/fixture-reconcile"]);
      if (changed) {
        assert.notEqual(current.cli.code, 0);
        assert.equal(current.mutations.length, 0);
        assert(!current.requests.some((row) => row.path === "/fixture-reconcile"));
      } else {
        assert.equal(current.cli.code,0,current.cli.stderr);
        assert(current.requests.some((row) => row.path === "/fixture-reconcile"));
      }
    });
  }
  await check("native-repair-refuses-truncated-500-row-inventory", async () => {
    current.boundedInventory=true;
    current.cli=await execute("migrate-payment-booking-repair.mjs",["--env",envPath,"--apply"]);
    assert.notEqual(current.cli.code,0);assert.match(current.cli.stderr,/bounded document scan|payload budget/);assert.equal(current.mutations.length,0);
  });
  await check("native-integrity-refuses-truncated-500-row-inventory", async () => {
    current.boundedInventory=true;
    current.cli=await execute("check-payment-booking-integrity.mjs",["--env",envPath]);
    assert.notEqual(current.cli.code,0);assert.match(current.cli.stderr,/bounded document scan|payload budget/);assert.equal(current.mutations.length,0);
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
