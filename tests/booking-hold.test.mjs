import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { createBookingHoldFixture } from "./fixtures/booking-hold.mjs";

let fixture, couponChild, couponCall;
before(async () => {
  couponChild = fork(new URL('./fixtures/booking-coupons.mjs', import.meta.url), [], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const pending = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    couponChild.on('message', message => {
      if (message.ready) return resolve();
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
    });
    couponChild.on('exit', code => {
      const error = new Error(`Coupon fixture exited (${code})`);
      reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    });
  });
  couponCall = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    couponChild.send({ id, method, args });
  });
  await ready;
  fixture = await createBookingHoldFixture();
});
after(async () => {
  await fixture?.stop();
  if (couponChild?.exitCode === null) {
    const exited = once(couponChild, 'exit');
    await couponCall('stop');
    await exited;
  }
});

const refresh = (payload, credentials = {}) => fixture.post("/api/holdSlot", {
  startTimeUTC: payload.startTimeUTC,
  packageTitle: payload.packageTitle,
  previousHoldId: payload.slotHoldId,
  previousHoldToken: payload.slotHoldToken,
  ...credentials,
});
const paymentMessage = "This slot already has a payment session in progress.";
const holdDocuments = async () => (await fixture.commerce.dataset({ documentTypes: ["slotHold"] }))
  .sort((left, right) => left._id.localeCompare(right._id));
const withConfiguredSlot = async (startTimeUTC, run) => {
  try {
    await fixture.slotAt(startTimeUTC);
    await run();
  } finally {
    await fixture.restoreSettings();
  }
};

test("an owner can recognize a live payment hold without losing valid credentials", async () => {
  const payload = await fixture.hold();
  const before = await fixture.commerce.getDocument(payload.slotHoldId);
  const payment = await fixture.start(payload);
  assert.equal(payment.status, 200, JSON.stringify(payment));
  const beforeRefresh = await fixture.snapshot(payload.startTimeUTC);
  const response = await refresh(payload);
  assert.deepEqual(await fixture.snapshot(payload.startTimeUTC), beforeRefresh);
  const stored = await fixture.commerce.getDocument(payload.slotHoldId);
  const { verifyHoldToken } = await import("../src/server/booking/holdToken.js");
  assert.equal(stored.phase, "payment_pending");
  assert.equal(stored.holdNonce, before.holdNonce);
  assert.ok(verifyHoldToken({ token: payload.slotHoldToken, holdId: stored._id,
    startTimeUTC: stored.startTimeUTC, holdNonce: stored.holdNonce,
    backend: stored.backendOwner, cutoverGeneration: Number(stored.cutoverGeneration || 0) }));
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { ok: false, message: paymentMessage, code: "hold_payment_in_progress" });
  assert.deepEqual(fixture.evidence.blocked, []);
});

test("payment ownership is not exposed to missing, invalid, or foreign credentials", async () => {
  const payload = await fixture.hold();
  assert.equal((await fixture.start(payload)).status, 200);
  const before = await fixture.snapshot(payload.startTimeUTC);
  for (const credentials of [
    { previousHoldId: null, previousHoldToken: null },
    { previousHoldToken: "invalid-token" },
    { previousHoldId: "another-hold" },
  ]) {
    const response = await refresh(payload, credentials);
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, { ok: false, message: paymentMessage });
    assert.deepEqual(await fixture.snapshot(payload.startTimeUTC), before);
  }
});

test("a token superseded before payment cannot identify the payment owner", async () => {
  const payload = await fixture.hold();
  const updated = await refresh(payload);
  assert.equal(updated.status, 200);
  assert.notEqual(updated.body.holdToken, payload.slotHoldToken);
  assert.equal((await fixture.start({ ...payload, slotHoldToken: updated.body.holdToken })).status, 200);
  const before = await fixture.snapshot(payload.startTimeUTC);
  const stale = await refresh(payload);
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { ok: false, message: paymentMessage });
  assert.deepEqual(await fixture.snapshot(payload.startTimeUTC), before);
});

test("an ordinary foreign active hold keeps its existing 409 response", async () => {
  const payload = await fixture.hold();
  const before = await fixture.snapshot(payload.startTimeUTC);
  const response = await refresh(payload, { previousHoldToken: "invalid-token" });
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { ok: false, message: "This slot is currently reserved by someone else." });
  assert.deepEqual(await fixture.snapshot(payload.startTimeUTC), before);
});

