#!/usr/bin/env node
const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { parse, evaluate } from "groq-js";

for (const key of Object.keys(process.env)) {
  if (/^(SANITY|SUPABASE|PAYPAL|RAZORPAY|DODO_PAYMENTS|REACT_APP_|NEXT_PUBLIC_|ALLOW_LIVE_|RESEND|BOOKING_EMAIL)/.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: "test", VERCEL_ENV: "development", DATA_PRIMARY_BACKEND: "sanity",
  COMMERCE_PRIMARY_BACKEND: "sanity", COMMERCE_FAILOVER_GENERATION: "0",
  SANITY_PROJECT_ID: "isolated", SANITY_DATASET: "isolated", SANITY_WRITE_TOKEN: "isolated-token",
  PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "isolated-client", PAYPAL_CLIENT_SECRET: "isolated-secret",
  PAYPAL_WEBHOOK_ID: "isolated-webhook", RAZORPAY_KEY_ID: "rzp_test_isolated", RAZORPAY_KEY_SECRET: "isolated-secret",
  RAZORPAY_WEBHOOK_SECRET: "isolated-webhook-secret", PAYMENT_SESSION_SECRET: "isolated-session-secret",
  CRON_SECRET: "isolated-cron", DODO_PAYMENTS_ENVIRONMENT: "test_mode", DODO_PAYMENTS_API_KEY: "isolated-dodo",
  DODO_PAYMENTS_WEBHOOK_KEY: `whsec_${Buffer.from("isolated-dodo-secret").toString("base64")}`,
  DODO_PAYMENTS_PRODUCT_ID: "pdt_isolated", DODO_PAYMENTS_RETURN_URL: "https://example.invalid/checkout",
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      if (!specifier.startsWith(".") || !context.parentURL?.startsWith("file:")) throw error;
      for (const suffix of [".js", ".ts", "/index.js"]) {
        const candidate = new URL(`${specifier}${suffix}`, context.parentURL);
        if (fs.existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
      throw error;
    }
  },
});

const documents = new Map();
let revision = 0;
let beforePaymentPatch = null;
let receiptTakeover = false;
let failBookingRefundSync = false;
const clone = (value) => structuredClone(value);
const conflict = () => Object.assign(new Error("fixture revision conflict"), { statusCode: 409 });
const createPatch = (id) => {
  const operation = { id, set: {}, unset: [], delta: {}, revision: null };
  const patch = {
    set(value) { Object.assign(operation.set, value); return this; },
    setIfMissing(value) { for (const [key, entry] of Object.entries(value)) if (documents.get(id)?.[key] === undefined) operation.set[key] = entry; return this; },
    unset(value) { operation.unset.push(...value); return this; },
    ifRevisionId(value) { operation.revision = value; return this; },
    inc(value) { for (const [key, entry] of Object.entries(value)) operation.delta[key] = (operation.delta[key] || 0) + entry; return this; },
    dec(value) { for (const [key, entry] of Object.entries(value)) operation.delta[key] = (operation.delta[key] || 0) - entry; return this; },
    async commit() {
      if (beforePaymentPatch && documents.get(id)?._type === "paymentRecord") {
        const hook = beforePaymentPatch; beforePaymentPatch = null; await hook(id);
      }
      return applyPatch(operation);
    },
    operation,
  };
  return patch;
};
const applyPatch = (operation) => {
  const current = documents.get(operation.id);
  if (!current) throw new Error("fixture document missing");
  if (operation.revision && current._rev !== operation.revision) throw conflict();
  const next = { ...clone(current), ...clone(operation.set), _rev: String(++revision) };
  for (const key of operation.unset) delete next[key];
  for (const [key, delta] of Object.entries(operation.delta)) next[key] = Number(next[key] || 0) + delta;
  documents.set(next._id, next);
  return clone(next);
};
const client = {
  backend: "sanity",
  async fetch(query, params = {}) { return (await evaluate(parse(query), { dataset: [...documents.values()].map(clone), params })).get(); },
  async create(doc) { if (documents.has(doc._id)) throw conflict(); const next = { ...clone(doc), _rev: String(++revision) }; documents.set(doc._id, next); return clone(next); },
  patch: createPatch,
  async delete(id) { documents.delete(id); },
  transaction() {
    const operations = [];
    return {
      patch(id, mutate) { operations.push(mutate(createPatch(id)).operation); return this; },
      create(doc) { operations.push({ create: doc }); return this; },
      delete(id) { operations.push({ delete: id }); return this; },
      async commit() {
        if (failBookingRefundSync && operations.some((op) => op.id === "booking.isolated")) {
          failBookingRefundSync = false;
          throw new Error("fixture booking refund sync failure");
        }
        const snapshot = new Map([...documents].map(([id, value]) => [id, clone(value)]));
        try {
          for (const op of operations) {
            if (op.create) await client.create(op.create);
            else if (op.delete) documents.delete(op.delete);
            else applyPatch(op);
          }
          if (receiptTakeover && operations.some((op) => op.id === "booking.isolated")) {
            receiptTakeover = false;
            const receipt = [...documents.values()].find((doc) => doc._type === "paymentWebhookReceipt");
            documents.set(receipt._id, { ...receipt, leaseId: "new-lease-owner", leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), _rev: String(++revision) });
          }
        } catch (error) { documents.clear(); for (const [id, value] of snapshot) documents.set(id, value); throw error; }
        return [];
      },
    };
  },
};

