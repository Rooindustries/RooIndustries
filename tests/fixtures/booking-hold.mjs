import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createHmac } from "node:crypto";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { installNetworkGuard, refuseEnvFiles } from "../../scripts/lib/test-target-safety.mjs";
import { portFromEnv } from "../../scripts/lib/free-tcp-port.mjs";

export async function createBookingHoldFixture() {
  refuseEnvFiles();
  const host = process.env.ROO_TEST_HOST || "127.0.0.1";
  const requested = portFromEnv("BOOKING_HOLD_PORT");
  const server = http.createServer();
  let baseURL, origins;
  Object.assign(process.env, {
    NODE_ENV: "test", VERCEL_ENV: "development", ALLOW_LIVE_PAYMENTS: "0",
    DATA_PRIMARY_BACKEND: "supabase", COMMERCE_PRIMARY_BACKEND: "supabase",
    SUPABASE_CUTOVER_ENABLED: "1", COMMERCE_CUTOVER_ENABLED: "1", COMMERCE_FAILOVER_GENERATION: "0",
    DODO_PAYMENTS_ENVIRONMENT: "test_mode", DODO_PAYMENTS_API_KEY: "fixture-only",
    DODO_PAYMENTS_WEBHOOK_KEY: "whsec_Zml4dHVyZS1vbmx5", DODO_PAYMENTS_PRODUCT_ID: "pdt_fixture",
    PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "",
    RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "", DISABLE_RAZORPAY_CHECKOUT: "0",
    PAYMENT_SESSION_SECRET: "fixture-only-payment-session", HOLD_TOKEN_SECRET: "fixture-only-hold",
    CRON_SECRET: "fixture-only-cron",
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
  let originalFetch;
  const originalDate = globalThis.Date;
  let database;
  const stop = async () => {
    if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (database) { await database.stop(); database = null; }
    if (originalFetch) globalThis.fetch = originalFetch;
    globalThis.Date = originalDate;
    evidence.stopped = true;
    save();
  };
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(requested, host, resolve); });
    baseURL = `http://${host}:${server.address().port}`;
    process.env.DODO_PAYMENTS_RETURN_URL = `${baseURL}/handoff`;
    const { createSweepPostgresFixture } = await import("../../scripts/lib/sweep-postgres-fixture.mjs");
    database = await createSweepPostgresFixture({ fullMigrationChain: true,
      pgBin: process.env.PG_BIN, postgrestBin: process.env.POSTGREST_BIN,
      libraryPath: process.env.LD_LIBRARY_PATH,
      ports: requested ? { postgres: requested + 1, rest: requested + 2, proxy: requested + 3 } : {} });
    origins = [baseURL, database.origin, database.postgrestUrl, `http://${host}:${database.pgPort}`];
    installNetworkGuard(origins);
    originalFetch = globalThis.fetch;
    evidence.database = { version: database.postgresVersion, postgrest: database.postgrestVersion, migrations: database.manifest.length };
    Object.assign(process.env, { SUPABASE_URL: database.origin, SUPABASE_SERVICE_ROLE_KEY: database.token,
      NEXT_PUBLIC_SUPABASE_URL: database.origin, NEXT_PUBLIC_SUPABASE_ANON_KEY: database.token });
    let checkoutCount = 0;
    let paymentStatus = null;
    const sessions = new Map();
    const orders = new Map();
    let loseOrderResponse = false;
    let hideOrderLookup = false;
    database.setProviderHandler(async request => {
      evidence.providerRequests.push(request);
      if (request.path === "/emails") return { body: { id: "email_fixture" } };
      if (request.path === "/v1/oauth2/token") return { body: { access_token: "fixture-token" } };
      if (["/v2/checkout/orders", "/v1/orders"].includes(request.path) && request.method === "POST") {
        const id = `order_fixture_${++checkoutCount}`;
        const order = { ...request.body, id, status: request.path === "/v1/orders" ? "created" : "CREATED" };
        orders.set(id, order);
        if (loseOrderResponse) {
          loseOrderResponse = false;
          hideOrderLookup = true;
          return { status: 503, body: {} };
        }
        return { body: order };
      }
      if (request.path.startsWith("/v1/orders?receipt=")) {
        if (hideOrderLookup) {
          hideOrderLookup = false;
          return { status: 503, body: {} };
        }
        const receipt = new URL(request.path, baseURL).searchParams.get("receipt");
        return { body: { items: [...orders.values()].filter(order => order.receipt === receipt) } };
      }
      const razorpayPayment = orderId => ({ id: `payment_${orderId}`, order_id: orderId,
        status: "captured", captured: true, amount: orders.get(orderId).amount, currency: orders.get(orderId).currency });
      if (/^\/v1\/orders\/[^/]+\/payments$/.test(request.path)) {
        return { body: { items: paymentStatus === "captured" ? [razorpayPayment(request.path.split("/")[3])] : [] } };
      }
      if (request.path.startsWith("/v1/payments/payment_")) {
        return { body: razorpayPayment(request.path.split("/").pop().slice("payment_".length)) };
      }
      if (request.path.startsWith("/v1/orders/")) return { body: orders.get(request.path.split("/").pop()) };
      if (request.path.startsWith("/v2/checkout/orders/")) {
        const order = orders.get(request.path.split("/").pop());
        assert.ok(order, "Unknown fixture order");
        return { body: order };
      }
      if (request.path === "/products/pdt_fixture") return { body: { product_id: "pdt_fixture", is_recurring: false,
        price: { type: "one_time_price", currency: "USD", pay_what_you_want: true, tax_inclusive: false,
          purchasing_power_parity: false, discount: 0, price: 0 } } };
      if (request.path === "/checkouts" && request.method === "POST") {
        const id = `session_fixture_${++checkoutCount}`;
        sessions.set(id, request.body);
        return { body: { session_id: id, checkout_url: `https://test.checkout.dodopayments.com/session/${id}` } };
      }
      if (request.path.startsWith("/checkouts/") && request.method === "GET") {
        const id = request.path.split("/").pop();
        return { body: { id, payment_id: paymentStatus && sessions.has(id) ? `payment_${id}` : null } };
      }
      if (request.path.startsWith("/payments/") && request.method === "GET") {
        const id = request.path.split("/").pop().replace(/^payment_/, "");
        const session = sessions.get(id);
        assert.ok(session && paymentStatus, "Unknown fixture payment");
        return { body: {
          payment_id: `payment_${id}`,
          checkout_session_id: id,
          metadata: session.metadata,
          status: paymentStatus,
          total_amount: session.product_cart[0].amount,
          tax: 0,
          currency: "USD",
          product_cart: session.product_cart,
          refunds: [],
          disputes: [],
          refund_status: null,
          customer: session.customer,
        } };
      }
      throw new Error(`Unhandled fixture provider request ${request.path}`);
    });
    const providers = new Set(["https://test.dodopayments.com", "https://api.resend.com",
      "https://api-m.sandbox.paypal.com", "https://api.razorpay.com"]);
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
      "/api/payment/providers": "../../src/server/api/payment/providers.js",
      "/api/payment/start": "../../src/server/api/payment/start.js",
      "/api/payment/finalize": "../../src/server/api/payment/finalize.js",
      "/api/payment/status": "../../src/server/api/payment/status.js",
      "/api/payment/cancel": "../../src/server/api/payment/cancel.js",
      "/api/releaseHold": "../../src/server/booking/releaseHold.js",
      "/api/bookingAvailability": "../../src/server/booking/availability.js",
      "/api/payment/reconcile": "../../src/server/api/payment/reconcile.js",
      "/api/payment/webhook/dodo": "../../src/server/api/payment/webhookDodo.js",
    })) handlers.set(route, (await import(module)).default);
    server.on("request", async (req, res) => {
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
    const post = async (route, body, authorization = "", headers = {}) => {
      globalThis.__rooRateLimitBuckets?.clear();
      const response = await fetch(`${baseURL}${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: baseURL,
          ...(authorization ? { authorization } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const get = async route => {
      const response = await fetch(`${baseURL}${route}`, { headers: { origin: baseURL } });
      return { status: response.status, body: await response.json() };
    };
    const RealDate = Date;
    let clockShiftMs = 0;
    class ShiftedDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [RealDate.now() + clockShiftMs])); }
      static now() { return RealDate.now() + clockShiftMs; }
    }
    globalThis.Date = ShiftedDate;
    const restoreClock = () => { clockShiftMs = 0; };
    const setPaymentStatus = status => { paymentStatus = status; };
    const holdRunsOut = async holdId => {
      clockShiftMs = 21 * 60_000;
      const expiresAt = new RealDate(RealDate.now() - 1000).toISOString();
      await database.sql.begin(async sql => {
        await sql`set local session_replication_role = replica`;
        await sql`update migration.source_documents
          set payload = jsonb_set(payload, '{expiresAt}', to_jsonb(${expiresAt}::text))
          where legacy_sanity_id = ${holdId}`;
        await sql`update commerce.slot_holds set expires_at = ${expiresAt} where legacy_sanity_id = ${holdId}`;
        await sql`update commerce.slot_claims set expires_at = ${expiresAt}
          where hold_id = (select id from commerce.slot_holds where legacy_sanity_id = ${holdId})`;
      });
    };
    const reconcile = () => post("/api/payment/reconcile", {}, "Bearer fixture-only-cron");
    const paymentSucceeded = async holdId => {
      const record = await commerce.fetch(
        '*[_type == "paymentRecord" && bookingPayload.slotHoldId == $id][0]', { id: holdId });
      const body = { business_id: "business_fixture", type: "payment.succeeded",
        timestamp: new Date().toISOString(), data: { payment_id: `payment_${record.providerOrderId}` } };
      const eventId = `fixture_paid_${record._id}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", Buffer.from("fixture-only"))
        .update(`${eventId}.${timestamp}.${JSON.stringify(body)}`).digest("base64");
      return post("/api/payment/webhook/dodo", body, "", {
        "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}`,
      });
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
    const createUpgrade = async () => {
      const id = `booking.original.${nextDate++}`;
      await commerce.create({ _id: id, _type: "booking", ...details,
        backendOwner: "supabase", cutoverGeneration: 0, status: "captured", packageTitle: "Vertex Essentials",
        packagePrice: "$9.99", grossAmount: 9.99, netAmount: 9.99, paymentProvider: "paypal",
        paypalOrderId: `order_${id}`, paymentRecordId: `payment_${id}`, startTimeUTC: "2099-02-01T00:30:00.000Z" });
      await commerce.create({ _id: `payment_${id}`, _type: "paymentRecord",
        backendOwner: "supabase", cutoverGeneration: 0, status: "booked", provider: "paypal",
        verificationState: "server_verified", bookingId: id, providerOrderId: `order_${id}`,
        providerPaymentId: `capture_${id}`, pricingSnapshot: { currency: "USD", netAmount: 9.99 },
        providerPublicData: { currency: "USD", totalAmount: 999, taxAmount: 0, taxInclusive: false } });
      const { issueUpgradeIntentToken } = await import("../../src/server/api/ref/upgradeIntentToken.js");
      return { originalOrderId: id, packageTitle: "Performance Vertex Overhaul", ...details,
        startTimeUTC: "2099-02-01T00:30:00.000Z", displayDate: "1 February 2099", displayTime: "6:00 AM",
        upgradeIntentToken: issueUpgradeIntentToken({ bookingId: id, email: details.email,
          targetPackageTitle: "Performance Vertex Overhaul", backend: "supabase", cutoverGeneration: 0 }) };
    };
    return { baseURL, post, get, hold, start, nextSlotDate, commerce, details, evidence, save, stop,
      createUpgrade,
      loseOrderResponse: () => { loseOrderResponse = true; },
      advanceClock: ms => { clockShiftMs += ms; },
      setPaymentStatus, holdRunsOut, restoreClock, reconcile, paymentSucceeded };
  } catch (error) { await stop(); throw error; }
}

if (process.argv.includes("--worker")) {
  const fixture = await createBookingHoldFixture();
  const shutdown = async () => { await fixture.stop(); process.disconnect(); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("disconnect", () => { fixture.stop(); });
  const forwardedMethods = ["get", "setPaymentStatus", "holdRunsOut", "restoreClock", "reconcile", "paymentSucceeded",
    "loseOrderResponse", "advanceClock", "createUpgrade"];
  process.on("message", async ({ id, method, args = [] }) => {
    try {
      let value;
      if (method === "post") value = await fixture.post(...args);
      else if (forwardedMethods.includes(method)) {
        value = (await fixture[method](...args)) ?? null;
      }
      else if (method === "createCoupon") {
        value = await fixture.commerce.createIfNotExists({ _id: `coupon.${args[0]}`, _type: "coupon", code: args[0],
          isActive: true, discountType: "percent", discountPercent: args[1] ?? 20, canCombineWithReferral: true,
          timesUsed: 0, activeReservations: 0, maxUses: 0, backendOwner: "supabase", cutoverGeneration: 0 });
      }
      else if (method === "setPaymentProvider") {
        Object.assign(process.env, {
          PAYPAL_CLIENT_ID: args[0] === "paypal" ? "fixture-client" : "",
          PAYPAL_CLIENT_SECRET: args[0] === "paypal" ? "fixture-secret" : "",
          RAZORPAY_KEY_ID: args[0] === "razorpay" ? "rzp_test_fixture" : "",
          RAZORPAY_KEY_SECRET: args[0] === "razorpay" ? "fixture-secret" : "",
        });
        value = null;
      }
      else if (method === "nextSlotDate") value = fixture.nextSlotDate();
      else if (method === "getHold") value = await fixture.commerce.getDocument(...args);
      else if (method === "expirePayment") {
        const record = await fixture.commerce.fetch('*[_type == "paymentRecord" && providerOrderId == $id][0]',
          { id: args[0] });
        value = await fixture.commerce.patch(record._id).set({ sessionExpiresAt: new Date(Date.now() - 1000).toISOString() })
          .commit();
      }
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
