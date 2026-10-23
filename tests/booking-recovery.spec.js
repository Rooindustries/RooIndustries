const { test: base, expect } = require("./fixtures/booking-flow.cjs");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");

const test = base.extend({
  native: [async ({}, use) => {
    const shared = process.env.ROO_NATIVE_RPC_SOCKET;
    const child = shared ? net.createConnection(shared) : fork(require.resolve("./fixtures/referral-payment.mjs"), ["--worker"], {
      execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const pending = new Map();
    let nextId = 0;
    const ready = new Promise((resolve, reject) => {
      const onMessage = message => {
        if (message.ready) return resolve(message.baseURL);
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
      };
      if (shared) {
        let input = "";
        child.on("data", data => {
          input += data;
          let end;
          while ((end = input.indexOf("\n")) !== -1) {
            onMessage(JSON.parse(input.slice(0, end)));
            input = input.slice(end + 1);
          }
        });
        child.on("error", reject);
      } else child.on("message", onMessage);
      child.on(shared ? "close" : "exit", code => {
        const error = new Error(`Native booking fixture exited (${code})`);
        reject(error);
        for (const request of pending.values()) request.reject(error);
        pending.clear();
      });
    });
    const call = (method, ...args) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      if (shared) child.write(`${JSON.stringify({ id, method, args })}\n`);
      else child.send({ id, method, args });
    });
    try {
      const baseURL = await ready;
      await use({ baseURL, ...Object.fromEntries(["request", "pay", "webhook", "state", "snapshot", "nextSlotDate", "expireHold", "evidence"]
        .map(method => [method, (...args) => call(method, ...args)])) });
    } finally {
      if (shared) child.end();
      else if (child.exitCode === null) {
        const exited = once(child, "exit");
        await call("stop");
        await exited;
      }
    }
  }, { scope: "worker", timeout: 180000 }],
  baseURL: async ({ native }, use) => use(native.baseURL),
});

test.use({ headless: true, video: "on", javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce",
  viewport: { width: 1440, height: 1000 }, actionTimeout: 10000, navigationTimeout: 30000 });
test.skip(![process.env.PG_BIN && path.join(process.env.PG_BIN, "postgres"), process.env.POSTGREST_BIN]
  .every(file => file && fs.existsSync(file)), "Runs in the native PostgreSQL 17 group.");

const clientState = page => page.evaluate(() => Object.fromEntries(
  ["my_slot_hold", "checkout_booking_state", "booking_draft", "payment_session_state"]
    .map(key => [key, JSON.parse(sessionStorage.getItem(key) || "null")])
));
const post = async (native, path, body) => {
  const response = await native.request({ method: "POST", path, body: JSON.stringify(body),
    headers: { "content-type": "application/json" } });
  return { status: response.status, data: JSON.parse(response.body) };
};
const attach = async (testInfo, name, value) => {
  const artifact = testInfo.outputPath(`${name}.json`);
  fs.writeFileSync(artifact, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path: artifact, contentType: "application/json" });
};
const withoutRateLimits = snapshot => ({ ...snapshot,
  documents: snapshot.documents.filter(document => document.payload._type !== "rateLimitBucket"),
});

