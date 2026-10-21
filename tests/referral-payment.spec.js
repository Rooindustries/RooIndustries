const { test: base, expect } = require("./fixtures/booking-flow.cjs");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const REFERRAL_ID = "referral.fixture-creator";
const REFERRAL_CODE = "fixturecreator";
const EXPECTED_COMMISSION = 5.5;
const EXPECTED_NET = 52.2;

const test = base.extend({
  native: [async ({}, use) => {
    const child = fork(require.resolve("./fixtures/referral-payment.mjs"), ["--worker"], { execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"] });
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
        const error = new Error(`Referral payment fixture exited (${code})`);
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
  }, { scope: "worker" }],
});

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce", actionTimeout: 10000, navigationTimeout: 20000 });
const nativeBinaries = [process.env.PG_BIN && path.join(process.env.PG_BIN, "postgres"), process.env.POSTGREST_BIN];
test.skip(!nativeBinaries.every(file => file && fs.existsSync(file)), "Needs PG_BIN and POSTGREST_BIN for the native PostgreSQL 17 fixture.");

const credit = state => ({
  bookings: state.bookings.length,
  commission: state.earnings.total,
  successfulReferrals: state.referral.successfulReferrals,
});
const creditedOnce = before => ({
  bookings: before.bookings + 1,
  commission: Math.round((before.commission + EXPECTED_COMMISSION) * 100) / 100,
  successfulReferrals: before.successfulReferrals + 1,
});

const payWithDodo = async ({ page, context, flow, native }) => {
  const startRequests = [];
  flow.state.slots = [{ date: await native.nextSlotDate(), times: ["10:00", "11:00"] }];
  await context.route(/\/api\/(holdSlot|releaseHold|payment\/(providers|quote|start|status|finalize|cancel)|ref\/(validateReferral|validateCoupon))(?:\?|$)/, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/payment/start") startRequests.push(request.postDataJSON());
    const headers = Object.fromEntries(Object.entries(request.headers()).filter(([name]) => ["authorization", "content-type"].includes(name)));
    const response = await native.request({ method: request.method(), path: `${url.pathname}${url.search}`, body: request.postData() || "", headers });
    if (url.pathname === "/api/payment/finalize" && new URL(page.url()).searchParams.has("dodo_return")) {
      await expect(page.getByText(`${REFERRAL_CODE} · −$2.75`, { exact: true })).toBeVisible();
      expect(JSON.parse(response.body)).toMatchObject({ status: "booked", bookingId: expect.any(String) });
    }
    return route.fulfill({ status: response.status, contentType: response.headers["content-type"] || "application/json", body: response.body });
  });
  await context.route("https://test.checkout.dodopayments.com/session/**", route => route.fulfill({
    contentType: "text/html", body: "<h1>Fixture Dodo test checkout</h1>",
  }));

  const before = credit(await native.state());
  await page.goto(`/?ref=${REFERRAL_CODE}`);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_session"))).toBe(REFERRAL_CODE);
  await flow.reserve();
  await flow.details();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await flow.payment();
  await expect(page.locator("#payment-referral-code")).toHaveValue(REFERRAL_CODE);
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fixture Dodo test checkout", exact: true })).toBeVisible();
  expect(startRequests).toHaveLength(1);
  expect(startRequests[0]).toMatchObject({ provider: "dodo", bookingPayload: { referralCode: REFERRAL_CODE } });

  const started = await native.state();
  expect(credit(started)).toEqual(before);
  const paymentId = await native.pay(started.checkoutSessions.at(-1));
  return { before, paymentId };
};

const expectCreditedBooking = (state, paymentId) => {
  const booking = state.bookings.find(item => item.dodoPaymentId === paymentId);
  const paymentRecord = state.paymentRecords.find(item => item.providerPaymentId === paymentId);
  expect(booking).toMatchObject({ status: "captured", referral: { _ref: REFERRAL_ID }, referralCode: REFERRAL_CODE,
    commissionAmount: EXPECTED_COMMISSION, netAmount: EXPECTED_NET, paymentProvider: "dodo" });
  expect(paymentRecord).toMatchObject({ bookingId: booking._id, verificationState: "server_verified" });
  return { booking, paymentRecord };
};

const returnFromDodo = async (page, booking) => {
  await page.goto("/payment?dodo_return=1");
  await expect(page).toHaveURL(/\/payment-success$/);
  await expect(page.getByRole("heading", { name: "Payment Successful", exact: true })).toBeVisible();
  await expect(page.getByText(booking._id, { exact: true })).toBeVisible();
};

const saveResult = async (testInfo, name, result) => {
  const evidence = await result.native.evidence();
  expect(evidence.dodoEnvironment).toBe("test_mode");
  expect(evidence.blocked).toEqual([]);
  expect(evidence.next.routeSource).toBe("app/api/payment/webhook/dodo/route.js");
  expect(evidence.next.compiledRouteSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(evidence.http.some(request => request.path === "/api/payment/webhook/dodo" && request.status === 200)).toBe(true);
  const { native, ...rest } = result;
  const body = JSON.stringify({ ...rest, dodoEnvironment: evidence.dodoEnvironment, next: evidence.next }, null, 2);
  fs.mkdirSync("test-results/referral-payment", { recursive: true });
  fs.writeFileSync(`test-results/referral-payment/${name}.json`, body);
  await testInfo.attach(name, { body, contentType: "application/json" });
};

test("a ?ref visitor pays with Dodo, the signed webhook confirms the booking once and credits the creator once", async ({ page, context, flow, native }, testInfo) => {
  const { before, paymentId } = await payWithDodo({ page, context, flow, native });

  const unconfirmed = await native.snapshot();
  expect((await native.request({ method: "GET", path: "/api/payment/webhook/dodo" })).status).toBe(405);
  const invalid = await native.webhook({ paymentId, type: "payment.succeeded", eventId: `msg_${paymentId}`, invalidSignature: true });
  expect(invalid.status).toBe(401);
  expect(await native.snapshot()).toEqual(unconfirmed);

  const delivered = await native.webhook({ paymentId, type: "payment.succeeded", eventId: `msg_${paymentId}` });
  expect(delivered.status).toBe(200);
  const confirmed = await native.state();
  const { booking, paymentRecord } = expectCreditedBooking(confirmed, paymentId);
  expect(credit(confirmed)).toEqual(creditedOnce(before));

  await returnFromDodo(page, booking);
  const settled = await native.snapshot();
  const afterReturn = await native.state();
  expect(credit(afterReturn)).toEqual(credit(confirmed));

  const redelivered = await native.webhook({ paymentId, type: "payment.succeeded", eventId: `msg_${paymentId}` });
  expect(redelivered).toMatchObject({ status: 200, body: { duplicate: true } });
  expect(await native.snapshot()).toEqual(settled);

  const resent = await native.webhook({ paymentId, type: "payment.succeeded", eventId: `msg_${paymentId}_resent` });
  expect(resent.status).toBe(200);
  const final = await native.state();
  expect(credit(final)).toEqual(credit(confirmed));
  expect(final.bookings).toEqual(afterReturn.bookings);
  expect((await native.snapshot()).emails).toEqual(settled.emails);

  await saveResult(testInfo, "webhook-first", { native, bookingId: booking._id, paymentRecordId: paymentRecord._id, paymentId,
    credit: { before, afterWebhook: credit(confirmed), afterDuplicates: credit(final) },
    webhooks: { invalid, delivered, redelivered, resent } });
});

test("a ?ref visitor who returns before the webhook sees the booking, and the late webhook credits nothing extra", async ({ page, context, flow, native }, testInfo) => {
  const { before, paymentId } = await payWithDodo({ page, context, flow, native });

  await page.goto("/payment?dodo_return=1");
  await expect(page).toHaveURL(/\/payment-success$/);
  const returned = await native.state();
  const { booking, paymentRecord } = expectCreditedBooking(returned, paymentId);
  await expect(page.getByRole("heading", { name: "Payment Successful", exact: true })).toBeVisible();
  await expect(page.getByText(booking._id, { exact: true })).toBeVisible();
  expect(credit(returned)).toEqual(creditedOnce(before));
  const settled = await native.snapshot();

  const late = await native.webhook({ paymentId, type: "payment.succeeded", eventId: `msg_${paymentId}` });
  expect(late.status).toBe(200);
  const final = await native.state();
  expect(credit(final)).toEqual(credit(returned));
  expect(final.bookings).toEqual(returned.bookings);
  expect((await native.snapshot()).emails).toEqual(settled.emails);

  const replayed = await native.snapshot();
  const redelivered = await native.webhook({ paymentId, type: "payment.succeeded", eventId: `msg_${paymentId}` });
  expect(redelivered).toMatchObject({ status: 200, body: { duplicate: true } });
  expect(await native.snapshot()).toEqual(replayed);

  await saveResult(testInfo, "return-first", { native, bookingId: booking._id, paymentRecordId: paymentRecord._id, paymentId,
    credit: { before, afterReturn: credit(returned), afterWebhooks: credit(final) },
    webhooks: { late, redelivered } });
});