test("unconfigured, sub-minute, and invalid starts do not create holds", async () => {
  const date = fixture.nextSlotDate();
  const { buildSlotHoldId } = await import("../src/server/booking/slotIdentity.js");
  const before = await holdDocuments();
  for (const [startTimeUTC, message] of [
    [`${date}T04:31:00.000Z`, "This time is not available for the selected package."],
    ["2099-02-01T04:30:00.000Z", "This time is not available for the selected package."],
    [`${date}T04:30:00.001Z`, "startTimeUTC must be an exact configured minute."],
    [`${date}T04:30:30.000Z`, "startTimeUTC must be an exact configured minute."],
    ["invalid", "startTimeUTC must be an exact configured minute."],
  ]) {
    const beforeCommands = await fixture.commandCount();
    const beforeClaims = await fixture.sql`select * from commerce.slot_claims order by start_time_utc`;
    const beforeSlot = Number.isFinite(Date.parse(startTimeUTC)) ? await fixture.snapshot(startTimeUTC) : null;
    const response = await fixture.post("/api/holdSlot", {
      startTimeUTC, packageTitle: "Performance Vertex Overhaul",
    }, "", { "x-forwarded-for": "192.0.2.51" });
    assert.equal(response.status, 400);
    assert.equal(response.body.message, message);
    const holdId = buildSlotHoldId(startTimeUTC);
    if (holdId) assert.equal(await fixture.commerce.getDocument(holdId), null);
    if (beforeSlot) assert.deepEqual(await fixture.snapshot(startTimeUTC), beforeSlot);
    assert.equal(await fixture.commandCount(), beforeCommands);
    assert.deepEqual(Array.from(await fixture.sql`select * from commerce.slot_claims order by start_time_utc`), Array.from(beforeClaims));
  }
  assert.deepEqual(await holdDocuments(), before);
});

const withDatabaseLimiter = async run => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSecret = process.env.RATE_LIMIT_HASH_SECRET;
  process.env.NODE_ENV = "development";
  process.env.RATE_LIMIT_HASH_SECRET = "fixture-only-rate-limit";
  try {
    await run();
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousSecret === undefined) delete process.env.RATE_LIMIT_HASH_SECRET;
    else process.env.RATE_LIMIT_HASH_SECRET = previousSecret;
  }
};

test("the twenty-first hold request from one address is rate limited", t => withDatabaseLimiter(async () => {
  const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now);
  try {
    const before = await holdDocuments();
    const startTimeUTC = `${fixture.nextSlotDate()}T04:30:00.000Z`;
    const body = { startTimeUTC, packageTitle: "Performance Vertex Overhaul" };
    for (let index = 0; index < 20; index += 1) {
      const response = await fixture.post("/api/holdSlot", body, "", { "x-forwarded-for": "192.0.2.52" });
      assert.equal(response.status, index === 0 ? 200 : 409);
    }
    const beforeLimit = await fixture.snapshot(startTimeUTC);
    const response = await fixture.post("/api/holdSlot", body, "", { "x-forwarded-for": "192.0.2.52" });
    assert.equal(response.status, 429);
    assert.deepEqual(response.body, { ok: false, error: "Too many slot hold requests. Please try again later." });
    assert.deepEqual(await fixture.snapshot(startTimeUTC), beforeLimit);
    const { buildSlotHoldId } = await import("../src/server/booking/slotIdentity.js");
    assert.equal((await fixture.commerce.getDocument(buildSlotHoldId(startTimeUTC))).phase, "active");
    const after = await holdDocuments();
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(after.filter(hold => hold._id !== buildSlotHoldId(startTimeUTC)), before);
  } finally {
    clock.mock.restore();
  }
}));

test("a limiter that cannot count refuses a reservation without writing", () => withDatabaseLimiter(async () => {
  const startTimeUTC = `${fixture.nextSlotDate()}T04:30:00.000Z`;
  const request = () => fetch(`${fixture.baseURL}/api/holdSlot`, {
    method: "POST", headers: { "content-type": "application/json", origin: fixture.baseURL,
      "x-forwarded-for": "192.0.2.60" },
    body: JSON.stringify({ startTimeUTC, packageTitle: "Performance Vertex Overhaul" }),
  });
  const before = await fixture.snapshot(startTimeUTC);
  await fixture.setFault("limiter");
  let response;
  try {
    response = await request();
  } finally {
    await fixture.clearFault("limiter");
  }
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.deepEqual(await response.json(), { ok: false, error: "Request protection is temporarily unavailable." });
  assert.deepEqual(await fixture.snapshot(startTimeUTC), before);
  assert.equal((await request()).status, 200);
}));