for (const [kind, code, net] of [["paid", "delay20", 43.96], ["free", "delayfree", 0]]) {
  test(`a lost Dodo start response recovers before a revised ${kind} checkout`, async ({ page, context, flow, native }, testInfo) => {
    test.setTimeout(180000);
    let first;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const calls = [];
    flow.state.slots = [{ date: await native.nextSlotDate(), times: ["10:00", "11:00"] }];
    await context.route(/\/api\/(holdSlot|releaseHold|payment\/(providers|quote|start|status|finalize|cancel|recover)|ref\/(validateReferral|validateCoupon))(?:\?|$)/, async route => {
      const request = route.request();
      const url = new URL(request.url());
      const call = { path: url.pathname, body: request.postDataJSON() };
      calls.push(call);
      const lost = url.pathname === "/api/payment/start" && !first;
      if (lost) first = call;
      const response = await native.request({ method: request.method(), path: `${url.pathname}${url.search}`,
        body: request.postData() || "", headers: Object.fromEntries(Object.entries(request.headers())
          .filter(([name]) => ["authorization", "content-type"].includes(name))) });
      call.status = response.status;
      call.data = JSON.parse(response.body);
      if (lost) {
        await gate;
        await route.abort("failed");
      } else {
        await route.fulfill({ status: response.status, contentType: "application/json", body: response.body });
      }
    });
    await context.route("https://test.checkout.dodopayments.com/session/**", route => route.fulfill({
      contentType: "text/html", body: "<h1>Dodo test checkout</h1>",
    }));
    try {
      const before = await native.state();
      if (kind === "paid") {
        await page.goto("/?ref=fixturecreator");
        await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_session"))).toBe("fixturecreator");
      }
      await flow.review();
      await flow.payment();
      await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect.poll(() => first?.status, { timeout: 30000 }).toBe(200);
      const held = await clientState(page);
      await page.locator("#payment-coupon-code").fill(code);
      await page.locator("#payment-coupon-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
      await expect(page.getByText(code, { exact: false }).filter({ hasNot: page.locator("input") }).first()).toBeVisible();
      release();
      await expect(page.getByRole("button", { name: "Change payment method", exact: true })).toBeEnabled({ timeout: 25000 });
      expect(page.url()).toContain("/payment");
      const recovered = await clientState(page);
      expect(recovered.payment_session_state.paymentAccessToken).toEqual(expect.any(String));
      expect(recovered.payment_session_state.result.quote.netAmount).toBe(kind === "paid" ? 52.2 : 54.95);
      expect((await native.state()).checkoutSessions).toHaveLength(before.checkoutSessions.length + 1);
      expect(recovered.booking_draft.packages[recovered.booking_draft.lastTitle].form)
        .toEqual(held.booking_draft.packages[held.booking_draft.lastTitle].form);
      await page.reload();
      await expect(page.getByRole("button", { name: "Change payment method", exact: true })).toBeEnabled();
      if (kind === "paid") {
        await page.goto("/");
        await page.goBack();
        await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeEnabled();
        await page.goForward();
        await page.goBack();
        await expect(page.getByRole("button", { name: "Change payment method", exact: true })).toBeEnabled();
        const opened = page.waitForEvent("popup");
        await page.evaluate(() => window.open("/payment", "recovered-checkout"));
        const secondTab = await opened;
        try {
          await secondTab.getByRole("button", { name: "Resume checkout", exact: true }).click();
          await expect(secondTab.getByRole("heading", { name: "Dodo test checkout" })).toBeVisible();
          expect((await native.state()).checkoutSessions).toHaveLength(before.checkoutSessions.length + 1);
        } finally { await secondTab.close(); }
      }
      await page.getByRole("button", { name: "Change payment method", exact: true }).click();
      await expect.poll(async () => (await clientState(page)).payment_session_state).toBeNull();
      if (kind === "free") {
        await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
        await expect(page).toHaveURL(/\/thank-you$/);
      } else {
        await page.getByRole("button", { name: "Pay your way", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Dodo test checkout" })).toBeVisible();
        const paymentId = await native.pay((await native.state()).checkoutSessions.at(-1));
        expect((await native.webhook({ paymentId, type: "payment.succeeded", eventId: `lost-${paymentId}` })).status).toBe(200);
        await page.goto("/payment?dodo_return=1");
        await expect(page).toHaveURL(/\/payment-success$/);
        expect((await native.webhook({ paymentId, type: "payment.succeeded", eventId: `lost-${paymentId}` })).status).toBe(200);
      }
      const after = await native.state();
      const newBookings = after.bookings.filter(booking => !before.bookings.some(old => old._id === booking._id));
      expect(newBookings).toHaveLength(1);
      expect(newBookings[0]).toMatchObject({ couponCode: code,
        netAmount: kind === "paid" ? calls.filter(call => call.path === "/api/payment/start").at(-1).data.quote.netAmount : net });
      expect(after.referral.successfulReferrals).toBe(before.referral.successfulReferrals + (kind === "paid" ? 1 : 0));
      expect(after.earnings.total).toBeCloseTo(before.earnings.total + newBookings[0].commissionAmount, 2);
      if (kind === "paid") expect(newBookings[0].commissionAmount).toBeGreaterThan(0);
      await attach(testInfo, "lost-response-confirmed", { calls, booking: newBookings[0], before, after, evidence: await native.evidence() });
    } finally {
      release();
      await attach(testInfo, "lost-response-state", { calls, client: await clientState(page), server: await native.state() });
    }
  });
}

test("a lost free-booking response still opens its confirmation once", async ({ page, context, flow, native }, testInfo) => {
  test.setTimeout(180000);
  const before = await native.state();
  flow.state.slots = [{ date: await native.nextSlotDate(), times: ["10:00", "11:00"] }];
  let lost = false;
  await context.route(/\/api\/(holdSlot|releaseHold|payment\/(providers|quote|start|status|finalize|cancel|recover)|ref\/(validateReferral|validateCoupon))(?:\?|$)/, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const response = await native.request({ method: request.method(), path: `${url.pathname}${url.search}`,
      body: request.postData() || "", headers: Object.fromEntries(Object.entries(request.headers())
        .filter(([name]) => ["authorization", "content-type"].includes(name))) });
    if (url.pathname === "/api/payment/start" && !lost) {
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).status).toMatch(/^(booked|email_partial)$/);
      lost = true;
      await route.abort("failed");
    } else await route.fulfill({ status: response.status, contentType: "application/json", body: response.body });
  });
  await flow.review();
  await flow.payment();
  await page.locator("#payment-coupon-code").fill("delayfree");
  await page.locator("#payment-coupon-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
  await expect(page).toHaveURL(/\/thank-you$/);
  expect(lost).toBe(true);
  const after = await native.state();
  expect(after.bookings).toHaveLength(before.bookings.length + 1);
  expect(after.checkoutSessions).toEqual(before.checkoutSessions);
  expect(after.earnings.total).toBe(before.earnings.total);
  await page.reload();
  await expect(page).toHaveURL(/\/thank-you$/);
  expect((await native.state()).bookings).toEqual(after.bookings);
  await attach(testInfo, "free-response-confirmed", { after, evidence: await native.evidence() });
});

test("hold ownership recovers the original quote and refuses other generations", async ({ native }, testInfo) => {
  const date = await native.nextSlotDate();
  const payload = { packageTitle: "Performance Vertex Overhaul", startTimeUTC: `${date}T04:30:00.000Z`,
    email: "visitor@example.invalid", discord: "fixture_visitor", specs: "Ryzen 7700 / RTX 4070", mainGame: "CS2", localTimeZone: "Asia/Kolkata" };
  const hold = await post(native, "/api/holdSlot", payload);
  expect(hold.status).toBe(200);
  Object.assign(payload, { slotHoldId: hold.data.holdId, slotHoldToken: hold.data.holdToken });
  const quote = await post(native, "/api/payment/quote", { bookingPayload: payload });
  const started = await post(native, "/api/payment/start", { provider: "dodo", bookingPayload: payload, quoteFingerprint: quote.data.quoteFingerprint });
  expect(started.status).toBe(200);
  const revised = { ...payload, couponCode: "delayfree" };
  const revisedQuote = await post(native, "/api/payment/quote", { bookingPayload: revised });
  expect((await post(native, "/api/payment/start", { provider: "free", bookingPayload: revised, quoteFingerprint: revisedQuote.data.quoteFingerprint })).status).toBe(409);
  const recovered = await post(native, "/api/payment/recover", { bookingPayload: revised });
  expect(recovered.status).toBe(200);
  expect(recovered.data).toMatchObject({ recovered: true, provider: "dodo", paymentAccessToken: expect.any(String),
    quote: { netAmount: 54.95, isFree: false } });
  const snapshot = withoutRateLimits(await native.snapshot());
  for (const changed of [{ slotHoldToken: `${payload.slotHoldToken}x` }, { slotHoldId: "different-hold" },
    { packageTitle: "Performance Vertex Max" }, { startTimeUTC: `${date}T05:30:00.000Z` }]) {
    expect((await post(native, "/api/payment/recover", { bookingPayload: { ...payload, ...changed } })).status).toBe(403);
  }
  expect(withoutRateLimits(await native.snapshot())).toEqual(snapshot);
  await attach(testInfo, "recovery-ownership", { recovered, evidence: await native.evidence() });
});

for (const expired of [false, true]) {
  test(`a late payment release ${expired ? "without" : "with"} a refreshed hold preserves a newer checkout`, async ({ page, context, flow, native }, testInfo) => {
    test.setTimeout(180000);
    const date = await native.nextSlotDate();
    flow.state.slots = [{ date, times: ["10:00", "11:00"] }];
    let delayed;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await context.route(/\/api\/(holdSlot|releaseHold|payment\/(providers|quote|start|status|finalize|cancel|recover)|ref\/(validateReferral|validateCoupon))(?:\?|$)/, async route => {
      const request = route.request();
      const url = new URL(request.url());
      const response = await native.request({ method: request.method(), path: `${url.pathname}${url.search}`,
        body: request.postData() || "", headers: Object.fromEntries(Object.entries(request.headers())
          .filter(([name]) => ["authorization", "content-type"].includes(name))) });
      if (url.pathname === "/api/payment/cancel") {
        delayed = JSON.parse(response.body);
        await gate;
      }
      await route.fulfill({ status: response.status, contentType: "application/json", body: response.body });
    });
    await context.route("https://test.checkout.dodopayments.com/session/**", route => route.fulfill({
      contentType: "text/html", body: "<h1>Dodo test checkout</h1>",
    }));
    try {
      await flow.review();
      await flow.payment();
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Dodo test checkout" })).toBeVisible();
      await page.goto("/booking");
      const original = await clientState(page);
      if (expired) await native.expireHold(original.my_slot_hold.holdId);
      await page.getByRole("button", { name: "Release payment", exact: true }).click();
      await expect.poll(() => delayed?.cancelled).toBe(true);
      const nextPayload = { ...original.checkout_booking_state, startTimeUTC: `${date}T05:30:00.000Z`, displayTime: "11:00 AM" };
      const held = await post(native, "/api/holdSlot", { startTimeUTC: nextPayload.startTimeUTC, packageTitle: nextPayload.packageTitle,
        previousHoldId: delayed.refreshedHold?.slotHoldId, previousHoldToken: delayed.refreshedHold?.slotHoldToken });
      expect(held.status).toBe(200);
      Object.assign(nextPayload, { slotHoldId: held.data.holdId, slotHoldToken: held.data.holdToken, slotHoldExpiresAt: held.data.expiresAt });
      const quote = await post(native, "/api/payment/quote", { bookingPayload: nextPayload });
      const nextStart = await post(native, "/api/payment/start", { provider: "dodo", bookingPayload: nextPayload, quoteFingerprint: quote.data.quoteFingerprint });
      expect(nextStart.status).toBe(200);
      const refreshed = nextStart.data.refreshedHold;
      Object.assign(nextPayload, { slotHoldId: refreshed.slotHoldId, slotHoldToken: refreshed.slotHoldToken, slotHoldExpiresAt: refreshed.slotHoldExpiresAt });
      const nextHold = { ...original.my_slot_hold, holdId: refreshed.slotHoldId, holdToken: refreshed.slotHoldToken,
        startTimeUTC: nextPayload.startTimeUTC, expiresAt: refreshed.slotHoldExpiresAt, phase: "payment_pending" };
      const nextSession = { ...original.payment_session_state, fingerprint: JSON.stringify({
        ...JSON.parse(original.payment_session_state.fingerprint), startTimeUTC: nextPayload.startTimeUTC,
      }), paymentAccessToken: nextStart.data.paymentAccessToken, providerPayload: nextStart.data.providerPayload, result: nextStart.data };
      await page.evaluate(({ nextHold, nextPayload, nextSession }) => {
        sessionStorage.setItem("my_slot_hold", JSON.stringify(nextHold));
        sessionStorage.setItem("checkout_booking_state", JSON.stringify(nextPayload));
        sessionStorage.setItem("payment_session_state", JSON.stringify(nextSession));
      }, { nextHold, nextPayload, nextSession });
      const newer = await clientState(page);
      const cancellationDelivered = page.waitForResponse(response => new URL(response.url()).pathname === "/api/payment/cancel");
      release();
      await cancellationDelivered;
      await expect(page.getByRole("button", { name: "Checking payment...", exact: true })).toHaveCount(0);
      await expect.poll(async () => (await clientState(page)).my_slot_hold).toEqual(newer.my_slot_hold);
      expect(await clientState(page)).toEqual(newer);
      await page.goto("/payment");
      await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Dodo test checkout" })).toBeVisible();
      const paymentId = await native.pay((await native.state()).checkoutSessions.at(-1));
      expect((await native.webhook({ paymentId, type: "payment.succeeded", eventId: `newer-${paymentId}` })).status).toBe(200);
      await page.goto("/payment?dodo_return=1");
      await expect(page).toHaveURL(/\/payment-success$/);
      await attach(testInfo, "newer-reservation-confirmed", { expired, delayed, newer, state: await native.state() });
    } finally {
      release();
      await attach(testInfo, "payment-release-state", { client: await clientState(page), evidence: await native.evidence() });
    }
  });
}

for (const width of [360, 390, 1440]) {
  test(`Max unsupported parts warning is inside the booking dialog at ${width}px`, async ({ page, flow }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      const title = "Performance Vertex Max";
      sessionStorage.setItem("booking_draft", JSON.stringify({ lastTitle: title,
        packages: { [title]: { selectedPackage: { title, price: "$99.95" } } } }));
    });
    await page.goto("/booking");
    const dialog = page.locator('[role="dialog"].ri-booking').first();
    await expect(dialog).toBeVisible();
    await expect(page.locator(".ri-booking-package-title")).toHaveText("Performance Vertex Max");
    const screenshot = testInfo.outputPath("max-warning.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("max-warning", { path: screenshot, contentType: "image/png" });
    await expect(dialog.getByText(/Refunds will not be issued in case you proceed with unsupported\/custom parts/)).toBeVisible();
    await attach(testInfo, "max-warning-bounds", await dialog.evaluate(node => ({
      width: node.getBoundingClientRect().width, scrollWidth: node.scrollWidth,
    })));
  });
}
