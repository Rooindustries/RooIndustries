import assert from "node:assert/strict";
import {
  fixtureMail,
  paypalOrders,
  postPayPalCaptureWebhook,
  readRollback,
  recordProviderCalls,
  startPayPalCheckout,
  withEnv,
} from "./payment-sweep-ads-fixtures.mjs";

const journeyId = "5b0f1c9e-3a4d-4e5f-8a6b-7c8d9e0f1a2b";

const v2Input = {
  version: 2,
  journeyId: journeyId.toUpperCase(),
  phone: "919876543210",
  firstTouch: {
    capturedAt: "2026-11-01T09:00:00.000Z", landingPath: "/", referrerHost: "L.Facebook.com",
    source: "meta.ads", medium: "paid  social", campaign: "spring sale", content: "ad+1", term: "2026",
    fbclid: "IwAR.fixture_1", email: "customer@example.invalid",
  },
  lastTouch: {
    capturedAt: "2026-11-10T09:00:00Z", landingPath: "/download/private-token", creatorCode: "friend",
    source: "newsletter", campaign: "winter\u0000 deal", content: "buyer@example.invalid",
    gclid: "Cj0K.fixture-2", fbclid: "not a click id", term: "212-555-0199 212-555-0198",
    medium: "example.com?token=sample",
  },
};

const v2Expected = {
  version: 2,
  journeyId,
  firstTouch: {
    capturedAt: "2026-11-01T09:00:00.000Z", landingPath: "/", referrerHost: "l.facebook.com",
    source: "meta.ads", medium: "paid social", campaign: "spring sale", content: "ad+1", term: "2026",
    fbclid: "IwAR.fixture_1",
  },
  lastTouch: {
    capturedAt: "2026-11-10T09:00:00.000Z", landingPath: "/", creatorCode: "friend",
    source: "newsletter", campaign: "winter deal", gclid: "Cj0K.fixture-2",
  },
};

const v1Input = {
  version: 1, journeyId, capturedAt: "2026-09-11T10:00:00.000Z", landingPath: "/packages",
  creatorCode: "winton", source: "creator", campaign: "vertex-max",
};
const v1Touch = {
  capturedAt: "2026-09-11T10:00:00.000Z", landingPath: "/packages", creatorCode: "winton",
  source: "creator", campaign: "vertex-max",
};

const wide = (offset) => String.fromCodePoint(0x20000 + offset).repeat(100);
const longestTouch = (capturedAt, offset) => ({
  capturedAt, landingPath: "/packages", referrerHost: `${"a".repeat(63)}.${"b".repeat(32)}.com`,
  creatorCode: "friend", source: wide(offset), medium: wide(offset + 1), campaign: wide(offset + 2),
  content: wide(offset + 3), term: wide(offset + 4), fbclid: `IwAR${"1".repeat(196)}`, gclid: `Cj0K${"2".repeat(196)}`,
});
const longestExpected = {
  version: 2,
  journeyId,
  firstTouch: longestTouch("2026-11-01T09:00:00.000Z", 0),
  lastTouch: longestTouch("2026-11-10T09:00:00.000Z", 5),
};
const longestInput = {
  ...longestExpected, lastTouch: { ...longestExpected.lastTouch, term: `${wide(9)}${wide(10)}` },
};

const flood = (unit) => unit.repeat(100_000);
const floodedTouch = (capturedAt) => ({
  capturedAt, landingPath: `/packages${flood("p")}`, referrerHost: `${flood("h")}.com`, creatorCode: flood("c"),
  source: flood("s"), medium: flood("m"), campaign: flood("n"), content: flood("o"), term: flood("t"),
  fbclid: flood("f"), gclid: flood("g"),
});
const cutTouch = (capturedAt) => ({
  capturedAt, landingPath: "/", source: "s".repeat(100), medium: "m".repeat(100), campaign: "n".repeat(100),
  content: "o".repeat(100), term: "t".repeat(100),
});
const paddedTouch = (capturedAt) => ({
  ...floodedTouch(capturedAt), source: `${flood(" ")}spring`, medium: `${flood("\u0000")}summer`,
  campaign: `${flood("<")}autumn`, content: `north${" ".repeat(99_990)}south`, term: `${flood("\u2028")}winter`,
});
const cleanedTouch = (capturedAt) => ({
  capturedAt, landingPath: "/", source: "spring", medium: "summer", campaign: "autumn", content: "north south",
  term: "winter",
});
const floodedInput = {
  version: 2, journeyId,
  firstTouch: floodedTouch("2026-11-01T09:00:00.000Z"), lastTouch: paddedTouch("2026-11-10T09:00:00.000Z"),
};
const floodedExpected = {
  version: 2, journeyId,
  firstTouch: cutTouch("2026-11-01T09:00:00.000Z"), lastTouch: cleanedTouch("2026-11-10T09:00:00.000Z"),
};
const FLOODED_START_MS = 1500;
const attributionMigration = "20261114002000_expose_booking_sales_attribution.sql";