let paypalOrder;
let razorpayPayment;
let paypalCapture;
let verificationHttpStatus;
let verificationThrow;
let dodoPayment;
let dodoRefund;
const reset = () => {
  documents.clear(); beforePaymentPatch = null; receiptTakeover = false; failBookingRefundSync = false;
  paypalOrder = { id: "order-isolated", status: "COMPLETED", intent: "CAPTURE", purchase_units: [{ amount: { value: "9.99", currency_code: "USD" }, payments: { captures: [{ id: "capture-isolated", status: "COMPLETED", amount: { value: "9.99", currency_code: "USD" } }] } }] };
  razorpayPayment = { id: "payment-isolated", order_id: "order-isolated", status: "captured", captured: true, amount: 999, currency: "USD", amount_refunded: 0, refund_status: null };
  paypalCapture = { id: "capture-isolated", status: "REFUNDED", amount: { value: "9.99", currency_code: "USD" }, supplementary_data: { related_ids: { order_id: "order-isolated" } } };
  verificationHttpStatus = 200; verificationThrow = false;
  dodoPayment = { payment_id: "payment-isolated", checkout_session_id: "order-isolated", metadata: { paymentRecordId: "paymentRecord.isolated" }, status: "succeeded", currency: "USD", total_amount: 999, tax: 0, product_cart: [{ product_id: "pdt_isolated", quantity: 1 }], disputes: [], refunds: [], refund_status: null, customer: { email: "customer@example.invalid" } };
  dodoRefund = { refund_id: "refund-isolated", payment_id: "payment-isolated", amount: 999, currency: "USD", status: "succeeded", is_partial: false };
};
const seed = async (provider = "paypal", status = "booked", changes = {}) => {
  await client.create({ _id: "booking.isolated", _type: "booking", status: "captured", netAmount: 9.99, commissionAmount: 1, ...changes.booking });
  return client.create({ _id: "paymentRecord.isolated", _type: "paymentRecord", provider, backendOwner: "sanity", cutoverGeneration: 0, status,
    providerOrderId: "order-isolated", providerPaymentId: "capture-isolated", bookingId: "booking.isolated",
    bookingPayload: { packageTitle: "Vertex Essentials", email: "customer@example.invalid", startTimeUTC: "2099-01-01T10:00:00.000Z" },
    pricingFingerprint: "isolated-fingerprint", pricingSnapshot: { netAmount: 9.99 },
    providerPublicData: { currency: "USD", productId: "pdt_isolated", environment: "test_mode", taxInclusive: false, totalAmount: 999 },
    sessionExpiresAt: "2099-01-01T10:00:00.000Z", emailDispatch: { allSent: true }, ...changes.record });
};
let flow;
let access;
const upstreamFetch = globalThis.fetch;
const requests = [];
const fixtureErrors = [];
const server = http.createServer(async (req, res) => {
  try {
    let rawBody = ""; for await (const chunk of req) rawBody += chunk;
    requests.push({ method: req.method, path: req.url });
    let body;
    let status = 200;
    if (req.url === "/v1/oauth2/token") body = { access_token: "isolated-access", expires_in: 3600 };
    else if (req.url === "/v2/checkout/orders/order-isolated") body = paypalOrder;
    else if (req.url === "/v2/payments/captures/capture-isolated") body = paypalCapture;
    else if (req.url === "/v1/payments/payment-isolated") body = razorpayPayment;
    else if (req.url === "/v1/orders/order-isolated/payments") body = { items: [razorpayPayment] };
    else if (req.url === "/payments/payment-isolated") body = dodoPayment;
    else if (req.url === "/refunds/refund-isolated") body = dodoRefund;
    else if (req.url === "/checkouts/order-isolated") body = { id: "order-isolated", payment_id: "payment-isolated" };
    else if (req.url === "/v1/notifications/verify-webhook-signature") {
      if (verificationThrow) { req.socket.destroy(); return; }
      status = verificationHttpStatus; body = { verification_status: "SUCCESS" };
    } else if (req.url.startsWith("/flow/")) {
      const input = rawBody ? JSON.parse(rawBody) : {};
      const action = req.url.slice(6);
      const args = { ...input, client };
      if (action === "paypal") body = await flow.handlePayPalWebhook(args);
      else if (action === "razorpay") body = await flow.handleRazorpayWebhook(args);
      else if (action === "dodo") body = await flow.handleDodoWebhook(args);
      else if (action === "finalize") body = await flow.finalizePaymentSession(args);
      else if (action === "cancel") body = await flow.cancelPaymentSession(args);
      else if (action === "reconcile") body = await flow.reconcilePaymentSessions(args);
      else throw new Error("unexpected flow action");
      status = body.httpStatus; body = body.body;
    } else throw new Error(`unexpected fixture path: ${req.url}`);
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body));
  } catch (error) {
    fixtureErrors.push(String(error?.code || error?.message || error));
    if (!res.destroyed) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, fixtureError: String(error?.code || error?.message || error) })); }
  }
});
server.listen(0, testHost);
await once(server, "listening");
const origin = `http://${testHost}:${server.address().port}`;
let blockedNetwork = 0;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (!["https://api-m.sandbox.paypal.com", "https://api.razorpay.com", "https://test.dodopayments.com"].includes(url.origin)) {
    blockedNetwork++; throw new Error("non-fixture network blocked");
  }
  return upstreamFetch(`${origin}${url.pathname}${url.search}`, { ...init, signal: init?.signal || AbortSignal.timeout(3000) });
};
const requestFlow = async (action, input) => {
  const response = await upstreamFetch(`${origin}/flow/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.json() };
};
const paypalReq = (type, resource, id = "event-isolated") => {
  const event = { id, event_type: type, resource };
  return { body: event, rawBody: JSON.stringify(event), headers: { "paypal-transmission-id": "transmission-isolated", "paypal-transmission-time": new Date().toISOString(), "paypal-transmission-sig": "signature-isolated", "paypal-cert-url": "https://example.invalid/cert", "paypal-auth-algo": "SHA256withRSA" } };
};
const razorpayReq = (type, refund) => {
  const event = { event: type, payload: { refund: { entity: refund } } };
  const rawBody = JSON.stringify(event);
  return { body: event, rawBody, headers: { "x-razorpay-signature": crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex") } };
};
const dodoReq = () => {
  const event = { business_id: "business-isolated", type: "payment.succeeded", timestamp: new Date().toISOString(), data: dodoPayment };
  const rawBody = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = "event-isolated";
  const signature = crypto.createHmac("sha256", Buffer.from("isolated-dodo-secret"))
    .update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return { body: event, rawBody, headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` } };
};
const getRecord = () => clone(documents.get("paymentRecord.isolated"));
const results = [];
const only = process.argv.find((value) => value.startsWith("--scenario="))?.slice(11);
const check = async (name, exercise) => {
  if (only && name !== only) return;
  reset(); requests.length = 0; fixtureErrors.length = 0;
  try { await exercise(); assert.equal(fixtureErrors.length, 0); results.push({ name, passed: true, requests: requests.length }); }
  catch (error) { results.push({ name, passed: false, error: String(error?.message || error), requests: requests.length, fixtureErrors: [...fixtureErrors] }); }
};
try {
  const providers = await import("../src/server/api/payment/providerClients.js");
  flow = await import("../src/server/api/payment/flow.js");
  access = await import("../src/server/api/payment/accessToken.js");
  const verifyPayPal = (extra = {}) => providers.verifyPayPalOrder({ orderId: "order-isolated", expectedAmount: 9.99, expectedCurrency: "USD", ...extra });
  const verifyRazorpay = (extra = {}) => providers.verifyRazorpayPayment({ orderId: "order-isolated", paymentId: "payment-isolated", expectedAmount: 9.99, expectedCurrency: "USD", ...extra });
  const tokenFor = (record) => access.createPaymentAccessToken({ paymentRecordId: record._id, provider: record.provider, pricingFingerprint: record.pricingFingerprint, backend: "sanity", expirySeconds: 600 });
  await check("paypal-exact-capture", async () => assert.equal((await verifyPayPal()).ok, true));
  for (const value of ["9.98", "10.00", "9.991", "", "NaN", "$9.99", "9,99"]) {
    await check(`paypal-reject-amount-${value || "missing"}`, async () => { paypalOrder.purchase_units[0].payments.captures[0].amount.value = value; assert.equal((await verifyPayPal()).ok, false); });
  }
  for (const expectedAmount of [0, NaN, Infinity, -1]) await check(`paypal-reject-expected-${expectedAmount}`, async () => assert.equal((await verifyPayPal({ expectedAmount })).ok, false));
  await check("paypal-order-identity", async () => { paypalOrder.id = "other-order"; assert.equal((await verifyPayPal()).ok, false); assert.equal((await providers.inspectPayPalOrder({ orderId: "order-isolated" })).state, "unavailable"); });
  await check("paypal-capture-identity", async () => assert.equal((await verifyPayPal({ expectedPaymentId: "other-capture" })).ok, false));
  for (const status of ["PENDING", "DECLINED", "REFUNDED", "PARTIALLY_REFUNDED"]) await check(`paypal-${status.toLowerCase()}`, async () => { paypalOrder.purchase_units[0].payments.captures[0].status = status; const proof = await verifyPayPal(); assert.equal(proof.ok, status === "PARTIALLY_REFUNDED"); if (status === "PARTIALLY_REFUNDED") { assert.equal(proof.refundStatus, "partial"); assert.equal(proof.refundDetailsMissing, false); assert.equal(proof.amountRefundedInSubunits, 0); assert.deepEqual(proof.refunds, []); } });
  await check("paypal-multiple-captures", async () => { paypalOrder.purchase_units[0].payments.captures.push({ id: "capture-other", status: "COMPLETED", amount: { value: "1.00", currency_code: "USD" } }); assert.equal((await verifyPayPal()).ok, false); });
  await check("razorpay-exact-capture", async () => assert.equal((await verifyRazorpay()).ok, true));
  await check("razorpay-payment-identity", async () => { razorpayPayment.id = "other-payment"; assert.equal((await verifyRazorpay()).ok, false); assert.equal((await providers.inspectRazorpayPayment({ paymentId: "payment-isolated" })).state, "unavailable"); });
  await check("razorpay-captured-contradiction", async () => { razorpayPayment.captured = false; assert.equal((await verifyRazorpay()).ok, false); });
  await check("razorpay-three-decimal-subunits", async () => { for (const currency of ["KWD", "BHD", "OMR"]) assert.equal(providers.toSubunits(9.99, currency), 9990); });
  await check("razorpay-unicode-signatures", async () => { for (const signature of ["é".repeat(64), "a".repeat(63), "", "z".repeat(64)]) { assert.equal(providers.verifyRazorpaySignature({ orderId: "order-isolated", paymentId: "payment-isolated", signature, secret: "isolated-secret" }), false); assert.equal(providers.verifyRazorpayWebhookSignature({ rawBody: "{}", signature, secret: "isolated-secret" }), false); } });
  await check("terminal-finalize-different-proof", async () => { const record = await seed(); const result = await requestFlow("finalize", { paymentAccessToken: tokenFor(record), body: { paypalOrderId: "other-order" } }); assert.equal(result.status, 409); });
  await check("paypal-refund-up-link", async () => { await seed("paypal", "booked", { record: { providerPaymentId: "" } }); const result = await requestFlow("paypal", { req: paypalReq("PAYMENT.CAPTURE.REFUNDED", { id: "refund-isolated", status: "COMPLETED", amount: { value: "9.99", currency_code: "USD" }, links: [{ rel: "up", method: "GET", href: "https://api-m.paypal.com/v2/payments/captures/capture-isolated" }] }) }); assert.equal(result.status, 200); assert.equal(getRecord().status, "refunded"); assert.equal(documents.get("booking.isolated").status, "refunded"); assert.equal([...documents.values()].filter((doc) => doc._type === "paymentRecord").length, 1); });
  await check("paypal-reversal-resource-capture", async () => { await seed(); const result = await requestFlow("paypal", { req: paypalReq("PAYMENT.CAPTURE.REVERSED", { id: "capture-isolated", status: "REFUNDED", amount: { value: "9.99", currency_code: "USD" } }) }); assert.equal(result.status, 200); assert.equal(getRecord().status, "refunded"); assert.equal(documents.get("booking.isolated").status, "refunded"); });
  await check("paypal-refund-missing-identity", async () => { await seed(); const result = await requestFlow("paypal", { req: paypalReq("PAYMENT.CAPTURE.REFUNDED", { id: "refund-isolated", status: "COMPLETED", amount: { value: "9.99", currency_code: "USD" } }) }); assert.ok(result.status >= 400); assert.equal([...documents.values()].filter((doc) => doc._type === "paymentRecord").length, 1); assert.equal(getRecord().status, "booked"); });
  for (const code of [500, 429]) await check(`paypal-webhook-verification-${code}`, async () => { verificationHttpStatus = code; const result = await requestFlow("paypal", { req: paypalReq("PAYMENT.CAPTURE.COMPLETED", { id: "capture-isolated" }) }); assert.equal(result.status, 503); assert.equal(documents.size, 0); });
  await check("paypal-webhook-verification-disconnect", async () => { verificationThrow = true; const result = await requestFlow("paypal", { req: paypalReq("PAYMENT.CAPTURE.COMPLETED", { id: "capture-isolated" }) }); assert.equal(result.status, 503); assert.equal(documents.size, 0); });
  const refund = (amount = 200, status = "processed", extra = {}) => ({ id: "refund-isolated", payment_id: "payment-isolated", amount, currency: "USD", status, ...extra });
  const sendRefund = (value) => requestFlow("razorpay", { req: razorpayReq(`refund.${value.status === "pending" ? "created" : value.status}`, value) });
  await check("refund-monotonic-replay", async () => { await seed("razorpay", "booked", { record: { providerPaymentId: "payment-isolated" } }); for (const status of ["pending", "processed", "pending", "failed", "processed"]) assert.equal((await sendRefund(refund(200, status))).status, 200); assert.equal(getRecord().refundProcessedAmountInSubunits, 200); assert.equal(getRecord().refunds.length, 1); assert.equal(getRecord().refundState, "partial"); });
  await check("refund-same-id-different-amount", async () => { await seed("razorpay", "booked", { record: { providerPaymentId: "payment-isolated" } }); await sendRefund(refund()); const result = await sendRefund(refund(999)); assert.equal(result.status, 409); assert.equal(getRecord().refundProcessedAmountInSubunits, 200); assert.equal(getRecord().status, "booked"); });
  await check("refund-legacy-key-different-amount", async () => {
    const entry = { _key: crypto.createHash("sha256").update("razorpay:refund-isolated").digest("hex").slice(0, 24), providerRefundId: "", providerPaymentId: "payment-isolated", status: "processed", amountInSubunits: 200, currency: "USD" };
    await seed("razorpay", "booked", { record: { providerPaymentId: "payment-isolated", refunds: [entry], refundProcessedAmountInSubunits: 200 } });
    assert.equal((await sendRefund(refund(999))).status, 409);
    assert.equal(getRecord().refundProcessedAmountInSubunits, 200);
    assert.deepEqual(getRecord().refunds, [entry]);
    assert.equal(documents.get("booking.isolated").status, "captured");
  });
  await check("refund-hash-key-different-identity", async () => {
    const entry = { _key: crypto.createHash("sha256").update("razorpay:refund-isolated").digest("hex").slice(0, 24), providerRefundId: "refund-other", providerPaymentId: "payment-isolated", status: "processed", amountInSubunits: 200, currency: "USD" };
    await seed("razorpay", "booked", { record: { providerPaymentId: "payment-isolated", refunds: [entry], refundProcessedAmountInSubunits: 200 } });
    assert.equal((await sendRefund(refund(200))).status, 409);
    assert.deepEqual(getRecord().refunds, [entry]);
    assert.equal(getRecord().refundProcessedAmountInSubunits, 200);
  });
  await check("refund-legacy-key-monotonic-replay", async () => {
    const entry = { _key: crypto.createHash("sha256").update("razorpay:refund-isolated").digest("hex").slice(0, 24), providerRefundId: "", providerPaymentId: "payment-isolated", status: "processed", amountInSubunits: 200, currency: "USD" };
    await seed("razorpay", "booked", { record: { providerPaymentId: "payment-isolated", refunds: [entry], refundProcessedAmountInSubunits: 200 } });
    assert.equal((await sendRefund(refund(200, "pending"))).status, 200);
    assert.equal(getRecord().refundProcessedAmountInSubunits, 200);
    assert.equal(getRecord().refunds.length, 1);
    assert.equal(getRecord().refunds[0].status, "processed");
  });
  for (const provider of ["paypal", "razorpay"]) for (const recovery of [false, true]) {
    await check(`${provider}-two-partials-full-${recovery ? "reconcile" : "accounting"}`, async () => {
      await seed(provider, "booked", { record: { providerPaymentId: provider === "paypal" ? "capture-isolated" : "payment-isolated" } });
      const send = (id, value, eventId = id) => provider === "paypal"
        ? requestFlow("paypal", { req: paypalReq("PAYMENT.CAPTURE.REFUNDED", { id, status: "COMPLETED", supplementary_data: { related_ids: { capture_id: "capture-isolated" } }, amount: { value, currency_code: "USD" } }, eventId) })
        : sendRefund(refund(Math.round(Number(value) * 100), "processed", { id }));
      assert.equal((await send("refund-first", "4.99")).status, 200);
      assert.equal(documents.get("booking.isolated").status, "captured");
      failBookingRefundSync = recovery;
      assert.equal((await send("refund-second", "5.00")).status, recovery ? 202 : 200);
      if (recovery) {
        assert.equal(getRecord().refundRequiresBookingSync, true);
        assert.equal(documents.get("booking.isolated").status, "captured");
        assert.equal((await requestFlow("reconcile", { req: { headers: { authorization: "Bearer isolated-cron" } } })).status, 200);
      }
      const verify = () => {
        assert.equal(getRecord().refundProcessedAmountInSubunits, 999);
        assert.equal(getRecord().refunds.length, 2);
        assert.equal(documents.get("booking.isolated").status, "refunded");
        assert.equal(documents.get("booking.isolated").refundStatus, "full");
        assert.equal(documents.get("booking.isolated").refundedAmount, 9.99);
        assert.equal(documents.get("booking.isolated").commissionAmount, 1);
      };
      verify();
      await send("refund-first", "4.99", "replay-first");
      await send("refund-second", "5.00", "replay-second");
      verify();
    });
  }
  await check("refund-conflict-rechecks-binding", async () => { await seed("razorpay", "booked", { record: { providerPaymentId: "payment-isolated" } }); beforePaymentPatch = async (id) => { const record = documents.get(id); documents.set(id, { ...record, providerPaymentId: "other-payment", _rev: String(++revision) }); }; const result = await sendRefund(refund(999)); assert.equal(result.status, 409); assert.equal(getRecord().refunds, undefined); assert.equal(documents.get("booking.isolated").status, "captured"); });
  await check("refund-order-payment-disagreement", async () => { await seed(); const result = await requestFlow("paypal", { req: paypalReq("PAYMENT.CAPTURE.REFUNDED", { id: "refund-isolated", status: "COMPLETED", supplementary_data: { related_ids: { order_id: "order-isolated", capture_id: "other-capture" } }, amount: { value: "9.99", currency_code: "USD" } }) }); assert.equal(result.status, 409); assert.equal(getRecord().status, "booked"); });
  await check("refund-requires-present-currency", async () => { await seed("razorpay", "booked", { record: { providerPaymentId: "payment-isolated", providerPublicData: {} } }); const result = await sendRefund(refund(999, "processed", { currency: "" })); assert.equal(result.status, 409); assert.equal(getRecord().refunds, undefined); assert.equal(documents.get("booking.isolated").status, "captured"); });
  await check("refund-101-distinct-cents", async () => {
    const refunds = Array.from({ length: 100 }, (_, i) => ({ _key: `refund-${i}`, providerRefundId: `refund-${i}`, providerPaymentId: "payment-isolated", amountInSubunits: 1, currency: "USD", status: "processed" }));
    await seed("razorpay", "booked", { record: { providerPaymentId: "payment-isolated", pricingSnapshot: { netAmount: 1.01 }, refunds }, booking: { netAmount: 1.01 } });
    assert.equal((await sendRefund(refund(1, "processed", { id: "refund-101" }))).status, 200);
    assert.equal(getRecord().refundProcessedAmountInSubunits, 101);
    assert.equal(getRecord().refunds.length, 101);
    assert.equal(documents.get("booking.isolated").status, "refunded");
  });
  await check("webhook-old-owner-cannot-complete-new-lease", async () => {
    await seed("razorpay", "booked", { record: { providerPaymentId: "payment-isolated" } }); receiptTakeover = true;
    assert.equal((await sendRefund(refund(999))).status, 200);
    const receipt = [...documents.values()].find((doc) => doc._type === "paymentWebhookReceipt");
    assert.equal(receipt.leaseId, "new-lease-owner"); assert.equal(receipt.status, "processing");
  });
  await check("dodo-processed-event-rechecks-new-state", async () => {
    await seed("dodo", "booked", { record: { providerPaymentId: "payment-isolated" } });
    const req = dodoReq(); assert.equal((await requestFlow("dodo", { req })).status, 200);
    dodoPayment.refund_status = "partial";
    dodoPayment.refunds = [{ refund_id: "refund-partial", payment_id: "payment-isolated", amount: 200, currency: "USD", status: "succeeded", is_partial: true }];
    assert.equal((await requestFlow("dodo", { req })).status, 200);
    assert.equal(getRecord().refundProcessedAmountInSubunits, 200);
    assert.equal(documents.get("booking.isolated").refundedAmount, 2);
    dodoPayment.refund_status = "full";
    dodoPayment.refunds.push({ refund_id: "refund-rest", payment_id: "payment-isolated", amount: 799, currency: "USD", status: "succeeded", is_partial: true });
    assert.equal((await requestFlow("dodo", { req })).status, 200);
    assert.equal(getRecord().refundProcessedAmountInSubunits, 999);
    assert.equal(documents.get("booking.isolated").status, "refunded");
    assert.equal(getRecord().refunds.length, 2);
  });
  await check("dodo-refund-replay-after-receipt-rebuild", async () => {
    await seed("dodo", "booked", { record: { providerPaymentId: "payment-isolated" } });
    dodoPayment.refund_status = "full";
    dodoPayment.refunds = [{ ...dodoRefund, refund_id: "refund-first", amount: 200, is_partial: true }, { ...dodoRefund, refund_id: "refund-rest", amount: 799, is_partial: true }];
    const req = dodoReq();
    assert.equal((await requestFlow("dodo", { req })).status, 200);
    for (const [id, value] of documents) if (value._type === "paymentWebhookReceipt") documents.delete(id);
    assert.equal((await requestFlow("dodo", { req })).status, 200);
    assert.equal(getRecord().refundProcessedAmountInSubunits, 999);
    assert.equal(getRecord().refunds.length, 2);
    assert.equal(documents.get("booking.isolated").refundedAmount, 9.99);
    assert.equal(documents.get("booking.isolated").status, "refunded");
    assert.equal([...documents.values()].filter((doc) => doc._type === "paymentWebhookReceipt").length, 1);
  });
  await check("dodo-full-refund-summary-without-items", async () => { const record = await seed("dodo", "started", { record: { providerPaymentId: "payment-isolated", bookingId: "" } }); dodoPayment.refund_status = "full"; const result = await requestFlow("finalize", { paymentAccessToken: tokenFor(record), body: {} }); assert.notEqual(result.body.status, "booked"); assert.notEqual(result.body.status, "email_partial"); assert.notEqual(getRecord().verificationState, "server_verified"); });
  await check("dodo-cancel-full-refund-summary", async () => { const record = await seed("dodo", "started", { record: { providerPaymentId: "payment-isolated", bookingId: "" } }); dodoPayment.refund_status = "full"; await requestFlow("cancel", { paymentAccessToken: tokenFor(record) }); assert.notEqual(getRecord().verificationState, "server_verified"); });
  await check("dodo-reconcile-finalizing-full-refund-summary", async () => { await seed("dodo", "finalizing", { record: { providerPaymentId: "payment-isolated", bookingId: "", emailDispatchRequired: false, createdAt: new Date(Date.now() - 600000).toISOString(), finalizationLeaseExpiresAt: "" } }); dodoPayment.refund_status = "full"; assert.equal((await requestFlow("reconcile", { req: { headers: { authorization: "Bearer isolated-cron" } } })).status, 200); assert.notEqual(getRecord().verificationState, "server_verified"); });
  await check("dodo-optional-refund-fields-retrieve-detail", async () => {
    await seed("dodo", "booked", { record: { providerPaymentId: "payment-isolated" } });
    dodoPayment.refund_status = "full"; dodoPayment.refunds = [{ ...dodoRefund, amount: null, currency: null }];
    assert.equal((await requestFlow("dodo", { req: dodoReq() })).status, 200);
    assert.equal(getRecord().status, "refunded"); assert.equal(documents.get("booking.isolated").status, "refunded");
  });
  await check("dodo-optional-refund-fields-bounded-manual-recovery", async () => {
    await seed("dodo", "booked", { record: { providerPaymentId: "payment-isolated" } });
    dodoRefund.amount = null; dodoRefund.currency = null; dodoRefund.is_partial = true;
    dodoPayment.refund_status = "partial"; dodoPayment.refunds = [dodoRefund];
    const req = dodoReq(); assert.equal((await requestFlow("dodo", { req })).status, 200);
    assert.equal(getRecord().providerRecoveryTerminal, true);
    assert.equal(getRecord().recoveryReason, "dodo_refund_details_incomplete");
    assert.equal(getRecord().refundProcessedAmountInSubunits, undefined);
    assert.equal(documents.get("booking.isolated").status, "captured");
    assert.equal((await requestFlow("dodo", { req })).status, 200);
    assert.equal([...documents.values()].filter((doc) => doc._type === "paymentWebhookReceipt").length, 1);
  });
  assert.ok(results.length > 0, "unknown scenario");
  assert.equal(blockedNetwork, 0, "all requests must stay in the fixture");
  const artifact = path.resolve(process.env.ROO_PAYMENT_SWEEP_ARTIFACT || "test-results/payment-sweep.json");
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  const evidence = { ok: results.every((entry) => entry.passed), providerContacted: false, fixture: "local HTTP, real provider clients and exported payment workflow, GROQ document/revision fixture", limits: "No provider service or PostgreSQL/Sanity deployment semantics exercised; production Next route runtime is not started.", results };
  fs.writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ...evidence, artifact }, null, 2));
  if (!evidence.ok) process.exitCode = 1;
} finally {
  globalThis.fetch = upstreamFetch;
  await new Promise((resolve) => server.close(resolve));
}
