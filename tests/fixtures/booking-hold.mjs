import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { installNetworkGuard, refuseEnvFiles } from "../../scripts/lib/test-target-safety.mjs";

export async function createBookingHoldFixture() {
  refuseEnvFiles();
  const host = process.env.ROO_TEST_HOST || "127.0.0.1";
  const port = Number(process.env.BOOKING_HOLD_PORT || Number(process.env.PW_PORT || 4173) + 2);
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65532, "Invalid booking fixture port");
  const baseURL = `http://${host}:${port}`;
  const origins = Array.from({ length: 4 }, (_, index) => `http://${host}:${port + index}`);
  installNetworkGuard(origins);
  Object.assign(process.env, {
    NODE_ENV: "test", VERCEL_ENV: "development", ALLOW_LIVE_PAYMENTS: "0",
    DATA_PRIMARY_BACKEND: "supabase", COMMERCE_PRIMARY_BACKEND: "supabase",
    SUPABASE_CUTOVER_ENABLED: "1", COMMERCE_CUTOVER_ENABLED: "1", COMMERCE_FAILOVER_GENERATION: "0",
    DODO_PAYMENTS_ENVIRONMENT: "test_mode", DODO_PAYMENTS_API_KEY: "fixture-only",
    DODO_PAYMENTS_WEBHOOK_KEY: "whsec_Zml4dHVyZS1vbmx5", DODO_PAYMENTS_PRODUCT_ID: "pdt_fixture",
    DODO_PAYMENTS_RETURN_URL: `${baseURL}/handoff`,
    PAYMENT_SESSION_SECRET: "fixture-only-payment-session", HOLD_TOKEN_SECRET: "fixture-only-hold",
    REF_SESSION_SECRET: "fixture-only-ref-session", RESEND_API_KEY: "re_fixture",
    FROM_EMAIL: "noreply@example.invalid", OWNER_EMAIL: "owner@example.invalid",
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
  const evidence = { http: [], providerRequests: [], blocked: [], stopped: false };
  const artifact = new URL("../../test-results/booking-hold/native.json", import.meta.url);
  const save = () => {
    fs.mkdirSync(new URL(".", artifact), { recursive: true });
    fs.writeFileSync(artifact, JSON.stringify(evidence, null, 2));
  };
  const originalFetch = globalThis.fetch;
  let database, server;
  const stop = async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
    if (database) { await database.stop(); database = null; }
    globalThis.fetch = originalFetch;
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
      NEXT_PUBLIC_SUPABASE_URL: database.origin, NEXT_PUBLIC_SUPABASE_ANON_KEY: database.token });
    let checkoutCount = 0;
    database.setProviderHandler(async request => {
      evidence.providerRequests.push(request);
      if (request.path === "/products/pdt_fixture") return { body: { product_id: "pdt_fixture", is_recurring: false,
        price: { type: "one_time_price", currency: "USD", pay_what_you_want: true, tax_inclusive: false,
          purchasing_power_parity: false, discount: 0, price: 0 } } };
      if (request.path === "/checkouts" && request.method === "POST") {
        const id = `session_fixture_${++checkoutCount}`;
        return { body: { session_id: id, checkout_url: `https://test.checkout.dodopayments.com/session/${id}` } };
      }
      throw new Error(`Unhandled fixture provider request ${request.path}`);
    });
    const providers = new Set(["https://test.dodopayments.com", "https://api.resend.com"]);
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
      if (providers.has(url.origin)) return originalFetch(`${database.origin}/provider${url.pathname}${url.search}`, init);
      if (!origins.includes(url.origin)) evidence.blocked.push(url.origin);
      return originalFetch(input, init);
    };
    const { createSupabaseDocumentClient } = await import("../../src/server/supabase/documentClient.js");
    const commerce = createSupabaseDocumentClient({ shadowClient: database.client, commerceOnly: true, cutoverGeneration: 0 });
    const content = createSupabaseDocumentClient({ shadowClient: database.client });
    const dates = Array.from({ length: 24 }, (_, index) => new Date(Date.UTC(2099, 0, index + 5)).toISOString().slice(0, 10));
    await content.create({ _id: "package.fixture.vertex", _type: "package", title: "Performance Vertex Overhaul", price: "$54.95" });
    await content.create({ _id: "6d8a3646-0ed2-44b5-ad45-c5c9d578126a", _type: "bookingSettings",
      dateSlots: dates.map(date => ({ date, times: ["10:00", "11:00"] })), ownerEmail: "owner@example.invalid" });
    const { runLegacyApiHandler } = await import("../../src/lib/nextApiAdapter.js");
    const handlers = new Map();
    for (const [route, module] of Object.entries({
      "/api/holdSlot": "../../src/server/booking/holdSlot.js",
      "/api/payment/quote": "../../src/server/api/payment/quote.js",
      "/api/payment/start": "../../src/server/api/payment/start.js",
    })) handlers.set(route, (await import(module)).default);
    server = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        const url = new URL(req.url, baseURL);
        const handler = handlers.get(url.pathname);
        if (!handler) { res.writeHead(404); res.end(); return; }
        const request = new Request(url, { method: req.method, headers: req.headers,
          ...(req.method === "GET" ? {} : { body: raw }) });
        const response = await runLegacyApiHandler({ request, handler });
        const body = await response.text();
        evidence.http.push({ path: url.pathname, request: raw.length ? JSON.parse(raw) : null,
          status: response.status, response: body ? JSON.parse(body) : null });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(body);
      } catch (error) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
    });
    server.listen(port, host);
    await once(server, "listening");
    const post = async (route, body) => {
      globalThis.__rooRateLimitBuckets?.clear();
      const response = await fetch(`${baseURL}${route}`, { method: "POST",
        headers: { "content-type": "application/json", origin: baseURL }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const details = { email: "visitor@example.invalid", discord: "fixture_visitor", specs: "Ryzen 7700 / RTX 4070",
      mainGame: "CS2", message: "Fixture booking", localTimeZone: "Asia/Kolkata", deferEmailsUntilConfirmation: true };
    let nextDate = 0;
    const nextSlotDate = () => dates[nextDate++];
    const hold = async () => {
      const startTimeUTC = `${nextSlotDate()}T04:30:00.000Z`;
      const response = await post("/api/holdSlot", { startTimeUTC, packageTitle: "Performance Vertex Overhaul" });
      assert.equal(response.status, 200, JSON.stringify(response));
      return { packageTitle: "Performance Vertex Overhaul", ...details, startTimeUTC,
        slotHoldId: response.body.holdId, slotHoldToken: response.body.holdToken };
    };
    const start = async bookingPayload => {
      const quote = await post("/api/payment/quote", { bookingPayload });
      assert.equal(quote.status, 200, JSON.stringify(quote));
      return post("/api/payment/start", { provider: "dodo", bookingPayload, quoteFingerprint: quote.body.quoteFingerprint });
    };
    return { baseURL, post, hold, start, nextSlotDate, commerce, details, evidence, save, stop };
  } catch (error) { await stop(); throw error; }
}

if (process.argv.includes("--worker")) {
  const fixture = await createBookingHoldFixture();
  const shutdown = async () => { await fixture.stop(); process.disconnect(); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("disconnect", () => { fixture.stop(); });
  process.on("message", async ({ id, method, args = [] }) => {
    try {
      let value;
      if (method === "post") value = await fixture.post(...args);
      else if (method === "nextSlotDate") value = fixture.nextSlotDate();
      else if (method === "getHold") value = await fixture.commerce.getDocument(...args);
      else if (method === "evidence") value = fixture.evidence;
      else if (method === "verifyHold") {
        const stored = await fixture.commerce.getDocument(args[0].holdId);
        const { verifyHoldToken } = await import("../../src/server/booking/holdToken.js");
        value = Boolean(verifyHoldToken({ ...args[0], startTimeUTC: stored.startTimeUTC,
          holdNonce: stored.holdNonce, backend: stored.backendOwner,
          cutoverGeneration: Number(stored.cutoverGeneration || 0) }));
      } else if (method === "stop") {
        await fixture.stop();
        process.send({ id, value: true });
        process.disconnect();
        return;
      } else throw new Error(`Unknown booking fixture operation: ${method}`);
      process.send({ id, value });
    } catch (error) { process.send({ id, error: error.stack || error.message }); }
  });
  process.send({ ready: true });
}
