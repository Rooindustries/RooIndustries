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

for (const [shape, sameSlot] of [["refreshed", false], ["refreshed", true], ["expired", false], ["captured", false]]) {
  test(`a stale ${shape} payment release preserves a newer ${sameSlot ? "generation" : "reservation"}`,
    async ({ page, context, flow, native }) => {
      const date = await native.nextSlotDate();
      await routeToNative(context, native, date);
      let delayed;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route("**/api/payment/cancel", async route => {
        if (shape === "captured") await native.setPaymentStatus("succeeded");
        delayed = await native.post("/api/payment/cancel", {}, route.request().headers().authorization);
        if (shape === "captured") await native.setPaymentStatus(null);
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
        await expect.poll(() => shape === "captured" ? delayed?.body.captured : delayed?.body.cancelled).toBe(true);
        const payload = { ...JSON.parse(original.checkout_booking_state),
          startTimeUTC: sameSlot ? oldHold.startTimeUTC : `${date}T05:30:00.000Z`,
          displayTime: sameSlot ? "10:00 AM" : "11:00 AM" };
        const held = await native.post("/api/holdSlot", { packageTitle: payload.packageTitle,
          startTimeUTC: payload.startTimeUTC,
          ...(sameSlot ? { previousHoldId: delayed.body.refreshedHold?.slotHoldId,
            previousHoldToken: delayed.body.refreshedHold?.slotHoldToken } : {}) });
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
        if (shape === "captured") {
          await expect(page).toHaveURL(/\/payment-success$/);
          expect(await page.evaluate(() => history.state.usr.bookingConfirmation.bookingId)).toBe(delayed.body.bookingId);
          expect(await reservationState(page)).toEqual(newer);
          expect((await native.getHold(nextHold.holdId)).phase).toBe("payment_pending");
        }
        await expect(page.getByRole("button", { name: "Checking payment...", exact: true })).toHaveCount(0);
        expect(await reservationState(page)).toEqual(newer);
        if (shape === "refreshed" && !sameSlot) {
          await expect.poll(async () => (await native.getHold(oldHold.holdId)).phase).toBe("released");
        }
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
      await expect.poll(async () => (await native.getHold(first.body.holdId)).phase).toBe("released");
      expect((await native.getHold(hold.holdId)).phase).toBe("active");
    } finally { release(); }
  });

for (const leave of ["Close", "Back"]) {
  for (const operation of ["Reserve", "Release payment", "Release Slot"]) {
    test(`${leave} during slow ${operation} keeps the saved reservation correct on reopen`,
      async ({ page, context, flow, native }) => {
        const date = await native.nextSlotDate();
        await routeToNative(context, native, date);
        await page.goto("/packages");
        await page.getByRole("link", { name: "Book Now" }).first().click();
        await page.getByRole("button", { name: /^Earliest available:/ }).click();
        await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
        const next = () => page.getByRole("button", { name: "Next", exact: true }).last();
        if (operation !== "Reserve") {
          await next().click();
          await flow.details();
          if (operation === "Release payment") {
            await page.getByRole("button", { name: "Review before payment", exact: true }).click();
            await flow.payment();
            await openCheckout(page);
            await page.goBack();
            await page.getByRole("link", { name: "Back to Booking", exact: true }).click();
          }
        }
        let delayed;
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const endpoint = operation === "Reserve" ? "/api/holdSlot"
          : operation === "Release payment" ? "/api/payment/cancel" : "/api/releaseHold";
        await page.route(`**${endpoint}`, async route => {
          delayed = await native.post(endpoint, route.request().postDataJSON(), route.request().headers().authorization);
          await gate;
          await route.fulfill({ status: delayed.status, json: delayed.body });
        });
        try {
          if (operation === "Reserve") await next().click();
          else await page.getByRole("button", { name: operation, exact: true }).click();
          await expect.poll(() => delayed?.status).toBe(200);
          if (leave === "Close") {
            await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
          } else {
            await page.goBack();
          }
          await expect(page).not.toHaveURL(/\/booking$/);
          await expect(page.locator(".ri-booking.transition-opacity")).toHaveCount(0);
          const reopenedWhilePending = leave === "Close" && operation === "Reserve";
          if (reopenedWhilePending) {
            await page.getByRole("link", { name: "Book Now" }).first().click();
            await expect(page.locator(".ri-booking.transition-opacity")).toBeVisible();
          }
          release();
          if (operation === "Release Slot") {
            await expect.poll(() => readHold(page)).toBeNull();
          } else {
            const holdId = delayed.body.holdId || delayed.body.refreshedHold.slotHoldId;
            const holdToken = delayed.body.holdToken || delayed.body.refreshedHold.slotHoldToken;
            await expect.poll(() => readHold(page)).toMatchObject({ holdId, holdToken });
            if (operation === "Release payment") {
              await expect.poll(() => page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
            }
          }
          if (leave === "Back") await page.goForward();
          else if (!reopenedWhilePending) {
            const reopen = operation === "Release Slot"
              ? page.getByRole("link", { name: "Book Now" }).first()
              : page.getByRole("button", { name: "Continue booking", exact: true });
            await reopen.click();
          }
          if (operation === "Release Slot") {
            await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
          } else if (operation === "Reserve") {
            await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
          } else {
            await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
            await expect(page.getByRole("button", { name: "Release payment", exact: true })).toHaveCount(0);
            await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled();
          }
        } finally { release(); }
      });
  }
}

for (const access of ["unreadable", "unwritable"]) {
  test(`${access} storage still lets Reserve keep the held slot after reopening`,
    async ({ page, context, flow, native }) => {
      const date = await native.nextSlotDate();
      await routeToNative(context, native, date);
      await flow.booking();
      await page.evaluate(access => {
        if (access === "unreadable") {
          Object.defineProperty(window, "sessionStorage", {
            configurable: true, get() { throw new DOMException("Blocked", "SecurityError"); },
          });
        } else {
          Storage.prototype.setItem = () => { throw new DOMException("Full", "QuotaExceededError"); };
          Storage.prototype.removeItem = () => { throw new DOMException("Blocked", "SecurityError"); };
        }
      }, access);
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Continue booking", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      const held = (await native.evidence()).http.findLast(entry => entry.path === "/api/holdSlot");
      expect(held.response.holdToken).toBeTruthy();
      expect((await native.getHold(held.response.holdId)).phase).toBe("active");
    });
}

const pendingBooking = async (page, flow) => {
  await page.goto("/packages");
  await page.getByRole("link", { name: "Book Now" }).first().click();
  await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await flow.details();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await flow.payment();
  await openCheckout(page);
  await page.goBack();
  await page.getByRole("link", { name: "Back to Booking", exact: true }).click();
};
const leaveBooking = async (page, leave) => {
  if (leave === "Close") await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  else await page.goBack();
  await expect(page.locator(".ri-booking.transition-opacity")).toHaveCount(0);
};
const blockReservationStorage = (page, access) => page.evaluate(access => {
  if (access === "unreadable") {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true, get() { throw new DOMException("Blocked", "SecurityError"); },
    });
  } else {
    Storage.prototype.setItem = () => { throw new DOMException("Full", "QuotaExceededError"); };
    Storage.prototype.removeItem = () => { throw new DOMException("Blocked", "SecurityError"); };
  }
}, access);
const watchReservationErrors = page => page.evaluate(() => {
  window.reservationErrors = [];
  globalThis[Symbol.for("roo.reportServerError")] = label => window.reservationErrors.push(label);
});

for (const leave of ["Close", "Back"]) {
  test(`captured payment after ${leave} during slow Release payment still shows its receipt`,
    async ({ page, context, flow, native }, testInfo) => {
      await routeToNative(context, native, await native.nextSlotDate());
      await pendingBooking(page, flow);
      const hold = await readHold(page);
      await native.setPaymentStatus("succeeded");
      let delayed;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route("**/api/payment/cancel", async route => {
        delayed = await native.post("/api/payment/cancel", {}, route.request().headers().authorization);
        await gate;
        await route.fulfill({ status: delayed.status, json: delayed.body });
      });
      try {
        await page.getByRole("button", { name: "Release payment", exact: true }).click();
        await expect.poll(() => delayed?.body.captured).toBe(true);
        await leaveBooking(page, leave);
        if (leave === "Close") await page.getByRole("link", { name: "Book Now", exact: true }).first().click();
        release();
        await expect(page).toHaveURL(/\/payment-success$/);
        await expect(page.getByRole("heading", { name: "Payment Successful", exact: true })).toBeVisible();
        expect((await native.getHold(hold.holdId)).bookingId).toBe(delayed.body.bookingId);
        expect(await readHold(page)).toBeNull();
        expect(await page.evaluate(() => history.state.usr.bookingConfirmation.bookingId)).toBe(delayed.body.bookingId);
        await testInfo.attach("captured-after-close", { body: await page.screenshot(), contentType: "image/png" });
        await page.reload();
        await expect(page.getByRole("heading", { name: "Payment Successful", exact: true })).toBeVisible();
      } finally { release(); await native.setPaymentStatus(null); }
    });

  for (const failure of ["network", "timeout", "rejected"]) {
    test(`${failure} Release payment after ${leave} is reported and stays visible on reopen`,
      async ({ page, context, flow, native }) => {
        await routeToNative(context, native, await native.nextSlotDate());
        await pendingBooking(page, flow);
        const original = await reservationState(page);
        await watchReservationErrors(page);
        let requested = false;
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        await page.route("**/api/payment/cancel", async route => {
          requested = true;
          await gate;
          if (failure === "network") await route.abort("failed");
          else if (failure === "rejected") await route.fulfill({ status: 409, json: { error: "Payment is still processing." } });
          else await route.abort("timedout");
        });
        try {
          await page.getByRole("button", { name: "Release payment", exact: true }).click();
          await expect.poll(() => requested).toBe(true);
          await leaveBooking(page, leave);
          if (failure !== "timeout") release();
          await expect.poll(() => page.evaluate(() => window.reservationErrors), { timeout: 15000 })
            .toContain("Failed to release payment session");
          release();
          if (leave === "Back") await page.goForward();
          else await page.getByRole("link", { name: "Book Now", exact: true }).first().click();
          const message = failure === "rejected" ? "Payment is still processing." : /could not be released|Failed to fetch/;
          await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
          const { booking_draft: draftBefore, ...checkoutBefore } = original;
          const { booking_draft: draftAfter, ...checkoutAfter } = await reservationState(page);
          expect(checkoutAfter).toEqual(checkoutBefore);
          const savedDraft = JSON.parse(draftBefore);
          const reopenedDraft = JSON.parse(draftAfter);
          expect(reopenedDraft.packages[reopenedDraft.lastTitle].form)
            .toEqual(savedDraft.packages[savedDraft.lastTitle].form);
        } finally { release(); }
      });
  }
}

for (const access of ["unreadable", "unwritable"]) {
  for (const operation of ["Release payment", "Release Slot"]) {
    test(`${access} storage lets ${operation} finish after Close and reopen`,
      async ({ page, context, flow, native }) => {
        await routeToNative(context, native, await native.nextSlotDate());
        await pendingBooking(page, flow);
        if (operation === "Release Slot") {
          await page.getByRole("button", { name: "Release payment", exact: true }).click();
          await expect(page.getByText(/Payment method released/)).toBeVisible();
          await page.getByRole("button", { name: "Back", exact: true }).last().click();
        }
        const original = await readHold(page);
        let delayed;
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const endpoint = operation === "Release Slot" ? "/api/releaseHold" : "/api/payment/cancel";
        await page.route(`**${endpoint}`, async route => {
          delayed = await native.post(endpoint, route.request().postDataJSON(), route.request().headers().authorization);
          await gate;
          await route.fulfill({ status: delayed.status, json: delayed.body });
        });
        await page.evaluate(() => window.addEventListener("hold-state", event => { window.releasedHold = event.detail; }));
        await blockReservationStorage(page, access);
        try {
          await page.getByRole("button", { name: operation, exact: true }).click();
          await expect.poll(() => delayed?.status).toBe(200);
          await leaveBooking(page, "Close");
          release();
          if (operation === "Release payment") {
            await expect.poll(() => page.evaluate(() => window.releasedHold?.phase)).toBe("holding");
            await page.getByRole("button", { name: "Continue booking", exact: true }).click();
            await expect(page.getByRole("button", { name: "Release payment", exact: true })).toHaveCount(0);
            await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
            await expect(page.getByText("visitor@example.invalid", { exact: true })).toBeVisible();
            await expect(page.getByText("Ryzen 7700 / RTX 4070", { exact: true })).toBeVisible();
          } else {
            await expect.poll(() => page.evaluate(() => window.releasedHold)).toBeNull();
            await page.getByRole("link", { name: "Book Now" }).first().click();
            await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
          }
          expect((await native.getHold(original.holdId)).phase).toBe(operation === "Release Slot" ? "released" : "holding");
        } finally { release(); }
      });
  }
}

test("Reserve repairs corrupt hold storage from the live reservation and reports the repair",
  async ({ page, context, flow, native }) => {
    await routeToNative(context, native, await native.nextSlotDate());
    await flow.reserve();
    const original = await readHold(page);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Back", exact: true }).last().click();
    await watchReservationErrors(page);
    await page.evaluate(() => sessionStorage.setItem("my_slot_hold", "{broken"));
    await dialog.getByRole("button", { name: "Next", exact: true }).last().click();
    await expect(dialog.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
    expect(await readHold(page)).toMatchObject({ holdId: original.holdId, startTimeUTC: original.startTimeUTC });
    expect(await page.evaluate(() => window.reservationErrors)).toContain("Repaired invalid slot reservation storage");
  });

test("Reserve restores a newer saved reservation instead of silently stopping",
  async ({ page, context, flow, native }) => {
    const date = await native.nextSlotDate();
    await routeToNative(context, native, date);
    await flow.reserve();
    const original = await readHold(page);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Back", exact: true }).last().click();
    const next = await native.post("/api/holdSlot", {
      startTimeUTC: `${date}T05:30:00.000Z`, packageTitle: original.packageTitle,
    });
    expect(next.status).toBe(200);
    const newer = { ...original, ...next.body, startTimeUTC: `${date}T05:30:00.000Z` };
    await watchReservationErrors(page);
    await page.evaluate(hold => sessionStorage.setItem("my_slot_hold", JSON.stringify(hold)), newer);
    const before = (await native.evidence()).http.filter(entry => entry.path === "/api/holdSlot").length;
    await dialog.getByRole("button", { name: "Next", exact: true }).last().click();
    await expect(page.getByRole("alert").filter({ hasText: "Your reservation changed." })).toBeVisible();
    expect(await readHold(page)).toMatchObject({ holdId: newer.holdId, holdToken: newer.holdToken });
    expect((await native.evidence()).http.filter(entry => entry.path === "/api/holdSlot")).toHaveLength(before);
    expect(await page.evaluate(() => window.reservationErrors)).toContain("Slot reservation changed before reserving");
  });

test("a failed outdated hold release is reported without replacing the newer reservation",
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
    await page.route("**/api/releaseHold", route => route.fulfill({ status: 503, json: { ok: false } }));
    try {
      await flow.booking();
      await watchReservationErrors(page);
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect.poll(() => first?.status).toBe(200);
      const next = await native.post("/api/holdSlot", {
        startTimeUTC: `${date}T05:30:00.000Z`, packageTitle: "Performance Vertex Overhaul",
      });
      expect(next.status).toBe(200);
      const newer = { ...next.body, startTimeUTC: `${date}T05:30:00.000Z`, phase: "active" };
      await page.evaluate(hold => sessionStorage.setItem("my_slot_hold", JSON.stringify(hold)), newer);
      release();
      await expect.poll(() => page.evaluate(() => window.reservationErrors))
        .toContain("Failed to release an outdated slot reservation");
      expect(await readHold(page)).toMatchObject({ holdId: newer.holdId, holdToken: newer.holdToken });
    } finally { release(); }
  });

for (const failure of ["network", "503"]) {
  test(`a delayed ${failure} Reserve failure is reported and shown after reopening`, async ({ page, context, native }) => {
    await routeToNative(context, native, await native.nextSlotDate());
    await page.goto("/packages");
    await page.getByRole("link", { name: "Book Now" }).first().click();
    await page.getByRole("button", { name: /^Earliest available:/ }).click();
    await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
    await watchReservationErrors(page);
    let requested = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/holdSlot", async route => {
      requested = true;
      await gate;
      if (failure === "network") await route.abort("failed");
      else await route.fulfill({ status: 503, json: { error: "Unavailable" } });
    });
    try {
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect.poll(() => requested).toBe(true);
      await leaveBooking(page, "Close");
      release();
      await expect.poll(() => page.evaluate(() => window.reservationErrors)).toContain("Failed to reserve slot");
      await page.getByRole("link", { name: "Book Now" }).first().click();
      await expect(page.getByRole("alert").filter({ hasText: "Could not reserve this slot" })).toBeVisible();
      expect(await readHold(page)).toBeNull();
    } finally { release(); }
  });
}