test("environment and database pauses prevent new holds", async () => {
  const { createSupabaseAdminClient } = await import("../src/server/supabase/adminClient.js");
  const { buildSlotHoldId } = await import("../src/server/booking/slotIdentity.js");
  const admin = createSupabaseAdminClient();
  const control = await admin.rpc("roo_commerce_control");
  assert.equal(control.error, null);
  const setPaused = paused => admin.rpc("roo_set_commerce_starts_paused", {
    p_expected_generation: control.data.generation, p_paused: paused, p_reason: "fixture pause",
  });
  const previousPause = process.env.COMMERCE_STARTS_PAUSED;
  const date = fixture.nextSlotDate();
  const before = await holdDocuments();
  try {
    process.env.COMMERCE_STARTS_PAUSED = "1";
    let startTimeUTC = `${date}T04:30:00.000Z`;
    let beforeSlot = await fixture.snapshot(startTimeUTC);
    let response = await fixture.post("/api/holdSlot", { startTimeUTC, packageTitle: "Performance Vertex Overhaul" },
      "", { "x-forwarded-for": "192.0.2.53" });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "commerce_starts_paused");
    assert.equal(await fixture.commerce.getDocument(buildSlotHoldId(startTimeUTC)), null);
    assert.deepEqual(await holdDocuments(), before);
    assert.deepEqual(await fixture.snapshot(startTimeUTC), beforeSlot);
    process.env.COMMERCE_STARTS_PAUSED = "0";
    assert.equal((await setPaused(true)).error, null);
    startTimeUTC = `${date}T05:30:00.000Z`;
    beforeSlot = await fixture.snapshot(startTimeUTC);
    response = await fixture.post("/api/holdSlot", { startTimeUTC, packageTitle: "Performance Vertex Overhaul" },
      "", { "x-forwarded-for": "192.0.2.54" });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "commerce_starts_paused");
    assert.equal(await fixture.commerce.getDocument(buildSlotHoldId(startTimeUTC)), null);
    assert.deepEqual(await holdDocuments(), before);
    assert.deepEqual(await fixture.snapshot(startTimeUTC), beforeSlot);
  } finally {
    const restored = await setPaused(false);
    if (previousPause === undefined) delete process.env.COMMERCE_STARTS_PAUSED;
    else process.env.COMMERCE_STARTS_PAUSED = previousPause;
    assert.equal(restored.error, null);
  }
});

test("a configured slot two minutes ahead can be reserved", async () => {
  try {
    const { startTimeUTC } = await fixture.nearSlot(120_000);
    const response = await fixture.post("/api/holdSlot", { startTimeUTC, packageTitle: "Performance Vertex Overhaul" },
      "", { "x-forwarded-for": "192.0.2.57" });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    const hold = await fixture.commerce.getDocument(response.body.holdId);
    assert.equal(hold.startTimeUTC, startTimeUTC);
    assert.equal(hold.phase, "active");
  } finally {
    await fixture.restoreSettings();
  }
});

test("a configured slot in the past cannot be reserved", async () => {
  const { buildSlotHoldId } = await import("../src/server/booking/slotIdentity.js");
  const start = Math.floor((Date.now() - 86_400_000) / 60_000) * 60_000;
  const startTimeUTC = new Date(start).toISOString();
  await withConfiguredSlot(startTimeUTC, async () => {
    const before = await fixture.snapshot(startTimeUTC);
    const response = await fixture.post("/api/holdSlot", { startTimeUTC, packageTitle: "Performance Vertex Overhaul" },
      "", { "x-forwarded-for": "192.0.2.58" });
    assert.equal(response.status, 400);
    assert.equal(response.body.message, "This time has already started.");
    assert.equal(await fixture.commerce.getDocument(buildSlotHoldId(startTimeUTC)), null);
    assert.deepEqual(await fixture.snapshot(startTimeUTC), before);
  });
});

test("an owned hold cannot be refreshed or reclaimed once its slot has started", async () => {
  const { buildSlotHoldId } = await import("../src/server/booking/slotIdentity.js");
  const { issueHoldToken } = await import("../src/server/booking/holdToken.js");
  for (const [daysAgo, expired] of [[2, false], [3, true]]) {
    const start = Math.floor((Date.now() - daysAgo * 86_400_000) / 60_000) * 60_000;
    const startTimeUTC = new Date(start).toISOString();
    const expiresAt = new Date(expired ? start - 120_000 : Date.now() + 1_200_000).toISOString();
    const holdId = buildSlotHoldId(startTimeUTC);
    const holdNonce = `fixture-${daysAgo}`;
    await withConfiguredSlot(startTimeUTC, async () => {
      await fixture.commerce.create({ _id: holdId, _type: "slotHold", startTimeUTC,
        packageTitle: "Performance Vertex Overhaul", expiresAt, holdNonce, phase: "active",
        backendOwner: "supabase", cutoverGeneration: 0 });
      const before = await fixture.commerce.getDocument(holdId);
      const beforeSnapshot = await fixture.snapshot(startTimeUTC);
      const token = issueHoldToken({ holdId, startTimeUTC, expiresAt, holdNonce,
        backend: "supabase", cutoverGeneration: 0 });
      const response = await fixture.post("/api/holdSlot", { startTimeUTC,
        packageTitle: "Performance Vertex Overhaul", previousHoldId: holdId, previousHoldToken: token },
      "", { "x-forwarded-for": "192.0.2.59" });
      assert.equal(response.status, 400);
      assert.equal(response.body.message, "This time has already started.");
      assert.deepEqual(await fixture.commerce.getDocument(holdId), before);
      assert.deepEqual(await fixture.snapshot(startTimeUTC), beforeSnapshot);
    });
  }
});

