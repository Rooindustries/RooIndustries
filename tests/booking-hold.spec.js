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
      await use({
        post: (...args) => call("post", ...args),
        nextSlotDate: () => call("nextSlotDate"),
        getHold: id => call("getHold", id),
        verifyHold: hold => call("verifyHold", hold),
        evidence: () => call("evidence"),
        get: route => call("get", route),
        setPaymentStatus: status => call("setPaymentStatus", status),
        holdRunsOut: id => call("holdRunsOut", id),
        restoreClock: () => call("restoreClock"),
        reconcile: () => call("reconcile"),
        paymentSucceeded: id => call("paymentSucceeded", id),
      });
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
const routeToNative = async (context, native, date) => {
  const fulfillJson = (route, response, body) =>
    route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(body) });
  const nativeRoutes = /\/api\/(holdSlot|releaseHold|payment\/quote|payment\/start|payment\/cancel)(?:\?|$)/;
  await context.route(nativeRoutes, async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const response = await native.post(pathname, request.postDataJSON(), request.headers().authorization);
    return fulfillJson(route, response, response.body);
  });
  await context.route(/\/api\/bookingAvailability(?:\?|$)/, async route => {
    const response = await native.get("/api/bookingAvailability");
    const dateSlots = [{ date, times: ["10:00", "11:00"] }];
    const settings = {
      ...response.body.settings,
      dateSlots,
      xocDateSlots: dateSlots,
      vertexEssentialsDateSlots: dateSlots,
      packageDateSlots: [],
    };
    return fulfillJson(route, response, { ...response.body, settings });
  });
  await context.route("https://test.checkout.dodopayments.com/session/**", route => route.fulfill({
    contentType: "text/html", body: "<h1>Fixture provider checkout</h1>",
  }));
};
const openCheckout = async page => {
  const started = page.waitForResponse(response => new URL(response.url()).pathname === "/api/payment/start");
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await started;
  await expect(page.getByRole("heading", { name: "Fixture provider checkout", exact: true })).toBeVisible();
};
const expectOnlyElevenOffered = async page => {
  const earliest = page.getByRole("button", { name: /^Earliest available:/ });
  await expect(earliest).toHaveText(/at 11:00 AM$/);
  await earliest.click();
  await expect(page.getByRole("button", { name: "11:00 AM", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "10:00 AM", exact: true })).toBeDisabled();
};

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });
    const title = "a slot whose payment is still going through when its hold runs out stays taken for everyone else";
    test(title, async ({ page, context, flow, native }, testInfo) => {
      const date = await native.nextSlotDate();
      await routeToNative(context, native, date);
      await native.setPaymentStatus("processing");
      try {
        await flow.reserve();
        await flow.details();
        await page.getByRole("button", { name: "Review before payment", exact: true }).click();
        await flow.payment();
        await openCheckout(page);
        const holdCall = (await native.evidence()).http.findLast(entry => entry.path === "/api/holdSlot");
        const held = await native.getHold(holdCall.response.holdId);
        expect(held.phase).toBe("payment_pending");
        await native.holdRunsOut(held._id);
        expect((await native.reconcile()).status).toBe(200);
        expect((await native.getHold(held._id)).phase).toBe("payment_pending");

        const other = await context.newPage();
        await other.goto("/booking");
        await expectOnlyElevenOffered(other);
        await other.goto("/packages");
        await other.getByRole("link", { name: "Book Now" }).first().click();
        await expect(other).toHaveURL(/\/booking$/);
        await expectOnlyElevenOffered(other);
        await other.goBack();
        await expect(other).toHaveURL(/\/packages$/);
        await expect(other.getByRole("dialog")).toHaveCount(0);
        await other.goForward();
        await expect(other).toHaveURL(/\/booking$/);
        await expectOnlyElevenOffered(other);

        await native.setPaymentStatus("succeeded");
        expect((await native.paymentSucceeded(held._id)).status).toBe(200);
        const consumed = await native.getHold(held._id);
        expect(consumed.phase).toBe("consumed");
        expect(consumed.bookingId).toBeTruthy();
        await other.reload();
        await expectOnlyElevenOffered(other);
        const screenshot = await other.screenshot({ fullPage: true });
        await testInfo.attach("payment-window-other-visitor", { body: screenshot, contentType: "image/png" });
        await other.close();
      } finally {
        await native.restoreClock();
        await native.setPaymentStatus(null);
      }
    });

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
        await page.bringToFront();
        await page.goto("/booking");
        await page.getByRole("button", { name: "Edit details", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "PC specifications", exact: true })).toHaveValue(specifications);
        if (!canResume) await page.evaluate(() => sessionStorage.removeItem("checkout_booking_state"));
        await page.getByRole("button", { name: "Back", exact: true }).last().click();
        await other.bringToFront();
        await openCheckout(other);
        const stored = await native.getHold(original.holdId);
        expect(stored.phase).toBe("payment_pending");
        await page.bringToFront();
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
          await openCheckout(page);
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
          await other.bringToFront();
          await other.goto("/booking");
          await other.getByRole("button", { name: "Release payment", exact: true }).click();
          await expect(other.getByText(/Payment method released/)).toBeVisible();
          await other.getByRole("button", { name: "Back", exact: true }).last().click();
          await other.getByRole("button", { name: "Release Slot", exact: true }).click();
          await expect.poll(() => readHold(other)).toBeNull();
          await page.bringToFront();
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

const reservationState = page => page.evaluate(() => Object.fromEntries(
  ["my_slot_hold", "checkout_booking_state", "payment_session_state", "booking_draft"]
    .map(key => [key, sessionStorage.getItem(key)])
));

