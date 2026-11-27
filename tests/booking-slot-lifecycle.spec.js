const { test: base, expect } = require("./fixtures/booking-flow.cjs");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const test = base.extend({
  native: [async ({}, use) => {
    const child = fork(require.resolve("./fixtures/booking-slot-lifecycle.mjs"), [], { execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const pending = new Map();
    let nextId = 0;
    const ready = new Promise((resolve, reject) => {
      child.on("message", message => {
        if (message.ready) return resolve(message.operations);
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
      });
      child.on("exit", code => {
        const error = new Error(`Slot lifecycle fixture exited (${code})`);
        reject(error);
        for (const request of pending.values()) request.reject(error);
        pending.clear();
      });
    });
    const call = (method, ...args) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      child.send({ id, method, args });
    });
    try {
      const operations = await ready;
      await use(Object.fromEntries(operations.map(method => [method, (...args) => call(method, ...args)])));
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        await call("stop");
        await exited;
      }
    }
  }, { scope: "worker" }],
});

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce", actionTimeout: 10000, navigationTimeout: 20000, trace: "off" });
const nativeBinaries = [process.env.PG_BIN && path.join(process.env.PG_BIN, "postgres"), process.env.POSTGREST_BIN];
test.skip(!nativeBinaries.every(file => file && fs.existsSync(file)), "Needs PG_BIN and POSTGREST_BIN for the native PostgreSQL 17 fixture.");

const fulfillJson = (route, response, body = response.body) =>
  route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(body) });