test("an unreachable database refuses a reservation without writing", async () => {
  const startTimeUTC = `${fixture.nextSlotDate()}T04:30:00.000Z`;
  const before = await fixture.snapshot(startTimeUTC);
  let response;
  try {
    await fixture.setFault("unreachable");
    response = await fetch(`${fixture.baseURL}/api/holdSlot`, {
      method: "POST", headers: { "content-type": "application/json", origin: fixture.baseURL,
        "x-forwarded-for": "192.0.2.61" },
      body: JSON.stringify({ startTimeUTC, packageTitle: "Performance Vertex Overhaul" }),
    });
  } finally {
    await fixture.clearFault("unreachable");
  }
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(await response.json(), { ok: false, code: "commerce_control_unavailable",
    message: "New booking starts are temporarily unavailable. Please try again shortly." });
  assert.deepEqual(await fixture.snapshot(startTimeUTC), before);
});

test("a refused hold write leaves no reservation behind", async () => {
  const startTimeUTC = `${fixture.nextSlotDate()}T04:30:00.000Z`;
  const before = await fixture.snapshot(startTimeUTC);
  await fixture.setFault("write");
  let response;
  try {
    response = await fixture.post("/api/holdSlot", { startTimeUTC, packageTitle: "Performance Vertex Overhaul" },
      "", { "x-forwarded-for": "192.0.2.62" });
  } finally {
    await fixture.clearFault("write");
  }
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { ok: false, message: "Failed to reserve this slot. Please try again." });
  assert.deepEqual(await fixture.snapshot(startTimeUTC), before);
});

test("missing booking settings refuse a reservation without writing", async () => {
  const startTimeUTC = `${fixture.nextSlotDate()}T04:30:00.000Z`;
  await fixture.setFault("settings");
  try {
    const before = await fixture.snapshot(startTimeUTC);
    const response = await fixture.post("/api/holdSlot", { startTimeUTC, packageTitle: "Performance Vertex Overhaul" },
      "", { "x-forwarded-for": "192.0.2.63" });
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { ok: false, message: "Failed to reserve this slot. Please try again." });
    assert.deepEqual(await fixture.snapshot(startTimeUTC), before);
  } finally {
    await fixture.clearFault("settings");
  }
});

test("holds are created and refreshed on Supabase across generations without Sanity settings", async () => {
  const { createSupabaseAdminClient } = await import("../src/server/supabase/adminClient.js");
  const admin = createSupabaseAdminClient();
  const savedSanity = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SANITY_|NEXT_PUBLIC_SANITY_)/.test(key)));
  const previousGeneration = process.env.COMMERCE_FAILOVER_GENERATION;
  const previousDataBackend = process.env.DATA_PRIMARY_BACKEND;
  const previousCommerceBackend = process.env.COMMERCE_PRIMARY_BACKEND;
  for (const key of Object.keys(savedSanity)) delete process.env[key];
  const [savedControl] = await fixture.sql`select generation, primary_backend, starts_paused, change_reason
    from migration.commerce_control where singleton`;
  const advance = generation => admin.rpc("roo_advance_commerce_generation", {
    p_expected_generation: generation, p_primary_backend: "supabase", p_starts_paused: false, p_reason: "fixture generation",
  });
  try {
    const control = await admin.rpc("roo_commerce_control");
    assert.equal(control.error, null);
    const firstGeneration = control.data.generation + 1;
    assert.equal((await advance(control.data.generation)).error, null);
    process.env.COMMERCE_FAILOVER_GENERATION = String(firstGeneration);
    const startTimeUTC = `${fixture.nextSlotDate()}T04:30:00.000Z`;
    const body = { startTimeUTC, packageTitle: "Performance Vertex Overhaul" };
    const first = await fixture.post("/api/holdSlot", body, "", { "x-forwarded-for": "192.0.2.55" });
    assert.equal(first.status, 200);
    assert.equal(first.body.backend, "supabase");
    assert.equal(first.body.cutoverGeneration, firstGeneration);
    const created = await fixture.commerce.getDocument(first.body.holdId);
    assert.equal(created.backendOwner, "supabase");
    assert.equal(created.cutoverGeneration, firstGeneration);
    assert.equal((await advance(firstGeneration)).error, null);
    process.env.COMMERCE_FAILOVER_GENERATION = String(firstGeneration + 1);
    process.env.DATA_PRIMARY_BACKEND = "sanity";
    process.env.COMMERCE_PRIMARY_BACKEND = "sanity";
    const second = await fixture.post("/api/holdSlot", { ...body, previousHoldId: first.body.holdId,
      previousHoldToken: first.body.holdToken }, "", { "x-forwarded-for": "192.0.2.56" });
    assert.equal(second.status, 200);
    assert.equal(second.body.backend, "supabase");
    assert.equal(second.body.cutoverGeneration, firstGeneration + 1);
    const refreshed = await fixture.commerce.getDocument(first.body.holdId);
    assert.equal(refreshed.backendOwner, "supabase");
    assert.equal(refreshed.cutoverGeneration, firstGeneration + 1);
    assert.notEqual(second.body.holdToken, first.body.holdToken);
  } finally {
    if (previousGeneration === undefined) delete process.env.COMMERCE_FAILOVER_GENERATION;
    else process.env.COMMERCE_FAILOVER_GENERATION = previousGeneration;
    process.env.DATA_PRIMARY_BACKEND = previousDataBackend;
    process.env.COMMERCE_PRIMARY_BACKEND = previousCommerceBackend;
    Object.assign(process.env, savedSanity);
    await fixture.sql`update migration.commerce_control set ${fixture.sql(savedControl)} where singleton`;
  }
});

