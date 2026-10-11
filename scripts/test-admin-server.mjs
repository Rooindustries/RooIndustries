import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { localOrigin, refuseEnvFiles, validateDistDir } from "./lib/test-target-safety.mjs";

refuseEnvFiles();
const root = process.cwd();
const baseURL = localOrigin(process.env.BASE_URL);
const target = new URL(baseURL);
const dist = validateDistDir(process.env.NEXT_DIST_DIR, { isolated: true });
const port = Number(target.port);
if (port !== Number(process.env.PW_PORT) || target.hostname !== process.env.ROO_TEST_HOST || port > 65528) throw new Error("Invalid admin fixture target.");
const controlOrigin = `http://127.0.0.1:${port + 6}`;
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) specifier = pathToFileURL(path.join(root, specifier.slice(2))).href;
  try { return next(specifier, context); } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" && (specifier.startsWith(".") || specifier.startsWith("file:")) && !path.extname(specifier)) return next(`${specifier}.js`, context);
    throw error;
  }
}});
process.env.ROO_TEST_HOST = "127.0.0.1";
const { start } = await import("./lib/storage-fixture.mjs");
const fixture = await start({
  fullMigrationChain: true,
  ports: { storage: port + 1, gateway: port + 2, postgres: port + 3, postgrest: port + 4, proxy: port + 5 },
  additionalOrigins: [baseURL, controlOrigin],
  ...(process.env.STORAGE_SOURCE ? { storageSource: process.env.STORAGE_SOURCE } : {}),
  ...(process.env.PG_BIN ? { pgBin: process.env.PG_BIN } : {}),
  ...(process.env.POSTGREST_BIN ? { postgrestBin: process.env.POSTGREST_BIN } : {}),
  ...(process.env.LD_LIBRARY_PATH ? { libraryPath: process.env.LD_LIBRARY_PATH } : {}),
});
let active, control;
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  if (active && active.exitCode === null && active.signalCode === null) {
    const child = active;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
  if (control) { control.closeAllConnections(); await new Promise(resolve => control.close(resolve)); }
  const cleanup = await fixture.stop();
  fs.mkdirSync("test-results/admin", { recursive: true });
  fs.writeFileSync("test-results/admin/cleanup.json", JSON.stringify(cleanup, null, 2));
};
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void stop().then(() => process.exit(0)); });
try {
  const { seedContentAdmin } = await import("./lib/content-admin-fixture.mjs");
  await seedContentAdmin(fixture);
  const { CONTENT_TYPES, createContentDefaults } = await import("../src/lib/cms/contentSchema.js");
  const { createToolingContentFixture } = await import("../tests/fixtures/tooling-content.mjs");
  const seed = await createToolingContentFixture({ origin: controlOrigin });
  let documents;
  try {
    const response = await fetch(`${controlOrigin}/rest/v1/rpc/roo_fetch_shadow_documents_targeted`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ p_document_types: CONTENT_TYPES.map(type => type.name), p_filters: [], p_limit: 1000, p_ids: null }),
    });
    if (!response.ok) throw new Error("Content fixture seed failed.");
    documents = await response.json();
  } finally { await seed.close(); }
  for (const document of documents) {
    delete document._rev;
    if (document._type === "package") document.order += 1;
    // Native publishing validates hour codes rather than display labels.
    if (document._type === "bookingSettings") document.dateSlots[0].times = ["10", "11"];
  }
  const used = new Set(documents.map(document => document._type));
  for (const type of CONTENT_TYPES) {
    if (used.has(type.name)) continue;
    const document = { _id: type.fixedId || `fixture-${type.name}`, _type: type.name, ...createContentDefaults(type.name) };
    for (const field of type.fields) {
      if (!field.required || document[field.name] != null) continue;
      if (["string", "text"].includes(field.type)) document[field.name] = `Synthetic ${field.title}`;
      if (field.type === "url") document[field.name] = "https://example.invalid/local-test";
      if (field.type === "reference") document[field.name] = { _type: "reference", _ref: "tooling-package-0" };
      if (field.type === "slug") document[field.name] = { _type: "slug", current: "fixture-upgrade" };
    }
    documents.push(document);
  }
  for (const document of documents) {
    const result = await fixture.client.rpc("roo_apply_document_mutations", { p_mutations: [{ operation: "create", id: document._id, document }] });
    if (result.error) throw new Error(`Seed ${document._type}: ${result.error.message}`);
  }
  for (let index = 0; index < 55; index += 1) {
    const email = `creator${index}@example.invalid`;
    const legacyId = `fixture-referral-${String(index).padStart(2, "0")}`;
    const referral = { _id: legacyId, _type: "referral", email, name: `Synthetic Creator ${index}`, slug: { _type: "slug", current: `fixture${String(index).padStart(2, "0")}` }, currentCommissionPercent: 10, currentDiscountPercent: 5, maxCommissionPercent: 15, successfulReferrals: index, bypassUnlock: false, verified: true, registrationStatus: "active" };
    const created = await fixture.client.rpc("roo_apply_document_mutations", { p_mutations: [{ operation: "create", id: legacyId, document: referral }] });
    if (created.error) throw new Error(`Referral seed: ${created.error.message}`);
    const [source] = await fixture.sql`select source_revision,source_hash from migration.source_documents where legacy_sanity_id=${legacyId} and document_type='referral'`;
    const [user] = await fixture.sql`insert into auth.users(id,email,email_confirmed_at) values(gen_random_uuid(),${email},now()) returning id`;
    const result = await fixture.client.rpc("roo_upsert_native_creator_account", { p_account: {
      user_id: user.id, primary_email: email, display_name: referral.name, referral_code: referral.slug.current, registration_status: "active", legacy_sanity_id: legacyId, source_revision: source.source_revision, source_hash: source.source_hash,
    } });
    if (result.error) throw new Error(`Creator seed: ${result.error.message}`);
    await fixture.sql`update accounts.creator_profiles set commission_basis_points=1000,discount_basis_points=500,total_basis_points=1500,successful_referrals=${index} where user_id=${user.id}`;
  }
  const marker = { version: 1, isolated: true, baseURL, origins: [baseURL, fixture.origin], versions: fixture.versions };
  control = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/fixture") {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(marker)); return;
    }
    if (request.method === "GET" && request.url === "/content-counts") {
      const [counts] = await fixture.sql`select
        (select count(*)::int from cms.documents) as documents,
        (select count(*)::int from migration.source_documents) as "sourceDocuments",
        (select count(*)::int from migration.cms_publish_commands) as receipts`;
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(counts)); return;
    }
    if (request.method === "POST" && request.url.startsWith("/create-receipt-processing/")) {
      const documentId = request.url.slice("/create-receipt-processing/".length);
      const updated = await fixture.sql`update migration.cms_publish_commands set status='processing',result=null,committed_at=null
        where operation='create' and status='committed' and result->'document_ids' ? ${documentId} returning command_id`;
      response.writeHead(updated.length === 1 ? 200 : 500); response.end(String(updated.length)); return;
    }
    if (request.method === "POST" && ["/booking-create-fixture/empty", "/booking-create-fixture/legacy"].includes(request.url)) {
      const ids = ["6d8a3646-0ed2-44b5-ad45-c5c9d578126a", "fixture-bookingSettings-legacy"];
      await fixture.sql.begin(async sql => {
        await sql`delete from migration.cms_publish_commands where result->'document_ids' ?| ${ids}::text[]`;
        await sql`delete from commerce.booking_settings where legacy_sanity_id=any(${ids}::text[])`;
        await sql`delete from cms.documents where legacy_sanity_id=any(${ids}::text[])`;
        await sql`delete from migration.source_documents where legacy_sanity_id=any(${ids}::text[])`;
      });
      if (request.url.endsWith("/legacy")) {
        const document = { _id: ids[1], _type: "bookingSettings", maxDaysAheadBooking: 7 };
        const result = await fixture.client.rpc("roo_apply_document_mutations", { p_mutations: [{ operation: "create", id: document._id, document }] });
        if (result.error) { response.writeHead(500); response.end("Booking fixture preparation failed."); return; }
      }
      response.writeHead(200); response.end("ok"); return;
    }
    if (request.method === "POST" && request.url === "/reset-content") {
      const current = await fixture.sql`select legacy_sanity_id from migration.source_documents where document_type=any(${CONTENT_TYPES.map(type => type.name)}::text[]) and not tombstoned`;
      const currentIds = new Set(current.map(document => document.legacy_sanity_id));
      const baselineIds = new Set(documents.map(document => document._id));
      for (const document of current) {
        if (baselineIds.has(document.legacy_sanity_id)) continue;
        const result = await fixture.client.rpc("roo_apply_document_mutations", { p_mutations: [{ operation: "delete", id: document.legacy_sanity_id }] });
        if (result.error) { response.writeHead(500); response.end("Fixture reset failed."); return; }
      }
      for (const document of documents) {
        const result = await fixture.client.rpc("roo_apply_document_mutations", { p_mutations: [{ operation: currentIds.has(document._id) ? "replace" : "create", id: document._id, document }] });
        if (result.error) { response.writeHead(500); response.end("Fixture reset failed."); return; }
      }
      response.writeHead(200); response.end("ok"); return;
    }
    if (request.method === "POST" && request.url === "/reset-rate-limits") {
      await fixture.sql`update commerce.rate_limit_buckets set count=0`;
      response.writeHead(200); response.end("ok"); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve, reject) => { control.once("error", reject); control.listen(port + 6, "127.0.0.1", resolve); });
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, CI: "true", TZ: "UTC", TOURNEY_DATABASE_MODE: "memory",
    DATA_PRIMARY_BACKEND: "supabase", COMMERCE_PRIMARY_BACKEND: "supabase", COMMERCE_FAILOVER_GENERATION: "0", SUPABASE_CUTOVER_ENABLED: "1", COMMERCE_CUTOVER_ENABLED: "1",
    SUPABASE_URL: fixture.origin, NEXT_PUBLIC_SUPABASE_URL: fixture.origin, NEXT_PUBLIC_SUPABASE_ASSET_URL: fixture.origin,
    SUPABASE_SECRET_KEY: fixture.serviceRoleKey, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: fixture.anonKey, NEXT_PUBLIC_SUPABASE_ANON_KEY: fixture.anonKey,
    REF_ADMIN_KEY: "synthetic-admin-key", REF_SESSION_SECRET: "synthetic-content-session-secret", RATE_LIMIT_HASH_SECRET: "synthetic-admin-rate-secret", CMS_WRITES_PAUSED: "0",
    ALLOW_LIVE_PAYMENTS: "0", SALES_PREVIEW_READ_ONLY: "0", NEXT_TELEMETRY_DISABLED: "1", BASE_URL: baseURL, ROO_TEST_HOST: target.hostname, NEXT_DIST_DIR: dist, TOOLING_NETWORK_GUARD: "1",
    NODE_OPTIONS: `--import=${path.join(root, "scripts/lib/test-target-safety.mjs")}`,
    ROO_TEST_NETWORK_ORIGINS: JSON.stringify([baseURL, fixture.origin, fixture.storageUrl, fixture.postgrestUrl, controlOrigin]),
  };
  const execute = args => new Promise((resolve, reject) => {
    active = spawn(process.execPath, args, { env, stdio: "inherit" });
    active.once("error", reject);
    active.once("exit", (code, signal) => code === 0 || stopped ? resolve() : reject(new Error(`Admin fixture server exited ${signal || code}.`)));
  });
  const next = path.join(root, "node_modules/next/dist/bin/next");
  console.log(`Guarded native CMS fixture: ${baseURL}`);
  if (process.env.ROO_TEST_DEV === "1") await execute([next, "dev", "--hostname", target.hostname, "--port", target.port]);
  else {
    await execute(["scripts/validate-runtime-env.js"]);
    await execute([next, "build"]);
    await execute([next, "start", "--hostname", target.hostname, "--port", target.port]);
  }
} finally { await stop(); }