for (const firstReply of [0, 1]) {
  test(`duplicate Release payment replies preserve the restored hold when request ${firstReply + 1} replies first`,
    async ({ page, context, flow, native }) => {
      await routeToNative(context, native, await native.nextSlotDate());
      await pendingBooking(page, flow);
      let returned;
      const replies = [];
      await page.route("**/api/payment/cancel", async route => {
        if (!returned) returned = await native.post("/api/payment/cancel", {}, route.request().headers().authorization);
        await new Promise(resolve => { replies.push(resolve); });
        await route.fulfill({ status: returned.status, json: returned.body });
      });
      try {
        await page.getByRole("button", { name: "Release payment", exact: true }).click();
        await expect.poll(() => replies.length).toBe(1);
        await leaveBooking(page, "Close");
        await page.getByRole("link", { name: "Book Now", exact: true }).first().click();
        await page.getByRole("button", { name: "Release payment", exact: true }).click();
        await expect.poll(() => replies.length).toBe(2);
        const refreshed = returned.body.refreshedHold;
        const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/payment/cancel");
        replies[firstReply]();
        await response;
        if (firstReply === 1) await expect.poll(() => readHold(page)).toMatchObject({ holdToken: refreshed.slotHoldToken });
        const last = page.waitForResponse(response => new URL(response.url()).pathname === "/api/payment/cancel");
        replies[1 - firstReply]();
        await last;
        await expect.poll(() => readHold(page)).toMatchObject({ holdId: refreshed.slotHoldId, holdToken: refreshed.slotHoldToken });
        expect((await native.getHold(refreshed.slotHoldId)).phase).toBe("holding");
        expect(await native.verifyHold({ holdId: refreshed.slotHoldId, token: refreshed.slotHoldToken })).toBe(true);
      } finally { for (const reply of replies) reply(); }
    });
}