test("a legacy paid booking creates its missing payment record", async () => {
  const payload = await fixture.hold();
  assert.ok(new Date(fixture.evidence.http.findLast(entry => entry.path === "/api/holdSlot").response.expiresAt).getTime() > Date.now());
  const emailsBefore = fixture.evidence.providerRequests.filter(request => request.path === "/emails").length;
  const response = await fixture.post("/api/ref/createBooking", {
    ...payload,
    status: "captured",
    paymentProvider: "paypal",
    paypalOrderId: "fixture_legacy_order",
    payerEmail: payload.email,
    displayDate: "Monday, January 15, 2099",
    displayTime: "10:00 AM",
    deferEmailsUntilConfirmation: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.ok(response.body.bookingId);
  assert.ok(response.body.emailDispatchToken);
  assert.deepEqual({ deferred: response.body.emailDispatch.deferred, allSent: response.body.emailDispatch.allSent },
    { deferred: true, allSent: false });
  assert.equal(fixture.evidence.providerRequests.filter(request => request.path === "/emails").length, emailsBefore);
  const booking = await fixture.commerce.getDocument(response.body.bookingId);
  assert.equal(booking.emailDispatchDeferred, true);
  assert.equal(booking.emailDispatchStatus, "pending");
  assert.ok(booking.emailDispatchQueuedAt);
  const records = await fixture.commerce.fetch(
    '*[_type == "paymentRecord" && provider == "paypal" && providerOrderId == $id]',
    { id: "fixture_legacy_order" }
  );
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.status, "email_partial");
  assert.equal(record.bookingId, response.body.bookingId);
  assert.equal(record.payerEmail, payload.email);
  assert.equal(record.emailDispatchToken, response.body.emailDispatchToken);
  assert.equal(record.bookingPayload.packageTitle, payload.packageTitle);
  assert.equal(record.bookingPayload.email, payload.email);
  assert.equal(record.bookingPayload.paymentProvider, "paypal");
  assert.equal(record.pricingSnapshot.netAmount, 54.95);
});

test("historical reconstruction keeps delivered emails and accounting unchanged", async () => {
  const payload = await fixture.hold();
  assert.ok(new Date(fixture.evidence.http.findLast(entry => entry.path === "/api/holdSlot").response.expiresAt).getTime() > Date.now());
  fixture.setPaymentStatus("succeeded");
  try {
    const started = await fixture.start(payload);
    assert.equal(started.status, 200, JSON.stringify(started));
    const record = await fixture.commerce.fetch(
      '*[_type == "paymentRecord" && bookingPayload.slotHoldId == $id][0]',
      { id: payload.slotHoldId }
    );
    const referralId = "referral.fixture.historical";
    await fixture.content.create({ _id: referralId, _type: "referral", creatorEmail: "creator@example.invalid",
      registrationStatus: "active", successfulReferrals: 4 });
    await fixture.commerce.create({ _id: "coupon.fixture.historical", _type: "coupon", code: "HISTORICAL", isActive: true,
      discountType: "percent", discountPercent: 10, canCombineWithReferral: true,
      timesUsed: 0, activeReservations: 0, maxUses: 0, backendOwner: "supabase", cutoverGeneration: 0 });
    const completedAt = "2099-01-15T10:05:00.000Z";
    await fixture.commerce.patch(record._id).set({ historicalBookingReconstruction: true,
      emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } },
      lastEmailDispatchAt: completedAt,
      pricingSnapshot: { ...record.pricingSnapshot, effectiveReferralId: referralId },
      bookingPayload: { ...record.bookingPayload, couponCode: "HISTORICAL" },
    }).commit();
    const emailsBefore = fixture.evidence.providerRequests.filter(request => request.path === "/emails").length;
    const redemptionsBefore = await fixture.commerce.fetch('*[_type == "couponRedemption"]{_id}');
    const response = await fixture.post("/api/payment/finalize", {}, `Bearer ${started.body.paymentAccessToken}`);
    assert.deepEqual(await fixture.commerce.fetch('*[_type == "couponRedemption"]{_id}'), redemptionsBefore);
    assert.equal(response.status, 200, JSON.stringify(response));
    const booking = await fixture.commerce.getDocument(response.body.bookingId);
    const payment = await fixture.commerce.getDocument(record._id);
    const bookings = await fixture.commerce.fetch('*[_type == "booking" && paymentRecordId == $id]', { id: record._id });
    assert.equal(bookings.length, 1);
    assert.equal(booking.emailDispatchStatus, "sent");
    assert.equal(booking.emailDispatchClientSentAt, completedAt);
    assert.equal(booking.emailDispatchOwnerSentAt, completedAt);
    assert.equal(fixture.evidence.providerRequests.filter(request => request.path === "/emails").length, emailsBefore);
    assert.equal((await fixture.content.getDocument(referralId)).successfulReferrals, 4);
    assert.equal(payment.status, "booked");
    assert.equal(payment.bookingId, booking._id);
  } finally {
    fixture.setPaymentStatus(null);
  }
});

