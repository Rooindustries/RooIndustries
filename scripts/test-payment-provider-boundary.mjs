#!/usr/bin/env node
// Exercise production provider-client HTTP contracts against an isolated local fixture.
// All credentials are synthetic. Unexpected upstream hosts are rejected before I/O.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";

process.env.NODE_ENV = "test";
process.env.VERCEL_ENV = "development";
process.env.PAYPAL_ENV = "sandbox";
process.env.PAYPAL_CLIENT_ID = "isolated-provider-client";
process.env.PAYPAL_CLIENT_SECRET = "isolated-provider-secret";
process.env.PAYPAL_WEBHOOK_ID = "isolated-provider-webhook";
delete process.env.ALLOW_LIVE_PAYMENTS_IN_DEVELOPMENT;

const upstreamFetch = globalThis.fetch;
const requests = [];
let rejectToken = false;
let rejectOrder = false;
let captureStatus = "COMPLETED";
let tokenNumber = 0;
const delayMs = 10;
const server = http.createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  requests.push({ method: req.method, path: req.url });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  let status = 200;
  let body;
  if (req.url === "/v1/oauth2/token") {
    assert.equal(req.headers.authorization, `Basic ${Buffer.from("isolated-provider-client:isolated-provider-secret").toString("base64")}`);
    assert.equal(text, "grant_type=client_credentials");
    status = rejectToken ? 401 : 200;
    body = rejectToken ? { error: "invalid_client" } : {
      access_token: `isolated-token-${++tokenNumber}`, token_type: "Bearer", expires_in: 3600,
    };
  } else {
    assert.match(req.headers.authorization || "", /^Bearer isolated-token-\d+$/);
    if (req.url === "/v2/checkout/orders" && req.method === "POST") {
      const order = JSON.parse(text);
      assert.equal(order.intent, "CAPTURE");
      assert.equal(order.purchase_units[0].amount.value, "79.95");
      assert.equal(req.headers["paypal-request-id"], "isolated-order-command");
      body = { id: "isolated-order", status: "CREATED" };
    } else if (req.url === "/v2/checkout/orders/isolated-order") {
      status = rejectOrder ? 401 : 200;
      body = rejectOrder ? { error: "invalid_token" } : {
        id: "isolated-order", status: "COMPLETED",
        payer: { email_address: "customer@example.invalid", payer_id: "isolated-payer" },
        purchase_units: [{ payments: { captures: [{ id: "isolated-capture", status: captureStatus, amount: { value: "79.95", currency_code: "USD" } }] } }],
      };
    } else if (req.url === "/v1/notifications/verify-webhook-signature") {
      const event = JSON.parse(text);
      assert.equal(event.webhook_id, "isolated-provider-webhook");
      assert.equal(event.webhook_event.id, "isolated-event");
      body = { verification_status: "SUCCESS" };
    } else {
      status = 404;
      body = { error: "unexpected_fixture_request" };
    }
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
server.listen(0, "100.127.48.111");
await once(server, "listening");
const localOrigin = `http://100.127.48.111:${server.address().port}`;
let rejectedExternalRequests = 0;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api-m.sandbox.paypal.com") {
    rejectedExternalRequests++;
    throw new Error("External provider request blocked by isolated fixture");
  }
  return upstreamFetch(`${localOrigin}${url.pathname}${url.search}`, init);
};

try {
  const providers = await import("../src/server/api/payment/providerClients.js");
  const results = [];
  const check = async (name, exercise, expectedOAuth, expectedOrders) => {
    requests.length = 0;
    const started = performance.now();
    await exercise();
    const elapsedMs = performance.now() - started;
    const oauth = requests.filter((entry) => entry.path === "/v1/oauth2/token").length;
    const orders = requests.filter((entry) => entry.path.startsWith("/v2/checkout/orders")).length;
    assert.equal(oauth, expectedOAuth, `${name}: OAuth request count`);
    assert.equal(orders, expectedOrders, `${name}: order request count`);
    results.push({ name, passed: true, oauthRequests: oauth, orderRequests: orders, totalRequests: requests.length, elapsedMs: +elapsedMs.toFixed(3) });
  };
  const verify = () => providers.verifyPayPalOrder({ orderId: "isolated-order", expectedAmount: 79.95, expectedCurrency: "USD" });
  await check("server order creation preserves idempotency header", async () => {
    assert.equal((await providers.createPayPalOrder({ amount: 79.95, currency: "USD", requestId: "isolated-order-command" })).orderId, "isolated-order");
  }, 1, 1);
  await check("sequential token acquisitions ignore advertised remaining lifetime", async () => {
    assert.equal((await providers.getPayPalToken()).ok, true);
    assert.equal((await providers.getPayPalToken()).ok, true);
  }, 2, 0);
  await check("concurrent token acquisitions are independent", async () => {
    assert.equal((await Promise.all(Array.from({ length: 4 }, () => providers.getPayPalToken()))).every((result) => result.ok), true);
  }, 4, 0);
  await check("two consecutive capture verifications each authenticate and read", async () => {
    assert.equal((await verify()).ok, true);
    assert.equal((await verify()).ok, true);
  }, 2, 2);
  await check("capture amount mismatch stays unverified", async () => {
    assert.deepEqual(await providers.verifyPayPalOrder({ orderId: "isolated-order", expectedAmount: 80, expectedCurrency: "USD" }), { ok: false, captured: true, reason: "paypal_amount_mismatch" });
  }, 1, 1);
  for (const status of ["PENDING", "DECLINED", "REFUNDED"]) {
    captureStatus = status;
    await check(`${status} capture is not accepted as settled`, async () => {
      assert.equal((await verify()).ok, false);
      assert.equal((await providers.inspectPayPalOrder({ orderId: "isolated-order" })).state, "pending");
    }, 2, 2);
  }
  captureStatus = "COMPLETED";
  rejectOrder = true;
  await check("order auth rejection is returned without a retry", async () => {
    assert.deepEqual(await verify(), { ok: false, reason: "paypal_lookup_auth_failed" });
  }, 1, 1);
  rejectOrder = false;
  rejectToken = true;
  await check("OAuth rejection fails closed before capture lookup", async () => {
    assert.deepEqual(await verify(), { ok: false, reason: "paypal_credentials_invalid" });
  }, 1, 0);
  rejectToken = false;
  await check("webhook event crosses signature verification boundary", async () => {
    assert.deepEqual(await providers.verifyPayPalWebhookSignature({
      rawBody: JSON.stringify({ id: "isolated-event", event_type: "PAYMENT.CAPTURE.COMPLETED" }),
      headers: {
        "paypal-transmission-id": "isolated-transmission", "paypal-transmission-time": "2099-01-05T05:00:00Z",
        "paypal-transmission-sig": "isolated-signature", "paypal-cert-url": "https://example.invalid/cert", "paypal-auth-algo": "SHA256withRSA",
      },
    }), { ok: true });
  }, 1, 0);
  assert.equal(rejectedExternalRequests, 0);
  console.log(JSON.stringify({
    ok: true, integration: "real provider-client fetches to isolated HTTP contract fixture", fixtureDelayPerRequestMs: delayMs,
    providerContacted: false, productionCodeChanged: false, results,
    limits: "No sandbox credentials were available. This proves application request/response behavior, not PayPal service semantics. Two-verification case isolates known calls; real finalize reproduction is separate.",
  }, null, 2));
} finally {
  globalThis.fetch = upstreamFetch;
  await new Promise((resolve) => server.close(resolve));
}