for (const result of ["cancelled", "captured"]) {
  test(`Change payment method keeps a ${result} reply after closing`, async ({ page, context, flow, native }) => {
    await routeToNative(context, native, await native.nextSlotDate());
    await pendingBooking(page, flow);
    await page.getByRole("button", { name: "Return to payment", exact: true }).click();
    await expect(page.getByRole("button", { name: "Change payment method", exact: true })).toBeVisible();
    if (result === "captured") await native.setPaymentStatus("succeeded");
    let delayed;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/payment/cancel", async route => {
      delayed = await native.post("/api/payment/cancel", {}, route.request().headers().authorization);
      await gate;
      await route.fulfill({ status: delayed.status, json: delayed.body });
    });
    try {
      await page.getByRole("button", { name: "Change payment method", exact: true }).click();
      await expect.poll(() => delayed?.status).toBe(200);
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      release();
      if (result === "captured") {
        await expect(page).toHaveURL(/\/payment-success$/);
        expect(await page.evaluate(() => history.state.usr.bookingConfirmation.bookingId)).toBe(delayed.body.bookingId);
      } else {
        await expect.poll(() => readHold(page)).toMatchObject({ holdToken: delayed.body.refreshedHold.slotHoldToken });
        expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
      }
    } finally { release(); await native.setPaymentStatus(null); }
  });
}

