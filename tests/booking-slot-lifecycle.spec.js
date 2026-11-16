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
const routeToNative = async (context, native, date) => {
  const reservations = [];
  await context.route(/\/api\/holdSlot(?:\?|$)/, async route => {
    const response = await native.post("/api/holdSlot", route.request().postDataJSON());
    reservations.push(response);
    return fulfillJson(route, response);
  });
  await context.route(/\/api\/bookingAvailability(?:\?|$)/, async route => {
    const response = await native.availability();
    const dateSlots = [{ date, times: ["10:00"] }];
    const settings = { dateSlots, xocDateSlots: dateSlots, vertexEssentialsDateSlots: dateSlots, packageDateSlots: [] };
    return fulfillJson(route, response, { ...response.body, settings });
  });
  return reservations;
};
const readHold = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")));
const expectReserved = async (page, native, slot) => {
  const held = await readHold(page);
  expect(held).toMatchObject({ holdId: slot.holdId, startTimeUTC: slot.startTimeUTC });
  expect(await native.verifyHold({ token: held.holdToken, holdId: held.holdId })).toBe(true);
  expect(await native.document(slot.holdId)).toMatchObject({ phase: "active" });
};

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("cancelling a booking frees only its own slot, and the next customer reserves it", async ({ page, context, flow, native }) => {
      const cancelled = await native.book();
      const kept = await native.book();
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
      const refunded = await native.book({ couponCode: codes.couponCode, referralCode: codes.referralCode });
      expect(await native.document(codes.couponId)).toMatchObject({ timesUsed: 1 });
      expect(await native.referral(codes.referralId)).toMatchObject({ successfulReferrals: 1 });
      expect(await native.adminStatus(refunded.bookingId, "refunded")).toMatchObject({
        status: 200,
        body: { reopenedSlot: true, couponRestored: true, referralReversed: true, idempotent: false },
      });
      expect(await native.adminStatus(refunded.bookingId, "refunded")).toMatchObject({ status: 200, body: { idempotent: true } });
      expect(await native.latePartialRefund(refunded.bookingId)).toMatchObject({ idempotent: true });
      await routeToNative(context, native, refunded.date);
      await flow.reserve();
      await expectReserved(page, native, refunded);
      expect(await native.document(refunded.bookingId)).toMatchObject({ status: "refunded", refundStatus: "full" });
      expect(await native.document(refunded.lockId)).toMatchObject({ status: "released" });
      expect(await native.document(codes.couponId)).toMatchObject({ timesUsed: 0, isActive: true });
      expect(await native.referral(codes.referralId)).toMatchObject({ successfulReferrals: 0 });
    });

    test("a cancelled booking cannot be restored over the slot a customer has just reserved", async ({ page, context, flow, native }) => {
      const cancelled = await native.cancelledBooking();
      await routeToNative(context, native, cancelled.date);
      await flow.reserve();
      expect(await native.adminStatus(cancelled.bookingId, "captured")).toMatchObject({ status: 409, body: { ok: false } });
      expect(await native.document(cancelled.bookingId)).toMatchObject({ status: "cancelled" });
      await expectReserved(page, native, cancelled);
    });

    test("a reservation sent while the slot's booking is being restored is refused and the booking keeps the slot", async ({ page, context, flow, native }) => {
      const cancelled = await native.cancelledBooking();
      const reservations = await routeToNative(context, native, cancelled.date);
      await flow.booking();
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await native.holdCommerceLock();
      try {
        await native.beginRestore(cancelled.bookingId);
        await expect.poll(() => native.commerceLockWaiters()).toBe(1);
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await expect.poll(() => native.commerceLockWaiters()).toBe(2);
      } finally {
        await native.releaseCommerceLock();
      }
      expect(await native.restoreAnswer()).toMatchObject({ status: 200, body: { status: "captured" } });
      await expect.poll(() => reservations.length).toBe(1);
      expect(reservations[0].status).toBe(409);
      await expect(page.getByRole("alert").filter({ hasText: reservations[0].body.message })).toBeVisible();
      expect(await readHold(page)).toBeNull();
      expect(await native.document(cancelled.bookingId)).toMatchObject({ status: "captured" });
      expect(await native.document(cancelled.lockId)).toMatchObject({ status: "active", bookingId: cancelled.bookingId });
      expect(await native.document(cancelled.holdId)).toMatchObject({ phase: "consumed", bookingId: cancelled.bookingId });
    });
  });
}
