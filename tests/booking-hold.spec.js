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
      await use({ post: (...args) => call("post", ...args), nextSlotDate: () => call("nextSlotDate"),
        getHold: id => call("getHold", id), verifyHold: hold => call("verifyHold", hold), evidence: () => call("evidence") });
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
const readHold = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")));
const specifications = "Ryzen 7700 / RTX 4070 · 東京 🦊";

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });
    for (const canResume of [true, false]) {
      test(`another tab starts payment; revalidation keeps credentials and ${canResume ? "resumes checkout" : "protects the draft without checkout data"}`, async ({ page, context, flow, native }, testInfo) => {
        flow.state.slots = [{ date: await native.nextSlotDate(), times: ["10:00", "11:00"] }];
        await context.route(/\/api\/(holdSlot|releaseHold|payment\/quote|payment\/start|payment\/cancel)(?:\?|$)/, async route => {
          const request = route.request();
          const response = await native.post(new URL(request.url()).pathname, request.postDataJSON(), request.headers().authorization);
          return route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) });
        });
        // The provider boundary stays inside the fixture; no checkout request is sent.
        await context.route("https://test.checkout.dodopayments.com/session/**", route => route.fulfill({
          contentType: "text/html", body: "<h1>Fixture provider checkout</h1>",
        }));
        await flow.reserve();
        await flow.details();
        await page.getByRole("textbox", { name: "PC specifications", exact: true }).fill(specifications);
        const original = await readHold(page);
        await page.getByRole("button", { name: "Review before payment", exact: true }).click();
        await flow.payment();
        const storage = await page.evaluate(() => Object.entries(sessionStorage));
        const other = await context.newPage();
        await other.goto("/__test/checkout-handoff");
        await other.evaluate(entries => entries.forEach(([key, value]) => sessionStorage.setItem(key, value)), storage);
        await other.goto("/payment");
        await expect(other.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
        await page.goto("/booking");
        await page.getByRole("button", { name: "Edit details", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "PC specifications", exact: true })).toHaveValue(specifications);
        if (!canResume) await page.evaluate(() => sessionStorage.removeItem("checkout_booking_state"));
        await page.getByRole("button", { name: "Back", exact: true }).last().click();
        await other.getByRole("button", { name: "Pay your way", exact: true }).click();
        await expect(other.getByRole("heading", { name: "Fixture provider checkout", exact: true })).toBeVisible();
        const stored = await native.getHold(original.holdId);
        expect(stored.phase).toBe("payment_pending");
        expect((await readHold(page)).phase).toBe("active");
        await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await expect.poll(() => readHold(page)).toMatchObject({ holdId: original.holdId,
          holdToken: original.holdToken, startTimeUTC: original.startTimeUTC, phase: "payment_pending", paymentStartedElsewhere: true });
        expect(await page.evaluate(() => sessionStorage.getItem("booking_draft"))).toContain(specifications);
        await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
        await expect(page.getByText(specifications, { exact: true })).toBeVisible();
        expect(await native.verifyHold({ token: original.holdToken, holdId: stored._id })).toBe(true);
        if (canResume) {
          const checkoutRequests = (await native.evidence()).providerRequests.filter(request => request.path === "/checkouts").length;
          await expect(page.getByRole("alert").filter({ hasText: "Your payment session is already in progress." })).toBeVisible();
          await page.getByRole("button", { name: "Return to payment", exact: true }).click();
          await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
          await page.getByRole("button", { name: "Pay your way", exact: true }).click();
          await expect(page.getByRole("heading", { name: "Fixture provider checkout", exact: true })).toBeVisible();
          expect((await native.evidence()).providerRequests.filter(request => request.path === "/checkouts")).toHaveLength(checkoutRequests);
        } else {
          await expect(page.getByRole("alert").filter({ hasText: "Payment already started in another tab." })).toBeVisible();
          await expect(page.getByRole("button", { name: "11:00 AM", exact: true })).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Return to payment", exact: true })).toHaveCount(0);
          expect(await readHold(page)).toMatchObject({ holdId: original.holdId, holdToken: original.holdToken });
          await page.reload();
          await expect(page.getByText(specifications, { exact: true })).toBeVisible();
          await expect(page.getByRole("alert").filter({ hasText: "Payment already started in another tab." })).toBeVisible();
          expect(await readHold(page)).toMatchObject({ holdId: original.holdId, holdToken: original.holdToken, phase: "payment_pending", paymentStartedElsewhere: true });
          await page.goto("/");
          await page.getByRole("button", { name: "View reservation", exact: true }).click();
          await expect(page.getByRole("alert").filter({ hasText: "Payment already started in another tab." })).toBeVisible();
          await expect(page.getByText(specifications, { exact: true })).toBeVisible();
          await testInfo.attach("other-tab-check-again", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
          await page.getByRole("button", { name: "Check again", exact: true }).click();
          await expect(page.getByRole("button", { name: "Check again", exact: true })).toBeEnabled();
          expect(await readHold(page)).toMatchObject({ holdId: original.holdId, holdToken: original.holdToken, phase: "payment_pending" });
          await other.goto("/booking");
          await other.getByRole("button", { name: "Release payment", exact: true }).click();
          await expect(other.getByText(/Payment method released/)).toBeVisible();
          await other.getByRole("button", { name: "Back", exact: true }).last().click();
          await other.getByRole("button", { name: "Release Slot", exact: true }).click();
          await expect.poll(() => readHold(other)).toBeNull();
          await page.getByRole("button", { name: "Check again", exact: true }).click();
          await expect(page.getByRole("textbox", { name: "PC specifications", exact: true })).toHaveValue(specifications);
          const recovered = await readHold(page);
          expect(recovered).toMatchObject({ holdId: original.holdId, startTimeUTC: original.startTimeUTC, phase: "active" });
          expect(recovered.paymentStartedElsewhere).toBeUndefined();
          expect(recovered.holdToken).not.toBe(original.holdToken);
          expect(await native.verifyHold({ token: recovered.holdToken, holdId: recovered.holdId })).toBe(true);
        }
        const evidence = await native.evidence();
        expect(evidence.blocked).toEqual([]);
        await testInfo.attach("native-reservation", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
        await other.close();
      });
    }
  });
}