test("a captured payment keeps confirming after a status failure until its receipt is ready",
  async ({ page, context, flow, native }, testInfo) => {
    await routeToNative(context, native, await native.nextSlotDate());
    await pendingBooking(page, flow);
    await native.setPaymentStatus("succeeded");
    await watchReservationErrors(page);
    let booked;
    let checks = 0;
    let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    await page.route("**/api/payment/cancel", async route => {
      booked = await native.post("/api/payment/cancel", {}, route.request().headers().authorization);
      await route.fulfill({ status: 200, json: { captured: true, status: "finalizing" } });
    });
    await page.route("**/api/payment/status", async route => {
      checks += 1;
      if (checks === 1) await route.fulfill({ status: 503, json: { error: "Status unavailable" } });
      else {
        await gate;
        await route.fulfill({ status: 200, json: booked.body });
      }
    });
    try {
      await expect(page.getByRole("button", { name: "Release payment", exact: true })).toBeVisible();
      await expect.poll(() => page.locator(".booking-dialog-stage").evaluate(el => Number(getComputedStyle(el).opacity)))
        .toBe(1);
      await expect.poll(() => page.locator(".ri-booking.transition-opacity").evaluate(el => Number(getComputedStyle(el).opacity)))
        .toBe(1);
      await page.getByRole("button", { name: "Release payment", exact: true }).scrollIntoViewIfNeeded();
      await testInfo.attach("before-confirming", { body: await page.screenshot(), contentType: "image/png" });
      await page.clock.install();
      await page.getByRole("button", { name: "Release payment", exact: true }).click();
      await expect(page).toHaveURL(/\/payment$/);
      await expect.poll(() => page.evaluate(() => window.reservationErrors)).toContain("Failed to confirm captured payment");
      await expect(page.getByRole("alert").filter({ hasText: "Your payment was received and is being finalized." })).toBeVisible();
      await page.clock.fastForward("21:00");
      await expect(page).toHaveURL(/\/payment$/);
      await expect(page.getByRole("alert").filter({ hasText: "Your payment was received and is being finalized." })).toBeVisible();
      await page.clock.runFor(500);
      await expect.poll(() => page.locator(".booking-dialog-stage").evaluate(el => Number(getComputedStyle(el).opacity)))
        .toBe(1);
      await testInfo.attach("payment-confirming", { body: await page.screenshot(), contentType: "image/png" });
      finish();
      await expect(page).toHaveURL(/\/payment-success$/);
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(await page.evaluate(() => history.state.usr.bookingConfirmation.bookingId)).toBe(booked.body.bookingId);
    } finally { finish(); await native.setPaymentStatus(null); }
  });