const payWithAttribution = async (ctx, salesAttribution) => {
  const { result: [started, restarted, startMs], calls } = await recordProviderCalls(async () => {
    const began = performance.now();
    const first = await startPayPalCheckout(ctx, { salesAttribution });
    const elapsed = Math.round(performance.now() - began);
    return [first, await first.restart(), elapsed];
  });
  assert.equal(started.status, 200, JSON.stringify(started));
  assert.equal(started.body.checkoutCreated, true, JSON.stringify(started.body));
  assert.equal(restarted.status, 200, JSON.stringify(restarted));
  assert.equal(restarted.body.checkoutCreated, false, JSON.stringify(restarted.body));
  const orders = paypalOrders(calls);
  assert.equal(orders.length, 1, JSON.stringify(started));
  const webhook = await postPayPalCaptureWebhook(ctx);
  assert.equal(webhook.status, 200, JSON.stringify(webhook));
  const finalized = await ctx.requestFlow("finalize", {
    paymentAccessToken: started.body.paymentAccessToken, body: { paypalOrderId: "order-fixture" },
  });
  assert.equal(finalized.status, 200, JSON.stringify(finalized));
  const paymentId = orders[0].purchase_units[0].custom_id;
  const payment = (await ctx.row(paymentId)).payload;
  assert.equal(payment.status, "booked", JSON.stringify(payment));
  const [booking] = await ctx.sql`
    select b.legacy_sanity_id, b.sales_attribution, b.booking_payload -> 'salesAttribution' as payload_attribution
    from commerce.bookings b
    join commerce.payment_records p on p.id = b.payment_record_id
    where p.legacy_sanity_id = ${paymentId} and b.legacy_sanity_id = ${payment.bookingId}`;
  assert.ok(booking, `No booking row is linked to ${paymentId}`);
  return { payment, booking, startMs, receipt: finalized.body.analyticsReceipt };
};

const assertStoredAttribution = async (ctx, input, expected) => {
  const { payment, booking, startMs, receipt } = await withEnv(fixtureMail, () => payWithAttribution(ctx, input));
  assert.deepEqual(payment.bookingPayload.salesAttribution, expected);
  assert.deepEqual(receipt?.attribution, expected, JSON.stringify(receipt));
  assert.deepEqual(booking.sales_attribution, expected);
  assert.deepEqual(booking.payload_attribution, expected);
  const [projected] = await ctx.sql`
    select count(*)::int as matches from commerce.bookings
    where sales_attribution @> ${ctx.sql.json({ journeyId: expected.journeyId })}`;
  assert.equal(projected.matches, 1);
  return { bookingId: booking.legacy_sanity_id, salesAttribution: booking.sales_attribution, startMs };
};

const assertReceiptAttribution = async (ctx, provider) => {
  const checkout = await ctx.a1Start(provider, "normal", { salesAttribution: v2Input });
  const webhook = await ctx.a1Hook(provider);
  assert.equal(webhook.status, 200, JSON.stringify(webhook));
  const finalized = await ctx.requestFlow("finalize", {
    paymentAccessToken: checkout.started.body.paymentAccessToken, body: checkout.proof,
  });
  assert.equal(finalized.status, 200, JSON.stringify(finalized));
  const payment = (await ctx.row(checkout.id)).payload;
  assert.equal(payment.status, "booked", JSON.stringify(payment));
  assert.deepEqual(payment.bookingPayload.salesAttribution, v2Expected);
  assert.deepEqual(finalized.body.analyticsReceipt?.attribution, v2Expected, JSON.stringify(finalized.body));
  return { provider, bookingId: payment.bookingId, receiptAttribution: finalized.body.analyticsReceipt.attribution };
};

export async function registerAttributionScenarios(ctx) {
  if (!process.argv.includes("--full-chain")) return;
  await ctx.run("ads-attribution-persisted", () => assertStoredAttribution(ctx, v2Input, v2Expected));
  for (const provider of ["razorpay", "dodo"]) {
    await ctx.run(`ads-attribution-${provider}-receipt`,
      () => withEnv(fixtureMail, () => assertReceiptAttribution(ctx, provider)));
  }
  await ctx.run("ads-attribution-v1-upgraded", () => assertStoredAttribution(ctx, v1Input, {
    version: 2, journeyId, firstTouch: v1Touch, lastTouch: v1Touch,
  }));
  await ctx.run("ads-attribution-longest-four-byte-labels-kept",
    () => assertStoredAttribution(ctx, longestInput, longestExpected));
  await ctx.run("ads-attribution-flooded-labels-bounded", async () => {
    const stored = await assertStoredAttribution(ctx, floodedInput, floodedExpected);
    assert.ok(stored.startMs < FLOODED_START_MS, `start took ${stored.startMs} ms`);
    return { startMs: stored.startMs, bookingId: stored.bookingId };
  });
  await ctx.run("ads-attribution-rollback-cycle", async () => {
    const salesAttribution = v2Expected;
    await ctx.seed("paypal", "booked", { booking: { salesAttribution } });
    const booking = async () => (await ctx.sql`
      select to_jsonb(b) -> 'sales_attribution' as projected, b.booking_payload -> 'salesAttribution' as payload
      from commerce.bookings b where legacy_sanity_id = 'booking.fixture'`)[0];
    const before = await booking();
    assert.deepEqual(before, { projected: salesAttribution, payload: salesAttribution });
    await ctx.sql.unsafe(readRollback(attributionMigration));
    let rolledBack;
    try {
      rolledBack = await booking();
    } finally {
      if ((await booking())?.projected === null) await ctx.fixture.apply(attributionMigration);
    }
    assert.deepEqual(rolledBack, { projected: null, payload: salesAttribution });
    assert.deepEqual(await booking(), before);
    return { before, rolledBack };
  });
}