for (const [shape, sameSlot] of [["refreshed", false], ["refreshed", true], ["expired", false]]) {
  test(`a stale ${shape} payment release preserves a newer ${sameSlot ? "generation" : "reservation"}`,
    async ({ page, context, flow, native }) => {
      const date = await native.nextSlotDate();
      await routeToNative(context, native, date);
      let delayed;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route("**/api/payment/cancel", async route => {
        delayed = await native.post("/api/payment/cancel", {}, route.request().headers().authorization);
        await gate;
        await route.fulfill({ status: delayed.status, json: delayed.body });
      });
      try {
        await flow.review();
        await flow.payment();
        await openCheckout(page);
        await page.goto("/booking");
        const original = await reservationState(page);
        const oldHold = JSON.parse(original.my_slot_hold);
        if (shape === "expired") await native.holdRunsOut(oldHold.holdId);
        await page.getByRole("button", { name: "Release payment", exact: true }).click();
        await expect.poll(() => delayed?.body.cancelled).toBe(true);
        const payload = { ...JSON.parse(original.checkout_booking_state),
          startTimeUTC: sameSlot ? oldHold.startTimeUTC : `${date}T05:30:00.000Z`,
          displayTime: sameSlot ? "10:00 AM" : "11:00 AM" };
        const held = await native.post("/api/holdSlot", { packageTitle: payload.packageTitle,
          startTimeUTC: payload.startTimeUTC, previousHoldId: delayed.body.refreshedHold?.slotHoldId,
          previousHoldToken: delayed.body.refreshedHold?.slotHoldToken });
        expect(held.status).toBe(200);
        const nextHold = { ...oldHold, holdId: held.body.holdId, holdToken: held.body.holdToken,
          expiresAt: held.body.expiresAt, startTimeUTC: payload.startTimeUTC, phase: "active" };
        Object.assign(payload, { slotHoldId: nextHold.holdId, slotHoldToken: nextHold.holdToken,
          slotHoldExpiresAt: nextHold.expiresAt });
        const quote = await native.post("/api/payment/quote", { bookingPayload: payload });
        expect(quote.status).toBe(200);
        const started = await native.post("/api/payment/start", { provider: "dodo", bookingPayload: payload,
          quoteFingerprint: quote.body.quoteFingerprint });
        expect(started.status).toBe(200);
        const refreshed = started.body.refreshedHold;
        Object.assign(nextHold, { holdToken: refreshed.slotHoldToken, expiresAt: refreshed.slotHoldExpiresAt,
          phase: "payment_pending" });
        Object.assign(payload, { slotHoldToken: refreshed.slotHoldToken, slotHoldExpiresAt: refreshed.slotHoldExpiresAt });
        const nextSession = { provider: started.body.provider,
          fingerprint: JSON.stringify({ packageTitle: payload.packageTitle, originalOrderId: payload.originalOrderId || "",
            startTimeUTC: payload.startTimeUTC, email: payload.email,
            referralCode: payload.referralCode || "", couponCode: payload.couponCode || "" }),
          paymentAccessToken: started.body.paymentAccessToken, providerPayload: started.body.providerPayload,
          result: started.body };
        await page.evaluate(({ nextHold, payload, nextSession }) => {
          sessionStorage.setItem("my_slot_hold", JSON.stringify(nextHold));
          sessionStorage.setItem("checkout_booking_state", JSON.stringify(payload));
          sessionStorage.setItem("payment_session_state", JSON.stringify(nextSession));
        }, { nextHold, payload, nextSession });
        const newer = await reservationState(page);
        release();
        await expect(page.getByRole("button", { name: "Checking payment...", exact: true })).toHaveCount(0);
        expect(await reservationState(page)).toEqual(newer);
        expect((await native.getHold(nextHold.holdId)).holdNonce).toBeTruthy();
        await page.goto("/payment");
        await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeEnabled();
        await native.setPaymentStatus("succeeded");
        expect((await native.paymentSucceeded(nextHold.holdId)).status).toBe(200);
        const consumed = await native.getHold(nextHold.holdId);
        expect(consumed.phase).toBe("consumed");
        expect(consumed.bookingId).toBeTruthy();
      } finally {
        release();
        await native.restoreClock();
        await native.setPaymentStatus(null);
      }
    });
}

test("a delayed hold response cannot replace a reservation selected while it was pending",
  async ({ page, context, flow, native }) => {
    const date = await native.nextSlotDate();
    await routeToNative(context, native, date);
    let first;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/holdSlot", async route => {
      first = await native.post("/api/holdSlot", route.request().postDataJSON());
      await gate;
      await route.fulfill({ status: first.status, json: first.body });
    });
    try {
      await flow.booking();
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect.poll(() => first?.status).toBe(200);
      const held = await native.post("/api/holdSlot", {
        packageTitle: "Performance Vertex Overhaul", startTimeUTC: `${date}T05:30:00.000Z`,
      });
      expect(held.status).toBe(200);
      const hold = { holdId: held.body.holdId, holdToken: held.body.holdToken, expiresAt: held.body.expiresAt,
        startTimeUTC: `${date}T05:30:00.000Z`, packageTitle: "Performance Vertex Overhaul", phase: "active" };
      await page.evaluate(hold => sessionStorage.setItem("my_slot_hold", JSON.stringify(hold)), hold);
      const newer = await reservationState(page);
      release();
      await expect(page.getByRole("button", { name: "Next", exact: true }).last()).toBeEnabled();
      expect(await reservationState(page)).toEqual(newer);
    } finally { release(); }
  });
