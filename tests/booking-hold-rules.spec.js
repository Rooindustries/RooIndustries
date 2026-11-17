const { test: base, expect } = require("./fixtures/booking-flow.cjs");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { nativeBinariesMissing } = require("./fixtures/native-fixture.cjs");

const test = base.extend({
  native: [async ({}, use) => {
    const child = fork(require.resolve("./fixtures/booking-hold.mjs"), ["--worker"], {
      execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
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
      await use({ post: (...args) => call("post", ...args), get: route => call("get", route), nextSlotDate: () => call("nextSlotDate"),
        getHold: id => call("getHold", id), verifyHold: hold => call("verifyHold", hold),
        expireHold: id => call("expireHold", id),
        setPackageSlots: date => call("setPackageSlots", date), restoreSettings: () => call("restoreSettings"),
        createBooking: start => call("createBooking", start), setHoldPhase: (id, phase) => call("setHoldPhase", id, phase),
        snapshot: start => call("snapshot", start), evidence: () => call("evidence"),
        resetRateLimits: () => call("resetRateLimits"),
        rateWindow: () => call("rateWindow"), extraSlot: () => call("extraSlot"), nearSlot: () => call("nearSlot"),
        setSlots: (date, times) => call("setSlots", date, times), setFault: mode => call("setFault", mode),
        clearFault: mode => call("clearFault", mode) });
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
test.skip(nativeBinariesMissing, "Needs PG_BIN and POSTGREST_BIN for the native PostgreSQL 17 fixture.");
const readHold = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")));
const expectNoSelection = async (page, hold = null) => {
  await expect(page.getByRole("button", { name: "Next", exact: true }).last()).toHaveAttribute("aria-disabled", "true");
  const grid = page.locator(".booking-slot-grid");
  await expect(grid.locator("button")).not.toHaveCount(0);
  await expect(grid.locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect(grid.locator("button:not([aria-pressed])")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveCount(0);
  expect(await readHold(page)).toEqual(hold);
};
const startPayment = async (native, hold) => {
  const bookingPayload = { packageTitle: "Performance Vertex Overhaul", startTimeUTC: hold.startTimeUTC,
    slotHoldId: hold.holdId, slotHoldToken: hold.holdToken, email: "visitor@example.invalid",
    discord: "fixture_visitor", specs: "Ryzen 7700 / RTX 4070", mainGame: "CS2",
    message: "Fixture booking", localTimeZone: "Asia/Kolkata", deferEmailsUntilConfirmation: true };
  const quote = await native.post("/api/payment/quote", { bookingPayload });
  expect(quote.status).toBe(200);
  const payment = await native.post("/api/payment/start", { provider: "dodo", bookingPayload,
    quoteFingerprint: quote.body.quoteFingerprint });
  expect(payment.status).toBe(200);
};
const routeToNative = async (context, native, date, { serverSettings = false, counted = false } = {}) => {
  await context.route(/\/api\/(holdSlot|releaseHold|payment\/quote|payment\/start)(?:\?|$)/, async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const headers = { "x-forwarded-for": `192.0.2.${Number(date.slice(-2))}` };
    const response = await native.post(pathname, request.postDataJSON(), "", headers,
      { counted: counted && pathname === "/api/holdSlot" });
    return route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) });
  });
  await context.route(/\/api\/bookingAvailability(?:\?|$)/, async route => {
    const response = await native.get("/api/bookingAvailability");
    if (serverSettings) return route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) });
    const dateSlots = response.body.settings.dateSlots.filter(slot => slot.date === date);
    const settings = { ...response.body.settings, dateSlots, xocDateSlots: dateSlots,
      vertexEssentialsDateSlots: dateSlots, packageDateSlots: [] };
    return route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify({ ...response.body, settings }) });
  });
};

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });
    test("a customer keeps the twentieth reservation when the rate limit is reached", async ({ page, context, flow, native }) => {
      try {
        let finished = false;
        for (let attempt = 0; attempt < 2 && !finished; attempt += 1) {
          await page.goto("/");
          await page.evaluate(() => sessionStorage.clear());
          await native.resetRateLimits();
          const date = await native.extraSlot();
          await routeToNative(context, native, date, { counted: true });
          await flow.booking();
          let posts = 0;
          const count = request => { if (new URL(request.url()).pathname === "/api/holdSlot") posts += 1; };
          page.on("request", count);
          try {
            const windowStart = await native.rateWindow();
            let previous;
            for (let index = 0; index < 20; index += 1) {
              await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
              const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/holdSlot");
              await page.getByRole("button", { name: "Next", exact: true }).last().click();
              expect((await response).status()).toBe(200);
              await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
              const current = await readHold(page);
              if (previous) expect(current.holdToken).not.toBe(previous.holdToken);
              expect(await native.verifyHold({ token: current.holdToken, holdId: current.holdId })).toBe(true);
              previous = current;
              await page.getByRole("button", { name: "Back", exact: true }).last().click();
            }
            const before = await native.snapshot(previous.startTimeUTC);
            await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
            const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/holdSlot");
            await page.getByRole("button", { name: "Next", exact: true }).last().click();
            const result = await response;
            const windowEnd = await native.rateWindow();
            if (windowStart !== windowEnd) continue;
            expect(result.status()).toBe(429);
            await expect(page.getByRole("alert").filter({ hasText: "Could not reserve this slot. Please check your internet and try again." }))
              .toHaveText("Could not reserve this slot. Please check your internet and try again.");
            await expect(page.getByRole("button", { name: "Next", exact: true }).last()).toHaveAttribute("aria-disabled", "false");
            await expect(page.getByRole("button", { name: "10:00 AM", exact: true })).toHaveAttribute("aria-pressed", "true");
            await expect(page.getByRole("button", { name: "11:00 AM", exact: true })).toHaveAttribute("aria-pressed", "false");
            await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveCount(0);
            expect(await readHold(page)).toEqual(previous);
            expect(await native.verifyHold({ token: previous.holdToken, holdId: previous.holdId })).toBe(true);
            expect(await native.snapshot(previous.startTimeUTC)).toEqual(before);
            expect(posts).toBe(21);
            await native.resetRateLimits();
            const renewal = page.waitForResponse(value => new URL(value.url()).pathname === "/api/holdSlot");
            await page.getByRole("button", { name: "Next", exact: true }).last().click();
            const renewed = await renewal;
            expect(renewed.request().postDataJSON().startTimeUTC).toBe(previous.startTimeUTC);
            expect(renewed.status()).toBe(200);
            await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
            const current = await readHold(page);
            expect(current.startTimeUTC).toBe(previous.startTimeUTC);
            expect(await native.verifyHold({ token: current.holdToken, holdId: current.holdId })).toBe(true);
            finished = true;
          } finally {
            page.off("request", count);
          }
        }
        expect(finished).toBe(true);
      } finally {
        await native.restoreSettings();
      }
    });

    test("a slot a few minutes ahead can be reserved", async ({ page, context, flow, native }) => {
      const slot = await native.nearSlot();
      try {
        await routeToNative(context, native, slot.date, { serverSettings: true });
        await flow.booking();
        const label = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(new Date(slot.startTimeUTC));
        const button = page.getByRole("button", { name: label, exact: true });
        await expect(button).toBeEnabled();
        await button.click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
        const hold = await readHold(page);
        expect(hold.startTimeUTC).toBe(slot.startTimeUTC);
        expect(await native.verifyHold({ token: hold.holdToken, holdId: hold.holdId })).toBe(true);
        expect((await native.getHold(hold.holdId)).startTimeUTC).toBe(slot.startTimeUTC);
      } finally {
        await native.restoreSettings();
      }
    });

    test("a duplicated tab keeps its token when payment starts on the same slot", async ({ page, context, flow, native }) => {
      const date = await native.extraSlot();
      try {
        await routeToNative(context, native, date);
        await context.route("https://test.checkout.dodopayments.com/session/**", route => route.fulfill({
          contentType: "text/html", body: "<h1>Fixture provider checkout</h1>",
        }));
        await flow.reserve();
        await flow.details();
        const original = await readHold(page);
        await page.getByRole("button", { name: "Review before payment", exact: true }).click();
        await flow.payment();
        const storage = await page.evaluate(() => Object.entries(sessionStorage));
        const other = await context.newPage();
        await other.addInitScript(entries => entries.forEach(([key, value]) => sessionStorage.setItem(key, value)), storage);
        await other.goto("/booking");
        await other.getByRole("button", { name: "Edit details", exact: true }).click();
        await other.getByRole("button", { name: "Back", exact: true }).last().click();
        await page.getByRole("button", { name: "Pay your way", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Fixture provider checkout", exact: true })).toBeVisible();
        const before = await native.getHold(original.holdId);
        const beforeSnapshot = await native.snapshot(original.startTimeUTC);
        expect(before.phase).toBe("payment_pending");
        let posts = 0;
        other.on("request", request => { if (new URL(request.url()).pathname === "/api/holdSlot") posts += 1; });
        await other.getByRole("button", { name: "10:00 AM", exact: true }).click();
        await other.getByRole("button", { name: "Next", exact: true }).last().click();
        await expect(other.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
        await expect(other.getByRole("alert").filter({ hasText: "Your payment session is already in progress." }))
          .toHaveText("Your payment session is already in progress. Return to payment to finish it.");
        expect(await readHold(other)).toMatchObject({ holdId: original.holdId, holdToken: original.holdToken,
          phase: "payment_pending", paymentStartedElsewhere: true });
        expect(posts).toBe(1);
        expect(await native.getHold(original.holdId)).toEqual(before);
        expect(await native.snapshot(original.startTimeUTC)).toEqual(beforeSnapshot);
        expect(await native.verifyHold({ token: original.holdToken, holdId: original.holdId })).toBe(true);
        await other.close();
      } finally {
        await native.restoreSettings();
      }
    });
    test("a removed time cannot be reserved from an open page", async ({ page, context, flow, native }) => {
      const date = await native.extraSlot();
      try {
        await routeToNative(context, native, date, { serverSettings: true });
        await flow.booking();
        await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
        await native.setSlots(date, ["11:00"]);
        const start = `${date}T04:30:00.000Z`;
        const before = await native.snapshot(start);
        const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/holdSlot");
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        expect((await response).status()).toBe(400);
        await expect(page.getByRole("alert").filter({ hasText: "This time is not available for the selected package." }))
          .toHaveText("This time is not available for the selected package.");
        await expectNoSelection(page);
        expect(await native.snapshot(start)).toEqual(before);
      } finally {
        await native.restoreSettings();
      }
    });

    test("reservation failures keep the selected time without writing", async ({ page, context, flow, native }) => {
      const date = await native.extraSlot();
      try {
        await routeToNative(context, native, date);
        await flow.booking();
        await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
        const start = `${date}T04:30:00.000Z`;
        for (const mode of ["env", "control", "unreachable", "write", "settings"]) {
          await native.setFault(mode);
          try {
            const before = await native.snapshot(start);
            const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/holdSlot");
            await page.getByRole("button", { name: "Next", exact: true }).last().click();
            expect((await response).status()).toBe(["write", "settings"].includes(mode) ? 500 : 503);
            await expect(page.getByRole("alert").filter({ hasText: "Could not reserve this slot. Please check your internet and try again." }))
              .toHaveText("Could not reserve this slot. Please check your internet and try again.");
            await expect(page.getByRole("button", { name: "Next", exact: true }).last()).toHaveAttribute("aria-disabled", "false");
            await expect(page.getByRole("button", { name: "10:00 AM", exact: true })).toHaveAttribute("aria-pressed", "true");
            await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveCount(0);
            expect(await readHold(page)).toBeNull();
            expect(await native.snapshot(start)).toEqual(before);
          } finally {
            await native.clearFault(mode);
          }
        }
      } finally {
        await native.restoreSettings();
      }
    });

    test("a duplicated tab with a superseded token cannot claim payment ownership", async ({ page, context, flow, native }) => {
      const date = await native.extraSlot();
      try {
        await routeToNative(context, native, date);
        await flow.reserve();
        await flow.details();
        const original = await readHold(page);
        const storage = await page.evaluate(() => Object.entries(sessionStorage));
        const other = await context.newPage();
        await other.addInitScript(entries => entries.forEach(([key, value]) => sessionStorage.setItem(key, value)), storage);
        await other.goto("/booking");
        await other.getByRole("button", { name: "Back", exact: true }).last().click();
        await page.getByRole("button", { name: "Back", exact: true }).last().click();
        await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
        const refreshed = await readHold(page);
        expect(refreshed.holdToken).not.toBe(original.holdToken);
        await page.getByRole("button", { name: "Review before payment", exact: true }).click();
        await flow.payment();
        await startPayment(native, refreshed);
        const before = await native.snapshot(original.startTimeUTC);
        let posts = 0;
        other.on("request", request => { if (new URL(request.url()).pathname === "/api/holdSlot") posts += 1; });
        await other.getByRole("button", { name: "10:00 AM", exact: true }).click();
        const response = other.waitForResponse(value => new URL(value.url()).pathname === "/api/holdSlot");
        await other.getByRole("button", { name: "Next", exact: true }).last().click();
        expect((await response).status()).toBe(409);
        await expect(other.getByText("This slot already has a payment session in progress.", { exact: true })).toBeVisible();
        await expectNoSelection(other);
        expect(await native.snapshot(original.startTimeUTC)).toEqual(before);
        expect(await native.verifyHold({ token: refreshed.holdToken, holdId: refreshed.holdId })).toBe(true);
        expect(posts).toBe(1);
        await other.close();
      } finally {
        await native.restoreSettings();
      }
    });

    test("a second customer cannot reserve a held slot", async ({ page, context, flow, native }) => {
      const date = await native.nextSlotDate();
      await routeToNative(context, native, date);
      await flow.booking();
      const other = await context.newPage();
      await other.goto("/booking");
      await other.getByRole("button", { name: /^Earliest available:/ }).click();
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/holdSlot");
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      const first = await firstResponse;
      expect(first.status()).toBe(200);
      expect((await first.json()).ok).toBe(true);
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      const original = await readHold(page);
      const before = await native.getHold(original.holdId);
      const beforeSnapshot = await native.snapshot(original.startTimeUTC);
      expect(beforeSnapshot.holds).toHaveLength(1);
      await other.getByRole("button", { name: "10:00 AM", exact: true }).click();
      const rejected = other.waitForResponse(response => new URL(response.url()).pathname === "/api/holdSlot");
      await other.getByRole("button", { name: "Next", exact: true }).last().click();
      expect((await rejected).status()).toBe(409);
      await expect(other.getByText("This slot is currently reserved by someone else.", { exact: true })).toBeVisible();
      await expectNoSelection(other);
      expect(await native.verifyHold({ token: original.holdToken, holdId: original.holdId })).toBe(true);
      const stored = await native.getHold(original.holdId);
      expect(stored).toEqual(before);
      expect(await native.snapshot(original.startTimeUTC)).toEqual(beforeSnapshot);
      const start = new Date(original.startTimeUTC);
      expect(stored.hostDate).toBe(new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata", weekday: "short", month: "short", day: "2-digit", year: "numeric",
      }).format(start).replaceAll(",", ""));
      expect(stored.hostTime).toBe(new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit",
      }).format(start));
      await other.close();
    });

    test("going Back and Next refreshes the owner's hold", async ({ page, context, flow, native }) => {
      const date = await native.nextSlotDate();
      await routeToNative(context, native, date);
      const first = page.waitForResponse(response => new URL(response.url()).pathname === "/api/holdSlot");
      await flow.reserve();
      expect((await first).status()).toBe(200);
      const original = await readHold(page);
      await page.getByRole("button", { name: "Back", exact: true }).last().click();
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      const second = page.waitForResponse(response => new URL(response.url()).pathname === "/api/holdSlot");
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      expect((await second).status()).toBe(200);
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      const refreshed = await readHold(page);
      expect(refreshed.holdId).toBe(original.holdId);
      expect(refreshed.holdToken).not.toBe(original.holdToken);
      expect(await native.verifyHold({ token: refreshed.holdToken, holdId: refreshed.holdId })).toBe(true);
      expect(await native.verifyHold({ token: original.holdToken, holdId: original.holdId })).toBe(false);
      expect((await native.snapshot(original.startTimeUTC)).holds).toHaveLength(1);
    });

    test("a package-specific time can be reserved", async ({ page, context, flow, native }) => {
      const date = await native.nextSlotDate();
      await native.setPackageSlots(date);
      try {
        await routeToNative(context, native, date, { serverSettings: true });
        await flow.booking();
        await page.getByRole("button", { name: "12:00 PM", exact: true }).click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
        const hold = await readHold(page);
        expect(hold.startTimeUTC).toBe(`${date}T06:30:00.000Z`);
        expect(await native.verifyHold({ token: hold.holdToken, holdId: hold.holdId })).toBe(true);
      } finally {
        await native.restoreSettings();
      }
    });

    test("a payment hold cannot be moved, released, or taken by another customer", async ({ page, context, flow, native }) => {
      const date = await native.nextSlotDate();
      await routeToNative(context, native, date);
      await flow.booking();
      const other = await context.newPage();
      await other.goto("/booking");
      await other.getByRole("button", { name: /^Earliest available:/ }).click();
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      const original = await readHold(page);
      await page.getByRole("button", { name: "Back", exact: true }).last().click();
      await startPayment(native, original);
      const before = await native.getHold(original.holdId);
      expect(before.phase).toBe("payment_pending");
      expect(before.paymentRecordId).toBeTruthy();
      const beforeSnapshot = await native.snapshot(original.startTimeUTC);
      expect(beforeSnapshot.holds).toHaveLength(1);
      await other.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await other.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect(other.getByText("This slot already has a payment session in progress.", { exact: true })).toBeVisible();
      await expectNoSelection(other);
      await page.getByRole("button", { name: "11:00 AM", exact: true }).click();
      const released = page.waitForResponse(response => new URL(response.url()).pathname === "/api/releaseHold");
      const moved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/holdSlot");
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      expect((await released).status()).toBe(409);
      expect((await moved).status()).toBe(409);
      await expect(page.getByText("The existing payment session must finish before changing slots.", { exact: true })).toBeVisible();
      await expectNoSelection(page, original);
      expect(await native.getHold(original.holdId)).toEqual(before);
      expect(await native.snapshot(original.startTimeUTC)).toEqual(beforeSnapshot);
      expect(await native.verifyHold({ token: original.holdToken, holdId: original.holdId })).toBe(true);
      await other.close();
    });

    test("a slot booked after availability loads cannot be reserved", async ({ page, context, flow, native }) => {
      const date = await native.nextSlotDate();
      await routeToNative(context, native, date);
      await flow.booking();
      const startTimeUTC = `${date}T04:30:00.000Z`;
      await native.createBooking(startTimeUTC);
      const before = await native.snapshot(startTimeUTC);
      expect(before.holds).toHaveLength(0);
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      const rejected = page.waitForResponse(response => new URL(response.url()).pathname === "/api/holdSlot");
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      expect((await rejected).status()).toBe(409);
      await expect(page.getByText("This slot is already booked.", { exact: true })).toBeVisible();
      await expectNoSelection(page);
      expect(await native.snapshot(startTimeUTC)).toEqual(before);
    });

    test("an expired slot can be rebooked and the old customer cannot release it", async ({ page, context, flow, native }) => {
      const date = await native.nextSlotDate();
      await routeToNative(context, native, date);
      const firstReservation = page.waitForResponse(response => new URL(response.url()).pathname === "/api/holdSlot");
      await flow.reserve();
      expect((await firstReservation).status()).toBe(200);
      const original = await readHold(page);
      await native.expireHold(original.holdId);
      const other = await context.newPage();
      await other.goto("/booking");
      await other.getByRole("button", { name: /^Earliest available:/ }).click();
      await other.getByRole("button", { name: "10:00 AM", exact: true }).click();
      const secondReservation = other.waitForResponse(response => new URL(response.url()).pathname === "/api/holdSlot");
      await other.getByRole("button", { name: "Next", exact: true }).last().click();
      expect((await secondReservation).status()).toBe(200);
      await expect(other.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      const replacement = await readHold(other);
      expect(replacement.holdId).toBe(original.holdId);
      expect(replacement.holdToken).not.toBe(original.holdToken);
      const emailsBefore = (await native.evidence()).providerRequests.filter(request => request.path === "/emails");
      await flow.details();
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      await flow.payment();
      const payment = page.waitForResponse(response => new URL(response.url()).pathname === "/api/payment/start");
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      expect((await payment).status()).toBe(403);
      const legacy = await native.post("/api/ref/createBooking", {
        discord: "fixture_visitor", email: "visitor@example.invalid", specs: "Ryzen 7700 / RTX 4070",
        mainGame: "CS2", message: "Fixture booking", packageTitle: "Performance Vertex Overhaul",
        packagePrice: "$54.95", status: "captured", paymentProvider: "razorpay",
        razorpayOrderId: "order_fixture", razorpayPaymentId: "payment_fixture", razorpaySignature: "fixture",
        localTimeZone: "Asia/Kolkata", startTimeUTC: original.startTimeUTC,
        displayDate: date, displayTime: "10:00 AM", slotHoldId: original.holdId,
        slotHoldToken: original.holdToken, slotHoldExpiresAt: original.expiresAt,
      });
      expect(legacy.status).toBe(409);
      expect((await native.evidence()).providerRequests.filter(request => request.path === "/emails")).toEqual(emailsBefore);
      await page.goto("/");
      const before = await native.snapshot(original.startTimeUTC);
      const released = page.waitForResponse(response => new URL(response.url()).pathname === "/api/releaseHold");
      await page.getByRole("button", { name: "Release", exact: true }).click();
      expect((await released).status()).toBe(403);
      expect((await native.getHold(replacement.holdId)).phase).toBe("active");
      expect(await native.snapshot(original.startTimeUTC)).toEqual(before);
      expect(await native.verifyHold({ token: replacement.holdToken, holdId: replacement.holdId })).toBe(true);
      await other.close();
    });

    for (const phase of ["released", "consumed"]) {
      test(`a ${phase} hold does not keep a future slot reserved`, async ({ page, context, flow, native }) => {
        const date = await native.nextSlotDate();
        await routeToNative(context, native, date);
        await flow.reserve();
        const original = await readHold(page);
        await native.setHoldPhase(original.holdId, phase);
        const other = await context.newPage();
        await other.goto("/booking");
        await other.getByRole("button", { name: /^Earliest available:/ }).click();
        await other.getByRole("button", { name: "10:00 AM", exact: true }).click();
        const reserved = other.waitForResponse(response => new URL(response.url()).pathname === "/api/holdSlot");
        await other.getByRole("button", { name: "Next", exact: true }).last().click();
        expect((await reserved).status()).toBe(200);
        await expect(other.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
        const replacement = await readHold(other);
        expect(replacement.holdId).toBe(original.holdId);
        expect((await native.getHold(replacement.holdId)).phase).toBe("active");
        expect((await native.snapshot(replacement.startTimeUTC)).holds).toHaveLength(1);
        await other.close();
      });
    }
  });
}
