const { test: base, expect } = require("./fixtures/booking-flow.cjs");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const test = base.extend({
  native: [async ({}, use) => {
    const child = fork(require.resolve("./fixtures/booking-hold.mjs"), ["--worker"], { execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const pending = new Map();
    let nextId = 0;
    const ready = new Promise((resolve, reject) => {
      child.on("message", message => {
        if (message.ready) return resolve();
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
      });
      child.on("exit", code => {
        const error = new Error(`Booking fixture exited (${code})`);
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
      await ready;
      await call("seedCoupon");
      await use({ call });
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        await call("stop");
        await exited;
      }
    }
  }, { scope: "worker" }],
});

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce", trace: "off" });
const nativeBinaries = [process.env.PG_BIN && path.join(process.env.PG_BIN, "postgres"), process.env.POSTGREST_BIN];
test.skip(!nativeBinaries.every(file => file && fs.existsSync(file)), "Needs PG_BIN and POSTGREST_BIN for the native PostgreSQL 17 fixture.");

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`a free checkout claims its proof and coupon at ${viewport.width}px`, async ({ page, context, flow, native }) => {
    await page.setViewportSize(viewport);
    flow.state.slots = [{ date: await native.call("nextSlotDate"), times: ["10:00", "11:00"] }];
    await context.route(/\/api\/(holdSlot|releaseHold|payment\/quote|payment\/start|ref\/validateCoupon)(?:\?|$)/, async route => {
      const request = route.request();
      const url = new URL(request.url());
      const response = request.method() === "GET"
        ? await native.call("get", `${url.pathname}${url.search}`)
        : await native.call("post", url.pathname, request.postDataJSON(), request.headers().authorization);
      await route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) });
    });
    await flow.booking();
    await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
    const held = page.waitForResponse(response => new URL(response.url()).pathname === "/api/holdSlot");
    await page.getByRole("button", { name: "Next", exact: true }).last().click();
    const response = await held;
    expect(new Date((await response.json()).expiresAt).getTime()).toBeGreaterThan(Date.now());
    await flow.details();
    await page.getByRole("button", { name: "Review before payment", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    await flow.codeInput("FREE100");
    await expect(page.getByRole("button", { name: /Remove coupon code/i })).toBeVisible();
    await flow.payment();
    await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Thank You!", exact: true })).toBeVisible();
    const evidence = await native.call("evidence");
    const started = evidence.http.findLast(entry => entry.path === "/api/payment/start");
    expect(started.status).toBe(200);
    const { booking, payment, proof, redemption, bookings, proofs } = await native.call("freeBooking", started.response.bookingId);
    expect(bookings).toHaveLength(1);
    expect(proofs).toHaveLength(1);
    expect(payment.bookingId).toBe(booking._id);
    expect(proof).toMatchObject({ paymentRecordId: payment._id, bookingId: booking._id, status: "claimed" });
    expect(redemption.status).toBe("consumed");
    expect(evidence.blocked).toEqual([]);
  });
}
