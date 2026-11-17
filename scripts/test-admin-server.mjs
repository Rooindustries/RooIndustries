import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { localOrigin, refuseEnvFiles, validateDistDir } from "./lib/test-target-safety.mjs";
import { listenOnPort, nextTestKeepAliveTimeout, portFromEnv, releaseTcpPorts, reserveTcpPorts } from "./lib/free-tcp-port.mjs";
import fixturePorts from "../tests/fixtures/fixture-ports.cjs";
import { lockBuildDirectory } from "./lib/build-lock.mjs";
import { withNodeOption } from "./lib/node-options.mjs";
import { snapshotDatabase } from "./lib/admin-test-isolation.mjs";

refuseEnvFiles();
const root = process.cwd();
const baseURL = localOrigin(process.env.BASE_URL);
const target = new URL(baseURL);
const dist = validateDistDir(process.env.NEXT_DIST_DIR, { isolated: true });
const lock = lockBuildDirectory(dist);
const port = Number(target.port);
if (port !== Number(process.env.PW_PORT) || target.hostname !== process.env.ROO_TEST_HOST) throw new Error("Invalid admin fixture target.");
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) specifier = pathToFileURL(path.join(root, specifier.slice(2))).href;
  try { return next(specifier, context); } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" && (specifier.startsWith(".") || specifier.startsWith("file:")) && !path.extname(specifier)) return next(`${specifier}.js`, context);
    throw error;
  }
}});
await reserveTcpPorts(target.hostname, [port]);
const control = http.createServer();
await listenOnPort(control, "127.0.0.1", portFromEnv("TOOLING_ADMIN_CONTROL_PORT"));
const controlPort = control.address().port;
const controlOrigin = `http://127.0.0.1:${controlPort}`;
process.env.ROO_TEST_HOST = "127.0.0.1";
const { start } = await import("./lib/storage-fixture.mjs");
const fixture = await start({
  fullMigrationChain: true,
  additionalOrigins: [baseURL, controlOrigin],
  ...(process.env.STORAGE_SOURCE ? { storageSource: process.env.STORAGE_SOURCE } : {}),
  ...(process.env.PG_BIN ? { pgBin: process.env.PG_BIN } : {}),
  ...(process.env.POSTGREST_BIN ? { postgrestBin: process.env.POSTGREST_BIN } : {}),
  ...(process.env.LD_LIBRARY_PATH ? { libraryPath: process.env.LD_LIBRARY_PATH } : {}),
});
let active, restoreEmailFetch, databaseSnapshot, resetIsolation;
const emails = [];
let notificationSequence = 0;
const IMAGE_BUCKET = "site-content-public";
const storeRules = new Map();
const storeCalls = [];
const storeHolds = [];
const closedStores = new Set();
const purges = [];
const pageRefusals = [];
const refreshEvents = [];
const refreshErrors = [];
const keptAlive = [];
const pageWrites = [];
const eventWaiters = new Set();
const notifyEvents = () => { for (const waiter of eventWaiters) waiter(); };
const waitForEvent = (response, ready) => {
  const finish = () => {
    const value = ready();
    if (!value) return;
    eventWaiters.delete(finish);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  finish.description = response.req.url;
  finish.cancel = () => {
    eventWaiters.delete(finish);
    if (!response.destroyed && !response.writableEnded) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end("{}");
    }
  };
  eventWaiters.add(finish);
  response.once("close", () => eventWaiters.delete(finish));
  finish();
};
const readJson = async request => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return JSON.parse(raw || "{}");
};
let stopped = false;
const stopActive = async () => {
  if (active && active.exitCode === null && active.signalCode === null) {
    const child = active;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
  active = null;
};
const stop = async () => {
  if (stopped) return;
  stopped = true;
  await stopActive();
  if (control.listening) { control.closeAllConnections(); await new Promise(resolve => control.close(resolve)); }
  restoreEmailFetch?.();
  databaseSnapshot?.release();
  const cleanup = await fixture.stop();
  fs.mkdirSync("test-results/admin", { recursive: true });
  fs.writeFileSync("test-results/admin/cleanup.json", JSON.stringify(cleanup, null, 2));
};
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void stop().then(() => process.exit(0)); });
try {
  const { seedContentAdmin } = await import("./lib/content-admin-fixture.mjs");
  const adminFixture = await seedContentAdmin(fixture);
  Object.assign(process.env, {
    DATA_PRIMARY_BACKEND: "supabase", COMMERCE_PRIMARY_BACKEND: "supabase", COMMERCE_FAILOVER_GENERATION: "0",
    SUPABASE_CUTOVER_ENABLED: "1", COMMERCE_CUTOVER_ENABLED: "1",
    SUPABASE_URL: fixture.origin, SUPABASE_SECRET_KEY: fixture.serviceRoleKey,
    RESEND_API_KEY: "synthetic-booking-email-key", FROM_EMAIL: "sender@fixture.invalid", OWNER_EMAIL: "fallback-owner@fixture.invalid",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    return originalFetch(url.origin === "https://api.resend.com" ? `${controlOrigin}${url.pathname}${url.search}` : input, init);
  };
  restoreEmailFetch = () => { globalThis.fetch = originalFetch; };
  const { CONTENT_TYPES, createContentDefaults } = await import("../src/lib/cms/contentSchema.js");
  const { createToolingContentFixture } = await import("../tests/fixtures/tooling-content.mjs");
  const seed = await createToolingContentFixture({ origin: controlOrigin, server: control });
  let documents;
  try {
    const response = await fetch(`${controlOrigin}/rest/v1/rpc/roo_fetch_shadow_documents_targeted`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ p_document_types: CONTENT_TYPES.map(type => type.name), p_filters: [], p_limit: 1000, p_ids: null }),
    });
    if (!response.ok) throw new Error("Content fixture seed failed.");
    documents = await response.json();
  } finally { await seed.close(); }
  const unusedFields = {
    hero: { tagline: "Legacy tagline café 日本語", ctaNoteIcon: "☀️", bullets: ["Legacy bullet café 日本語", ""] },
    packagesSettings: { heading: "Legacy packages heading" },
    faqSettings: { title: "Legacy FAQ heading" },
    services: { heading: "Legacy services heading" },
    supportedGames: { title: "Legacy games heading" },
    proReviewsCarousel: { title: "Legacy reviews heading" },
  };
  for (const document of documents) {
    delete document._rev;
    Object.assign(document, unusedFields[document._type]);
    if (document._type === "package") document.order += 1;
    // Native publishing validates hour codes rather than display labels.
    if (document._type === "bookingSettings") document.dateSlots[0].times = ["10", "11"];
  }
  documents.push({ _id: "fixture-faq-legacy", _type: "faqSection", questions: [{ _key: "legacy-question", question: "Legacy extra FAQ question", answer: "This extra document must stay untouched." }] });
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
  databaseSnapshot = await snapshotDatabase(fixture.sql);
  const marker = { version: 1, isolated: true, baseURL, origins: [baseURL, fixture.origin], versions: fixture.versions };
  const instance = fixturePorts.fixtureInstance();
  const handleControl = async (request, response) => {
    if (request.method === "POST" && request.url === "/reset-isolation") {
      try {
        const result = await resetIsolation();
        response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (request.method === "GET" && request.url === fixturePorts.INSTANCE_PATH) {
      response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); response.end(instance); return;
    }
    if (request.method === "GET" && request.url === "/fixture") {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(marker)); return;
    }
    if (request.method === "GET" && request.url === "/creator-terms-rpcs") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(fixture.requestLog.map(({ rpc }) => rpc).filter(Boolean))); return;
    }
    if (request.method === "POST" && request.url === "/emails") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      emails.push(JSON.parse(raw));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: `fixture-email-${emails.length}` })); return;
    }
    if (request.method === "POST" && request.url === "/owner-notification") {
      try {
        const { createSupabaseDocumentClient } = await import("../src/server/supabase/documentClient.js");
        const { sendBookingEmailsForBooking } = await import("../src/server/api/ref/bookingEmails.js");
        const client = createSupabaseDocumentClient({ shadowClient: fixture.client, commerceOnly: true, cutoverGeneration: 0 });
        const id = `fixture-owner-${randomUUID()}`;
        const startTimeUTC = new Date(Date.UTC(2099, 0, 5 + notificationSequence++, 10)).toISOString();
        await client.create({
          _id: id, _type: "booking", packageTitle: "Performance Vertex Max", packagePrice: "$99.95",
          email: "customer@fixture.invalid", displayDate: "January 5, 2099", displayTime: "10:00", localTimeZone: "UTC",
          hostDate: "January 5, 2099", hostTime: "15:30", hostTimeZone: "Asia/Kolkata", startTimeUTC,
          grossAmount: 99.95, netAmount: 99.95, currency: "USD", paymentStatus: "paid",
        });
        const start = emails.length;
        const result = await sendBookingEmailsForBooking({ bookingId: id, client });
        response.writeHead(result.httpStatus, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ result, emails: emails.slice(start) })); return;
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: error.message })); return;
      }
    }
    if (request.method === "POST" && ["/refresh-events", "/refresh-errors"].includes(request.url)) {
      (request.url === "/refresh-events" ? refreshEvents : refreshErrors).push(await readJson(request));
      notifyEvents();
      response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}"); return;
    }
    if (request.method === "GET" && (request.url.startsWith("/refresh-events?") || request.url.startsWith("/refresh-errors?"))) {
      const url = new URL(request.url, controlOrigin);
      const records = url.pathname === "/refresh-events" ? refreshEvents : refreshErrors;
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(records.filter(record => record.trace === url.searchParams.get("trace")))); return;
    }
    if (request.method === "POST" && request.url === "/page-refusals") {
      pageRefusals.push(await readJson(request));
      response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}"); return;
    }
    if (request.method === "GET" && request.url === "/page-refusals") {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(pageRefusals)); return;
    }
    if (request.method === "POST" && ["/purges", "/kept-alive"].includes(request.url)) {
      (request.url === "/purges" ? purges : keptAlive).push(await readJson(request));
      notifyEvents();
      response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}"); return;
    }
    if (request.method === "POST" && request.url === "/test-page-write") {
      pageWrites.push(await readJson(request));
      notifyEvents();
      response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}"); return;
    }
    if (request.method === "GET" && request.url === "/test-page-writes") {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(pageWrites)); return;
    }
    if (request.method === "GET" && request.url.startsWith("/await-test-event?")) {
      const query = new URL(request.url, controlOrigin).searchParams;
      const kind = query.get("kind");
      const trace = query.get("trace");
      const key = query.get("key");
      const count = Number(query.get("count"));
      const rpc = query.get("rpc");
      waitForEvent(response, () => {
        const events = kind === "refresh" ? refreshEvents.filter(event => event.trace === trace)
          : kind === "refresh-error" ? refreshErrors.filter(event => event.trace === trace)
            : kind === "purge" ? purges.filter(event => event.trace === trace && event.operation === "invalidateByTag" && event.target === "_N_T_/layout")
          : kind === "hold" ? storeHolds.filter(event => event.trace === trace && (!rpc || event.rpc === rpc))
            : pageWrites.filter(event => event.key === key);
        return events.length >= count ? { count: events.length } : null;
      });
      return;
    }
    if (request.method === "GET" && request.url === "/purges") {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(purges)); return;
    }
    if (request.method === "GET" && request.url.startsWith("/kept-alive?")) {
      const trace = new URL(request.url, controlOrigin).searchParams.get("trace");
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(keptAlive.filter(entry => entry.trace === trace).map(({ state }) => state))); return;
    }
    if (request.method === "POST" && request.url === "/store-rules") {
      const { trace, rules } = await readJson(request);
      if (rules.length) storeRules.set(trace, rules.map(rule => ({ ...rule, pattern: new RegExp(rule.rpc) })));
      else storeRules.delete(trace);
      response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}"); return;
    }
    if (request.method === "POST" && request.url === "/store-calls") {
      const call = await readJson(request);
      storeCalls.push(call);
      const rule = (storeRules.get(call.trace) || []).find(entry => entry.pattern.test(call.rpc) && (!entry.types || new RegExp(entry.types).test(call.types || "")) && entry.times !== 0);
      if (rule && rule.times > 0) rule.times -= 1;
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ action: rule?.action || "pass" })); return;
    }
    if (request.method === "POST" && request.url === "/store-holds") {
      const hold = await readJson(request);
      if (!closedStores.has(hold.trace)) await new Promise(resolve => { storeHolds.push({ ...hold, release: resolve }); notifyEvents(); });
      response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}"); return;
    }
    if (request.method === "GET" && request.url.startsWith("/store-holds?")) {
      const trace = new URL(request.url, controlOrigin).searchParams.get("trace");
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(storeHolds.filter(hold => hold.trace === trace).map(({ rpc }) => rpc))); return;
    }
    if (request.method === "POST" && ["/store-release", "/store-close"].includes(request.url)) {
      const { trace } = await readJson(request);
      if (request.url === "/store-close") { closedStores.add(trace); storeRules.delete(trace); }
      const released = storeHolds.filter(hold => hold.trace === trace);
      storeHolds.splice(0, storeHolds.length, ...storeHolds.filter(hold => hold.trace !== trace));
      for (const hold of released) hold.release();
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ released: released.length })); return;
    }
    if (request.method === "GET" && request.url.startsWith("/store-calls?")) {
      const trace = new URL(request.url, controlOrigin).searchParams.get("trace");
      const calls = storeCalls.filter(call => call.trace === trace);
      const details = new URL(request.url, controlOrigin).searchParams.has("details");
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(details ? calls : calls.map(({ rpc }) => rpc))); return;
    }
    if (request.method === "POST" && request.url === "/publish-elsewhere") {
      try {
        const { executeGlobalCmsCommand } = await import("../src/server/cms/publishCommand.js");
        const data = await executeGlobalCmsCommand({ body: await readJson(request), supabaseClient: fixture.client, env: { CMS_WRITES_PAUSED: "0" } });
        response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); return;
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: error.message })); return;
      }
    }
    if (request.method === "GET" && request.url === "/content-counts") {
      const [counts] = await fixture.sql`select
        (select count(*)::int from cms.documents) as documents,
        (select count(*)::int from migration.source_documents) as "sourceDocuments",
        (select count(*)::int from migration.cms_publish_commands) as receipts`;
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(counts)); return;
    }
    if (request.method === "POST" && request.url === "/cms-field-fixture") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const document = JSON.parse(raw);
      if (!CONTENT_TYPES.some(type => type.name === document._type) || typeof document._id !== "string") {
        response.writeHead(400); response.end("Invalid content fixture."); return;
      }
      const [existing] = await fixture.sql`select legacy_sanity_id from migration.source_documents where legacy_sanity_id=${document._id}`;
      const result = await fixture.client.rpc("roo_apply_document_mutations", { p_mutations: [{ operation: existing ? "replace" : "create", id: document._id, document }] });
      response.writeHead(result.error ? 500 : 200); response.end(result.error?.message || "ok"); return;
    }
    if (request.method === "POST" && request.url.startsWith("/create-receipt-processing/")) {
      const documentId = request.url.slice("/create-receipt-processing/".length);
      const updated = await fixture.sql`update migration.cms_publish_commands set status='processing',result=null,committed_at=null
        where operation='create' and status='committed' and result->'document_ids' ? ${documentId} returning command_id`;
      response.writeHead(updated.length === 1 ? 200 : 500); response.end(String(updated.length)); return;
    }
    if (request.method === "POST" && request.url === "/remove-content-document") {
      const { id } = await readJson(request);
      await fixture.sql.begin(async sql => {
        await sql`delete from cms.documents where legacy_sanity_id=${id}`;
        await sql`delete from migration.source_documents where legacy_sanity_id=${id}`;
      });
      response.writeHead(200); response.end("ok"); return;
    }
    if (request.method === "POST" && request.url === "/faq-create-fixture/legacy") {
      await fixture.sql.begin(async sql => {
        await sql`delete from migration.cms_publish_commands where result->'document_ids' ? 'faq'`;
        await sql`delete from cms.documents where legacy_sanity_id='faq'`;
        await sql`delete from migration.source_documents where legacy_sanity_id='faq'`;
      });
      response.writeHead(200); response.end("ok"); return;
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
      const mutations = [
        ...current.filter(document => !baselineIds.has(document.legacy_sanity_id)).map(document => ({ operation: "delete", id: document.legacy_sanity_id })),
        ...documents.map(document => ({ operation: currentIds.has(document._id) ? "replace" : "create", id: document._id, document })),
      ];
      for (let index = 0; index < mutations.length; index += 100) {
        const result = await fixture.client.rpc("roo_apply_document_mutations", { p_mutations: mutations.slice(index, index + 100) });
        if (result.error) { response.writeHead(500); response.end("Fixture reset failed."); return; }
      }
      const cleared = await fetch(`${baseURL}/api/admin/content/documents/tooling-hero`, { headers: { "x-admin-key": "synthetic-admin-key", "x-roo-test-clear-rounds": "1" } });
      if (!cleared.ok) { response.writeHead(500); response.end("Fixture timer reset failed."); return; }
      response.writeHead(200); response.end("ok"); return;
    }
    if (request.method === "POST" && request.url === "/storage-failures") {
      const { rules } = await readJson(request);
      fixture.storageFailures.splice(0, fixture.storageFailures.length, ...rules.map(({ method, path, hold }) => ({ method, path, hold: hold === true })));
      response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}"); return;
    }
    if (request.method === "GET" && request.url === "/storage-holds") {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ held: fixture.storageHolds.length })); return;
    }
    if (request.method === "POST" && request.url === "/storage-release") {
      const released = fixture.storageHolds.splice(0, fixture.storageHolds.length);
      for (const refuse of released) refuse();
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ released: released.length })); return;
    }
    if (request.method === "GET" && request.url.startsWith("/asset-document?")) {
      const id = new URL(request.url, controlOrigin).searchParams.get("id");
      const [source] = await fixture.sql`select payload from migration.source_documents where legacy_sanity_id=${id} and not tombstoned`;
      const [{ assets }] = await fixture.sql`select count(*)::int as assets from cms.assets where legacy_sanity_asset_id=${id}`;
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ document: source?.payload ?? null, assets })); return;
    }
    if (request.method === "POST" && request.url === "/seed-legacy-image") {
      const { bytes, extension, mimeType, width, height, document } = await readJson(request);
      const body = Buffer.from(bytes, "base64");
      const sha1 = createHash("sha1").update(body).digest("hex");
      const id = `image-${sha1}-${width}x${height}-${extension}`;
      const storagePath = `images/${sha1}.${extension}`;
      const bucket = fixture.client.storage.from(IMAGE_BUCKET);
      const url = bucket.getPublicUrl(storagePath).data.publicUrl;
      const asset = { legacy_sanity_asset_id: id, storage_bucket: IMAGE_BUCKET, storage_path: storagePath, source_url: url, mime_type: mimeType, byte_size: body.length, sha256: createHash("sha256").update(body).digest("hex"), width, height };
      const stored = await bucket.upload(storagePath, body, { contentType: mimeType, upsert: false });
      let registered = stored;
      if (!stored.error && document === false) {
        await fixture.sql`select public.roo_upsert_asset(${fixture.sql.json({ ...asset, source_url: `https://cdn.sanity.io/images/fixture/production/${sha1}-${width}x${height}.${extension}`, metadata: { source_sha1: sha1 } })})`;
      } else if (!stored.error) {
        registered = await fixture.client.rpc("roo_register_verified_cms_asset", {
          p_asset: asset,
          p_asset_document: { _id: id, _type: "sanity.imageAsset", url, sha1hash: sha1, size: body.length, mimeType, extension, metadata: { dimensions: { width, height, aspectRatio: width / height } } },
        });
      }
      response.writeHead(registered.error ? 500 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(registered.error ? { error: registered.error.message } : { id, sha1, path: storagePath })); return;
    }
    if (request.method === "POST" && request.url === "/remove-object") {
      const removed = await fixture.client.storage.from(IMAGE_BUCKET).remove([(await readJson(request)).path]);
      response.writeHead(removed.error || removed.data.length !== 1 ? 500 : 200); response.end(); return;
    }
    if (request.method === "POST" && request.url === "/record-no-image-sizes") {
      const [{ outcome }] = await fixture.sql`select public.roo_record_cms_image_sizes(${(await readJson(request)).id}, '[]'::jsonb) as outcome`;
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(outcome)); return;
    }
    if (request.method === "GET" && request.url === "/image-store") {
      const objects = await fixture.sql`select name, version, updated_at from storage.objects where bucket_id=${IMAGE_BUCKET} order by name`;
      const documents = await fixture.sql`select legacy_sanity_id as id, source_revision as revision, payload #> '{metadata,sizes}' as sizes, payload #> '{metadata,dimensions}' as dimensions from migration.source_documents where document_type='sanity.imageAsset' and not tombstoned order by legacy_sanity_id`;
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ objects, documents })); return;
    }
    if (request.method === "GET" && request.url === "/operator-environment") {
      response.writeHead(200, { "Content-Type": "text/plain" }); response.end(`SUPABASE_URL=${fixture.origin}\nSUPABASE_SECRET_KEY=${fixture.serviceRoleKey}\n`); return;
    }
    if (request.method === "POST" && request.url === "/reset-rate-limits") {
      await fixture.sql`update commerce.rate_limit_buckets set count=0`;
      response.writeHead(200); response.end("ok"); return;
    }
    response.writeHead(404); response.end();
  };
  control.on("request", (request, response) => {
    void handleControl(request, response).catch(error => {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      if (!response.writableEnded) response.end(JSON.stringify({ error: error.message }));
    });
  });
  fixturePorts.writeFixturePorts(baseURL, instance, { TOOLING_ADMIN_CONTROL_PORT: controlPort });
  const env = withNodeOption({
    PATH: process.env.PATH, HOME: process.env.HOME, CI: "true", TZ: "UTC", TOURNEY_DATABASE_MODE: "memory",
    DATA_PRIMARY_BACKEND: "supabase", COMMERCE_PRIMARY_BACKEND: "supabase", COMMERCE_FAILOVER_GENERATION: "0", SUPABASE_CUTOVER_ENABLED: "1", COMMERCE_CUTOVER_ENABLED: "1",
    SUPABASE_URL: fixture.origin, NEXT_PUBLIC_SUPABASE_URL: fixture.origin, NEXT_PUBLIC_SUPABASE_ASSET_URL: fixture.origin,
    SUPABASE_SECRET_KEY: fixture.serviceRoleKey, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: fixture.anonKey, NEXT_PUBLIC_SUPABASE_ANON_KEY: fixture.anonKey,
    REF_ADMIN_KEY: "synthetic-admin-key", REF_SESSION_SECRET: "synthetic-content-session-secret", RATE_LIMIT_HASH_SECRET: "synthetic-admin-rate-secret", CMS_WRITES_PAUSED: "0",
    ALLOW_LIVE_PAYMENTS: "0", SALES_PREVIEW_READ_ONLY: "0", NEXT_TELEMETRY_DISABLED: "1", BASE_URL: baseURL, ROO_TEST_HOST: target.hostname, NEXT_DIST_DIR: dist, TOOLING_NETWORK_GUARD: "1",
    ROO_CONTENT_TEST_CONTROL_URL: controlOrigin,
    NEXT_CACHE_HANDLER_PATH: path.join(root, "tests/fixtures/stale-mark-cache-handler.cjs"),
    ROO_TEST_NETWORK_ORIGINS: JSON.stringify([baseURL, fixture.origin, fixture.storageUrl, fixture.postgrestUrl, controlOrigin]),
  }, "--import", pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href, path.join(root, "scripts/lib/admin-test-imports.mjs"));
  const execute = args => new Promise((resolve, reject) => {
    const stdio = ["inherit", "inherit", "inherit", lock.fd];
    active = spawn(process.execPath, args, { env: lock.childEnv(env), stdio });
    active.once("error", reject);
    active.once("exit", (code, signal) => code === 0 || stopped ? resolve() : reject(new Error(`Admin fixture server exited ${signal || code}.`)));
  });
  const next = path.join(root, "node_modules/next/dist/bin/next");
  console.log(`Guarded native CMS fixture: ${baseURL}`);
  await execute(["scripts/generate-sitemap.js"]);
  await execute(["scripts/generate-robots.js"]);
  const development = process.env.ROO_TEST_DEV === "1";
  if (!development) {
    await execute(["scripts/validate-runtime-env.js"]);
    await execute([next, "build"]);
  }
  await releaseTcpPorts(target.hostname, [port]);
  let finish, fail;
  const lifetime = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const startApp = () => new Promise((resolve, reject) => {
    const args = [next, development ? "dev" : "start", "--hostname", target.hostname, "--port", target.port];
    if (!development) args.push("--keepAliveTimeout", String(nextTestKeepAliveTimeout));
    const child = spawn(process.execPath, args, {
      env: lock.childEnv(env), stdio: ["inherit", "pipe", "pipe", lock.fd],
    });
    active = child;
    let ready = false;
    let output = "";
    child.stdout.on("data", chunk => {
      output += String(chunk);
      process.stdout.write(chunk);
      if (!ready && /Ready in/.test(output)) { ready = true; resolve(); }
    });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    child.once("error", error => { if (!ready) reject(error); else fail(error); });
    child.once("exit", (code, signal) => {
      if (!ready) reject(new Error(`Admin fixture server exited ${signal || code}.`));
      else (stopped || code === 0 ? finish : fail)(new Error(`Admin fixture server exited ${signal || code}.`));
    });
  });
  resetIsolation = async () => {
    const started = Date.now();
    const step = async (name, action) => {
      try { return await action(); } catch (error) { throw new Error(`reset: ${name}: ${error.message}`, { cause: error }); }
    };
    const hook = async (header, extra = {}) => {
      const response = await fetch(baseURL, { headers: { [header]: "1", ...extra } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    };
    const controls = await step("inspect controls", async () => (await hook("x-roo-test-inspect-controls")).json());
    const leftovers = [
      ...storeHolds.map(({ trace, rpc }) => rpc === "page-store" ? `held page store ${trace}` : `held store ${trace}/${rpc}`),
      ...[...eventWaiters].map(waiter => `pending waiter ${waiter.description}`),
      ...controls.active.map(({ trace, content, pages, holds }) => `hang control ${trace}/${[content && "content purge", pages && "page mark", holds && `${holds} holds`].filter(Boolean).join(", ")}`),
      ...controls.failures.map(({ trace, content, pages }) => `forced failure ${trace}/${[content && "content purge", pages && "page mark"].filter(Boolean).join(", ")}`),
      ...controls.pageStoreHolds.map(trace => `unused page store hold ${trace}`),
      ...fixture.storageFailures.map(({ method, path }) => `storage failure rule ${method} ${path}`),
      ...fixture.storageHolds.map(() => "held storage request"),
    ];
    fixture.storageFailures.length = 0;
    for (const refuse of fixture.storageHolds.splice(0)) refuse();
    await step("clear controls", () => hook("x-roo-test-reset-all-controls", { "x-roo-test-clear-rounds": "1" }));
    for (const hold of storeHolds.splice(0)) hold.release();
    for (const waiter of eventWaiters) waiter.cancel();
    const clearRecords = () => {
      storeRules.clear(); closedStores.clear();
      storeCalls.length = 0; purges.length = 0; pageRefusals.length = 0;
      refreshEvents.length = 0; refreshErrors.length = 0; keptAlive.length = 0; pageWrites.length = 0;
      adminFixture.sessions.clear(); adminFixture.requests.length = 0;
      adminFixture.setLoginReply(null); adminFixture.setLogoutReply(null);
      emails.length = 0; notificationSequence = 0;
    };
    fixture.pause();
    let comparisonFailure;
    try {
      await step("cancel pending database requests", () => databaseSnapshot.cancelPending());
      await step("drain requests", () => fixture.drain());
      const revision = await step("read revision", () => databaseSnapshot.revision());
      await step("restore database", () => databaseSnapshot.restore());
      try {
        const changed = await step("compare database", () => databaseSnapshot.differences());
        if (changed.length) throw new Error(`reset: compare database: ${changed.join(", ")}`);
      } catch (error) { comparisonFailure = error; }
      await step("advance revision", () => databaseSnapshot.advanceRevision(revision));
    } finally { fixture.resume(); clearRecords(); }
    await step("mark pages", () => hook("x-roo-test-mark-pages"));
    if (comparisonFailure) throw comparisonFailure;
    return { leftovers, durationMs: Date.now() - started };
  };
  await startApp();
  await lifetime;
} finally { await stop(); }
