const { test: base, expect } = require("./fixtures/booking-flow.cjs");
const { fork } = require("node:child_process");
const { once } = require("node:events");

const creators = {
  fixturecreator: { id: "referral.fixture-creator", commission: 5.5 },
  fixturesecond: { id: "referral.fixture-second", commission: 4.4 },
};
const byId = records => [...records].sort((a, b) => a._id.localeCompare(b._id));

const test = base.extend({
  native: [async ({}, use) => {
    const child = fork(require.resolve("./fixtures/referral-payment.mjs"), ["--worker"], {
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
        const error = new Error(`Creator payment fixture exited (${code})`);
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
      await use(Object.fromEntries(["request", "pay", "webhook", "state", "snapshot", "nextSlotDate", "evidence"]
        .map(method => [method, (...args) => call(method, ...args)])));
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        await call("stop");
        await exited;
      }
    }
  }, { scope: "worker", timeout: 180000 }],
});

test.use({ headless: true, javaScriptEnabled: true, timezoneId: "Asia/Kolkata", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", actionTimeout: 15000, navigationTimeout: 30000 });
test.skip(process.env.ROO_CREATOR_CREDIT_NATIVE !== "1", "Run npm run test:creator-credit with PostgreSQL 17 and PostgREST.");

const guide = async (page, code, testInfo) => {
  await page.goto(`/BIOSGuide?ref=${code}`);
  if (testInfo) {
    await page.getByText("Want Professional Optimization?", { exact: true }).scrollIntoViewIfNeeded();
    await testInfo.attach("guide-packages", { body: await page.screenshot(), contentType: "image/png" });
  }
  await page.getByRole("link", { name: "PC optimization packages", exact: true }).click();
  await expect(page).toHaveURL(/\/packages(?:\?|$)/);
};

const review = async (page, flow) => {
  const book = page.getByRole("link", { name: "Book Now", exact: true }).first();
  await expect(book).toBeVisible();
  await book.click();
  await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await flow.details();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
};

for (const [index, scenario] of [
  { name: "guide first", expected: "fixturecreator", returnFirst: false },
  { name: "second guide before applying", expected: "fixturesecond", returnFirst: true },
  { name: "second guide after applying", expected: "fixturecreator", returnFirst: false },
  { name: "second payment link after applying", expected: "fixturecreator", returnFirst: true },
  { name: "second guide after payment started", expected: "fixturecreator", returnFirst: false },
  { name: "manual replacement at review", expected: "fixturesecond", returnFirst: false },
  { name: "manual replacement at payment", expected: "fixturesecond", returnFirst: true },
  { name: "manual removal at review", expected: "", returnFirst: false },
  { name: "manual removal at payment", expected: "", returnFirst: true },
  { name: "new creator after manual removal", expected: "fixturesecond", returnFirst: false },
  { name: "manual replacement in coupon field", expected: "fixturesecond", returnFirst: true },
  { name: "invalid manual replacement", expected: "fixturecreator", returnFirst: false },
  { name: "validation unavailable after applying", expected: "fixturecreator", returnFirst: true },
].entries()) {
  test(`${scenario.name}: one paid booking credits only the chosen creator`, async ({ page, context, flow, native }, testInfo) => {
    test.setTimeout(180000);
    const before = await native.state();
    flow.state.slots = [{ date: await native.nextSlotDate(), times: ["10:00", "11:00"] }];
    const starts = [];
    let validationUnavailable = false;
    await context.route(/\/api\/(holdSlot|releaseHold|payment\/(providers|quote|start|status|finalize|cancel)|ref\/(validateReferral|validateCoupon))(?:\?|$)/, async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (validationUnavailable && url.pathname === "/api/ref/validateReferral") {
        return route.fulfill({ status: 503, json: { ok: false, reason: "unavailable" } });
      }
      if (url.pathname === "/api/payment/start") starts.push(request.postDataJSON());
      const headers = Object.fromEntries(Object.entries(request.headers()).filter(([name]) => ["authorization", "content-type"].includes(name)));
      headers["x-forwarded-for"] = `192.0.2.${index + 1}`;
      const response = await native.request({ method: request.method(), path: `${url.pathname}${url.search}`, body: request.postData() || "", headers });
      await route.fulfill({ status: response.status, contentType: response.headers["content-type"] || "application/json", body: response.body });
    });
    await context.route("https://test.checkout.dodopayments.com/session/**", route => route.fulfill({
      contentType: "text/html", body: "<h1>Fixture Dodo test checkout</h1>",
    }));

    await guide(page, "fixturecreator", testInfo);
    if (scenario.name === "second guide before applying") await guide(page, "fixturesecond");
    await review(page, flow);
    if (scenario.name === "second guide after applying") {
      await expect(page.getByRole("button", { name: "Remove referral code fixturecreator", exact: true })).toBeVisible();
      await guide(page, "fixturesecond");
      await page.goto("/booking");
      const heading = page.getByRole("heading", { name: "Review your booking", exact: true });
      const button = page.getByRole("button", { name: "Review before payment", exact: true });
      await expect(heading.or(button).first()).toBeVisible();
      if (await button.isVisible()) await button.click();
      await expect(heading).toBeVisible();
    }
    if (scenario.name === "manual replacement at review") {
      await flow.codeInput("fixturesecond");
      await expect(page.getByRole("button", { name: "Remove referral code fixturesecond", exact: true })).toBeVisible();
    }
    if (scenario.name === "manual removal at review") {
      await page.getByRole("button", { name: "Remove referral code fixturecreator", exact: true }).click();
    }
    await flow.payment();
    if (scenario.name === "second payment link after applying") await page.goto("/payment?ref=fixturesecond");
    if (scenario.name === "manual replacement at payment") {
      await page.locator("#payment-referral-code").fill("fixturesecond");
      await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_session"))).toBe("fixturesecond");
      await page.reload();
      await page.goto("/payment?ref=fixturecreator");
    }
    if (scenario.name === "manual removal at review") await page.goto("/payment?ref=fixturecreator");
    if (["manual removal at payment", "new creator after manual removal"].includes(scenario.name)) {
      await page.locator("#payment-referral-code").fill("");
      await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_session"))).toBeNull();
      await page.goto(`/payment?ref=${scenario.expected || "fixturecreator"}`);
    }
    if (scenario.name === "manual replacement in coupon field") {
      await page.locator("#payment-coupon-code").fill("fixturesecond");
      await page.locator("#payment-coupon-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_session"))).toBe("fixturesecond");
      await page.reload();
    }
    if (scenario.name === "invalid manual replacement") {
      await page.goto("/payment?ref=fixturesecond");
      await page.locator("#payment-referral-code").fill("unknown");
      await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
      await expect(page.locator("#payment-referral-code-error")).toBeVisible();
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_session"))).toBe("fixturecreator");
      await page.reload();
    }
    if (scenario.name === "validation unavailable after applying") {
      validationUnavailable = true;
      await page.goto("/payment?ref=fixturesecond");
      await expect(page.locator("#payment-referral-code-error")).toBeVisible();
    }
    await expect(page.locator("#payment-referral-code")).toBeEnabled();
    await expect(page.locator("#payment-referral-code")).toHaveValue(scenario.expected);
    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Fixture Dodo test checkout", exact: true })).toBeVisible();
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ provider: "dodo", bookingPayload: { referralCode: scenario.expected } });
    const started = await native.state();
    expect(started.credits).toEqual(before.credits);
    if (scenario.name === "second guide after payment started") {
      await guide(page, "fixturesecond");
    }
    const paymentId = await native.pay(started.checkoutSessions.at(-1));
    const deliver = eventId => native.webhook({ paymentId, type: "payment.succeeded", eventId });
    if (scenario.name === "guide first") {
      const unconfirmed = await native.snapshot();
      const rejected = await native.webhook({ paymentId, type: "payment.succeeded", eventId: `msg_${paymentId}`, invalidSignature: true });
      expect(rejected.status).toBe(401);
      expect(await native.snapshot()).toEqual(unconfirmed);
    }
    let delivery;
    if (scenario.returnFirst) {
      await page.goto("/payment?dodo_return=1");
      await expect(page).toHaveURL(/\/payment-success$/);
      delivery = await deliver(`msg_${paymentId}`);
    } else {
      delivery = await deliver(`msg_${paymentId}`);
      await page.goto("/payment?dodo_return=1");
      await expect(page).toHaveURL(/\/payment-success$/);
    }
    expect(delivery.status).toBe(200);
    const after = await native.state();
    const selected = creators[scenario.expected];
    const booking = after.bookings.find(item => item.dodoPaymentId === paymentId);
    expect(booking).toMatchObject({ status: "captured", referralCode: scenario.expected,
      commissionAmount: selected?.commission || 0, netAmount: selected ? 52.2 : 54.95, paymentProvider: "dodo" });
    expect(booking.referral?._ref || "").toBe(selected?.id || "");
    expect(byId(after.bookings.filter(item => item.dodoPaymentId !== paymentId))).toEqual(byId(before.bookings));
    for (const code of Object.keys(creators)) {
      expect(after.credits[code]).toEqual(code === scenario.expected ? {
        successfulReferrals: before.credits[code].successfulReferrals + 1,
        total: Math.round((before.credits[code].total + selected.commission) * 100) / 100,
      } : before.credits[code]);
    }
    const duplicate = await deliver(`msg_${paymentId}`);
    expect(duplicate).toMatchObject({ status: 200, body: { duplicate: true } });
    expect((await deliver(`msg_${paymentId}_replay`)).status).toBe(200);
    const final = await native.state();
    expect(byId(final.bookings)).toEqual(byId(after.bookings));
    expect(final.credits).toEqual(after.credits);
    const evidence = await native.evidence();
    expect(evidence.dodoEnvironment).toBe("test_mode");
    expect(evidence.blocked).toEqual([]);
    expect(evidence.next.compiledRouteSha256).toMatch(/^[a-f0-9]{64}$/);
    await testInfo.attach("booking-confirmed", { body: await page.screenshot(), contentType: "image/png" });
    await testInfo.attach("creator-credit", { body: JSON.stringify({ scenario, before: before.credits,
      after: final.credits, booking, delivery, duplicate, next: evidence.next }, null, 2), contentType: "application/json" });
  });
}
