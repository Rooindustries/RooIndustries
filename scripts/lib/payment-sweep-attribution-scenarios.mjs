import assert from "node:assert/strict";
import {
  fixtureMail,
  paypalOrders,
  postPayPalCaptureWebhook,
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
    gclid: "Cj0K.fixture-2", fbclid: "not a click id",
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

const payWithAttribution = async (ctx, salesAttribution) => {
  const { result: started, calls } = await recordProviderCalls(() => startPayPalCheckout(ctx, { salesAttribution }));
  assert.equal(started.status, 200, JSON.stringify(started));
  const orders = paypalOrders(calls);
  assert.equal(orders.length, 1, JSON.stringify(started));
  const webhook = await postPayPalCaptureWebhook(ctx);
  assert.equal(webhook.status, 200, JSON.stringify(webhook));
  const paymentId = orders[0].purchase_units[0].custom_id;
  const payment = (await ctx.row(paymentId)).payload;
  assert.equal(payment.status, "booked", JSON.stringify(payment));
  const [booking] = await ctx.sql`
    select b.legacy_sanity_id, b.sales_attribution, b.booking_payload -> 'salesAttribution' as payload_attribution
    from commerce.bookings b
    join commerce.payment_records p on p.id = b.payment_record_id
    where p.legacy_sanity_id = ${paymentId} and b.legacy_sanity_id = ${payment.bookingId}`;
  assert.ok(booking, `No booking row is linked to ${paymentId}`);
  return { payment, booking };
};

const assertStoredAttribution = async (ctx, input, expected) => {
  const { payment, booking } = await withEnv(fixtureMail, () => payWithAttribution(ctx, input));
  assert.deepEqual(payment.bookingPayload.salesAttribution, expected);
  assert.deepEqual(booking.sales_attribution, expected);
  assert.deepEqual(booking.payload_attribution, expected);
  const [projected] = await ctx.sql`
    select count(*)::int as matches from commerce.bookings
    where sales_attribution @> ${ctx.sql.json({ journeyId: expected.journeyId })}`;
  assert.equal(projected.matches, 1);
  return { bookingId: booking.legacy_sanity_id, salesAttribution: booking.sales_attribution };
};

export async function registerAttributionScenarios(ctx) {
  if (!process.argv.includes("--full-chain")) return;
  await ctx.run("ads-attribution-persisted", () => assertStoredAttribution(ctx, v2Input, v2Expected));
  await ctx.run("ads-attribution-v1-upgraded", () => assertStoredAttribution(ctx, v1Input, {
    version: 2, journeyId, firstTouch: v1Touch, lastTouch: v1Touch,
  }));
}
