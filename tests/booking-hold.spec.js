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

const nativeSwapSnapshot = page => page.evaluate(() => ({
  at: Date.now(),
  hold: JSON.parse(sessionStorage.getItem("my_slot_hold")),
  draft: JSON.parse(sessionStorage.getItem("booking_draft")),
  fields: Object.fromEntries(["discord", "email", "specs", "mainGame"].map(key => [
    key, document.querySelector(`[name="${key}"]`)?.value ?? null,
  ])),
}));

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

    test("native slot-swap retention: replacement preserves details and retires only the old hold", async ({ page, context, flow, native }, testInfo) => {
      const evidence = { viewport, timeline: [], pageErrors: [], apiCalls: [] };
      page.on("pageerror", error => evidence.pageErrors.push({ name: error.name, message: error.message }));
      page.on("request", request => {
        const url = new URL(request.url());
        if (url.pathname.startsWith("/api/")) evidence.apiCalls.push({ path: url.pathname, body: request.postDataJSON() });
      });
      const priorEvidence = await native.evidence();
      const providerBoundary = priorEvidence.providerRequests.length;
      const httpBoundary = priorEvidence.http.length;
      flow.state.slots = [{ date: await native.nextSlotDate(), times: ["10:00", "11:00"] }];
      const adapterRoute = /\/api\/(holdSlot|releaseHold)(?:\?|$)/;
      const adapter = async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const body = request.postDataJSON();
        evidence.timeline.push({ kind: "native-request", path, body, at: Date.now() });
        if (path === "/api/releaseHold") evidence.cleanupEntry = await nativeSwapSnapshot(page);
        const response = await native.post(path, body, request.headers().authorization);
        evidence.timeline.push({ kind: "native-response", path, body, response, at: Date.now() });
        await route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) });
      };
      await context.route(adapterRoute, adapter);
      let releaseGate;
      let finishHandler;
      let handlerEntered = false;
      const gate = new Promise(resolve => { releaseGate = resolve; });
      const handlerFinished = new Promise(resolve => { finishHandler = resolve; });
      let enterHandler;
      const entered = new Promise(resolve => { enterHandler = resolve; });
      const replacementGate = async route => {
        handlerEntered = true;
        evidence.gatedRequest = route.request().postDataJSON();
        evidence.timeline.push({ kind: "replacement-gated", at: Date.now() });
        enterHandler();
        try { await gate; await route.fallback(); }
        finally { finishHandler(); }
      };
      let gateInstalled = false;
      try {
        await flow.reserve();
        await flow.details();
        await page.getByRole("textbox", { name: "PC specifications", exact: true }).fill(specifications);
        evidence.before = await nativeSwapSnapshot(page);
        const original = evidence.before;
        evidence.originalRow = await native.getHold(original.hold.holdId);
        expect(evidence.originalRow.phase).toBe("active");
        expect(await native.verifyHold({ token: original.hold.holdToken, holdId: original.hold.holdId })).toBe(true);
        expect(original.fields).toEqual({ discord: "fixture_visitor", email: "visitor@example.invalid", specs: specifications, mainGame: "CS2" });
        await page.route("**/api/holdSlot", replacementGate);
        gateInstalled = true;
        await page.getByRole("button", { name: "Back", exact: true }).last().click();
        await page.getByRole("button", { name: "11:00 AM", exact: true }).click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await entered;
        await expect(page.getByRole("button", { name: "Reserving...", exact: true })).toBeVisible();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        evidence.inflight = await nativeSwapSnapshot(page);
        evidence.inflightRow = await native.getHold(original.hold.holdId);
        evidence.inflightTimeline = [...evidence.timeline];
        releaseGate();
        await expect.poll(async () => (await readHold(page))?.startTimeUTC).toBe(`${flow.state.slots[0].date}T05:30:00.000Z`);
        await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
        evidence.after = await nativeSwapSnapshot(page);
        evidence.newRow = await native.getHold(evidence.after.hold.holdId);
        await expect.poll(async () => (await native.getHold(original.hold.holdId))?.phase).toBe("released");
        await expect.poll(() => evidence.timeline.filter(event => event.kind === "native-response" && event.path === "/api/releaseHold").length).toBe(1);
        await expect(page.getByRole("button", { name: "Reserving...", exact: true })).toHaveCount(0);
        evidence.afterCleanup = await nativeSwapSnapshot(page);
        evidence.oldRowAfter = await native.getHold(original.hold.holdId);
        evidence.newRowAfter = await native.getHold(evidence.after.hold.holdId);
        evidence.newTokenValid = await native.verifyHold({ token: evidence.after.hold.holdToken, holdId: evidence.after.hold.holdId });
        await testInfo.attach("native-slot-swap-before-product-assertions", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
        const holdRequests = evidence.timeline.filter(event => event.kind === "native-request" && event.path === "/api/holdSlot");
        const holdResponses = evidence.timeline.filter(event => event.kind === "native-response" && event.path === "/api/holdSlot");
        expect(holdRequests).toHaveLength(2);
        expect(holdResponses.map(event => event.response.status)).toEqual([200, 200]);
        expect(holdRequests[1].body).toEqual(evidence.gatedRequest);
        expect(holdRequests[1].body).toMatchObject({ previousHoldId: original.hold.holdId, previousHoldToken: original.hold.holdToken,
          packageTitle: original.hold.packageTitle, startTimeUTC: evidence.after.hold.startTimeUTC });
        expect(evidence.after.hold.holdId).not.toBe(original.hold.holdId);
        expect(evidence.newRow._id).toBe(evidence.after.hold.holdId);
        expect(evidence.newRow.phase).toBe("active");
        expect(evidence.newRow.startTimeUTC).toBe(evidence.after.hold.startTimeUTC);
        expect(evidence.newRowAfter.phase).toBe("active");
        expect(evidence.oldRowAfter.phase).toBe("released");
        expect(evidence.newTokenValid).toBe(true);
        evidence.setupControlsPassed = true;
        await testInfo.attach("native-slot-swap-setup-controls-passed", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
        expect.soft(evidence.inflightRow.phase, "old native reservation stays active until replacement succeeds").toBe("active");
        expect.soft(evidence.inflight.hold).toEqual(original.hold);
        expect.soft(evidence.inflight.draft.packages[original.hold.packageTitle].form).toEqual(original.draft.packages[original.hold.packageTitle].form);
        expect.soft(evidence.afterCleanup.fields).toEqual(original.fields);
        expect.soft(evidence.afterCleanup.draft.packages[original.hold.packageTitle].form).toEqual(original.draft.packages[original.hold.packageTitle].form);
        const newResponseIndex = evidence.timeline.indexOf(holdResponses[1]);
        const releaseIndex = evidence.timeline.findIndex(event => event.kind === "native-request" && event.path === "/api/releaseHold");
        expect.soft(releaseIndex, "client cleanup follows accepted replacement response").toBeGreaterThan(newResponseIndex);
        expect.soft(evidence.inflightTimeline.filter(event => event.path === "/api/releaseHold")).toEqual([]);
        expect.soft(evidence.cleanupEntry.hold).toEqual(evidence.after.hold);
        expect.soft(evidence.afterCleanup.hold).toEqual(evidence.after.hold);
      } finally {
        releaseGate();
        if (handlerEntered) await handlerFinished;
        if (gateInstalled) await page.unroute("**/api/holdSlot", replacementGate);
        await context.unroute(adapterRoute, adapter);
        const nativeEvidence = await native.evidence();
        evidence.native = { database: nativeEvidence.database, http: nativeEvidence.http.slice(httpBoundary),
          providerRequests: nativeEvidence.providerRequests.slice(providerBoundary), blocked: nativeEvidence.blocked };
        evidence.final = await nativeSwapSnapshot(page);
        await testInfo.attach("native-slot-swap", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
        await testInfo.attach("native-slot-swap-final-page", { body: await page.screenshot(), contentType: "image/png" });
        expect(evidence.pageErrors).toEqual([]);
        expect(evidence.apiCalls.filter(call => call.path.startsWith("/api/payment/"))).toEqual([]);
        expect(evidence.native.providerRequests).toEqual([]);
        expect(evidence.native.blocked).toEqual([]);
      }
    });
  });
}