const reserve = async () => {
  const payload = await fixture.hold();
  const response = fixture.evidence.http.findLast(entry => entry.path === "/api/holdSlot").response;
  assert.ok(new Date(response.expiresAt).getTime() > Date.now());
  return { ...payload, slotHoldExpiresAt: response.expiresAt };
};

const legacyPayload = payload => ({
  ...payload, packagePrice: "$54.95", status: "captured", paymentProvider: "razorpay",
  razorpayOrderId: "order_fixture", razorpayPaymentId: "payment_fixture",
  localTimeZone: "America/Los_Angeles",
  displayDate: new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles",
    weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(payload.startTimeUTC)),
  displayTime: new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles",
    hour: "numeric", minute: "2-digit" }).format(new Date(payload.startTimeUTC)),
});

test("legacy Razorpay booking requires a client signature", async () => {
  const payload = await reserve();
  const key = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  const originalFetch = globalThis.fetch;
  process.env.RAZORPAY_KEY_ID = "rzp_test_fixture";
  process.env.RAZORPAY_KEY_SECRET = "fixture-secret";
  globalThis.fetch = (input, init) => String(input) === "https://api.razorpay.com/v1/payments/payment_fixture"
    ? Promise.resolve(Response.json({ id: "payment_fixture", order_id: "order_fixture", status: "captured",
      captured: true, currency: "USD", amount: 5495 })) : originalFetch(input, init);
  try {
    const result = await fixture.post("/api/ref/createBooking", { ...legacyPayload(payload),
      paymentRecordId: "paymentRecord.razorpay.order.public_fixture" });
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.deepEqual(result.body, { error: "Missing payment verification fields." });
    assert.equal((await fixture.commerce.getDocument(payload.slotHoldId)).phase, "active");
  } finally {
    globalThis.fetch = originalFetch;
    if (key === undefined) delete process.env.RAZORPAY_KEY_ID; else process.env.RAZORPAY_KEY_ID = key;
    if (secret === undefined) delete process.env.RAZORPAY_KEY_SECRET; else process.env.RAZORPAY_KEY_SECRET = secret;
  }
});

test("a legacy Razorpay payment without transaction IDs creates no booking or emails and can be released", async () => {
  const payload = await reserve();
  const before = fixture.evidence.providerRequests.length;
  const holds = () => fixture.commerce.fetch('*[_type == "slotHold" && _id == $id]', { id: payload.slotHoldId });
  assert.equal((await holds()).length, 1);
  const result = await fixture.post("/api/ref/createBooking", { ...legacyPayload(payload),
    razorpayOrderId: "", razorpayPaymentId: "", razorpaySignature: "fixture_signature", deferEmailsUntilConfirmation: false });
  assert.equal(result.status, 400, JSON.stringify(result));
  assert.deepEqual(await fixture.commerce.fetch('*[_type == "booking" && startTimeUTC == $start]', { start: payload.startTimeUTC }), []);
  assert.deepEqual(fixture.evidence.providerRequests.slice(before), []);
  const release = await fixture.post("/api/releaseHold", { holdId: payload.slotHoldId, holdToken: payload.slotHoldToken });
  assert.equal(release.status, 200, JSON.stringify(release));
  const released = await holds();
  assert.equal(released.length, 1);
  assert.equal(released[0].phase, "released");
});

