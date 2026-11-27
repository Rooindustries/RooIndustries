import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  fixtureMail,
  fixturePackage,
  fixtureStart,
  paypalOrders,
  postPayPalCaptureWebhook,
  readRollback,
  recordProviderCalls,
  seedFixtureSlot,
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
const DAY_MS = 86_400_000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

const refCookie = (entry) => `roo_ref=${encodeURIComponent(JSON.stringify(entry))}`;
const jsonReq = async (origin, path, { method = "POST", headers = {}, body } = {}) => {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};

const cleanCreatorsAndCoupons = async (ctx) => {
  await ctx.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended('cms-reference-integrity', 0))`;
    await tx`delete from commerce.coupon_redemptions`;
    await tx`delete from commerce.coupons`;
    await tx`delete from commerce.referral_ledger`;
    await tx`delete from migration.source_documents where document_type in ('referral', 'coupon', 'couponRedemption', 'couponReservation', 'referralIdentityClaim')`;
  });
};

const createHoldForSlot = async (ctx, { id = "slotHold.fixture", startTimeUTC = fixtureStart, phase = "holding", expiresAt = new Date(Date.now() + 1_800_000).toISOString(), holdNonce = "fixture-hold-owner", paymentRecordId = "" } = {}) => {
  const { issueHoldToken } = await import("../../src/server/booking/holdToken.js");
  await ctx.commerce.create({
    _id: id, _type: "slotHold", backendOwner: "supabase", cutoverGeneration: 0,
    startTimeUTC, packageTitle: fixturePackage, phase, holdNonce, expiresAt,
    ...(paymentRecordId ? { paymentRecordId, paymentProvider: "paypal" } : {}),
  });
  return {
    slotHoldId: id,
    slotHoldToken: issueHoldToken({ holdId: id, startTimeUTC, expiresAt, holdNonce, backend: "supabase", cutoverGeneration: 0 }),
    slotHoldExpiresAt: expiresAt,
  };
};

const baseBookingPayload = (hold, extra = {}) => ({
  packageTitle: fixturePackage, email: "customer@example.invalid", discord: "fixture",
  specs: "synthetic computer", mainGame: "fixture game", localTimeZone: "Asia/Kolkata",
  startTimeUTC: fixtureStart, ...hold, ...extra,
});

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

  await ctx.run("ads-ref-registration-reserved-and-pending-to-active", async () => {
    const { isAllowedRefSource } = await import("../../src/server/api/ref/validateRefAttribution.js");
    try {
      await cleanCreatorsAndCoupons(ctx);
      for (const reserved of ["gads-max", "chatgpt-ads"]) {
        const val = await jsonReq(ctx.origin, `/validate-referral?purpose=registration&code=${reserved}`, { method: "GET" });
        assert.equal(val.status, 200, JSON.stringify(val));
        assert.equal(val.body.ok, false);
        assert.equal(val.body.reason, "reserved");
        const reg = await withEnv(fixtureMail, () => jsonReq(ctx.origin, "/register-route", {
          body: { discordUsername: "creator1", email: `${reserved}@example.invalid`, paypalEmail: `${reserved}@example.invalid`, password: "FixturePassword123!", slug: reserved },
        }));
        assert.equal(reg.status, 409, JSON.stringify(reg));
        assert.equal(reg.body.reason, "reserved");
      }
      const badVal = await jsonReq(ctx.origin, "/validate-referral?purpose=registration&code=promo-2026-11-24", { method: "GET" });
      assert.equal(badVal.status, 400);
      const badReg = await withEnv(fixtureMail, () => jsonReq(ctx.origin, "/register-route", {
        body: { discordUsername: "creator1", email: "bad@example.invalid", paypalEmail: "bad@example.invalid", password: "FixturePassword123!", slug: "promo-2026-11-24" },
      }));
      assert.equal(badReg.status, 400);

      const okVal = await jsonReq(ctx.origin, "/validate-referral?purpose=registration&code=123456", { method: "GET" });
      assert.equal(okVal.status, 200, JSON.stringify(okVal));
      assert.equal(okVal.body.reason, "available", JSON.stringify(okVal));
      const okReg = await withEnv(fixtureMail, () => jsonReq(ctx.origin, "/register-route", {
        body: { discordUsername: "creator123456", email: "c123456@example.invalid", paypalEmail: "c123456@example.invalid", password: "FixturePassword123!", slug: "123456" },
      }));
      assert.equal(okReg.status, 202, JSON.stringify(okReg));
      const pendingDoc = await ctx.documents.fetch(`*[_type == "referral" && lower(slug.current) == "123456"][0]`);
      assert.equal(pendingDoc?.registrationStatus, "pending_email");
      assert.equal(await isAllowedRefSource({ source: "123456", client: ctx.documents }), false);
      await ctx.documents.patch(pendingDoc._id).set({ registrationStatus: "active" }).commit();
      assert.equal(await isAllowedRefSource({ source: "123456", client: ctx.documents }), true);
      return { registeredId: pendingDoc._id, allowedAfterActivation: true };
    } finally {
      await cleanCreatorsAndCoupons(ctx);
    }
  });

  await ctx.run("ads-ref-reserved-rpc-quote-start-legacy-and-mixed", async () => {
    try {
      await cleanCreatorsAndCoupons(ctx);
      await seedFixtureSlot(ctx);
      await ctx.documents.create({
        _id: "referral.valid-friend", _type: "referral", name: "Friend", slug: { current: "friend" },
        registrationStatus: "active", currentDiscountPercent: 10, currentCommissionPercent: 15,
      });
      await ctx.documents.create({
        _id: "coupon.valid-oneuse", _type: "coupon", code: "ONCE10", isActive: true,
        discountType: "percent", discountPercent: 10, maxUses: 1, timesUsed: 0, activeReservations: 0,
        canCombineWithReferral: true,
      });

      const rpcCount = () => ctx.fixture.requestLog.filter((r) => r.rpc === "roo_consume_quote_rate_limit_and_get_pricing").length;
      const quoteRpc = async (body, { expectedRpcReferralCode = null } = {}) => {
        const rpcEvents = [];
        ctx.fixture.setRequestHook((phase, req) => {
          if (phase === "after" && req.path.startsWith("/rest/v1/rpc/")) {
            rpcEvents.push({ rpc: req.path.slice(13), body: req.body, status: req.status, response: req.response });
          }
        });
        try {
          const res = await withEnv({ NODE_ENV: "development", RATE_LIMIT_HASH_SECRET: "fixture-rl-secret" }, () => jsonReq(ctx.origin, "/quote-route", {
            headers: { "x-forwarded-for": `198.51.100.${(rpcCount() % 200) + 1}` },
            body,
          }));
          const quoteCall = rpcEvents.find((e) => e.rpc === "roo_consume_quote_rate_limit_and_get_pricing");
          assert.ok(quoteCall, `Expected combined quote RPC call, saw ${JSON.stringify(rpcEvents)}`);
          assert.equal(quoteCall.response?.rateLimit?.allowed, true, JSON.stringify(quoteCall));
          assert.equal(rpcEvents.some((e) => e.rpc === "roo_consume_rate_limit"), false);
          if (expectedRpcReferralCode !== null) {
            assert.equal(quoteCall.body?.p_referral_code, expectedRpcReferralCode, JSON.stringify(quoteCall.body));
          }
          return res;
        } finally {
          ctx.fixture.setRequestHook(null);
        }
      };
      const runReservedCheck = async (tag, collidingReferralId = "") => {
        const valRef = await jsonReq(ctx.origin, `/validate-referral?code=${tag}`, { method: "GET" });
        assert.equal(valRef.body.ok, false);
        assert.equal(valRef.body.reason, "not_found");
        const valCoup = await jsonReq(ctx.origin, `/validate-coupon?code=${tag}`, { method: "GET" });
        assert.equal(valCoup.body.ok, false);
        assert.equal(valCoup.body.reason, "not_found");

        const beforeRpc = rpcCount();
        const q = await quoteRpc(
          { packageTitle: fixturePackage, referralCode: tag, ...(collidingReferralId ? { referralId: collidingReferralId } : {}) },
          { expectedRpcReferralCode: "" }
        );
        assert.equal(q.status, 200, JSON.stringify(q));
        assert.ok(rpcCount() > beforeRpc, "Expected real roo_consume_quote_rate_limit_and_get_pricing RPC");
        assert.equal(q.body.quote.referralDiscountPercent, 0);
        assert.equal(q.body.quote.commissionPercent, 0);
        assert.equal(q.body.quote.discountPercent, 0);
        assert.equal(q.body.quote.netAmount, 9.99);

        const qWithCoupon = await quoteRpc(
          { packageTitle: fixturePackage, referralCode: tag, ...(collidingReferralId ? { referralId: collidingReferralId } : {}), couponCode: "ONCE10" },
          { expectedRpcReferralCode: "" }
        );
        assert.equal(qWithCoupon.status, 200, JSON.stringify(qWithCoupon));
        assert.equal(qWithCoupon.body.quote.referralDiscountPercent, 0);
        assert.equal(qWithCoupon.body.quote.couponDiscountPercent, 10);
        assert.equal(qWithCoupon.body.quote.netAmount, 8.99);

        const qBadCoupon = await quoteRpc({ packageTitle: fixturePackage, couponCode: tag });
        assert.equal(qBadCoupon.status, 400, JSON.stringify(qBadCoupon));
        assert.equal(qBadCoupon.body.code, "coupon_invalid");
      };

      await runReservedCheck("gads-max");
      await runReservedCheck("chatgpt-ads");

      const legacyNoCollisionHold = await createHoldForSlot(ctx, { id: "slotHold.legacy-nocollide", startTimeUTC: "2099-01-01T10:00:00.000Z", phase: "active" });
      const badLegacyNoCollision = await jsonReq(ctx.origin, "/booking", {
        body: {
          body: {
            status: "captured", email: "customer@example.invalid", discord: "fixture", specs: "pc", mainGame: "cs2",
            packageTitle: fixturePackage, packagePrice: "$9.99", localTimeZone: "Asia/Kolkata",
            startTimeUTC: "2099-01-01T10:00:00.000Z", ...legacyNoCollisionHold,
            couponCode: "gads-max", paymentProvider: "razorpay", razorpayOrderId: "order-fixture", razorpayPaymentId: "payment-fixture",
            razorpaySignature: crypto.createHmac("sha256", "fixture-secret").update("order-fixture|payment-fixture").digest("hex"),
          },
        },
      });
      assert.equal(badLegacyNoCollision.status, 400, JSON.stringify(badLegacyNoCollision));
      assert.equal(badLegacyNoCollision.body.code, "coupon_invalid", JSON.stringify(badLegacyNoCollision));
      assert.equal(badLegacyNoCollision.body.error, "Coupon is invalid.");
      await ctx.commerce.delete("slotHold.legacy-nocollide");

      for (const tag of ["gads-max", "chatgpt-ads"]) {
        await ctx.documents.create({
          _id: `referral.collide-${tag}`, _type: "referral", name: tag, slug: { current: tag },
          registrationStatus: "active", currentDiscountPercent: 25, currentCommissionPercent: 20,
        });
        await ctx.documents.create({
          _id: `coupon.collide-${tag}`, _type: "coupon", code: tag.toUpperCase(), isActive: true,
          discountType: "percent", discountPercent: 30, canCombineWithReferral: true,
        });
      }
      await runReservedCheck("gads-max", "referral.collide-gads-max");
      await runReservedCheck("chatgpt-ads", "referral.collide-chatgpt-ads");

      const beforeMixedRpc = rpcCount();
      const mixed = await quoteRpc(
        { packageTitle: fixturePackage, referralCode: "gads-max", referralId: "referral.valid-friend" },
        { expectedRpcReferralCode: "" }
      );
      const cleanValid = await quoteRpc(
        { packageTitle: fixturePackage, referralId: "referral.valid-friend" },
        { expectedRpcReferralCode: "" }
      );
      assert.ok(rpcCount() >= beforeMixedRpc + 2);
      assert.equal(mixed.status, 200, JSON.stringify(mixed));
      assert.equal(mixed.body.quote.referralDiscountPercent, 10);
      assert.equal(mixed.body.quote.commissionPercent, 15);
      assert.equal(mixed.body.quoteFingerprint, cleanValid.body.quoteFingerprint);

      const holdStart = await createHoldForSlot(ctx, { id: "slotHold.reserved-start" });
      const badStart = await jsonReq(ctx.origin, "/start-route", {
        body: { provider: "paypal", quoteFingerprint: "any", bookingPayload: baseBookingPayload(holdStart, { couponCode: "gads-max" }) },
      });
      assert.equal(badStart.status, 400, JSON.stringify(badStart));
      assert.equal(badStart.body.code, "coupon_invalid");

      const qReserved = await jsonReq(ctx.origin, "/quote-route", {
        body: { packageTitle: fixturePackage, startTimeUTC: fixtureStart, email: "customer@example.invalid", referralCode: "gads-max", referralId: "referral.collide-gads-max" },
      });
      const { result: startRes, calls: startCalls } = await recordProviderCalls(() => jsonReq(ctx.origin, "/start-route", {
        body: {
          provider: "paypal", quoteFingerprint: qReserved.body.quoteFingerprint,
          bookingPayload: baseBookingPayload(holdStart, { referralCode: "gads-max", referralId: "referral.collide-gads-max" }),
        },
      }));
      assert.equal(startRes.status, 200, JSON.stringify(startRes));
      const startedId = paypalOrders(startCalls)[0].purchase_units[0].custom_id;
      const startedRec = (await ctx.row(startedId)).payload;
      assert.equal(startedRec.pricingSnapshot.effectiveReferralCode, "");
      assert.equal(startedRec.pricingSnapshot.effectiveReferralId, "");
      assert.equal(startedRec.pricingSnapshot.referralDiscountPercent, 0);
      assert.equal(startedRec.pricingSnapshot.commissionPercent, 0);

      const legacyHold = await createHoldForSlot(ctx, { id: "slotHold.legacy-reserved", startTimeUTC: "2099-01-02T10:00:00.000Z", phase: "active" });
      await ctx.documents.patch("6d8a3646-0ed2-44b5-ad45-c5c9d578126a").set({
        dateSlots: [{ date: "2099-01-01", times: ["15:30"] }, { date: "2099-01-02", times: ["15:30"] }],
      }).commit();
      const legacyBody = {
        status: "captured", email: "customer@example.invalid", discord: "fixture", specs: "pc", mainGame: "cs2",
        packageTitle: fixturePackage, packagePrice: "$9.99", localTimeZone: "Asia/Kolkata",
        startTimeUTC: "2099-01-02T10:00:00.000Z", ...legacyHold,
        referralCode: "gads-max", referralId: "referral.collide-gads-max", couponCode: "ONCE10",
        paymentProvider: "razorpay", razorpayOrderId: "order-fixture", razorpayPaymentId: "payment-fixture",
        razorpaySignature: crypto.createHmac("sha256", "fixture-secret").update("order-fixture|payment-fixture").digest("hex"),
      };
      const badLegacy = await jsonReq(ctx.origin, "/booking", {
        body: { body: { ...legacyBody, couponCode: "chatgpt-ads" } },
      });
      assert.equal(badLegacy.status, 400, JSON.stringify(badLegacy));
      assert.equal(badLegacy.body.code, "coupon_invalid", JSON.stringify(badLegacy));
      assert.equal(badLegacy.body.error, "Coupon is invalid.");

      const withRazorpayAmount = async (amount, fn) => {
        const prev = globalThis.fetch;
        globalThis.fetch = (input, init = {}) => {
          const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
          if (url.pathname === "/v1/payments/payment-fixture") {
            return Promise.resolve(Response.json({ id: "payment-fixture", order_id: "order-fixture", status: "captured", captured: true, amount, currency: "USD", amount_refunded: 0, refund_status: null }));
          }
          return prev(input, init);
        };
        try { return await fn(); } finally { globalThis.fetch = prev; }
      };
      const firstLegacy = await withEnv(fixtureMail, () => withRazorpayAmount(899, () => jsonReq(ctx.origin, "/booking", { body: { body: legacyBody } })));
      assert.equal(firstLegacy.status, 200, JSON.stringify(firstLegacy));
      const legacyBooking = (await ctx.row(firstLegacy.body.bookingId)).payload;
      assert.equal(legacyBooking.referralCode, "");
      assert.equal(legacyBooking.referral, undefined);
      assert.equal(legacyBooking.commissionPercent, 0);
      assert.equal(legacyBooking.couponDiscountPercent, 10);
      assert.equal(legacyBooking.netAmount, 8.99);

      const replayIdentical = await withEnv(fixtureMail, () => withRazorpayAmount(899, () => jsonReq(ctx.origin, "/booking", { body: { body: legacyBody } })));
      assert.equal(replayIdentical.status, 200, JSON.stringify(replayIdentical));
      assert.equal(replayIdentical.body.bookingId, firstLegacy.body.bookingId);

      const replayChangedRef = await withEnv(fixtureMail, () => withRazorpayAmount(899, () => jsonReq(ctx.origin, "/booking", {
        body: { body: { ...legacyBody, referralCode: "friend", referralId: "referral.valid-friend" } },
      })));
      assert.equal(replayChangedRef.status, 409, JSON.stringify(replayChangedRef));

      return { mixedFingerprintMatched: true, legacyBookingId: firstLegacy.body.bookingId };
    } finally {
      await cleanCreatorsAndCoupons(ctx);
    }
  });

  await ctx.run("ads-ref-prerollout-start-retry-and-settlement", async () => {
    const { buildPaymentStartClaimId, buildQuoteFingerprint } = await import("../../src/server/api/payment/paymentRecord.js");
    const realNow = Date.now;
    let startIp = 1;
    const startReq = (opts = {}) => jsonReq(ctx.origin, "/start-route", {
      ...opts,
      headers: { "x-forwarded-for": `198.51.101.${startIp++}`, ...(opts.headers || {}) },
    });
    try {
      await cleanCreatorsAndCoupons(ctx);
      await seedFixtureSlot(ctx);
      await ctx.documents.create({
        _id: "referral.collide-pre", _type: "referral", name: "gads-max", slug: { current: "gads-max" },
        registrationStatus: "active", currentDiscountPercent: 20, currentCommissionPercent: 18,
      });
      await ctx.documents.create({
        _id: "coupon.pre-reserved", _type: "coupon", code: "GADS-MAX", isActive: true,
        discountType: "percent", discountPercent: 100, maxUses: 5, timesUsed: 0, activeReservations: 1,
        canCombineWithReferral: true,
      });

      const originalAttr = { ref: { source: "gads-max", capturedAt: new Date(realNow() - 60_000).toISOString() } };
      const paidHold = await createHoldForSlot(ctx, { id: "slotHold.pre-paid", phase: "holding" });
      const paidScope = `hold:${paidHold.slotHoldId}:fixture-hold-owner`;
      const paidPayload = baseBookingPayload(paidHold, { referralCode: "gads-max", referralId: "referral.collide-pre", salesAttribution: originalAttr });
      const paidFrozenQuote = {
        paymentProvider: "paid", effectiveGrossAmount: 9.99, effectiveDiscountAmount: 2, effectiveDiscountPercent: 20,
        effectiveNetAmount: 7.99, referralDiscountPercent: 20, referralDiscountAmount: 2, effectiveCommissionPercent: 18,
        couponDiscountPercent: 0, couponDiscountAmount: 0, couponDiscountType: "", couponDiscountValue: 0,
        canCombineWithReferral: false, effectiveReferralCode: "gads-max", effectiveReferralId: "referral.collide-pre",
      };
      const paidFp = buildQuoteFingerprint({ bookingPayload: paidPayload, quote: paidFrozenQuote });
      const prePaidSnapshot = {
        grossAmount: 9.99, discountAmount: 2, discountPercent: 20, netAmount: 7.99,
        referralDiscountPercent: 20, referralDiscountAmount: 2, commissionPercent: 18,
        couponDiscountPercent: 0, couponDiscountAmount: 0, couponDiscountType: "", couponDiscountValue: 0,
        canCombineWithReferral: false, effectiveReferralCode: "gads-max", effectiveReferralId: "referral.collide-pre",
      };
      await ctx.commerce.create({
        _id: "paymentRecord.pre-paid", _type: "paymentRecord", provider: "paypal", status: "started",
        backendOwner: "supabase", cutoverGeneration: 0, sessionScope: paidScope,
        providerOrderId: "order-pre-paid", providerIdempotencyKey: "pre-paid-key",
        quoteFingerprint: paidFp, pricingFingerprint: "pre-paid-pf",
        pricingSnapshot: prePaidSnapshot, bookingPayload: paidPayload,
        holdSnapshot: { slotHoldId: paidHold.slotHoldId, startTimeUTC: fixtureStart, holdNonce: "fixture-hold-owner", slotHoldExpiresAt: paidHold.slotHoldExpiresAt, phase: "payment_pending" },
        providerPublicData: { currency: "USD", orderId: "order-pre-paid" },
        sessionExpiresAt: paidHold.slotHoldExpiresAt, emailDispatch: {},
      });
      await ctx.commerce.patch(paidHold.slotHoldId).set({ phase: "payment_pending", paymentRecordId: "paymentRecord.pre-paid", paymentProvider: "paypal" }).commit();
      await ctx.commerce.create({
        _id: buildPaymentStartClaimId(paidScope),
        _type: "paymentStartClaim", backendOwner: "supabase", cutoverGeneration: 0,
        scope: paidScope, paymentRecordId: "paymentRecord.pre-paid", provider: "paypal", quoteFingerprint: paidFp,
      });

      const retryPaid = await jsonReq(ctx.origin, "/start-route", {
        headers: { cookie: refCookie({ source: "chatgpt-ads", capturedAt: "2026-11-19T10:00:00.000Z" }) },
        body: { provider: "paypal", quoteFingerprint: paidFp, bookingPayload: paidPayload },
      });
      assert.equal(retryPaid.status, 200, JSON.stringify(retryPaid));
      assert.equal(retryPaid.body.quote.grossAmount, 9.99);
      assert.equal(retryPaid.body.quote.netAmount, 7.99);
      assert.equal(retryPaid.body.quote.commissionPercent, 18);
      assert.equal(retryPaid.body.quote.isFree, false);
      assert.deepEqual((await ctx.row("paymentRecord.pre-paid")).payload.bookingPayload.salesAttribution, originalAttr);

      const staleRefFp = await jsonReq(ctx.origin, "/start-route", {
        body: { provider: "paypal", quoteFingerprint: "stale-fingerprint", bookingPayload: paidPayload },
      });
      assert.equal(staleRefFp.status, 409, JSON.stringify(staleRefFp));
      assert.equal(staleRefFp.body.code, "quote_fingerprint_mismatch");

      await ctx.commerce.patch("paymentRecord.pre-paid").set({ providerOrderId: "" }).commit();
      const noOrderRetry = await jsonReq(ctx.origin, "/start-route", {
        body: { provider: "paypal", quoteFingerprint: paidFp, bookingPayload: paidPayload },
      });
      assert.equal(noOrderRetry.status, 409, JSON.stringify(noOrderRetry));
      assert.equal(noOrderRetry.body.code, "provider_order_creation_in_progress");

      await ctx.commerce.create({
        _id: "booking.pre-settled", _type: "booking", backendOwner: "supabase", cutoverGeneration: 0,
        status: "captured", netAmount: 7.99, grossAmount: 9.99, packageTitle: fixturePackage, email: "customer@example.invalid",
        localTimeZone: "Asia/Kolkata",
      });
      for (const settledStatus of ["booked", "email_partial"]) {
        await ctx.commerce.patch("paymentRecord.pre-paid").set({
          providerOrderId: "order-pre-paid", status: settledStatus, bookingId: "booking.pre-settled", verificationState: "server_verified",
        }).commit();
        const startableSettled = await jsonReq(ctx.origin, "/start-route", {
          body: { provider: "paypal", quoteFingerprint: paidFp, bookingPayload: paidPayload },
        });
        assert.equal(startableSettled.status, 200, JSON.stringify(startableSettled));
        assert.equal(startableSettled.body.status, settledStatus);
        assert.equal(startableSettled.body.bookingId, "booking.pre-settled");
        assert.equal(startableSettled.body.quote.netAmount, 7.99);
        assert.deepEqual((await ctx.row("paymentRecord.pre-paid")).payload.bookingPayload.salesAttribution, originalAttr);
      }

      const commitIso = new Date(Date.now() - 5000).toISOString();
      await ctx.commerce.patch(paidHold.slotHoldId).set({
        phase: "consumed", consumedAt: commitIso, expiresAt: commitIso, bookingId: "booking.pre-settled",
      }).commit();
      for (const settledStatus of ["booked", "email_partial"]) {
        await ctx.commerce.patch("paymentRecord.pre-paid").set({ status: settledStatus }).commit();
        const consumedPaidRetry = await jsonReq(ctx.origin, "/start-route", {
          body: { provider: "paypal", quoteFingerprint: paidFp, bookingPayload: paidPayload },
        });
        assert.equal(consumedPaidRetry.status, 409, JSON.stringify(consumedPaidRetry));
        assert.equal(consumedPaidRetry.body.error, "Your slot reservation expired.");
        assert.equal(Object.hasOwn(consumedPaidRetry.body, "bookingSummary"), false);
        assert.deepEqual((await ctx.row("paymentRecord.pre-paid")).payload.bookingPayload.salesAttribution, originalAttr);

        Date.now = () => Date.parse(paidHold.slotHoldExpiresAt) + 1000;
        try {
          const expiredTokenPaidRetry = await startReq({
            body: { provider: "paypal", quoteFingerprint: paidFp, bookingPayload: paidPayload },
          });
          assert.equal(expiredTokenPaidRetry.status, 409, JSON.stringify(expiredTokenPaidRetry));
          assert.equal(expiredTokenPaidRetry.body.error, "Your slot reservation expired.");
          assert.equal(Object.hasOwn(expiredTokenPaidRetry.body, "bookingSummary"), false);
          assert.deepEqual((await ctx.row("paymentRecord.pre-paid")).payload.bookingPayload.salesAttribution, originalAttr);
        } finally {
          Date.now = realNow;
        }
      }

      const { issueUpgradeIntentToken } = await import("../../src/server/api/ref/upgradeIntentToken.js");
      const { buildPaymentSessionRecordId, buildPaymentSessionScope } = await import("../../src/server/api/payment/paymentRecord.js");
      await ctx.commerce.create({
        _id: "booking.pre-upgrade-orig", _type: "booking", backendOwner: "supabase", cutoverGeneration: 0,
        status: "captured", netAmount: 9.99, grossAmount: 9.99, packageTitle: fixturePackage, email: "customer@example.invalid",
        localTimeZone: "Asia/Kolkata",
      });
      await ctx.commerce.create({
        _id: "booking.pre-upgrade-settled", _type: "booking", backendOwner: "supabase", cutoverGeneration: 0,
        status: "captured", originalOrderId: "booking.pre-upgrade-orig", netAmount: 7.99, grossAmount: 9.99,
        packageTitle: "Fixture Upgrade", email: "customer@example.invalid", localTimeZone: "Asia/Kolkata",
      });
      const upgradeIntentToken = issueUpgradeIntentToken({
        bookingId: "booking.pre-upgrade-orig", email: "customer@example.invalid", targetPackageTitle: "Fixture Upgrade",
        backend: "supabase", cutoverGeneration: 0,
      });
      const { verifyUpgradeIntentToken } = await import("../../src/server/api/ref/upgradeIntentToken.js");
      const verifiedUpgrade = verifyUpgradeIntentToken({
        token: upgradeIntentToken, bookingId: "booking.pre-upgrade-orig", email: "customer@example.invalid",
        targetPackageTitle: "Fixture Upgrade", backend: "supabase", cutoverGeneration: 0,
      });
      const upgradePayload = {
        originalOrderId: "booking.pre-upgrade-orig", upgradeIntentToken, packageTitle: "Fixture Upgrade",
        email: "customer@example.invalid", referralCode: "gads-max", referralId: "referral.collide-pre",
        salesAttribution: originalAttr,
      };
      const upgradeScope = `${buildPaymentSessionScope({ bookingPayload: upgradePayload, holdNonce: "" })}:${String(verifiedUpgrade.n || "").trim()}`;
      const upgradeRecordId = buildPaymentSessionRecordId(upgradeScope);
      const upgradeFp = buildQuoteFingerprint({ bookingPayload: upgradePayload, quote: paidFrozenQuote });
      await ctx.commerce.create({
        _id: upgradeRecordId, _type: "paymentRecord", provider: "paypal", status: "booked",
        backendOwner: "supabase", cutoverGeneration: 0, sessionScope: upgradeScope,
        providerOrderId: "order-pre-upg", providerIdempotencyKey: "pre-upg-key",
        quoteFingerprint: upgradeFp, pricingFingerprint: "pre-upg-pf",
        pricingSnapshot: prePaidSnapshot, bookingPayload: upgradePayload,
        bookingId: "booking.pre-upgrade-settled", verificationState: "server_verified",
        providerPublicData: { currency: "USD", orderId: "order-pre-upg" },
        sessionExpiresAt: paidHold.slotHoldExpiresAt, emailDispatch: {},
      });
      for (const settledStatus of ["booked", "email_partial"]) {
        await ctx.commerce.patch(upgradeRecordId).set({ status: settledStatus }).commit();
        const upgRetry = await jsonReq(ctx.origin, "/start-route", {
          body: { provider: "paypal", quoteFingerprint: upgradeFp, bookingPayload: upgradePayload },
        });
        assert.equal(upgRetry.status, 200, JSON.stringify(upgRetry));
        assert.equal(upgRetry.body.status, settledStatus);
        assert.equal(upgRetry.body.bookingId, "booking.pre-upgrade-settled");
        assert.equal(upgRetry.body.quote.netAmount, 7.99);
        assert.deepEqual((await ctx.row(upgradeRecordId)).payload.bookingPayload.salesAttribution, originalAttr);
      }

      const raceHold = await createHoldForSlot(ctx, { id: "slotHold.pre-race", startTimeUTC: "2099-01-01T10:00:00.000Z", phase: "holding" });
      const raceScope = `hold:${raceHold.slotHoldId}:fixture-hold-owner`;
      const racePayload = baseBookingPayload(raceHold, { referralCode: "gads-max", referralId: "referral.collide-pre", salesAttribution: originalAttr });
      const raceFp = buildQuoteFingerprint({ bookingPayload: racePayload, quote: paidFrozenQuote });
      await ctx.commerce.create({
        _id: "booking.pre-race", _type: "booking", backendOwner: "supabase", cutoverGeneration: 0,
        status: "captured", netAmount: 7.99, grossAmount: 9.99, packageTitle: fixturePackage, email: "customer@example.invalid",
        localTimeZone: "Asia/Kolkata",
      });
      await ctx.commerce.create({
        _id: "paymentRecord.pre-race", _type: "paymentRecord", provider: "paypal", status: "started",
        backendOwner: "supabase", cutoverGeneration: 0, sessionScope: raceScope,
        providerOrderId: "order-pre-race", providerIdempotencyKey: "pre-race-key",
        quoteFingerprint: raceFp, pricingFingerprint: "pre-race-pf",
        pricingSnapshot: prePaidSnapshot, bookingPayload: racePayload,
        holdSnapshot: { slotHoldId: raceHold.slotHoldId, startTimeUTC: fixtureStart, holdNonce: "fixture-hold-owner", slotHoldExpiresAt: raceHold.slotHoldExpiresAt, phase: "payment_pending" },
        providerPublicData: { currency: "USD", orderId: "order-pre-race" },
        sessionExpiresAt: raceHold.slotHoldExpiresAt, emailDispatch: {},
      });
      await ctx.commerce.patch(raceHold.slotHoldId).set({ phase: "payment_pending", paymentRecordId: "paymentRecord.pre-race", paymentProvider: "paypal" }).commit();
      await ctx.commerce.create({
        _id: buildPaymentStartClaimId(raceScope),
        _type: "paymentStartClaim", backendOwner: "supabase", cutoverGeneration: 0,
        scope: raceScope, paymentRecordId: "paymentRecord.pre-race", provider: "paypal", quoteFingerprint: raceFp,
      });
      let raceCommitted = false;
      ctx.fixture.setRequestHook(async (phase, req) => {
        if (phase === "after" && !raceCommitted && JSON.stringify(req.response || "").includes("slotHold.pre-race")) {
          raceCommitted = true;
          ctx.fixture.setRequestHook(null);
          const raceCommitIso = new Date(Date.now() - 2000).toISOString();
          await ctx.commerce.patch(raceHold.slotHoldId).set({
            phase: "consumed", consumedAt: raceCommitIso, expiresAt: raceCommitIso, bookingId: "booking.pre-race",
          }).commit();
          await ctx.commerce.patch("paymentRecord.pre-race").set({
            status: "booked", bookingId: "booking.pre-race", verificationState: "server_verified",
          }).commit();
        }
      });
      try {
        const raceRetry = await startReq({
          body: { provider: "paypal", quoteFingerprint: raceFp, bookingPayload: racePayload },
        });
        assert.equal(raceCommitted, true, "Expected commit hook to fire between hold and payment reads");
        assert.equal(raceRetry.status, 409, JSON.stringify(raceRetry));
        assert.equal(raceRetry.body.error, "Your slot reservation expired.");
        assert.equal(Object.hasOwn(raceRetry.body, "bookingSummary"), false);
        assert.deepEqual((await ctx.row("paymentRecord.pre-race")).payload.bookingPayload.salesAttribution, originalAttr);
      } finally {
        ctx.fixture.setRequestHook(null);
      }

      await ctx.documents.patch("6d8a3646-0ed2-44b5-ad45-c5c9d578126a").set({
        dateSlots: [
          { date: "2099-01-01", times: ["15:30"] }, { date: "2099-01-02", times: ["15:30"] },
          { date: "2099-01-03", times: ["15:30"] }, { date: "2099-01-04", times: ["15:30"] },
          { date: "2099-01-05", times: ["15:30"] }, { date: "2099-01-06", times: ["15:30"] },
          { date: "2099-01-07", times: ["15:30"] }, { date: "2099-01-08", times: ["15:30"] },
          { date: "2099-01-09", times: ["15:30"] }, { date: "2099-01-10", times: ["15:30"] },
          { date: "2099-01-11", times: ["15:30"] }, { date: "2099-01-12", times: ["15:30"] },
        ],
      }).commit();

      const freeHold = await createHoldForSlot(ctx, { id: "slotHold.pre-free", startTimeUTC: "2099-01-02T10:00:00.000Z", phase: "holding" });
      const freeScope = `hold:${freeHold.slotHoldId}:fixture-hold-owner`;
      const freePayload = baseBookingPayload(freeHold, { startTimeUTC: "2099-01-02T10:00:00.000Z", couponCode: "gads-max", salesAttribution: originalAttr });
      const freeFp = buildQuoteFingerprint({
        bookingPayload: freePayload,
        quote: { paymentProvider: "free", effectiveGrossAmount: 9.99, effectiveDiscountAmount: 9.99, effectiveNetAmount: 0, effectiveReferralCode: "", effectiveReferralId: "" },
      });
      await ctx.commerce.create({
        _id: "couponRedemption.pre-free", _type: "couponRedemption", backendOwner: "supabase", cutoverGeneration: 0,
        coupon: { _type: "reference", _ref: "coupon.pre-reserved" }, couponCode: "gads-max",
        ownerId: "paymentRecord.pre-free", paymentRecordId: "paymentRecord.pre-free", status: "reserved",
      });
      await ctx.commerce.create({
        _id: "paymentRecord.pre-free", _type: "paymentRecord", provider: "free", status: "started",
        backendOwner: "supabase", cutoverGeneration: 0, sessionScope: freeScope,
        providerOrderId: "", providerIdempotencyKey: "pre-free-key",
        quoteFingerprint: freeFp, pricingFingerprint: "pre-free-pf",
        couponReservationId: "couponRedemption.pre-free",
        pricingSnapshot: { grossAmount: 9.99, discountAmount: 9.99, discountPercent: 100, netAmount: 0, couponDiscountPercent: 100, couponDiscountAmount: 9.99, couponDiscountType: "percent", couponDiscountValue: 100, effectiveReferralCode: "", effectiveReferralId: "" },
        bookingPayload: freePayload,
        holdSnapshot: { slotHoldId: freeHold.slotHoldId, startTimeUTC: "2099-01-02T10:00:00.000Z", holdNonce: "fixture-hold-owner", slotHoldExpiresAt: freeHold.slotHoldExpiresAt, phase: "payment_pending" },
        providerPublicData: { currency: "USD" }, sessionExpiresAt: freeHold.slotHoldExpiresAt, emailDispatch: {},
      });
      await ctx.commerce.patch(freeHold.slotHoldId).set({ phase: "payment_pending", paymentRecordId: "paymentRecord.pre-free", paymentProvider: "free" }).commit();
      await ctx.commerce.create({
        _id: buildPaymentStartClaimId(freeScope),
        _type: "paymentStartClaim", backendOwner: "supabase", cutoverGeneration: 0,
        scope: freeScope, paymentRecordId: "paymentRecord.pre-free", provider: "free", quoteFingerprint: freeFp,
      });

      const badFreeFp = await startReq({
        body: { provider: "free", quoteFingerprint: "wrong-fp", bookingPayload: freePayload },
      });
      assert.equal(badFreeFp.status, 400, JSON.stringify(badFreeFp));
      assert.equal(badFreeFp.body.code, "coupon_invalid");

      const freeRetry = await withEnv(fixtureMail, () => startReq({
        body: { provider: "free", quoteFingerprint: freeFp, bookingPayload: freePayload },
      }));
      assert.equal(freeRetry.status, 200, JSON.stringify(freeRetry));
      assert.equal(freeRetry.body.quote.isFree, true);
      assert.equal(freeRetry.body.quote.netAmount, 0);
      assert.equal((await ctx.row("couponRedemption.pre-free")).payload.status, "consumed");
      assert.equal((await ctx.row("coupon.pre-reserved")).payload.timesUsed, 1);
      assert.equal((await ctx.row(freeHold.slotHoldId)).payload.phase, "consumed");
      assert.deepEqual((await ctx.row("paymentRecord.pre-free")).payload.bookingPayload.salesAttribution, originalAttr);

      const freeSettledRetry = await withEnv(fixtureMail, () => startReq({
        body: { provider: "free", quoteFingerprint: freeFp, bookingPayload: freePayload },
      }));
      assert.equal(freeSettledRetry.status, 409, JSON.stringify(freeSettledRetry));
      assert.equal(freeSettledRetry.body.error, "Your slot reservation expired.");
      assert.equal(Object.hasOwn(freeSettledRetry.body, "bookingSummary"), false);
      assert.deepEqual((await ctx.row("paymentRecord.pre-free")).payload.bookingPayload.salesAttribution, originalAttr);

      Date.now = () => Date.parse(freeHold.slotHoldExpiresAt) + 1000;
      try {
        const freeExpiredTokenRetry = await withEnv(fixtureMail, () => startReq({
          body: { provider: "free", quoteFingerprint: freeFp, bookingPayload: freePayload },
        }));
        assert.equal(freeExpiredTokenRetry.status, 409, JSON.stringify(freeExpiredTokenRetry));
        assert.equal(freeExpiredTokenRetry.body.error, "Your slot reservation expired.");
        assert.equal(Object.hasOwn(freeExpiredTokenRetry.body, "bookingSummary"), false);
        assert.deepEqual((await ctx.row("paymentRecord.pre-free")).payload.bookingPayload.salesAttribution, originalAttr);
      } finally {
        Date.now = realNow;
      }

      await ctx.documents.create({
        _id: "referral.live-comm", _type: "referral", name: "LiveComm", slug: { current: "livecomm" },
        registrationStatus: "active", currentDiscountPercent: 10, currentCommissionPercent: 12,
      });
      const refHold = await createHoldForSlot(ctx, { id: "slotHold.pre-refunded", startTimeUTC: "2099-01-03T10:00:00.000Z", phase: "holding" });
      const refScope = `hold:${refHold.slotHoldId}:fixture-hold-owner`;
      const refPayload = baseBookingPayload(refHold, { startTimeUTC: "2099-01-03T10:00:00.000Z", referralCode: "livecomm", referralId: "referral.live-comm" });
      const refFp = buildQuoteFingerprint({
        bookingPayload: refPayload,
        quote: { paymentProvider: "paid", effectiveGrossAmount: 9.99, effectiveDiscountAmount: 1, effectiveNetAmount: 8.99, effectiveReferralCode: "livecomm", effectiveReferralId: "referral.live-comm" },
      });
      await ctx.commerce.create({
        _id: "paymentRecord.pre-refunded", _type: "paymentRecord", provider: "paypal", status: "refunded",
        backendOwner: "supabase", cutoverGeneration: 0, sessionScope: refScope,
        providerOrderId: "order-pre-refunded", providerIdempotencyKey: "pre-ref-key",
        quoteFingerprint: refFp, pricingFingerprint: "pre-ref-pf",
        pricingSnapshot: { grossAmount: 9.99, discountAmount: 1, discountPercent: 10, netAmount: 8.99, referralDiscountPercent: 10, referralDiscountAmount: 1, commissionPercent: 12, effectiveReferralCode: "livecomm", effectiveReferralId: "referral.live-comm" },
        bookingPayload: refPayload, providerPublicData: { currency: "USD" }, sessionExpiresAt: refHold.slotHoldExpiresAt, emailDispatch: {},
      });
      await ctx.commerce.create({
        _id: buildPaymentStartClaimId(refScope),
        _type: "paymentStartClaim", backendOwner: "supabase", cutoverGeneration: 0,
        scope: refScope, paymentRecordId: "paymentRecord.pre-refunded", provider: "paypal", quoteFingerprint: refFp,
      });
      await ctx.documents.patch("referral.live-comm").set({ currentCommissionPercent: 27 }).commit();
      const refundedStart = await startReq({
        body: { provider: "paypal", quoteFingerprint: refFp, bookingPayload: refPayload },
      });
      assert.equal(refundedStart.status, 200, JSON.stringify(refundedStart));
      assert.equal(refundedStart.body.quote.commissionPercent, 27);

      const withPayPalMock = async (orderId, captureId, amountStr, fn) => {
        const prev = globalThis.fetch;
        globalThis.fetch = (input, init = {}) => {
          const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
          if (url.pathname === `/v2/checkout/orders/${orderId}`) {
            return Promise.resolve(Response.json({
              id: orderId, status: "COMPLETED", intent: "CAPTURE",
              purchase_units: [{ amount: { value: amountStr, currency_code: "USD" }, payments: { captures: [{ id: captureId, status: "COMPLETED", amount: { value: amountStr, currency_code: "USD" } }] } }],
            }));
          }
          return prev(input, init);
        };
        try { return await fn(); } finally { globalThis.fetch = prev; }
      };

      await ctx.documents.patch("coupon.pre-reserved").set({ discountPercent: 20, activeReservations: 2 }).commit();
      const finHold = await createHoldForSlot(ctx, { id: "slotHold.pre-fin", startTimeUTC: "2099-01-04T10:00:00.000Z", phase: "holding" });
      await ctx.commerce.create({
        _id: "couponRedemption.pre-fin", _type: "couponRedemption", backendOwner: "supabase", cutoverGeneration: 0,
        coupon: { _type: "reference", _ref: "coupon.pre-reserved" }, couponCode: "gads-max",
        ownerId: "paymentRecord.pre-fin", paymentRecordId: "paymentRecord.pre-fin", status: "reserved",
      });
      const preFinRec = await ctx.commerce.create({
        _id: "paymentRecord.pre-fin", _type: "paymentRecord", provider: "paypal", status: "started",
        backendOwner: "supabase", cutoverGeneration: 0, sessionScope: `hold:${finHold.slotHoldId}:fixture-hold-owner`,
        providerOrderId: "order-pre-fin", providerIdempotencyKey: "pre-fin-key",
        quoteFingerprint: "pre-fin-fp", pricingFingerprint: "pre-fin-pf", couponReservationId: "couponRedemption.pre-fin",
        pricingSnapshot: { grossAmount: 9.99, discountAmount: 2, discountPercent: 20, netAmount: 7.99, couponDiscountPercent: 20, couponDiscountAmount: 2, couponDiscountType: "percent", couponDiscountValue: 20, effectiveReferralCode: "gads-max", effectiveReferralId: "referral.collide-pre", commissionPercent: 18 },
        bookingPayload: baseBookingPayload(finHold, { startTimeUTC: "2099-01-04T10:00:00.000Z", couponCode: "gads-max", referralCode: "gads-max", salesAttribution: originalAttr }),
        holdSnapshot: { slotHoldId: finHold.slotHoldId, startTimeUTC: "2099-01-04T10:00:00.000Z", holdNonce: "fixture-hold-owner", slotHoldExpiresAt: finHold.slotHoldExpiresAt, phase: "payment_pending" },
        providerPublicData: { currency: "USD" }, sessionExpiresAt: finHold.slotHoldExpiresAt, emailDispatch: {},
      });
      await ctx.commerce.patch(finHold.slotHoldId).set({ phase: "payment_pending", paymentRecordId: "paymentRecord.pre-fin", paymentProvider: "paypal" }).commit();
      const finRes = await withEnv(fixtureMail, () => withPayPalMock("order-pre-fin", "capture-pre-fin", "7.99", () => jsonReq(ctx.origin, "/finalize-route", {
        headers: { authorization: `Bearer ${ctx.tokenFor(preFinRec)}` },
        body: { paypalOrderId: "order-pre-fin" },
      })));
      assert.equal(finRes.status, 200, JSON.stringify(finRes));
      const finRed = (await ctx.row("couponRedemption.pre-fin")).payload;
      assert.equal(finRed.status, "consumed");
      assert.equal(finRed.bookingId, finRes.body.bookingId);
      assert.equal((await ctx.row("coupon.pre-reserved")).payload.timesUsed, 2);

      await ctx.commerce.create({
        _id: "couponRedemption.pre-rec", _type: "couponRedemption", backendOwner: "supabase", cutoverGeneration: 0,
        coupon: { _type: "reference", _ref: "coupon.pre-reserved" }, couponCode: "gads-max",
        ownerId: "paymentRecord.pre-rec", paymentRecordId: "paymentRecord.pre-rec", status: "reserved",
      });
      await ctx.commerce.create({
        _id: "paymentRecord.pre-rec", _type: "paymentRecord", provider: "paypal", status: "abandoned",
        backendOwner: "supabase", cutoverGeneration: 0, sessionScope: "hold:slotHold.expired-pre-rec:nonce",
        providerOrderId: "order-pre-rec", providerPaymentId: "", providerIdempotencyKey: "pre-rec-key",
        quoteFingerprint: "pre-rec-fp", pricingFingerprint: "pre-rec-pf", couponReservationId: "couponRedemption.pre-rec",
        pricingSnapshot: { grossAmount: 9.99, discountAmount: 2, discountPercent: 20, netAmount: 7.99, couponDiscountPercent: 20, couponDiscountAmount: 2, couponDiscountType: "percent", couponDiscountValue: 20, effectiveReferralCode: "gads-max", effectiveReferralId: "referral.collide-pre", commissionPercent: 18 },
        bookingPayload: { packageTitle: fixturePackage, email: "customer@example.invalid", discord: "fixture", specs: "pc", mainGame: "cs2", localTimeZone: "Asia/Kolkata", startTimeUTC: "2099-01-05T10:00:00.000Z", couponCode: "gads-max", referralCode: "gads-max", salesAttribution: originalAttr },
        providerPublicData: { currency: "USD" }, sessionExpiresAt: new Date(Date.now() + 600_000).toISOString(), emailDispatch: {},
      });
      const recRes = await withEnv(fixtureMail, () => withPayPalMock("order-pre-rec", "capture-pre-rec", "7.99", () => ctx.requestFlow("paypal", {
        req: ctx.paypalReq("PAYMENT.CAPTURE.COMPLETED", { id: "capture-pre-rec", supplementary_data: { related_ids: { order_id: "order-pre-rec" } } }, "evt-pre-rec"),
      })));
      assert.equal(recRes.status, 200, JSON.stringify(recRes));
      const recPayment = (await ctx.row("paymentRecord.pre-rec")).payload;
      assert.equal(recPayment.requiresReschedule, true, JSON.stringify(recPayment));
      assert.ok(recPayment.bookingId);
      const recRed = (await ctx.row("couponRedemption.pre-rec")).payload;
      assert.equal(recRed.status, "consumed");
      assert.equal(recRed.bookingId, recPayment.bookingId);
      assert.equal((await ctx.row("coupon.pre-reserved")).payload.timesUsed, 3);

      await ctx.commerce.create({
        _id: "paymentRecord.new-rec", _type: "paymentRecord", provider: "paypal", status: "abandoned",
        backendOwner: "supabase", cutoverGeneration: 0, sessionScope: "hold:slotHold.expired-new-rec:nonce",
        providerOrderId: "order-new-rec", providerPaymentId: "", providerIdempotencyKey: "new-rec-key",
        quoteFingerprint: "new-rec-fp", pricingFingerprint: "new-rec-pf",
        pricingSnapshot: { grossAmount: 9.99, discountAmount: 0, discountPercent: 0, netAmount: 9.99, referralDiscountPercent: 0, referralDiscountAmount: 0, commissionPercent: 0, effectiveReferralCode: "", effectiveReferralId: "" },
        bookingPayload: { packageTitle: fixturePackage, email: "customer@example.invalid", discord: "fixture", specs: "pc", mainGame: "cs2", localTimeZone: "Asia/Kolkata", startTimeUTC: "2099-01-06T10:00:00.000Z", referralCode: "gads-max", referralId: "referral.collide-pre", salesAttribution: originalAttr },
        providerPublicData: { currency: "USD" }, sessionExpiresAt: new Date(realNow() + 600_000).toISOString(), emailDispatch: {},
      });
      const newRecRes = await withEnv(fixtureMail, () => withPayPalMock("order-new-rec", "capture-new-rec", "9.99", () => ctx.requestFlow("paypal", {
        req: ctx.paypalReq("PAYMENT.CAPTURE.COMPLETED", { id: "capture-new-rec", supplementary_data: { related_ids: { order_id: "order-new-rec" } } }, "evt-new-rec"),
      })));
      assert.equal(newRecRes.status, 200, JSON.stringify(newRecRes));
      const newRecPayment = (await ctx.row("paymentRecord.new-rec")).payload;
      assert.equal(newRecPayment.requiresReschedule, true, JSON.stringify(newRecPayment));
      const newRecBooking = (await ctx.row(newRecPayment.bookingId)).payload;
      assert.equal(newRecBooking.referralCode, "");
      assert.equal(newRecBooking.referral, undefined);
      assert.equal(newRecBooking.commissionPercent, 0);
      assert.equal(newRecBooking.discountPercent, 0);
      assert.equal(newRecBooking.discountAmount, 0);
      const [newRecAttrRow] = await ctx.sql`select sales_attribution from commerce.bookings where legacy_sanity_id = ${newRecPayment.bookingId}`;
      assert.deepEqual(newRecAttrRow.sales_attribution, originalAttr);

      await ctx.commerce.create({
        _id: "paymentRecord.drop-rec", _type: "paymentRecord", provider: "paypal", status: "abandoned",
        backendOwner: "supabase", cutoverGeneration: 0, sessionScope: "hold:slotHold.expired-drop-rec:nonce",
        providerOrderId: "order-drop-rec", providerPaymentId: "", providerIdempotencyKey: "drop-rec-key",
        quoteFingerprint: "drop-rec-fp", pricingFingerprint: "drop-rec-pf",
        pricingSnapshot: { grossAmount: 9.99, discountAmount: 0, discountPercent: 0, netAmount: 9.99, referralDiscountPercent: 0, referralDiscountAmount: 0, commissionPercent: 0, effectiveReferralCode: "", effectiveReferralId: "" },
        bookingPayload: { packageTitle: fixturePackage, email: "customer@example.invalid", discord: "fixture", specs: "pc", mainGame: "cs2", localTimeZone: "Asia/Kolkata", startTimeUTC: "2099-01-07T10:00:00.000Z", salesAttribution: { ref: { source: "removed-creator", capturedAt: new Date(realNow() - 5000).toISOString() } } },
        providerPublicData: { currency: "USD" }, sessionExpiresAt: new Date(realNow() + 600_000).toISOString(), emailDispatch: {},
      });
      const dropRecRes = await withEnv(fixtureMail, () => withPayPalMock("order-drop-rec", "capture-drop-rec", "9.99", () => ctx.requestFlow("paypal", {
        req: ctx.paypalReq("PAYMENT.CAPTURE.COMPLETED", { id: "capture-drop-rec", supplementary_data: { related_ids: { order_id: "order-drop-rec" } } }, "evt-drop-rec"),
      })));
      assert.equal(dropRecRes.status, 200, JSON.stringify(dropRecRes));
      const dropRecPayment = (await ctx.row("paymentRecord.drop-rec")).payload;
      assert.equal(dropRecPayment.requiresReschedule, true, JSON.stringify(dropRecPayment));
      const [dropRecAttrRow] = await ctx.sql`
        select sales_attribution is null as is_sql_null, (booking_payload ? 'salesAttribution') as has_key
        from commerce.bookings where legacy_sanity_id = ${dropRecPayment.bookingId}`;
      assert.equal(dropRecAttrRow.is_sql_null, true);
      assert.equal(dropRecAttrRow.has_key, false);

      return { finalizedBookingId: finRes.body.bookingId, recoveredBookingId: recPayment.bookingId };
    } finally {
      Date.now = realNow;
      await cleanCreatorsAndCoupons(ctx);
    }
  });

  await ctx.run("ads-ref-attribution-server-rules-and-timeout", async () => {
    const { buildSalesReceipt } = await import("../../src/server/api/payment/salesReceipt.ts");
    const { salesEventProperties } = await import("../../src/lib/salesAttribution.ts");
    const { resolveValidatedServerSalesAttribution } = await import("../../src/server/api/ref/validateRefAttribution.js");
    const { resolveBookingPricing } = await import("../../src/server/api/ref/pricing.js");
    const realNow = Date.now;
    try {
      await cleanCreatorsAndCoupons(ctx);
      await seedFixtureSlot(ctx);
      await ctx.documents.patch("6d8a3646-0ed2-44b5-ad45-c5c9d578126a").set({
        dateSlots: [
          { date: "2099-01-01", times: ["15:30"] }, { date: "2099-01-02", times: ["15:30"] },
          { date: "2099-01-03", times: ["15:30"] }, { date: "2099-01-04", times: ["15:30"] },
          { date: "2099-01-05", times: ["15:30"] }, { date: "2099-01-06", times: ["15:30"] },
          { date: "2099-01-07", times: ["15:30"] }, { date: "2099-01-08", times: ["15:30"] },
          { date: "2099-01-09", times: ["15:30"] }, { date: "2099-01-10", times: ["15:30"] },
          { date: "2099-01-11", times: ["15:30"] }, { date: "2099-01-12", times: ["15:30"] },
          { date: "2099-01-13", times: ["15:30"] }, { date: "2099-01-14", times: ["15:30"] },
          { date: "2099-01-15", times: ["15:30"] }, { date: "2099-01-16", times: ["15:30"] },
        ],
      }).commit();

      const t0 = realNow();
      Date.now = () => t0;

      const withPayPalOrderId = async (orderId, fn) => {
        const prev = globalThis.fetch;
        const created = [];
        globalThis.fetch = (input, init = {}) => {
          const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
          if (url.pathname === "/v2/checkout/orders" && init.method === "POST") {
            const payload = JSON.parse(init.body);
            created.push(payload);
            return Promise.resolve(Response.json({ id: orderId, status: "CREATED", purchase_units: payload.purchase_units }, { status: 201 }));
          }
          if (url.pathname === `/v2/checkout/orders/${orderId}` && (!init.method || init.method === "GET")) {
            return Promise.resolve(Response.json({ id: orderId, status: "CREATED", purchase_units: [{ amount: { currency_code: "USD", value: "9.99" } }] }, { status: 200 }));
          }
          return prev(input, init);
        };
        try { return { result: await fn(), created }; } finally { globalThis.fetch = prev; }
      };

      for (const [idx, tag] of ["gads-max", "chatgpt-ads"].entries()) {
        const slot = `2099-01-0${idx + 1}T10:00:00.000Z`;
        const hold = await createHoldForSlot(ctx, { id: `slotHold.ad-${tag}`, startTimeUTC: slot, expiresAt: new Date(t0 + 1_800_000).toISOString() });
        const q = await jsonReq(ctx.origin, "/quote-route", { body: { packageTitle: fixturePackage, startTimeUTC: slot, email: "customer@example.invalid" } });
        const entry = { source: tag, capturedAt: new Date(t0 - 5000).toISOString() };
        const fakeAttr = Buffer.from(JSON.stringify({ version: 2, journeyId, firstTouch: v1Touch })).toString("base64url");
        const fakeLast = Buffer.from(JSON.stringify({ journeyId, lastTouch: v1Touch })).toString("base64url");
        const { result: started, created } = await withPayPalOrderId(`order-fixture-ad-${idx}`, () => jsonReq(ctx.origin, "/start-route", {
          headers: { cookie: `roo_attr=${fakeAttr}; roo_attr_last=${fakeLast}; ${refCookie(entry)}` },
          body: { provider: "paypal", quoteFingerprint: q.body.quoteFingerprint, bookingPayload: baseBookingPayload(hold, { startTimeUTC: slot }) },
        }));
        assert.equal(started.status, 200, JSON.stringify(started));
        const payId = created[0].purchase_units[0].custom_id;
        const payDoc = (await ctx.row(payId)).payload;
        assert.deepEqual(payDoc.bookingPayload.salesAttribution, { ref: entry });

        const idem = await jsonReq(ctx.origin, "/start-route", {
          headers: { cookie: refCookie({ source: "gads-max", capturedAt: new Date(t0 - 99_000).toISOString() }) },
          body: { provider: "paypal", quoteFingerprint: q.body.quoteFingerprint, bookingPayload: baseBookingPayload(hold, { startTimeUTC: slot }) },
        });
        assert.equal(idem.status, 200);
        assert.deepEqual((await ctx.row(payId)).payload.bookingPayload.salesAttribution, { ref: entry });
      }

      const slotConflict = "2099-01-10T10:00:00.000Z";
      await ctx.documents.create({ _id: "coupon.claim-recovery", _type: "coupon", code: "save20rec", discountType: "percent", discountPercent: 20, active: true, maxUses: 5, timesUsed: 0, canCombineWithReferral: true });
      const holdConflict = await createHoldForSlot(ctx, { id: "slotHold.claim-recovery", startTimeUTC: slotConflict, expiresAt: new Date(t0 + 1_800_000).toISOString() });
      const qBase = await jsonReq(ctx.origin, "/quote-route", { body: { packageTitle: fixturePackage, startTimeUTC: slotConflict, email: "customer@example.invalid" } });
      const qDisc = await jsonReq(ctx.origin, "/quote-route", { body: { packageTitle: fixturePackage, startTimeUTC: slotConflict, email: "customer@example.invalid", couponCode: "save20rec" } });
      const { result: claimedStart } = await withPayPalOrderId("order-claim-recovery-1", () => jsonReq(ctx.origin, "/start-route", {
        headers: { "x-forwarded-for": "198.51.102.1" },
        body: { provider: "paypal", quoteFingerprint: qBase.body.quoteFingerprint, bookingPayload: baseBookingPayload(holdConflict, { startTimeUTC: slotConflict }) },
      }));
      assert.equal(claimedStart.status, 200, JSON.stringify(claimedStart));
      const quoteConflict = await jsonReq(ctx.origin, "/start-route", {
        headers: { "x-forwarded-for": "198.51.102.2" },
        body: { provider: "paypal", quoteFingerprint: qDisc.body.quoteFingerprint, bookingPayload: baseBookingPayload(holdConflict, { startTimeUTC: slotConflict, couponCode: "save20rec" }) },
      });
      assert.equal(quoteConflict.status, 409, JSON.stringify(quoteConflict));
      assert.equal(quoteConflict.body.code, "payment_quote_already_claimed");
      assert.equal(quoteConflict.body.claimedSession?.provider, "paypal");
      assert.ok(quoteConflict.body.claimedSession?.paymentAccessToken);
      assert.equal(quoteConflict.body.claimedSession?.providerPayload?.orderId, "order-claim-recovery-1");
      assert.equal(quoteConflict.body.claimedSession?.quote?.netAmount, qBase.body.quote.netAmount);
      const statusReady = await ctx.requestFlow("status", { paymentAccessToken: quoteConflict.body.claimedSession.paymentAccessToken });
      assert.equal(statusReady.status, 200, JSON.stringify(statusReady));
      assert.equal(statusReady.body.providerPayload?.orderId, "order-claim-recovery-1");
      const provConflict = await jsonReq(ctx.origin, "/start-route", {
        headers: { "x-forwarded-for": "198.51.102.3" },
        body: { provider: "razorpay", quoteFingerprint: qBase.body.quoteFingerprint, bookingPayload: baseBookingPayload(holdConflict, { startTimeUTC: slotConflict }) },
      });
      assert.equal(provConflict.status, 409, JSON.stringify(provConflict));
      assert.equal(provConflict.body.code, "payment_provider_already_claimed");
      assert.equal(provConflict.body.claimedSession?.provider, "paypal");
      assert.ok(provConflict.body.claimedSession?.paymentAccessToken);
      const { result: released } = await withPayPalOrderId("order-claim-recovery-1", () => jsonReq(ctx.origin, "/cancel-route", {
        headers: { authorization: `Bearer ${quoteConflict.body.claimedSession.paymentAccessToken}` },
        body: {},
      }));
      assert.equal(released.status, 200, JSON.stringify(released));
      assert.equal(released.body.cancelled, true);
      assert.ok(released.body.refreshedHold?.slotHoldToken);
      const { result: retryDisc } = await withPayPalOrderId("order-claim-recovery-2", () => jsonReq(ctx.origin, "/start-route", {
        headers: { "x-forwarded-for": "198.51.102.4" },
        body: {
          provider: "paypal", quoteFingerprint: qDisc.body.quoteFingerprint,
          bookingPayload: baseBookingPayload({ ...holdConflict, slotHoldToken: released.body.refreshedHold.slotHoldToken }, { startTimeUTC: slotConflict, couponCode: "save20rec" }),
        },
      }));
      assert.equal(retryDisc.status, 200, JSON.stringify(retryDisc));
      assert.equal(retryDisc.body.quote.netAmount, qDisc.body.quote.netAmount);

      const slotAmbig = "2099-01-11T10:00:00.000Z";
      const holdAmbig = await createHoldForSlot(ctx, { id: "slotHold.paypal-ambig", startTimeUTC: slotAmbig, expiresAt: new Date(t0 + 1_800_000).toISOString() });
      const qAmbig = await jsonReq(ctx.origin, "/quote-route", { body: { packageTitle: fixturePackage, startTimeUTC: slotAmbig, email: "customer@example.invalid" } });
      const prevFetchAmbig = globalThis.fetch;
      globalThis.fetch = (input, init = {}) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
        if (url.pathname === "/v2/checkout/orders" && init.method === "POST") {
          return Promise.resolve(Response.json({ message: "temporary_timeout" }, { status: 503 }));
        }
        return prevFetchAmbig(input, init);
      };
      let ambigStart;
      try {
        ambigStart = await jsonReq(ctx.origin, "/start-route", {
          headers: { "x-forwarded-for": "198.51.102.5" },
          body: { provider: "paypal", quoteFingerprint: qAmbig.body.quoteFingerprint, bookingPayload: baseBookingPayload(holdAmbig, { startTimeUTC: slotAmbig }) },
        });
      } finally {
        globalThis.fetch = prevFetchAmbig;
      }
      assert.equal(ambigStart.status, 500, JSON.stringify(ambigStart));
      const rzpConflict = await jsonReq(ctx.origin, "/start-route", {
        headers: { "x-forwarded-for": "198.51.102.6" },
        body: { provider: "razorpay", quoteFingerprint: qAmbig.body.quoteFingerprint, bookingPayload: baseBookingPayload(holdAmbig, { startTimeUTC: slotAmbig }) },
      });
      assert.equal(rzpConflict.status, 409, JSON.stringify(rzpConflict));
      assert.equal(rzpConflict.body.code, "payment_provider_already_claimed");
      assert.equal(rzpConflict.body.claimedSession?.provider, "paypal");
      const ambigPat = rzpConflict.body.claimedSession?.paymentAccessToken;
      assert.ok(ambigPat);
      const beforeRecStatus = await ctx.requestFlow("status", { paymentAccessToken: ambigPat });
      assert.equal(beforeRecStatus.status, 200, JSON.stringify(beforeRecStatus));
      assert.equal(beforeRecStatus.body.status, "needs_recovery");
      assert.equal(beforeRecStatus.body.providerPayload, undefined);
      const beforeRecCancel = await jsonReq(ctx.origin, "/cancel-route", {
        headers: { authorization: `Bearer ${ambigPat}` },
        body: {},
      });
      assert.equal(beforeRecCancel.status, 409, JSON.stringify(beforeRecCancel));
      const ambigRecordId = (await ctx.row("slotHold.paypal-ambig")).payload.paymentRecordId;
      await ctx.documents.patch(ambigRecordId).set({ nextRecoveryAt: "" }).commit();
      const { result: recAmbig } = await withPayPalOrderId("order-paypal-ambig-1", () => ctx.requestFlow("reconcile", {
        req: { headers: { authorization: "Bearer fixture-cron" } },
      }));
      assert.equal(recAmbig.status, 200, JSON.stringify(recAmbig));
      const ambigStatus = await ctx.requestFlow("status", { paymentAccessToken: ambigPat });
      assert.equal(ambigStatus.status, 200, JSON.stringify(ambigStatus));
      assert.equal(ambigStatus.body.status, "started");
      assert.equal(ambigStatus.body.providerPayload?.orderId, "order-paypal-ambig-1");
      const { result: ambigCancel } = await withPayPalOrderId("order-paypal-ambig-1", () => jsonReq(ctx.origin, "/cancel-route", {
        headers: { authorization: `Bearer ${ambigPat}` },
        body: {},
      }));
      assert.equal(ambigCancel.status, 200, JSON.stringify(ambigCancel));
      assert.equal(ambigCancel.body.cancelled, true);
      assert.ok(ambigCancel.body.refreshedHold?.slotHoldToken);
      const abandonedStatusLive = await ctx.requestFlow("status", { paymentAccessToken: ambigPat });
      assert.equal(abandonedStatusLive.status, 200, JSON.stringify(abandonedStatusLive));
      assert.equal(abandonedStatusLive.body.status, "abandoned");
      assert.equal(abandonedStatusLive.body.refreshedHold?.slotHoldToken, ambigCancel.body.refreshedHold.slotHoldToken);
      await ctx.documents.patch(ambigRecordId).set({ cancelledHoldSnapshot: { ...ambigCancel.body.refreshedHold, slotHoldExpiresAt: "2000-01-01T00:00:00.000Z" } }).commit();
      const abandonedStatusExpired = await ctx.requestFlow("status", { paymentAccessToken: ambigPat });
      assert.equal(abandonedStatusExpired.status, 200, JSON.stringify(abandonedStatusExpired));
      assert.equal(abandonedStatusExpired.body.refreshedHold, undefined);
      await ctx.documents.patch(ambigRecordId).set({ cancelledHoldSnapshot: ambigCancel.body.refreshedHold }).commit();
      const { result: supersededStart } = await withPayPalOrderId("order-paypal-ambig-2", () => jsonReq(ctx.origin, "/start-route", {
        headers: { "x-forwarded-for": "198.51.102.7" },
        body: {
          provider: "paypal",
          quoteFingerprint: qAmbig.body.quoteFingerprint,
          bookingPayload: baseBookingPayload(ambigCancel.body.refreshedHold, { startTimeUTC: slotAmbig }),
        },
      }));
      assert.equal(supersededStart.status, 200, JSON.stringify(supersededStart));
      const { result: supersededCancel2 } = await withPayPalOrderId("order-paypal-ambig-2", () => jsonReq(ctx.origin, "/cancel-route", {
        headers: { authorization: `Bearer ${supersededStart.body.paymentAccessToken}` },
        body: {},
      }));
      assert.equal(supersededCancel2.status, 200, JSON.stringify(supersededCancel2));
      assert.ok(supersededCancel2.body.refreshedHold?.slotHoldToken);
      assert.notEqual(supersededCancel2.body.refreshedHold.slotHoldToken, ambigCancel.body.refreshedHold.slotHoldToken);
      const staleStatusAfterSecondCancel = await ctx.requestFlow("status", { paymentAccessToken: ambigPat });
      assert.equal(staleStatusAfterSecondCancel.status, 200, JSON.stringify(staleStatusAfterSecondCancel));
      assert.equal(staleStatusAfterSecondCancel.body.refreshedHold, undefined);
      const { result: staleCancelReplay } = await withPayPalOrderId("order-paypal-ambig-1", () => jsonReq(ctx.origin, "/cancel-route", {
        headers: { authorization: `Bearer ${ambigPat}` },
        body: {},
      }));
      assert.equal(staleCancelReplay.status, 200, JSON.stringify(staleCancelReplay));
      assert.equal(staleCancelReplay.body.refreshedHold, undefined);
      assert.equal(staleCancelReplay.body.slotReleased, true);
      const latestStatusAfterSecondCancel = await ctx.requestFlow("status", { paymentAccessToken: supersededStart.body.paymentAccessToken });
      assert.equal(latestStatusAfterSecondCancel.status, 200, JSON.stringify(latestStatusAfterSecondCancel));
      assert.equal(latestStatusAfterSecondCancel.body.refreshedHold?.slotHoldToken, supersededCancel2.body.refreshedHold.slotHoldToken);
      const { getPaymentStatus, cancelPaymentSession, finalizePaymentSession } = await import("../../src/server/api/payment/flow.js");
      const failingHoldClient = Object.assign(Object.create(Object.getPrototypeOf(ctx.documents)), ctx.documents, {
        fetch: (query, params) => String(query).includes('"slotHold"')
          ? Promise.reject(Object.assign(new Error("temporary_hold_outage"), { status: 503 }))
          : ctx.documents.fetch(query, params),
      });
      const outageStatus = await getPaymentStatus({ query: {}, paymentAccessToken: supersededStart.body.paymentAccessToken, client: failingHoldClient });
      assert.equal(outageStatus.httpStatus, 503, JSON.stringify(outageStatus));
      assert.equal(outageStatus.body.ok, false);
      const outageCancel = await cancelPaymentSession({ paymentAccessToken: supersededStart.body.paymentAccessToken, client: failingHoldClient });
      assert.equal(outageCancel.httpStatus, 503, JSON.stringify(outageCancel));
      assert.equal(outageCancel.body.slotReleased, undefined);
      const { result: outageFinalize } = await withPayPalOrderId("order-paypal-ambig-2", () => finalizePaymentSession({
        body: {}, paymentAccessToken: supersededStart.body.paymentAccessToken, client: failingHoldClient,
      }));
      assert.equal(outageFinalize.httpStatus, 503, JSON.stringify(outageFinalize));
      const { result: raceStart } = await withPayPalOrderId("order-paypal-ambig-3", () => jsonReq(ctx.origin, "/start-route", {
        headers: { "x-forwarded-for": "198.51.102.8" },
        body: {
          provider: "paypal",
          quoteFingerprint: qAmbig.body.quoteFingerprint,
          bookingPayload: baseBookingPayload(supersededCancel2.body.refreshedHold, { startTimeUTC: slotAmbig }),
        },
      }));
      assert.equal(raceStart.status, 200, JSON.stringify(raceStart));
      let tab1Cancel = null;
      let injectedCancelRace = false;
      const racingHoldClient = Object.assign(Object.create(Object.getPrototypeOf(ctx.documents)), ctx.documents, {
        fetch: async (query, params) => {
          if (!injectedCancelRace && String(query).includes('"slotHold"')) {
            injectedCancelRace = true;
            tab1Cancel = await cancelPaymentSession({ paymentAccessToken: raceStart.body.paymentAccessToken, client: ctx.documents });
          }
          return ctx.documents.fetch(query, params);
        },
      });
      const { result: tab2Cancel } = await withPayPalOrderId("order-paypal-ambig-3", () => cancelPaymentSession({
        paymentAccessToken: raceStart.body.paymentAccessToken, client: racingHoldClient,
      }));
      assert.equal(tab1Cancel?.httpStatus, 200, JSON.stringify(tab1Cancel));
      assert.ok(tab1Cancel?.body?.refreshedHold?.slotHoldToken);
      assert.equal(tab2Cancel.httpStatus, 200, JSON.stringify(tab2Cancel));
      assert.equal(tab2Cancel.body.cancelled, true);
      assert.equal(tab2Cancel.body.refreshedHold?.slotHoldToken, tab1Cancel.body.refreshedHold.slotHoldToken);
      const thirtyDaysMs = 30 * 86_400_000;
      const legacyCutoffOrders = [
        { name: "before_commit_and_sync", slot: "2099-01-13T10:00:00.000Z", beforeCommit: -1, afterCommit: -1, expectAttr: true },
        { name: "cutoff_between_commit_and_sync", slot: "2099-01-14T10:00:00.000Z", beforeCommit: -1, afterCommit: 1, expectAttr: true },
        { name: "cutoff_before_commit", slot: "2099-01-15T10:00:00.000Z", beforeCommit: 0, afterCommit: 1000, expectAttr: false },
      ];
      let cutoffSyncBookingId = "";
      let cutoffSyncOrderId = "";
      let cutoffSyncPaymentId = "";
      let cutoffSyncPaymentRecordId = "";
      const cutoffTs = realNow() + 60_000;
      const cutoffCapturedAt = new Date(cutoffTs - thirtyDaysMs).toISOString();
      for (const order of legacyCutoffOrders) {
        const holdId = `slotHold.legacy-cutoff-${order.name}`;
        const orderId = `order-legacy-cutoff-${order.name}`;
        const payId = `payment-legacy-cutoff-${order.name}`;
        let currentNow = cutoffTs + order.beforeCommit;
        let clockAdvanced = false;
        const prevNow = Date.now;
        Date.now = () => currentNow;
        const prevFetchOrder = globalThis.fetch;
        globalThis.fetch = (input, init = {}) => {
          const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
          if (url.pathname === `/v1/payments/${payId}`) {
            return Promise.resolve(Response.json({
              id: payId, order_id: orderId, status: "captured", captured: true,
              amount: 999, currency: "USD", amount_refunded: 0, refund_status: null,
            }));
          }
          return prevFetchOrder(input, init);
        };
        ctx.fixture.setRequestHook(async (phase, req) => {
          if (
            phase === "after" &&
            !clockAdvanced &&
            req.status >= 200 &&
            req.status < 300 &&
            JSON.stringify(req.body || "").includes("booking-finalize:")
          ) {
            clockAdvanced = true;
            currentNow = cutoffTs + order.afterCommit;
          }
        });
        try {
          const hold = await createHoldForSlot(ctx, {
            id: holdId, startTimeUTC: order.slot, phase: "active",
            expiresAt: new Date(cutoffTs + 1_800_000).toISOString(),
          });
          const res = await withEnv(fixtureMail, () => jsonReq(ctx.origin, "/booking", {
            body: {
              body: {
                status: "captured", email: "customer@example.invalid", discord: "fixture", specs: "pc",
                mainGame: "cs2", packageTitle: fixturePackage, packagePrice: "$9.99",
                localTimeZone: "Asia/Kolkata", startTimeUTC: order.slot, ...hold,
                salesAttribution: { ref: { source: "gads-max", capturedAt: cutoffCapturedAt } },
                paymentProvider: "razorpay", razorpayOrderId: orderId, razorpayPaymentId: payId,
                razorpaySignature: crypto.createHmac("sha256", "fixture-secret")
                  .update(`${orderId}|${payId}`).digest("hex"),
              },
            },
          }));
          assert.equal(res.status, 200, `${order.name}: ${JSON.stringify(res)}`);
          assert.equal(clockAdvanced, true, `${order.name}: booking-finalize clock hook did not fire`);
          const bookingId = res.body.bookingId;
          const [bookingRow] = await ctx.sql`
            select sales_attribution, (booking_payload ? 'salesAttribution') as has_key
            from commerce.bookings where legacy_sanity_id = ${bookingId}`;
          const payDoc = await ctx.commerce.fetch(
            '*[_type == "paymentRecord" && bookingId == $id][0]',
            { id: bookingId },
          );
          assert.ok(payDoc, `${order.name}: missing linked payment record`);
          const linkedAttr = payDoc.bookingPayload?.salesAttribution;
          if (order.expectAttr) {
            assert.equal(bookingRow.sales_attribution?.ref?.source, "gads-max", `${order.name} booking`);
            assert.equal(
              linkedAttr?.ref?.source,
              "gads-max",
              `${order.name} linked payment: ${JSON.stringify(payDoc.bookingPayload)}`,
            );
            if (order.name === "cutoff_between_commit_and_sync") {
              cutoffSyncBookingId = bookingId;
              cutoffSyncOrderId = orderId;
              cutoffSyncPaymentId = payId;
              cutoffSyncPaymentRecordId = payDoc._id;
            }
          } else {
            assert.equal(bookingRow.sales_attribution, null, `${order.name} booking`);
            assert.equal(bookingRow.has_key, false, `${order.name} booking key`);
            assert.equal(
              Object.hasOwn(payDoc.bookingPayload || {}, "salesAttribution"),
              false,
              `${order.name} payment key`,
            );
          }
        } finally {
          ctx.fixture.setRequestHook(null);
          globalThis.fetch = prevFetchOrder;
          Date.now = prevNow;
        }
      }
      {
        const prevNow = Date.now;
        Date.now = () => cutoffTs + 86_400_000;
        try {
          await ctx.commerce.delete(cutoffSyncPaymentRecordId);
          assert.equal(
            await ctx.commerce.fetch('*[_type == "paymentRecord" && bookingId == $id][0]', { id: cutoffSyncBookingId }),
            null,
          );
          const whBody = {
            event: "payment.captured",
            payload: {
              payment: {
                entity: {
                  id: cutoffSyncPaymentId, order_id: cutoffSyncOrderId,
                  status: "captured", captured: true, amount: 999, currency: "USD",
                },
              },
            },
          };
          const whPayload = JSON.stringify(whBody);
          const sig = crypto.createHmac("sha256", "fixture-webhook-secret").update(whPayload).digest("hex");
          const whRes = await withEnv(fixtureMail, () =>
            ctx.requestFlow("razorpay", {
              req: {
                method: "POST",
                body: whBody,
                headers: { "x-razorpay-signature": sig, "x-razorpay-event-id": "evt-legacy-cutoff-wh" },
                rawBody: whPayload,
              },
            }));
          assert.equal(whRes.status, 200, JSON.stringify(whRes));
          const whPayDoc = await ctx.commerce.fetch(
            '*[_type == "paymentRecord" && bookingId == $id][0]',
            { id: cutoffSyncBookingId },
          );
          assert.equal(whPayDoc?.source, "webhook", JSON.stringify(whPayDoc));
          assert.equal(
            whPayDoc?.bookingPayload?.salesAttribution?.ref?.source,
            "gads-max",
            JSON.stringify(whPayDoc),
          );
        } finally {
          Date.now = prevNow;
        }
      }
      {
        const slotPostCutoffReceipt = "2099-01-16T10:00:00.000Z";
        const prevNow = Date.now;
        Date.now = () => cutoffTs - 2_000;
        try {
          const holdRcpt = await createHoldForSlot(ctx, {
            id: "slotHold.post-cutoff-receipt",
            startTimeUTC: slotPostCutoffReceipt,
            expiresAt: new Date(cutoffTs + 1_800_000).toISOString(),
          });
          const qRcpt = await jsonReq(ctx.origin, "/quote-route", {
            body: { packageTitle: fixturePackage, startTimeUTC: slotPostCutoffReceipt, email: "customer@example.invalid" },
          });
          const { result: startRcpt } = await withPayPalOrderId("order-post-cutoff-receipt", () => jsonReq(ctx.origin, "/start-route", {
            headers: { cookie: refCookie({ source: "gads-max", capturedAt: cutoffCapturedAt }) },
            body: {
              provider: "paypal",
              quoteFingerprint: qRcpt.body.quoteFingerprint,
              bookingPayload: baseBookingPayload(holdRcpt, { startTimeUTC: slotPostCutoffReceipt }),
            },
          }));
          assert.equal(startRcpt.status, 200, JSON.stringify(startRcpt));
          Date.now = () => cutoffTs - 1_000;
          const finRcpt = await withEnv(fixtureMail, () => {
            const prev = globalThis.fetch;
            globalThis.fetch = (input, init = {}) => {
              const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
              if (url.pathname === "/v2/checkout/orders/order-post-cutoff-receipt") {
                return Promise.resolve(Response.json({
                  id: "order-post-cutoff-receipt", status: "COMPLETED", intent: "CAPTURE",
                  purchase_units: [{
                    amount: { value: "9.99", currency_code: "USD" },
                    payments: { captures: [{ id: "cap-post-cutoff", status: "COMPLETED", amount: { value: "9.99", currency_code: "USD" } }] },
                  }],
                }));
              }
              return prev(input, init);
            };
            return jsonReq(ctx.origin, "/finalize-route", {
              headers: { authorization: `Bearer ${startRcpt.body.paymentAccessToken}` },
              body: { paypalOrderId: "order-post-cutoff-receipt" },
            }).finally(() => { globalThis.fetch = prev; });
          });
          assert.equal(finRcpt.status, 200, JSON.stringify(finRcpt));
          Date.now = () => cutoffTs - 500;
          const failedReadValid = await ctx.requestFlow("status", {
            paymentAccessToken: startRcpt.body.paymentAccessToken,
            confirmationReadOverride: { failBookingRead: true },
          });
          assert.equal(failedReadValid.status, 200, JSON.stringify(failedReadValid));
          assert.equal(
            failedReadValid.body.analyticsReceipt?.attribution?.ref?.source,
            "gads-max",
            JSON.stringify(failedReadValid.body),
          );
          Date.now = () => cutoffTs + 1_000;
          const postCutoffStatus = await ctx.requestFlow("status", {
            paymentAccessToken: startRcpt.body.paymentAccessToken,
          });
          assert.equal(postCutoffStatus.status, 200, JSON.stringify(postCutoffStatus));
          assert.equal(
            postCutoffStatus.body.analyticsReceipt?.attribution?.ref?.source,
            "gads-max",
            JSON.stringify(postCutoffStatus.body.analyticsReceipt),
          );
          const postCutoffFailedRead = await ctx.requestFlow("status", {
            paymentAccessToken: startRcpt.body.paymentAccessToken,
            confirmationReadOverride: { failBookingRead: true },
          });
          assert.equal(postCutoffFailedRead.status, 200, JSON.stringify(postCutoffFailedRead));
          assert.equal(
            postCutoffFailedRead.body.analyticsReceipt?.attribution?.ref?.source,
            "gads-max",
            JSON.stringify(postCutoffFailedRead.body),
          );
          assert.equal(
            salesEventProperties(postCutoffStatus.body.analyticsReceipt.attribution).ref_source,
            "gads-max",
          );
        } finally {
          Date.now = prevNow;
        }
      }

      const slotDodoFail = "2099-01-12T10:00:00.000Z";
      const holdDodoFail = await createHoldForSlot(ctx, { id: "slotHold.dodo-fail-release", startTimeUTC: slotDodoFail, expiresAt: new Date(t0 + 1_800_000).toISOString() });
      const qDodoFail = await jsonReq(ctx.origin, "/quote-route", { body: { packageTitle: fixturePackage, startTimeUTC: slotDodoFail, email: "customer@example.invalid" } });
      let dodoFailState = false;
      let dodoFailRecordId = "";
      const prevFetchDodo = globalThis.fetch;
      globalThis.fetch = (input, init = {}) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
        if (url.pathname === "/products/pdt_fixture") {
          return Promise.resolve(Response.json({
            product_id: "pdt_fixture", is_recurring: false,
            price: { type: "one_time_price", currency: "USD", pay_what_you_want: true, tax_inclusive: false, purchasing_power_parity: false, discount: 0, price: 0 },
          }, { status: 200 }));
        }
        if (url.pathname === "/checkouts" && init.method === "POST") {
          return Promise.resolve(Response.json({ session_id: "cs_dodo_fail_1", checkout_url: "https://test.checkout.dodopayments.com/session/cs_dodo_fail_1" }, { status: 201 }));
        }
        if (url.pathname === "/checkouts/cs_dodo_fail_1") {
          return Promise.resolve(Response.json({ id: "cs_dodo_fail_1", payment_id: dodoFailState ? "pay_dodo_fail_1" : null }, { status: 200 }));
        }
        if (url.pathname === "/payments/pay_dodo_fail_1") {
          return Promise.resolve(Response.json({
            payment_id: "pay_dodo_fail_1", checkout_session_id: "cs_dodo_fail_1", status: "failed",
            currency: "USD", total_amount: 999, settlement_amount: 999, settlement_currency: "USD", tax: 0,
            metadata: { paymentRecordId: dodoFailRecordId }, product_cart: [{ product_id: "pdt_fixture", quantity: 1 }],
            disputes: [], refunds: [], refund_status: null, customer: { customer_id: "c_1", name: "Fixture", email: "customer@example.invalid" },
          }, { status: 200 }));
        }
        return prevFetchDodo(input, init);
      };
      try {
        const dodoStarted = await jsonReq(ctx.origin, "/start-route", {
          headers: { "x-forwarded-for": "198.51.102.7" },
          body: { provider: "dodo", quoteFingerprint: qDodoFail.body.quoteFingerprint, bookingPayload: baseBookingPayload(holdDodoFail, { startTimeUTC: slotDodoFail }) },
        });
        assert.equal(dodoStarted.status, 200, JSON.stringify(dodoStarted));
        const dodoPat = dodoStarted.body.paymentAccessToken;
        dodoFailRecordId = (await ctx.row("slotHold.dodo-fail-release")).payload.paymentRecordId;
        await ctx.documents.patch(dodoFailRecordId).set({ updatedAt: new Date(t0 - 120_000).toISOString(), lastAttemptAt: new Date(t0 - 120_000).toISOString() }).commit();
        const recUnpaid = await ctx.requestFlow("reconcile", { req: { headers: { authorization: "Bearer fixture-cron" } } });
        assert.equal(recUnpaid.status, 200, JSON.stringify(recUnpaid));
        assert.equal((await ctx.row(dodoFailRecordId)).payload.providerOrderLastSeenState, "unpaid");

        dodoFailState = true;
        await ctx.documents.patch(dodoFailRecordId).set({ nextRecoveryAt: "" }).commit();
        await ctx.sql.unsafe(`create or replace function public.dodo_release_fail_fixture() returns trigger language plpgsql as $$
          begin
            if old.legacy_sanity_id = 'slotHold.dodo-fail-release' then raise exception 'Synthetic slot release failure'; end if;
            return coalesce(new, old);
          end; $$;
          drop trigger if exists dodo_release_fail_fixture on migration.source_documents;
          create trigger dodo_release_fail_fixture before update or delete on migration.source_documents for each row execute function public.dodo_release_fail_fixture();`);
        try {
          await ctx.requestFlow("reconcile", { req: { headers: { authorization: "Bearer fixture-cron" } } });
        } finally {
          await ctx.sql.unsafe("drop trigger if exists dodo_release_fail_fixture on migration.source_documents; drop function if exists public.dodo_release_fail_fixture();");
        }
        const pendingFailRow = (await ctx.row(dodoFailRecordId)).payload;
        assert.equal(pendingFailRow.status, "needs_recovery", JSON.stringify(pendingFailRow));
        assert.equal(pendingFailRow.resourceReleasePending, true, JSON.stringify(pendingFailRow));
        const failStatus = await ctx.requestFlow("status", { paymentAccessToken: dodoPat });
        assert.equal(failStatus.status, 200, JSON.stringify(failStatus));
        assert.equal(failStatus.body.status, "needs_recovery");
        assert.equal(failStatus.body.providerPayload, undefined, JSON.stringify(failStatus.body));
        const failStartRetry = await jsonReq(ctx.origin, "/start-route", {
          headers: { "x-forwarded-for": "198.51.102.8" },
          body: { provider: "dodo", quoteFingerprint: qDodoFail.body.quoteFingerprint, bookingPayload: baseBookingPayload(holdDodoFail, { startTimeUTC: slotDodoFail }) },
        });
        assert.equal(failStartRetry.status, 409, JSON.stringify(failStartRetry));
        assert.equal(failStartRetry.body.status, "needs_recovery");
        assert.equal(failStartRetry.body.code, "payment_session_not_payable");
        assert.equal(failStartRetry.body.providerPayload, undefined, JSON.stringify(failStartRetry.body));
        const failPaypalStart = await jsonReq(ctx.origin, "/start-route", {
          headers: { "x-forwarded-for": "198.51.102.9" },
          body: { provider: "paypal", quoteFingerprint: qDodoFail.body.quoteFingerprint, bookingPayload: baseBookingPayload(holdDodoFail, { startTimeUTC: slotDodoFail }) },
        });
        assert.equal(failPaypalStart.status, 409, JSON.stringify(failPaypalStart));
        assert.equal(failPaypalStart.body.code, "payment_provider_already_claimed");
        assert.equal(failPaypalStart.body.claimedSession?.providerPayload?.checkoutUrl, undefined, JSON.stringify(failPaypalStart.body));
        const failCancel = await jsonReq(ctx.origin, "/cancel-route", {
          headers: { authorization: `Bearer ${dodoPat}` },
          body: {},
        });
        assert.equal(failCancel.status, 409, JSON.stringify(failCancel));
        const stillPending = (await ctx.row(dodoFailRecordId)).payload;
        assert.equal(stillPending.status, "needs_recovery");
        assert.equal(stillPending.resourceReleasePending, true);
        assert.equal((await ctx.row("slotHold.dodo-fail-release")).payload.phase, "payment_pending");

        await ctx.documents.patch(dodoFailRecordId).set({ nextRecoveryAt: "" }).commit();
        const recClean = await ctx.requestFlow("reconcile", { req: { headers: { authorization: "Bearer fixture-cron" } } });
        assert.equal(recClean.status, 200, JSON.stringify(recClean));
        const cleaned = (await ctx.row(dodoFailRecordId)).payload;
        assert.equal(cleaned.status, "failed", JSON.stringify(cleaned));
        assert.equal(cleaned.resourceReleasePending, false);
      } finally {
        globalThis.fetch = prevFetchDodo;
      }

      const tCaptured = t0 - (THIRTY_DAYS_MS - 1);
      const expEntry = { source: "gads-max", capturedAt: new Date(tCaptured).toISOString() };
      const slotExp = "2099-01-03T10:00:00.000Z";
      const holdExp = await createHoldForSlot(ctx, { id: "slotHold.exp-boundary", startTimeUTC: slotExp, expiresAt: new Date(t0 + 1_800_000).toISOString() });
      const qExp = await jsonReq(ctx.origin, "/quote-route", { body: { packageTitle: fixturePackage, startTimeUTC: slotExp, email: "customer@example.invalid" } });
      const { result: startExp, calls: expCalls } = await recordProviderCalls(() => jsonReq(ctx.origin, "/start-route", {
        headers: { cookie: refCookie(expEntry) },
        body: { provider: "paypal", quoteFingerprint: qExp.body.quoteFingerprint, bookingPayload: baseBookingPayload(holdExp, { startTimeUTC: slotExp }) },
      }));
      assert.equal(startExp.status, 200, JSON.stringify(startExp));
      const expPayId = paypalOrders(expCalls)[0].purchase_units[0].custom_id;
      assert.deepEqual((await ctx.row(expPayId)).payload.bookingPayload.salesAttribution, { ref: expEntry });

      Date.now = () => t0 + 1;
      const freshEntry = { source: "chatgpt-ads", capturedAt: new Date(t0 + 1).toISOString() };
      const finExp = await withEnv(fixtureMail, () => jsonReq(ctx.origin, "/finalize-route", {
        headers: { authorization: `Bearer ${startExp.body.paymentAccessToken}`, cookie: refCookie(freshEntry) },
        body: { paypalOrderId: "order-fixture", salesAttribution: { ref: freshEntry } },
      }));
      assert.equal(finExp.status, 200, JSON.stringify(finExp));
      const [expBookingRow] = await ctx.sql`
        select sales_attribution is null as is_sql_null, (booking_payload ? 'salesAttribution') as has_key
        from commerce.bookings where legacy_sanity_id = ${finExp.body.bookingId}`;
      assert.equal(expBookingRow.is_sql_null, true);
      assert.equal(expBookingRow.has_key, false);
      assert.equal(finExp.body.analyticsReceipt?.attribution, null, JSON.stringify(finExp.body.analyticsReceipt));
      const failedReadExp = await ctx.requestFlow("status", {
        paymentAccessToken: startExp.body.paymentAccessToken,
        confirmationReadOverride: { failBookingRead: true },
      });
      assert.equal(failedReadExp.status, 200, JSON.stringify(failedReadExp));
      assert.equal(failedReadExp.body.analyticsReceipt?.attribution, null, JSON.stringify(failedReadExp.body));

      Date.now = () => t0;
      const fakeAttrOnly = Buffer.from(JSON.stringify({ version: 2, journeyId, firstTouch: v1Touch })).toString("base64url");
      const fakeLastOnly = Buffer.from(JSON.stringify({ journeyId, lastTouch: v1Touch })).toString("base64url");
      const slotIgnoredCookies = "2099-01-06T10:00:00.000Z";
      const holdIgnoredCookies = await createHoldForSlot(ctx, { id: "slotHold.ignored-cookies", startTimeUTC: slotIgnoredCookies, expiresAt: new Date(t0 + 1_800_000).toISOString() });
      const qIgnoredCookies = await jsonReq(ctx.origin, "/quote-route", { body: { packageTitle: fixturePackage, startTimeUTC: slotIgnoredCookies, email: "customer@example.invalid" } });
      const { result: startIgnoredCookies, created: ignoredCreated } = await withPayPalOrderId("order-fixture-ignored-cookies", () => jsonReq(ctx.origin, "/start-route", {
        headers: { cookie: `roo_attr=${fakeAttrOnly}; roo_attr_last=${fakeLastOnly}` },
        body: { provider: "paypal", quoteFingerprint: qIgnoredCookies.body.quoteFingerprint, bookingPayload: baseBookingPayload(holdIgnoredCookies, { startTimeUTC: slotIgnoredCookies }) },
      }));
      assert.equal(startIgnoredCookies.status, 200, JSON.stringify(startIgnoredCookies));
      const ignoredPayId = ignoredCreated[0].purchase_units[0].custom_id;
      assert.equal(Object.hasOwn((await ctx.row(ignoredPayId)).payload.bookingPayload, "salesAttribution"), false);

      const futureOkEntry = { source: "gads-max", capturedAt: new Date(t0 + 3_600_000).toISOString() };
      const slotFutureOk = "2099-01-07T10:00:00.000Z";
      const holdFutureOk = await createHoldForSlot(ctx, { id: "slotHold.future-ok", startTimeUTC: slotFutureOk, expiresAt: new Date(t0 + 1_800_000).toISOString() });
      const qFutureOk = await jsonReq(ctx.origin, "/quote-route", { body: { packageTitle: fixturePackage, startTimeUTC: slotFutureOk, email: "customer@example.invalid" } });
      const { result: startFutureOk, created: futureOkCreated } = await withPayPalOrderId("order-fixture-future-ok", () => jsonReq(ctx.origin, "/start-route", {
        headers: { cookie: refCookie(futureOkEntry) },
        body: { provider: "paypal", quoteFingerprint: qFutureOk.body.quoteFingerprint, bookingPayload: baseBookingPayload(holdFutureOk, { startTimeUTC: slotFutureOk }) },
      }));
      assert.equal(startFutureOk.status, 200, JSON.stringify(startFutureOk));
      assert.deepEqual((await ctx.row(futureOkCreated[0].purchase_units[0].custom_id)).payload.bookingPayload.salesAttribution, { ref: futureOkEntry });

      const futureExpEntry = { source: "gads-max", capturedAt: new Date(t0 + 3_600_001).toISOString() };
      const slotFutureExp = "2099-01-08T10:00:00.000Z";
      const holdFutureExp = await createHoldForSlot(ctx, { id: "slotHold.future-exp", startTimeUTC: slotFutureExp, expiresAt: new Date(t0 + 1_800_000).toISOString() });
      const qFutureExp = await jsonReq(ctx.origin, "/quote-route", { body: { packageTitle: fixturePackage, startTimeUTC: slotFutureExp, email: "customer@example.invalid" } });
      const { result: startFutureExp, created: futureExpCreated } = await withPayPalOrderId("order-fixture-future-exp", () => jsonReq(ctx.origin, "/start-route", {
        headers: { cookie: refCookie(futureExpEntry) },
        body: { provider: "paypal", quoteFingerprint: qFutureExp.body.quoteFingerprint, bookingPayload: baseBookingPayload(holdFutureExp, { startTimeUTC: slotFutureExp }) },
      }));
      assert.equal(startFutureExp.status, 200, JSON.stringify(startFutureExp));
      assert.equal(Object.hasOwn((await ctx.row(futureExpCreated[0].purchase_units[0].custom_id)).payload.bookingPayload, "salesAttribution"), false);

      await ctx.documents.create({
        _id: "referral.real-creator", _type: "referral", name: "Creator", slug: { current: "friend" },
        registrationStatus: "active", currentDiscountPercent: 10, currentCommissionPercent: 15,
      });
      const slotValid = "2099-01-04T10:00:00.000Z";
      const holdValid = await createHoldForSlot(ctx, { id: "slotHold.valid-creator", startTimeUTC: slotValid, expiresAt: new Date(t0 + 1_800_000).toISOString() });
      const qValid = await jsonReq(ctx.origin, "/quote-route", { body: { packageTitle: fixturePackage, startTimeUTC: slotValid, email: "customer@example.invalid", referralCode: "friend" } });
      assert.equal(qValid.status, 200);
      assert.equal(qValid.body.quote.referralDiscountPercent, 10);
      const { result: startValid } = await withPayPalOrderId("order-fixture-valid", () => jsonReq(ctx.origin, "/start-route", {
        headers: { cookie: refCookie({ source: "friend", capturedAt: new Date(t0 - 1000).toISOString() }) },
        body: { provider: "paypal", quoteFingerprint: qValid.body.quoteFingerprint, bookingPayload: baseBookingPayload(holdValid, { startTimeUTC: slotValid, referralCode: "friend" }) },
      }));
      assert.equal(startValid.status, 200, JSON.stringify(startValid));

      const slotDropCreator = "2099-01-09T10:00:00.000Z";
      const holdDropCreator = await createHoldForSlot(ctx, { id: "slotHold.drop-creator", startTimeUTC: slotDropCreator, expiresAt: new Date(t0 + 1_800_000).toISOString() });
      const qDropCreator = await jsonReq(ctx.origin, "/quote-route", { body: { packageTitle: fixturePackage, startTimeUTC: slotDropCreator, email: "customer@example.invalid" } });
      const dropCreatorEntry = { source: "friend", capturedAt: new Date(t0 - 1000).toISOString() };
      const { result: startDropCreator, created: dropCreatorOrders } = await withPayPalOrderId("order-fixture-drop-creator", () => jsonReq(ctx.origin, "/start-route", {
        headers: { cookie: refCookie(dropCreatorEntry) },
        body: { provider: "paypal", quoteFingerprint: qDropCreator.body.quoteFingerprint, bookingPayload: baseBookingPayload(holdDropCreator, { startTimeUTC: slotDropCreator }) },
      }));
      assert.equal(startDropCreator.status, 200, JSON.stringify(startDropCreator));
      const dropCreatorPayId = dropCreatorOrders[0].purchase_units[0].custom_id;
      assert.deepEqual((await ctx.row(dropCreatorPayId)).payload.bookingPayload.salesAttribution, { ref: dropCreatorEntry });

      await ctx.documents.patch("referral.real-creator").set({ slug: { current: "friend-retired" } }).commit();
      const finDropCreator = await withEnv(fixtureMail, () => {
        const prev = globalThis.fetch;
        globalThis.fetch = (input, init = {}) => {
          const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
          if (url.pathname === "/v2/checkout/orders/order-fixture-drop-creator") {
            return Promise.resolve(Response.json({
              id: "order-fixture-drop-creator", status: "COMPLETED", intent: "CAPTURE",
              purchase_units: [{ amount: { value: "9.99", currency_code: "USD" }, payments: { captures: [{ id: "capture-drop-creator", status: "COMPLETED", amount: { value: "9.99", currency_code: "USD" } }] } }],
            }));
          }
          return prev(input, init);
        };
        return jsonReq(ctx.origin, "/finalize-route", {
          headers: { authorization: `Bearer ${startDropCreator.body.paymentAccessToken}` },
          body: { paypalOrderId: "order-fixture-drop-creator" },
        }).finally(() => { globalThis.fetch = prev; });
      });
      assert.equal(finDropCreator.status, 200, JSON.stringify(finDropCreator));
      const [dropCreatorRow] = await ctx.sql`
        select sales_attribution is null as is_sql_null, (booking_payload ? 'salesAttribution') as has_key
        from commerce.bookings where legacy_sanity_id = ${finDropCreator.body.bookingId}`;
      assert.equal(dropCreatorRow.is_sql_null, true);
      assert.equal(dropCreatorRow.has_key, false);
      assert.equal(finDropCreator.body.analyticsReceipt?.attribution, null, JSON.stringify(finDropCreator.body.analyticsReceipt));
      assert.deepEqual((await ctx.row(dropCreatorPayId)).payload.bookingPayload.salesAttribution, { ref: dropCreatorEntry });
      const statusDropCreator = await ctx.requestFlow("status", { paymentAccessToken: startDropCreator.body.paymentAccessToken });
      assert.equal(statusDropCreator.status, 200, JSON.stringify(statusDropCreator));
      assert.equal(statusDropCreator.body.analyticsReceipt?.attribution, null, JSON.stringify(statusDropCreator.body.analyticsReceipt));
      const failedReadDrop = await ctx.requestFlow("status", {
        paymentAccessToken: startDropCreator.body.paymentAccessToken,
        confirmationReadOverride: { failBookingRead: true },
      });
      assert.equal(failedReadDrop.status, 200, JSON.stringify(failedReadDrop));
      assert.equal(failedReadDrop.body.analyticsReceipt?.attribution, null, JSON.stringify(failedReadDrop.body));
      await ctx.documents.patch("referral.real-creator").set({ slug: { current: "friend" } }).commit();

      const refReceipt = buildSalesReceipt({
        _id: "paymentRecord.r1", bookingId: "booking.r1", status: "booked", provider: "dodo",
        verificationState: "server_verified", pricingSnapshot: { netAmount: 9.99, effectiveReferralCode: "" },
        providerPublicData: { currency: "USD" }, bookingPayload: { packageTitle: fixturePackage, salesAttribution: { ref: { source: "gads-max", capturedAt: new Date(t0).toISOString() } } },
      });
      assert.equal(refReceipt.referralCode, "");
      assert.deepEqual(refReceipt.attribution, { ref: { source: "gads-max", capturedAt: new Date(t0).toISOString() } });
      const legacyReceipt = buildSalesReceipt({
        _id: "paymentRecord.r2", bookingId: "booking.r2", status: "booked", provider: "dodo",
        verificationState: "server_verified", pricingSnapshot: { netAmount: 9.99, effectiveReferralCode: "promo-2026-11-24" },
        providerPublicData: { currency: "USD" }, bookingPayload: { packageTitle: fixturePackage },
      });
      assert.equal(legacyReceipt.referralCode, "");

      let lookupCount = 0;
      const stageNoFallthrough = await resolveValidatedServerSalesAttribution({
        salesAttribution: { version: 2, journeyId, firstTouch: { ...v1Touch, creatorCode: "gads-max" }, lastTouch: { ...v1Touch, creatorCode: "promo-2026-11-24" }, ref: { source: "gads-max", capturedAt: new Date(t0 - 60_000).toISOString() } },
        cookieHeader: refCookie({ source: "unknowncode", capturedAt: new Date(t0 - 120_000).toISOString() }),
        lookupCreator: async () => { lookupCount += 1; return false; },
        now: t0,
      });
      assert.equal(lookupCount, 1);
      assert.equal(stageNoFallthrough.ref, undefined);
      assert.equal(stageNoFallthrough.firstTouch.creatorCode, undefined);
      assert.equal(stageNoFallthrough.lastTouch.creatorCode, undefined);

      const tieCookieWins = await resolveValidatedServerSalesAttribution({
        salesAttribution: { ref: { source: "chatgpt-ads", capturedAt: new Date(t0 - 60_000).toISOString() } },
        cookieHeader: refCookie({ source: "gads-max", capturedAt: new Date(t0 - 60_000).toISOString() }),
        now: t0,
      });
      assert.equal(tieCookieWins.ref.source, "gads-max");

      Date.now = realNow;
      const runWithVirtualTimer = async (lookupDelayMs) => {
        const realSetTimeout = globalThis.setTimeout;
        const realClearTimeout = globalThis.clearTimeout;
        const timers = [];
        let nextId = 1;
        let unrefCalled = false;
        globalThis.setTimeout = (fn, ms) => {
          const handle = {
            id: nextId++,
            fn,
            ms: Number(ms),
            cleared: false,
            unref() {
              unrefCalled = true;
              return this;
            },
          };
          timers.push(handle);
          return handle;
        };
        globalThis.clearTimeout = (handle) => {
          if (handle) handle.cleared = true;
        };
        try {
          let calls = 0;
          const pending = resolveValidatedServerSalesAttribution({
            salesAttribution: { ...v2Expected, ref: { source: "friend", capturedAt: new Date().toISOString() } },
            lookupCreator: () => {
              calls += 1;
              return new Promise((resolve) => {
                globalThis.setTimeout(() => resolve(true), lookupDelayMs);
              });
            },
          });
          for (let i = 0; i < 10; i += 1) await Promise.resolve();
          const active = timers.filter((t) => !t.cleared).sort((a, b) => a.ms - b.ms || a.id - b.id);
          for (const handle of active) {
            if (!handle.cleared) handle.fn();
            for (let i = 0; i < 5; i += 1) await Promise.resolve();
          }
          return { result: await pending, calls, unrefCalled };
        } finally {
          globalThis.setTimeout = realSetTimeout;
          globalThis.clearTimeout = realClearTimeout;
        }
      };

      const boundary1499 = await runWithVirtualTimer(1499);
      assert.equal(boundary1499.calls, 1);
      assert.equal(boundary1499.unrefCalled, true);
      assert.equal(boundary1499.result?.ref?.source, "friend");

      const boundary1500 = await runWithVirtualTimer(1500);
      assert.equal(boundary1500.calls, 1);
      assert.equal(boundary1500.unrefCalled, true);
      assert.equal(boundary1500.result?.ref, undefined);
      assert.equal(boundary1500.result?.journeyId, journeyId);

      const ok1300 = await resolveValidatedServerSalesAttribution({
        salesAttribution: { ref: { source: "friend", capturedAt: new Date().toISOString() } },
        lookupCreator: () => new Promise((r) => setTimeout(() => r(true), 1300)),
      });
      assert.equal(ok1300?.ref?.source, "friend");

      let timedLookups = 0;
      const timedOut = await resolveValidatedServerSalesAttribution({
        salesAttribution: { ...v2Expected, ref: { source: "friend", capturedAt: new Date().toISOString() } },
        lookupCreator: () => { timedLookups += 1; return new Promise((r) => setTimeout(() => r(true), 1520)); },
      });
      assert.equal(timedLookups, 1);
      assert.equal(timedOut.ref, undefined);
      assert.equal(timedOut.journeyId, journeyId);

      const rejected = await resolveValidatedServerSalesAttribution({
        salesAttribution: { ...v2Expected, ref: { source: "friend", capturedAt: new Date().toISOString() } },
        lookupCreator: () => Promise.reject(new Error("db down")),
      });
      assert.equal(rejected.ref, undefined);
      assert.equal(rejected.journeyId, journeyId);

      const slowPricingClient = {
        fetch: async (q, params) => {
          await new Promise((r) => setTimeout(r, 1800));
          return ctx.documents.fetch(q, params);
        },
      };
      const slowPricing = await resolveBookingPricing({
        packageTitle: fixturePackage, referralCode: "friend", client: slowPricingClient,
      });
      assert.equal(slowPricing.referralDiscountPercent, 10);

      const slotDirect = "2099-01-05T10:00:00.000Z";
      const holdDirect = await createHoldForSlot(ctx, { id: "slotHold.direct-cookie", startTimeUTC: slotDirect, phase: "active" });
      const directEntry = { source: "gads-max", capturedAt: new Date().toISOString() };
      const directRes = await withEnv(fixtureMail, () => jsonReq(ctx.origin, "/booking", {
        headers: { cookie: refCookie(directEntry) },
        body: {
          body: {
            status: "captured", email: "customer@example.invalid", discord: "fixture", specs: "pc", mainGame: "cs2",
            packageTitle: fixturePackage, packagePrice: "$9.99", localTimeZone: "Asia/Kolkata", startTimeUTC: slotDirect,
            ...holdDirect, paymentProvider: "razorpay", razorpayOrderId: "order-fixture", razorpayPaymentId: "payment-fixture",
            razorpaySignature: crypto.createHmac("sha256", "fixture-secret").update("order-fixture|payment-fixture").digest("hex"),
          },
        },
      }));
      assert.equal(directRes.status, 200, JSON.stringify(directRes));
      const [directRow] = await ctx.sql`select sales_attribution from commerce.bookings where legacy_sanity_id = ${directRes.body.bookingId}`;
      assert.deepEqual(directRow.sales_attribution, { ref: directEntry });

      return { expBookingId: finExp.body.bookingId, directBookingId: directRes.body.bookingId };
    } finally {
      Date.now = realNow;
      await cleanCreatorsAndCoupons(ctx);
    }
  });
}