test("a reopened form keeps the latest Reserve response and releases the earlier slot",
  async ({ page, context, native }) => {
    await routeToNative(context, native, await native.nextSlotDate());
    await page.goto("/packages");
    const open = async () => {
      await page.getByRole("link", { name: "Book Now" }).first().click();
      await page.getByRole("button", { name: /^Earliest available:/ }).click();
    };
    await open();
    const requests = [];
    await page.route("**/api/holdSlot", async route => {
      const response = await native.post("/api/holdSlot", route.request().postDataJSON());
      await new Promise(resolve => { requests.push({ response, release: resolve }); });
      await route.fulfill({ status: response.status, json: response.body });
    });
    try {
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect.poll(() => requests.length).toBe(1);
      await leaveBooking(page, "Close");
      await open();
      await page.getByRole("button", { name: "11:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect.poll(() => requests.length).toBe(2);
      const first = page.waitForResponse(response => new URL(response.url()).pathname === "/api/holdSlot");
      requests[0].release();
      await first;
      requests[1].release();
      const latest = requests[1].response.body;
      await expect.poll(() => readHold(page)).toMatchObject({ holdId: latest.holdId, holdToken: latest.holdToken });
      await expect.poll(async () => (await native.getHold(requests[0].response.body.holdId)).phase).toBe("released");
      expect((await native.getHold(latest.holdId)).phase).toBe("active");
    } finally { for (const request of requests) request.release(); }
  });

test("a booked reply opens the receipt even while an earlier reply is still confirming",
  async ({ page, context, flow, native }) => {
    await routeToNative(context, native, await native.nextSlotDate());
    await pendingBooking(page, flow);
    await native.setPaymentStatus("succeeded");
    const requests = [];
    let booked;
    let stopStatus;
    const statusGate = new Promise(resolve => { stopStatus = resolve; });
    await page.route("**/api/payment/status", async route => {
      await statusGate;
      await route.fulfill({ status: 200, json: { status: "finalizing" } });
    });
    await page.route("**/api/payment/cancel", async route => {
      if (!booked) booked = await native.post("/api/payment/cancel", {}, route.request().headers().authorization);
      const index = requests.length;
      await new Promise(resolve => { requests.push(resolve); });
      await route.fulfill({ status: 200, json: index ? booked.body : { captured: true, status: "finalizing" } });
    });
    try {
      await page.getByRole("button", { name: "Release payment", exact: true }).click();
      await expect.poll(() => requests.length).toBe(1);
      await leaveBooking(page, "Close");
      await page.getByRole("link", { name: "Book Now", exact: true }).first().click();
      await page.getByRole("button", { name: "Release payment", exact: true }).click();
      await expect.poll(() => requests.length).toBe(2);
      requests[0]();
      await expect(page).toHaveURL(/\/payment$/);
      requests[1]();
      await expect(page).toHaveURL(/\/payment-success$/);
      expect(await page.evaluate(() => history.state.usr.bookingConfirmation.bookingId)).toBe(booked.body.bookingId);
    } finally {
      for (const request of requests) request();
      stopStatus();
      await native.setPaymentStatus(null);
    }
  });

for (const firstReply of [0, 1]) {
  test(`an older successful Release wins over a newer failure when request ${firstReply + 1} replies first`,
    async ({ page, context, flow, native }) => {
      await routeToNative(context, native, await native.nextSlotDate());
      await pendingBooking(page, flow);
      await watchReservationErrors(page);
      let returned;
      const replies = [];
      await page.route("**/api/payment/cancel", async route => {
        const index = replies.length;
        if (!index) returned = await native.post("/api/payment/cancel", {}, route.request().headers().authorization);
        await new Promise(resolve => { replies.push(resolve); });
        if (index) await route.fulfill({ status: 503, json: { error: "Release unavailable" } });
        else await route.fulfill({ status: returned.status, json: returned.body });
      });
      try {
        await page.getByRole("button", { name: "Release payment", exact: true }).click();
        await expect.poll(() => replies.length).toBe(1);
        await leaveBooking(page, "Close");
        await page.getByRole("link", { name: "Book Now", exact: true }).first().click();
        await page.getByRole("button", { name: "Release payment", exact: true }).click();
        await expect.poll(() => replies.length).toBe(2);
        const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/payment/cancel");
        replies[firstReply]();
        await response;
        replies[1 - firstReply]();
        await expect.poll(() => page.evaluate(() => window.reservationErrors)).toContain("Failed to release payment session");
        const restored = returned.body.refreshedHold;
        await expect.poll(() => readHold(page)).toMatchObject({ holdId: restored.slotHoldId, holdToken: restored.slotHoldToken });
        expect((await native.getHold(restored.slotHoldId)).phase).toBe("holding");
        expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
        await expect(page.getByRole("alert").filter({ hasText: "Release unavailable" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Release payment", exact: true })).toHaveCount(0);
      } finally { for (const reply of replies) reply(); }
    });
}

test("an older Reserve cannot release the hold returned by a retry after a newer failure",
  async ({ page, context, native }) => {
    const date = await native.nextSlotDate();
    await routeToNative(context, native, date);
    await page.route("**/api/bookingAvailability", route => route.fulfill({ json: {
      settings: { dateSlots: [{ date, times: ["10:00", "11:00"] }] }, bookedSlots: [],
    } }));
    await page.goto("/packages");
    const open = async () => {
      await page.getByRole("link", { name: "Book Now" }).first().click();
      await page.getByRole("button", { name: /^Earliest available:/ }).click();
    };
    await open();
    const requests = [];
    let held;
    await page.route("**/api/holdSlot", async route => {
      const index = requests.length;
      if (!index) held = await native.post("/api/holdSlot", route.request().postDataJSON());
      await new Promise(resolve => { requests.push(resolve); });
      if (index === 1) await route.fulfill({ status: 503, json: { error: "Unavailable" } });
      else await route.fulfill({ status: held.status, json: held.body });
    });
    try {
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect.poll(() => requests.length).toBe(1);
      await leaveBooking(page, "Close");
      await open();
      await page.getByRole("button", { name: "11:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect.poll(() => requests.length).toBe(2);
      requests[1]();
      await expect(page.getByRole("alert").filter({ hasText: "Could not reserve this slot" })).toBeVisible();
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect.poll(() => requests.length).toBe(3);
      const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/holdSlot");
      requests[0]();
      await oldResponse;
      requests[2]();
      await expect.poll(() => readHold(page)).toMatchObject({ holdId: held.body.holdId, holdToken: held.body.holdToken });
      expect((await native.getHold(held.body.holdId)).phase).toBe("active");
    } finally { for (const request of requests) request(); }
  });