test("a rejected legacy payment leaves no booking or email and permits release", async () => {
  const payload = await reserve();
  const before = fixture.evidence.providerRequests.length;
  const key = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  const originalFetch = globalThis.fetch;
  const razorpayRequests = [];
  globalThis.fetch = (input, init) => {
    if (String(input).startsWith("https://api.razorpay.com/")) {
      razorpayRequests.push(String(input));
      return Promise.resolve(Response.json({ id: "payment_fixture", order_id: "order_fixture",
        status: "captured", captured: true, currency: "USD", amount: 5495 }));
    }
    return originalFetch(input, init);
  };
  process.env.RAZORPAY_KEY_ID = "rzp_test_fixture";
  process.env.RAZORPAY_KEY_SECRET = "fixture-secret";
  try {
    const result = await fixture.post("/api/ref/createBooking", { ...legacyPayload(payload), razorpaySignature: "invalid", deferEmailsUntilConfirmation: false });
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.deepEqual(result.body, { error: "Payment verification failed." });
    assert.deepEqual(await fixture.commerce.fetch('*[_type == "booking" && startTimeUTC == $start]', { start: payload.startTimeUTC }), []);
    assert.deepEqual(fixture.evidence.providerRequests.slice(before), []);
    assert.deepEqual(razorpayRequests, []);
    const release = await fixture.post("/api/releaseHold", { holdId: payload.slotHoldId, holdToken: payload.slotHoldToken });
    assert.equal(release.status, 200, JSON.stringify(release));
    assert.equal((await fixture.commerce.getDocument(payload.slotHoldId)).phase, "released");
  } finally {
    globalThis.fetch = originalFetch;
    if (key === undefined) delete process.env.RAZORPAY_KEY_ID; else process.env.RAZORPAY_KEY_ID = key;
    if (secret === undefined) delete process.env.RAZORPAY_KEY_SECRET; else process.env.RAZORPAY_KEY_SECRET = secret;
  }
});

for (const missing of [false, true]) {
  test(`a captured legacy payment books after its hold ${missing ? "is deleted" : "expires"}`, async () => {
    const payload = await reserve();
    const originalFetch = globalThis.fetch;
    const emails = [];
    globalThis.fetch = (input, init) => {
      if (String(input) === "https://api.resend.com/emails") {
        emails.push(JSON.parse(init.body));
        return Promise.resolve(Response.json({ id: `email_fixture_${emails.length}` }));
      }
      return originalFetch(input, init);
    };
    try {
      await fixture.holdRunsOut(payload.slotHoldId);
      if (missing) await fixture.commerce.delete(payload.slotHoldId);
      const response = await fixture.post("/api/ref/createBooking", {
        ...legacyPayload(payload), paymentProvider: "paypal", paypalOrderId: `order_${payload.slotHoldId}`,
        razorpayOrderId: "", razorpayPaymentId: "",
        payerEmail: payload.email,
        deferEmailsUntilConfirmation: false,
      });
      assert.equal(response.status, 200, JSON.stringify(response));
      const bookings = await fixture.commerce.fetch('*[_type == "booking" && startTimeUTC == $start]', { start: payload.startTimeUTC });
      assert.equal(bookings.length, 1);
      assert.equal(bookings[0].slotReservationState, missing ? "reconciled_after_missing_hold" : "reconciled_after_expired_hold");
      if (!missing) assert.equal(emails.length, 2);
    } finally {
      fixture.restoreClock();
      globalThis.fetch = originalFetch;
    }
  });
}

