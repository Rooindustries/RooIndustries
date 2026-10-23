import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, createHmac } from "node:crypto";
import { installNetworkGuard, refuseEnvFiles, validateDistDir } from "../../scripts/lib/test-target-safety.mjs";

export const REFERRAL = Object.freeze({
  id: "referral.fixture-creator",
  code: "fixturecreator",
  commissionPercent: 10,
  discountPercent: 5,
});
export const PACKAGE = Object.freeze({ title: "Performance Vertex Overhaul", price: 54.95 });

const WEBHOOK_SECRET = "fixture-only";

export async function createReferralPaymentFixture() {
  refuseEnvFiles();
  const host = process.env.ROO_TEST_HOST || "127.0.0.1";
  const port = Number(process.env.REFERRAL_PAYMENT_PORT || Number(process.env.PW_PORT || 4173) + 6);
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65532, "Invalid referral payment fixture port");
  const baseURL = `http://${host}:${port}`;
  const origins = Array.from({ length: 4 }, (_, index) => `http://${host}:${port + index}`);
  const restoreGuard = installNetworkGuard(origins);
  const dist = validateDistDir(`${process.env.NEXT_DIST_DIR || ".next-e2e-referral"}-api-${process.env.TEST_WORKER_INDEX || "0"}`, { isolated: true });
  Object.assign(process.env, {
    NODE_ENV: "development", VERCEL_ENV: "development", ALLOW_LIVE_PAYMENTS: "0",
    NEXT_DIST_DIR: dist, NEXT_TELEMETRY_DISABLED: "1", SALES_PREVIEW_READ_ONLY: "0",
    DATA_PRIMARY_BACKEND: "supabase", COMMERCE_PRIMARY_BACKEND: "supabase",
    SUPABASE_CUTOVER_ENABLED: "1", COMMERCE_CUTOVER_ENABLED: "1", COMMERCE_FAILOVER_GENERATION: "0",
    DODO_PAYMENTS_ENVIRONMENT: "test_mode", DODO_PAYMENTS_API_KEY: "fixture-only",
    DODO_PAYMENTS_WEBHOOK_KEY: `whsec_${Buffer.from(WEBHOOK_SECRET).toString("base64")}`,
    DODO_PAYMENTS_PRODUCT_ID: "pdt_fixture", DODO_PAYMENTS_RETURN_URL: `${baseURL}/handoff`,
    PAYMENT_SESSION_SECRET: "fixture-only-payment-session", HOLD_TOKEN_SECRET: "fixture-only-hold",
    REF_SESSION_SECRET: "fixture-only-ref-session", RESEND_API_KEY: "re_fixture",
    FROM_EMAIL: "noreply@example.invalid", OWNER_EMAIL: "owner@example.invalid",
    RATE_LIMIT_HASH_SECRET: "fixture-only-rate-limit", CMS_WRITES_PAUSED: "0",
  });
  registerHooks({ resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      if (specifier === "next/server") return nextResolve("next/server.js", context);
      if (!specifier.startsWith(".") || !context.parentURL?.startsWith("file:")) throw error;
      for (const suffix of [".js", ".ts", "/index.js"]) {
        const candidate = new URL(`${specifier}${suffix}`, context.parentURL);
        if (fs.existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
      throw error;
    }
  } });
  const routeSource = "app/api/payment/webhook/dodo/route.js";
  const evidence = { dodoEnvironment: process.env.DODO_PAYMENTS_ENVIRONMENT,
    next: { baseURL, dist, routeSource, sourceSha256: createHash("sha256").update(fs.readFileSync(routeSource)).digest("hex") },
    http: [], providerRequests: [], blocked: [], stopped: false };
  const artifact = process.env.ROO_REFERRAL_PAYMENT_ARTIFACT
    ? new URL(process.env.ROO_REFERRAL_PAYMENT_ARTIFACT, pathToFileURL(`${process.cwd()}/`))
    : new URL("../../test-results/referral-payment/native.json", import.meta.url);
  assert.equal(artifact.protocol, "file:", "Referral fixture artifact must be a local file");
  const save = () => {
    fs.mkdirSync(new URL(".", artifact), { recursive: true });
    fs.writeFileSync(artifact, JSON.stringify(evidence, null, 2));
    fs.writeFileSync(new URL(`native-${process.env.TEST_WORKER_INDEX || "0"}.json`, artifact), JSON.stringify(evidence, null, 2));
  };
  const originalFetch = globalThis.fetch;
  let database, server, app;
  const stop = async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
    if (app) {
      let timeout;
      try { await Promise.race([app.close(), new Promise(resolve => { timeout = setTimeout(resolve, 5000); })]); }
      finally { clearTimeout(timeout); app = null; }
    }
    if (database) { await database.stop(); database = null; }
    globalThis.fetch = originalFetch;
    restoreGuard();
    evidence.stopped = true;
    save();
  };
  try {
    const { createSweepPostgresFixture } = await import("../../scripts/lib/sweep-postgres-fixture.mjs");
    database = await createSweepPostgresFixture({ fullMigrationChain: true,
      pgBin: process.env.PG_BIN, postgrestBin: process.env.POSTGREST_BIN,
      libraryPath: process.env.LD_LIBRARY_PATH,
      ports: { postgres: port + 1, rest: port + 2, proxy: port + 3 } });
    evidence.database = { version: database.postgresVersion, postgrest: database.postgrestVersion, migrations: database.manifest.length };
    Object.assign(process.env, { SUPABASE_URL: database.origin, SUPABASE_SERVICE_ROLE_KEY: database.token,
      SUPABASE_SECRET_KEY: database.token, NEXT_PUBLIC_SUPABASE_URL: database.origin,
      NEXT_PUBLIC_SUPABASE_ASSET_URL: database.origin, NEXT_PUBLIC_SUPABASE_ANON_KEY: database.token });
    const sessions = new Map();
    const paid = new Set();
    database.setProviderHandler(async request => {
      evidence.providerRequests.push({ method: request.method, path: request.path });
      if (request.path === "/products/pdt_fixture") return { body: { product_id: "pdt_fixture", is_recurring: false,
        price: { type: "one_time_price", currency: "USD", pay_what_you_want: true, tax_inclusive: false,
          purchasing_power_parity: false, discount: 0, price: 0 } } };
      if (request.path === "/checkouts" && request.method === "POST") {
        const id = `session_fixture_${sessions.size + 1}`;
        sessions.set(id, request.body);
        return { body: { session_id: id, checkout_url: `https://test.checkout.dodopayments.com/session/${id}` } };
      }
      if (request.path.startsWith("/checkouts/") && request.method === "GET") {
        const id = request.path.split("/").pop();
        return { body: { id, payment_id: paid.has(id) ? `payment_${id}` : null } };
      }
      if (request.path.startsWith("/payments/") && request.method === "GET") {
        const paymentId = request.path.split("/").pop();
        const id = paymentId.replace(/^payment_/, "");
        const session = sessions.get(id);
        assert.ok(session && paid.has(id), `Unknown or unpaid fixture payment ${paymentId}`);
        return { body: { payment_id: paymentId, checkout_session_id: id, metadata: session.metadata,
          status: "succeeded", total_amount: session.product_cart[0].amount, tax: 0, currency: "USD",
          product_cart: session.product_cart, refunds: [], disputes: [], refund_status: null,
          customer: session.customer } };
      }
      if (request.path === "/emails" && request.method === "POST") return { body: { id: `email_fixture_${evidence.providerRequests.length}` } };
      throw new Error(`Unhandled fixture provider request ${request.method} ${request.path}`);
    });
    const providers = new Set(["https://test.dodopayments.com", "https://api.resend.com"]);
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
      if (url.href === "https://registry.npmjs.org/-/package/next/dist-tags") {
        evidence.next.versionCheckRefused = true;
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      if (url.hostname.endsWith("dodopayments.com") && url.origin !== "https://test.dodopayments.com") {
        throw new Error(`Live Dodo request refused: ${url.origin}`);
      }
      if (providers.has(url.origin)) return originalFetch(`${database.origin}/provider${url.pathname}${url.search}`, init);
      if (!origins.includes(url.origin)) evidence.blocked.push(url.origin);
      return originalFetch(input, init);
    };
    const { createSupabaseDocumentClient } = await import("../../src/server/supabase/documentClient.js");
    const commerce = createSupabaseDocumentClient({ shadowClient: database.client, commerceOnly: true, cutoverGeneration: 0 });
    const content = createSupabaseDocumentClient({ shadowClient: database.client });
    const dates = Array.from({ length: 24 }, (_, index) => new Date(Date.UTC(2099, 0, index + 5)).toISOString().slice(0, 10));
    await content.create({ _id: "package.fixture.vertex", _type: "package", title: PACKAGE.title, price: `$${PACKAGE.price}` });
    await content.create({ _id: "6d8a3646-0ed2-44b5-ad45-c5c9d578126a", _type: "bookingSettings",
      dateSlots: dates.map(date => ({ date, times: ["10:00", "11:00"] })), ownerEmail: "owner@example.invalid" });
    for (const [code, percent] of [["delay20", 20], ["delayfree", 100]]) {
      await commerce.create({ _id: `coupon.fixture.${code}`, _type: "coupon", code,
        isActive: true, discountType: "percent", discountPercent: percent,
        canCombineWithReferral: true, timesUsed: 0, activeReservations: 0, maxUses: 0,
        backendOwner: "supabase", cutoverGeneration: 0 });
    }
    const referral = { _id: REFERRAL.id, _type: "referral", email: "creator@example.invalid", name: "Fixture Creator",
      slug: { _type: "slug", current: REFERRAL.code }, registrationStatus: "active", verified: true,
      currentCommissionPercent: REFERRAL.commissionPercent, currentDiscountPercent: REFERRAL.discountPercent,
      maxCommissionPercent: 15, successfulReferrals: 0, bypassUnlock: false };
    const created = await database.client.rpc("roo_apply_document_mutations", { p_mutations: [{ operation: "create", id: REFERRAL.id, document: referral }] });
    assert.equal(created.error, null, `Referral seed: ${created.error?.message}`);
    const [source] = await database.sql`select source_revision,source_hash from migration.source_documents
      where legacy_sanity_id=${REFERRAL.id} and document_type='referral'`;
    const [user] = await database.sql`insert into auth.users(id,email,email_confirmed_at)
      values(gen_random_uuid(),${referral.email},now()) returning id`;
    const account = await database.client.rpc("roo_upsert_native_creator_account", { p_account: {
      user_id: user.id, primary_email: referral.email, display_name: referral.name, referral_code: REFERRAL.code,
      registration_status: "active", legacy_sanity_id: REFERRAL.id, source_revision: source.source_revision, source_hash: source.source_hash,
    } });
    assert.equal(account.error, null, `Creator seed: ${account.error?.message}`);
    await database.sql`update accounts.creator_profiles set commission_basis_points=${REFERRAL.commissionPercent * 100},
      discount_basis_points=${REFERRAL.discountPercent * 100}, total_basis_points=1500, successful_referrals=0 where user_id=${user.id}`;
    const { default: nextConfig } = await import("../../next.config.mjs");
    nextConfig.distDir = dist;
    const { default: next } = await import("next");
    app = next({ dev: true, hostname: host, port });
    await app.prepare();
    const handle = app.getRequestHandler();
    server = http.createServer(async (req, res) => {
      try {
        await handle(req, res);
      } catch (error) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
    });
    server.listen(port, host);
    await once(server, "listening");
    const warmRoute = async (path) => {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(`${baseURL}${path}`, {
            method: "GET",
            headers: { origin: baseURL },
            signal: AbortSignal.timeout(20000),
          });
          await response.arrayBuffer();
          if (response.status >= 500) {
            throw new Error(`Route warm-up failed: ${path} returned ${response.status}`);
          }
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    };
    for (const path of [
      "/api/holdSlot",
      "/api/releaseHold",
      "/api/payment/providers",
      "/api/payment/quote",
      "/api/payment/start",
      "/api/payment/status",
      "/api/payment/finalize",
      "/api/payment/cancel",
      "/api/payment/webhook/dodo",
      "/api/ref/validateReferral",
      "/api/ref/validateCoupon",
    ]) {
      await warmRoute(path);
    }
    globalThis.__rooRateLimitBuckets?.clear();
    const request = async ({ method = "GET", path, body = "", headers = {} }) => {
      globalThis.__rooRateLimitBuckets?.clear();
      const response = await fetch(`${baseURL}${path}`, { method,
        headers: { origin: baseURL, ...headers }, ...(["GET", "HEAD"].includes(method) ? {} : { body }) });
      const text = await response.text();
      evidence.http.push({ method, path, status: response.status,
        response: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text });
      return { status: response.status, headers: Object.fromEntries(response.headers), body: text };
    };
    const readEvidence = () => {
      const manifest = JSON.parse(fs.readFileSync(`${dist}/server/app-paths-manifest.json`, "utf8"));
      const compiledRoute = manifest["/api/payment/webhook/dodo/route"];
      assert.equal(compiledRoute, "app/api/payment/webhook/dodo/route.js");
      evidence.next.compiledRouteSha256 = createHash("sha256").update(fs.readFileSync(`${dist}/server/${compiledRoute}`)).digest("hex");
      return evidence;
    };
    const pay = sessionId => {
      assert.ok(sessions.has(sessionId), `Unknown checkout session ${sessionId}`);
      paid.add(sessionId);
      return `payment_${sessionId}`;
    };
    const webhook = async ({ paymentId, type, eventId, invalidSignature = false }) => {
      const body = JSON.stringify({ business_id: "business_fixture", type,
        timestamp: new Date().toISOString(), data: { payment_id: paymentId } });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", Buffer.from(WEBHOOK_SECRET))
        .update(`${eventId}.${timestamp}.${body}`).digest("base64");
      const response = await request({ method: "POST", path: "/api/payment/webhook/dodo", body, headers: {
        "content-type": "application/json", "webhook-id": eventId,
        "webhook-timestamp": timestamp, "webhook-signature": `v1,${invalidSignature ? "invalid" : signature}` } });
      return { status: response.status, body: JSON.parse(response.body) };
    };
    const { fetchReferralEarnings } = await import("../../src/server/api/ref/payoutUtils.js");
    const state = async () => {
      const bookings = await commerce.fetch(`*[_type == "booking"]{...}`);
      const paymentRecords = await commerce.fetch(`*[_type == "paymentRecord"]{...}`);
      const referral = await commerce.fetch(`*[_type == "referral" && _id == $id][0]{...}`, { id: REFERRAL.id });
      const earnings = await fetchReferralEarnings({ client: commerce, referralId: REFERRAL.id, referralCode: REFERRAL.code });
      return { bookings, paymentRecords, referral, earnings, checkoutSessions: [...sessions.keys()] };
    };
    const snapshot = async () => {
      const tables = {};
      for (const table of ["payment_records", "payment_start_claims", "payment_proof_claims", "webhook_receipts",
        "slot_holds", "coupons", "coupon_redemptions", "bookings"]) {
        tables[table] = await database.sql.unsafe(`select to_jsonb(t) as row from commerce.${table} t order by to_jsonb(t)::text`);
      }
      return {
        documents: await database.sql`select legacy_sanity_id,payload,source_revision,tombstoned
          from migration.source_documents order by legacy_sanity_id`,
        tables,
        commands: await database.sql`select command_id from migration.commerce_commands order by command_id`,
        emails: evidence.providerRequests.filter(request => request.method === "POST" && request.path === "/emails"),
      };
    };
    const nextSlotDate = (() => { let next = 0; return () => dates[next++]; })();
    const expireHold = async id => {
      await database.sql.begin(async sql => {
        await sql`update migration.source_documents set
          payload=jsonb_set(payload,'{expiresAt}',to_jsonb((now()-interval '1 second')::text)),
          source_hash=encode(extensions.digest(jsonb_set(payload,'{expiresAt}',to_jsonb((now()-interval '1 second')::text))::text,'sha256'),'hex')
          where legacy_sanity_id=${id}`;
        const [hold] = await sql`update commerce.slot_holds set expires_at=now()-interval '1 second'
          where legacy_sanity_id=${id} returning id`;
        assert.ok(hold, "Hold to expire must exist");
        await sql`delete from commerce.slot_claims where hold_id=${hold.id}`;
      });
      assert.ok(Date.parse((await commerce.fetch(`*[_type == "slotHold" && _id == $id][0]`, { id })).expiresAt) < Date.now());
      return true;
    };
    return { baseURL, request, pay, webhook, state, snapshot, nextSlotDate, expireHold, evidence, readEvidence, save, stop };
  } catch (error) { await stop(); throw error; }
}

if (process.argv.includes("--worker")) {
  const fixture = await createReferralPaymentFixture();
  const shutdown = async () => { await fixture.stop(); process.disconnect(); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("disconnect", () => { fixture.stop(); });
  process.on("message", async ({ id, method, args = [] }) => {
    try {
      if (method === "stop") {
        await fixture.stop();
        process.send({ id, value: true }, () => {
          process.disconnect();
          process.exit(0);
        });
        return;
      }
      if (!["request", "pay", "webhook", "state", "snapshot", "nextSlotDate", "expireHold"].includes(method) && method !== "evidence") {
        throw new Error(`Unknown referral payment fixture operation: ${method}`);
      }
      const value = method === "evidence" ? fixture.readEvidence() : await fixture[method](...args);
      process.send({ id, value: JSON.parse(JSON.stringify(value)) });
    } catch (error) { process.send({ id, error: error.stack || error.message }); }
  });
  process.send({ ready: true, baseURL: fixture.baseURL });
}
