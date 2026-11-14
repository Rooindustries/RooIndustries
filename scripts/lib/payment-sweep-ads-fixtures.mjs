import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const sweepRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const sandboxOrigin = "https://api-m.sandbox.paypal.com";
export const fixtureMail = { FROM_EMAIL: "noreply@example.invalid", OWNER_EMAIL: "owner@example.invalid" };

export const sqlFilePath = (folder, name) => path.join(sweepRoot, "supabase", folder, name);
export const readRollback = (name) => fs.readFileSync(sqlFilePath("rollbacks", name), "utf8");

export const psqlFile = (fixture, file) => spawnSync(path.join(fixture.pgBin, "psql"), [
  "-X", "-q", "-v", "ON_ERROR_STOP=0", "-h", fixture.host, "-p", String(fixture.pgPort),
  "-U", os.userInfo().username, "-d", "postgres", "-f", file,
], { encoding: "utf8" });

export const withEnv = async (values, fn) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

export const captureConsole = async (stream, fn) => {
  const lines = [];
  const original = console[stream];
  console[stream] = (...values) => {
    lines.push(values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console[stream] = original;
  }
};

export const recordProviderCalls = async (fn, hostSuffixes = ["paypal.com"]) => {
  const calls = [];
  const sweepFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (hostSuffixes.some((suffix) => url.hostname.endsWith(suffix))) {
      calls.push({ url, authorization: new Headers(init.headers).get("authorization"), body: init.body });
    }
    if (url.href === `${sandboxOrigin}/v2/checkout/orders` && init.method === "POST") {
      return Promise.resolve(Response.json({ id: "order-fixture", status: "CREATED" }, { status: 201 }));
    }
    return sweepFetch(input, init);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = sweepFetch;
  }
};

export const paypalOrders = (calls) =>
  calls.filter((call) => call.url.pathname === "/v2/checkout/orders").map((call) => JSON.parse(call.body));

export const fixturePackage = "Fixture Payment";
export const fixtureStart = "2099-01-01T10:00:00.000Z";

export const seedFixtureSlot = async (ctx) => {
  const { createSupabaseDocumentClient } = await import("../../src/server/supabase/documentClient.js");
  const documents = createSupabaseDocumentClient({ shadowClient: ctx.fixture.client });
  const packageTitle = fixturePackage;
  for (const doc of [
    { _id: "package.payment-integration", _type: "package", title: packageTitle, price: "$9.99" },
    { _id: "6d8a3646-0ed2-44b5-ad45-c5c9d578126a", _type: "bookingSettings",
      dateSlots: [{ date: "2099-01-01", times: ["15:30"] }] },
  ]) {
    const current = await documents.fetch("*[_id == $id][0]", { id: doc._id });
    if (current) await documents.patch(doc._id).ifRevisionId(current._rev).set(doc).commit();
    else await documents.create(doc);
  }
};

const fixtureHold = async (ctx) => {
  const { issueHoldToken } = await import("../../src/server/booking/holdToken.js");
  const expiresAt = new Date(Date.now() + 1_800_000).toISOString();
  const hold = {
    _id: "slotHold.fixture", _type: "slotHold", backendOwner: "supabase", cutoverGeneration: 0,
    startTimeUTC: fixtureStart, packageTitle: fixturePackage, phase: "holding", holdNonce: "fixture-hold-owner",
    expiresAt,
  };
  await ctx.commerce.create(hold);
  return {
    slotHoldId: hold._id,
    slotHoldToken: issueHoldToken({ holdId: hold._id, startTimeUTC: fixtureStart, expiresAt,
      holdNonce: hold.holdNonce, backend: "supabase", cutoverGeneration: 0 }),
  };
};

export const startPayPalCheckout = async (ctx, bookingFields = {}, slotHold = null) => {
  const { resolvePaymentQuote } = await import("../../src/server/api/ref/pricing.js");
  const { buildQuoteFingerprint } = await import("../../src/server/api/payment/paymentRecord.js");
  const packageTitle = fixturePackage;
  await seedFixtureSlot(ctx);
  const bookingPayload = {
    packageTitle, email: "customer@example.invalid", discord: "fixture", specs: "synthetic computer",
    mainGame: "fixture game", localTimeZone: "Asia/Kolkata", startTimeUTC: fixtureStart,
    ...(slotHold || await fixtureHold(ctx)),
    ...bookingFields,
  };
  const quote = await resolvePaymentQuote({ packageTitle, client: ctx.commerce });
  const quoteFingerprint = buildQuoteFingerprint({ bookingPayload, quote });
  const start = () => ctx.requestFlow("start", { body: { provider: "paypal", bookingPayload, quoteFingerprint } });
  return { ...await start(), restart: start };
};

export const postPayPalCaptureWebhook = async ({ origin, paypalReq }) => {
  const { POST } = await import("../../app/api/payment/webhook/paypal/route.js");
  const event = paypalReq("PAYMENT.CAPTURE.COMPLETED", {
    id: "capture-fixture",
    supplementary_data: { related_ids: { order_id: "order-fixture" } },
  });
  const response = await POST(new Request(`${origin}/api/payment/webhook/paypal`, {
    method: "POST",
    headers: { ...event.headers, "content-type": "application/json" },
    body: event.rawBody,
  }));
  return { status: response.status, body: await response.json() };
};