test("one legacy provider proof cannot book two different slots", async () => {
  const holds = [await reserve(), await reserve()];
  const originalFetch = globalThis.fetch;
  const emails = [];
  globalThis.fetch = (input, init) => {
    if (String(input) === "https://api.resend.com/emails") {
      emails.push(JSON.parse(init.body));
      return Promise.resolve(Response.json({ id: `email_proof_${emails.length}` }));
    }
    return originalFetch(input, init);
  };
  try {
    const responses = await Promise.all(holds.map(payload => fixture.post("/api/ref/createBooking", {
      ...legacyPayload(payload), paymentProvider: "paypal", paypalOrderId: "order_shared_proof",
      razorpayOrderId: "", razorpayPaymentId: "", payerEmail: payload.email, deferEmailsUntilConfirmation: false,
    })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.deepEqual(responses.find(response => response.status === 409).body, { error: "Booking time changed for this request key." });
    const bookings = (await Promise.all(holds.map(({ startTimeUTC }) => fixture.commerce.fetch(
      '*[_type == "booking" && startTimeUTC == $start]', { start: startTimeUTC })))).flat();
    assert.equal(bookings.length, 1);
    const slots = (await Promise.all(holds.map(({ startTimeUTC }) => fixture.commerce.fetch(
      '*[_type == "bookingSlot" && startTimeUTC == $start]', { start: startTimeUTC })))).flat();
    assert.equal(slots.length, 1);
    assert.equal(emails.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a Razorpay webhook recovers a captured payment after its hold was deleted", async () => {
  const payload = await reserve();
  const keys = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { RAZORPAY_KEY_ID: "rzp_test_fixture", RAZORPAY_KEY_SECRET: "fixture-secret",
    RAZORPAY_WEBHOOK_SECRET: "fixture-webhook-secret" });
  const originalFetch = globalThis.fetch;
  const payment = { id: "payment_webhook_fixture", order_id: "order_webhook_fixture", status: "captured",
    captured: true, amount: 5495, amount_refunded: 0, refund_status: null, currency: "USD" };
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.razorpay.com/v1/orders?")) return Promise.resolve(Response.json({ items: [] }));
    if (url === "https://api.razorpay.com/v1/orders") return Promise.resolve(Response.json({ id: payment.order_id,
      amount: payment.amount, currency: payment.currency, receipt: JSON.parse(init.body).receipt, status: "created" }));
    if (url === `https://api.razorpay.com/v1/payments/${payment.id}`) return Promise.resolve(Response.json(payment));
    return originalFetch(input, init);
  };
  try {
    const quote = await fixture.post("/api/payment/quote", { bookingPayload: payload });
    assert.equal(quote.status, 200, JSON.stringify(quote));
    const started = await fixture.post("/api/payment/start", { provider: "razorpay", bookingPayload: payload,
      quoteFingerprint: quote.body.quoteFingerprint });
    assert.equal(started.status, 200, JSON.stringify(started));
    await fixture.holdRunsOut(payload.slotHoldId);
    await fixture.commerce.delete(payload.slotHoldId);
    const event = { id: "event_webhook_fixture", event: "payment.captured", payload: { payment: { entity: payment } } };
    const signature = createHmac("sha256", "fixture-webhook-secret").update(JSON.stringify(event)).digest("hex");
    const webhook = await fixture.post("/api/payment/webhook/razorpay", event, "", { "x-razorpay-signature": signature });
    assert.equal(webhook.status, 200, JSON.stringify(webhook));
    const bookings = await fixture.commerce.fetch('*[_type == "booking" && startTimeUTC == $start]', { start: payload.startTimeUTC });
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].paymentProvider, "razorpay");
    assert.equal(bookings[0].razorpayOrderId, payment.order_id);
    assert.equal(bookings[0].razorpayPaymentId, payment.id);
    assert.equal(bookings[0].slotReservationState, "reconciled_after_missing_hold");
  } finally {
    fixture.restoreClock();
    globalThis.fetch = originalFetch;
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

test('booking rejects a coupon targeted at another package', async () => {
  await couponCall('create', { _id: 'coupon.targeted', _type: 'coupon', code: 'TARGETED', discountType: 'fixed',
    discountAmount: 10, eligiblePackages: [{ _ref: 'package.fixture.2' }], canCombineWithReferral: true,
    isActive: true, timesUsed: 0 });
  const payload = await couponCall('hold');
  const existing = await couponCall('rows', 'booking');
  const response = await couponCall('post', '/api/ref/createBooking', { ...payload, status: 'captured',
    paymentProvider: 'paypal', paypalOrderId: 'targeted-order', couponCode: 'TARGETED' });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: 'This coupon is not valid for the selected package.' });
  assert.deepEqual(await couponCall('rows', 'booking'), existing);
});

test('booking rejects a coupon that cannot be combined with a referral', async () => {
  await couponCall('create', { _id: 'referral.noclub', _type: 'referral', slug: { _type: 'slug', current: 'noclub' },
    registrationStatus: 'active', currentCommissionPercent: 20, currentDiscountPercent: 10 });
  await couponCall('create', { _id: 'coupon.noclub', _type: 'coupon', code: 'NOCLUB', discountType: 'percent',
    discountPercent: 5, canCombineWithReferral: false, isActive: true, timesUsed: 0 });
  const payload = await couponCall('hold');
  const existing = await couponCall('rows', 'booking');
  const response = await couponCall('post', '/api/ref/createBooking', { ...payload, status: 'captured',
    paymentProvider: 'paypal', paypalOrderId: 'noclub-order', couponCode: 'NOCLUB', referralCode: 'noclub' });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "This coupon can't be combined with a referral discount." });
  assert.deepEqual(await couponCall('rows', 'booking'), existing);
});