const nativeRoutes = /\/api\/(holdSlot|releaseHold|payment\/quote|payment\/start|payment\/finalize|payment\/status)(?:\?|$)/;
const routeToNative = async (context, native, date) => {
  const answers = [];
  const forward = async request => {
    const endpoint = new URL(request.url()).pathname;
    const token = (request.headers().authorization || "").replace(/^Bearer /, "");
    const response = await native.post(endpoint, request.postDataJSON(), token);
    answers.push({ endpoint, ...response });
    return response;
  };
  await context.route(nativeRoutes, async route => fulfillJson(route, await forward(route.request())));
  await context.route(/\/api\/bookingAvailability(?:\?|$)/, async route => {
    const response = await native.availability();
    const dateSlots = [{ date, times: ["10:00"] }];
    const settings = { dateSlots, xocDateSlots: dateSlots, vertexEssentialsDateSlots: dateSlots, packageDateSlots: [] };
    return fulfillJson(route, response, { ...response.body, settings });
  });
  await context.route("https://test.checkout.dodopayments.com/session/**", route => route.fulfill({
    contentType: "text/html", body: "<h1>Fixture provider checkout</h1>",
  }));
  return { forward, answered: endpoint => answers.filter(answer => answer.endpoint === endpoint) };
};
const readHold = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")));
const selectSlot = async (page, flow) => {
  await flow.booking();
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
};
const pressNext = page => page.getByRole("button", { name: "Next", exact: true }).last().click();
const expectDetailsStep = page => expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
const expectReserved = async (page, native, slot) => {
  const held = await readHold(page);
  expect(held).toMatchObject({ holdId: slot.holdId, startTimeUTC: slot.startTimeUTC });
  expect(await native.verifyHold({ token: held.holdToken, holdId: held.holdId })).toBe(true);
  expect(await native.document(slot.holdId)).toMatchObject({ phase: "active" });
  expect(await native.slotClaims(slot.startTimeUTC)).toEqual(["hold"]);
};
const outcome = ({ status, body }) => ({ status, state: body.status, bookingId: body.bookingId });
const queueBehindCommerceLock = async (native, actors) => {
  await native.holdCommerceLock();
  try {
    for (const [index, act] of actors.entries()) {
      await act();
      await expect.poll(() => native.commerceLockWaiters()).toBe(index + 1);
    }
  } finally {
    await native.releaseCommerceLock();
  }
};

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("two confirmations of one payment book the slot once and email each side once", async ({ page, context, flow, native }) => {
      const slot = await native.freeSlot();
      const { forward, answered } = await routeToNative(context, native, slot.date);
      await flow.reserve();
      const held = await readHold(page);
      await native.sellAtPagePrice(held);
      await flow.details();
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      await flow.payment();
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Fixture provider checkout", exact: true })).toBeVisible();
      const { orderId, dodoReturnTag } = answered("/api/payment/start").at(-1).body.providerPayload;
      const confirmations = [];
      await context.route(/\/api\/payment\/finalize(?:\?|$)/, async route => {
        const both = await Promise.all([forward(route.request()), native.paymentSucceeded(orderId, "race")]);
        confirmations.push(...both);
        return fulfillJson(route, both[0]);
      });
      await page.goto(`/payment?dodo_return=1&dodo_session=${encodeURIComponent(dodoReturnTag)}`);
      await expect(page.getByRole("heading", { level: 1, name: "Payment Successful", exact: true })).toBeVisible();
      const bookings = await native.bookingsAt(slot.startTimeUTC);
      expect(bookings).toHaveLength(1);
      expect(await native.document(bookings[0])).toMatchObject({ packageTitle: held.packageTitle, packagePrice: held.packagePrice });
      expect(confirmations).toHaveLength(2);
      const [returned, raced] = confirmations.map(outcome);
      const answersFor = waiting => [
        { status: 200, state: "booked", bookingId: bookings[0] },
        { status: 200, state: "email_partial", bookingId: bookings[0] },
        { status: 200, state: "finalizing", bookingId: bookings[0] },
        { status: waiting, state: "started", bookingId: "" },
        { status: waiting, state: "finalizing", bookingId: "" },
      ];
      expect(answersFor(202)).toContainEqual(returned);
      expect(answersFor(503)).toContainEqual(raced);
      expect([returned.state, raced.state].some(state => ["booked", "email_partial"].includes(state))).toBe(true);
      expect(await native.paymentSucceeded(orderId, "retry")).toMatchObject({ status: 200, body: { status: "booked", bookingId: bookings[0] } });
      expect(await native.bookingsAt(slot.startTimeUTC)).toEqual(bookings);
      expect(await native.slotClaims(slot.startTimeUTC)).toEqual(["booking"]);
      expect(await native.document(slot.holdId)).toMatchObject({ phase: "consumed", bookingId: bookings[0] });
      expect(await native.emails(bookings[0])).toEqual(["owner@example.invalid", "visitor@example.invalid"]);
    });

    test("cancelling a booking frees only its own slot, and the next customer reserves it", async ({ page, context, flow, native }) => {
      const cancelled = await native.book(await native.freeSlot());
      const kept = await native.book(await native.freeSlot());
      expect(await native.adminStatus(cancelled.bookingId, "canceled"))
        .toMatchObject({ status: 200, body: { status: "cancelled", reopenedSlot: true } });
      await routeToNative(context, native, cancelled.date);
      await flow.reserve();
      await expectReserved(page, native, cancelled);
      expect(await native.document(cancelled.bookingId)).toMatchObject({ status: "cancelled" });
      expect(await native.document(cancelled.lockId)).toMatchObject({ status: "released" });
      expect(await native.document(kept.lockId)).toMatchObject({ status: "active", bookingId: kept.bookingId });
    });

    test("a full refund reopens the slot for the next customer and reverses the coupon and referral once", async ({ page, context, flow, native }) => {
      const codes = await native.discountCodes();
      const refunded = await native.book(await native.freeSlot(), { couponCode: codes.couponCode, referralCode: codes.referralCode });
      expect(await native.document(codes.couponId)).toMatchObject({ timesUsed: 1 });
      expect(await native.referral(codes.referralId)).toMatchObject({ successfulReferrals: 1 });
      expect(await native.adminStatus(refunded.bookingId, "refunded")).toMatchObject({
        status: 200,
        body: { reopenedSlot: true, couponRestored: true, referralReversed: true, idempotent: false },
      });
      expect(await native.adminStatus(refunded.bookingId, "refunded")).toMatchObject({ status: 200, body: { idempotent: true } });
      const settled = await native.document(refunded.bookingId);
      expect(settled).toMatchObject({ status: "refunded", refundStatus: "full" });
      expect(await native.latePartialRefund(refunded)).toMatchObject({ status: 200 });
      expect(await native.document(refunded.bookingId)).toEqual(settled);
      expect(await native.document(settled.paymentRecordId)).toMatchObject({ status: "refunded", refundState: "full" });
      expect(await native.document(refunded.lockId)).toMatchObject({ status: "released" });
      expect(await native.document(codes.couponId)).toMatchObject({ timesUsed: 0, isActive: true });
      expect(await native.referral(codes.referralId)).toMatchObject({ successfulReferrals: 0 });
      await routeToNative(context, native, refunded.date);
      await flow.reserve();
      await expectReserved(page, native, refunded);
    });

    test("a slot still locked by a refunded booking is reserved by a customer who chose it earlier, while its upgrade stays active", async ({ page, context, flow, native }) => {
      const slot = await native.freeSlot();
      await routeToNative(context, native, slot.date);
      await selectSlot(page, flow);
      try {
        const original = await native.book(slot);
        await native.activeUpgrade(original);
        await native.markRefunded(original.bookingId);
        expect(await native.document(slot.lockId)).toMatchObject({ status: "active", bookingId: original.bookingId });
        await pressNext(page);
        await expectDetailsStep(page);
        await expectReserved(page, native, slot);
        expect(await native.document(slot.lockId)).toMatchObject({ status: "released", releaseReason: "booking_status_repair" });
        await page.getByRole("button", { name: "Back", exact: true }).last().click();
        await page.getByRole("button", { name: "Release Slot", exact: true }).click();
        await expect.poll(() => readHold(page)).toBeNull();
        expect(await native.document(slot.holdId)).toMatchObject({ phase: "released" });
      } finally {
        const held = await readHold(page);
        if (held) expect.soft(await native.post("/api/releaseHold", { holdId: held.holdId, holdToken: held.holdToken })).toMatchObject({ status: 200 });
      }
    });

    test("a cancelled booking cannot be restored over the slot a customer has just reserved", async ({ page, context, flow, native }) => {
      const cancelled = await native.cancelledBooking();
      await routeToNative(context, native, cancelled.date);
      await flow.reserve();
      expect(await native.adminStatus(cancelled.bookingId, "captured")).toMatchObject({ status: 409, body: { ok: false } });
      expect(await native.document(cancelled.bookingId)).toMatchObject({ status: "cancelled" });
      await expectReserved(page, native, cancelled);
    });

    test("a restore queued ahead of a reservation keeps the slot for its booking and the reservation is refused", async ({ page, context, flow, native }) => {
      const cancelled = await native.cancelledBooking();
      const { answered } = await routeToNative(context, native, cancelled.date);
      await selectSlot(page, flow);
      await queueBehindCommerceLock(native, [() => native.beginRestore(cancelled.bookingId), () => pressNext(page)]);
      expect(await native.restoreAnswer()).toMatchObject({ status: 200, body: { status: "captured" } });
      await expect.poll(() => answered("/api/holdSlot").length).toBe(1);
      const [reservation] = answered("/api/holdSlot");
      expect(reservation.status).toBe(409);
      await expect(page.getByRole("alert").filter({ hasText: reservation.body.message })).toBeVisible();
      expect(await readHold(page)).toBeNull();
      expect(await native.document(cancelled.bookingId)).toMatchObject({ status: "captured" });
      expect(await native.document(cancelled.lockId)).toMatchObject({ status: "active", bookingId: cancelled.bookingId });
      expect(await native.document(cancelled.holdId)).toMatchObject({ phase: "consumed", bookingId: cancelled.bookingId });
      expect(await native.slotClaims(cancelled.startTimeUTC)).toEqual(["booking"]);
    });

    test("a reservation queued ahead of a restore keeps the slot for the customer and the restore is refused", async ({ page, context, flow, native }) => {
      const cancelled = await native.cancelledBooking();
      await routeToNative(context, native, cancelled.date);
      await selectSlot(page, flow);
      await queueBehindCommerceLock(native, [() => pressNext(page), () => native.beginRestore(cancelled.bookingId)]);
      expect(await native.restoreAnswer()).toMatchObject({ status: 409, body: { ok: false } });
      await expectDetailsStep(page);
      await expectReserved(page, native, cancelled);
      expect(await native.document(cancelled.bookingId)).toMatchObject({ status: "cancelled" });
    });
  });
}
