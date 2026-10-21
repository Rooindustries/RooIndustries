const { test: base, expect } = require("./fixtures/booking-flow.cjs");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { createHash } = require("node:crypto");
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

test.describe("a changed quote after a claimed payment start", () => {
  const nativeRows = (snapshot, table) => snapshot.tables[table].map(item => item.row);
  const nativeHold = (snapshot, holdId) => nativeRows(snapshot, "slot_holds")
    .find(row => row.legacy_sanity_id === holdId);
  const liveClaims = (snapshot, holdId) => {
    const ids = new Set(nativeRows(snapshot, "payment_records")
      .filter(row => row.booking_payload?.slotHoldId === holdId && row.status === "started").map(row => row.id));
    return nativeRows(snapshot, "payment_start_claims").filter(row => ids.has(row.payment_record_id));
  };
  const tokenNonce = token => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")).n;
  const clientState = page => page.evaluate(() => {
    const raw = Object.fromEntries(["my_slot_hold", "booking_draft", "checkout_booking_state", "payment_session_state"]
      .map(key => [key, sessionStorage.getItem(key)]));
    const draft = JSON.parse(raw.booking_draft || "null");
    return { url: location.href, raw, hold: JSON.parse(raw.my_slot_hold || "null"), draft,
      form: draft?.packages?.[draft.lastTitle]?.form,
      session: JSON.parse(raw.payment_session_state || "null"),
      couponInput: document.querySelector("#payment-coupon-code")?.value ?? null };
  });

  for (const [kind, code, net] of [["paid", "delay20", 43.96], ["free", "delayfree", 0]]) {
    test(`a delayed claimed Dodo start remains recoverable before a revised ${kind === "paid" ? "paid checkout" : "free booking"}`,
      async ({ page, context, flow, native }, testInfo) => {
        test.setTimeout(180000);
        const evidence = { setupComplete: false, calls: [], pageErrors: [], aborted: [], handoffs: [], snapshots: {} };
        const soft = expect.configure({ soft: true });
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        let first;
        page.on("pageerror", error => evidence.pageErrors.push({ name: error.name, message: error.message }));
        page.on("requestfailed", request => evidence.aborted.push({ url: request.url(), failure: request.failure() }));
        flow.state.slots = [{ date: await native.nextSlotDate(), times: ["10:00", "11:00"] }];
        await context.route(/\/api\/(holdSlot|releaseHold|payment\/(providers|quote|start|status|finalize|cancel)|ref\/(validateReferral|validateCoupon))(?:\?|$)/, async route => {
          const request = route.request();
          const url = new URL(request.url());
          const call = { at: Date.now(), path: url.pathname, method: request.method(), query: url.search,
            body: request.postDataJSON(), authorization: request.headers().authorization || "" };
          evidence.calls.push(call);
          const isFirst = url.pathname === "/api/payment/start" && !first;
          if (isFirst) first = call;
          const headers = Object.fromEntries(Object.entries(request.headers())
            .filter(([name]) => ["authorization", "content-type"].includes(name)));
          const response = await native.request({ method: request.method(), path: `${url.pathname}${url.search}`,
            body: request.postData() || "", headers });
          call.response = response;
          call.data = response.headers["content-type"]?.includes("application/json") ? JSON.parse(response.body) : null;
          call.completedAt = Date.now();
          if (isFirst) await gate;
          await route.fulfill({ status: response.status, contentType: response.headers["content-type"] || "application/json", body: response.body });
          call.fulfilledAt = Date.now();
        });
        await context.route("https://test.checkout.dodopayments.com/session/**", route => {
          evidence.handoffs.push({ at: Date.now(), url: route.request().url() });
          return route.fulfill({ contentType: "text/html", body: "<h1>Fixture Dodo test checkout</h1>" });
        });
        try {
          evidence.beforeState = await native.state();
          await flow.review();
          await flow.payment();
          await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
          await page.waitForLoadState("networkidle", { timeout: 10000 });
          evidence.initial = await clientState(page);
          expect(evidence.initial.form).toMatchObject({ discord: "fixture_visitor", email: "visitor@example.invalid",
            specs: "Ryzen 7700 / RTX 4070", mainGame: "CS2" });
          expect(evidence.initial.session).toBeNull();
          const holdId = evidence.initial.hold.holdId;
          const initialNonce = tokenNonce(evidence.initial.hold.holdToken);
          expect(initialNonce).toEqual(expect.any(String));
          await page.getByRole("button", { name: "Pay your way", exact: true }).click();
          await expect.poll(() => first?.response?.status, { timeout: 30000 }).toBe(200);
          expect(first.body).toMatchObject({ provider: "dodo", bookingPayload: { couponCode: "", referralCode: "", slotHoldId: holdId } });
          expect(first.data).toMatchObject({ ok: true, status: "started", provider: "dodo",
            paymentAccessToken: expect.any(String), quote: { grossAmount: 54.95, netAmount: 54.95 } });
          expect(first.data.paymentAccessToken.length).toBeGreaterThan(0);
          expect(first.data.providerPayload.checkoutUrl).toMatch(/^https:\/\/test\.checkout\.dodopayments\.com\/session\//);
          expect(first.fulfilledAt).toBeUndefined();
          evidence.snapshots.claimed = await native.snapshot();
          const claimedHold = nativeHold(evidence.snapshots.claimed, holdId);
          expect(claimedHold.phase).toBe("payment");
          expect(claimedHold.owner_token_hash).toBe(createHash("sha256").update(initialNonce).digest("hex"));
          const claims = liveClaims(evidence.snapshots.claimed, holdId);
          expect(claims).toHaveLength(1);
          expect(claims[0]).toMatchObject({ scope: `hold:${holdId}:${initialNonce}`, provider: "dodo",
            quote_fingerprint: first.data.quoteFingerprint, payment_record_id: claimedHold.payment_record_id });
          const claimedRecord = nativeRows(evidence.snapshots.claimed, "payment_records")
            .find(row => row.id === claims[0].payment_record_id);
          expect(claimedRecord).toMatchObject({ session_scope: claims[0].scope, status: "started",
            booking_payload: { slotHoldId: holdId, startTimeUTC: evidence.initial.hold.startTimeUTC } });
          expect((await native.state()).checkoutSessions.length).toBe(evidence.beforeState.checkoutSessions.length + 1);
          expect((await clientState(page)).session).toBeNull();
          const input = page.locator("#payment-coupon-code");
          await expect(input).toBeEnabled();
          await input.fill(code);
          await input.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
          await expect.poll(() => evidence.calls.filter(call => call.path === "/api/payment/quote" &&
            call.body?.couponCode === code && call.fulfilledAt && call.response.status === 200).length).toBeGreaterThan(0);
          const revisedQuote = evidence.calls.filter(call => call.path === "/api/payment/quote" && call.body?.couponCode === code).at(-1);
          expect(revisedQuote.data.quote).toMatchObject({ grossAmount: 54.95, netAmount: net });
          expect(revisedQuote.data.quoteFingerprint).not.toBe(first.data.quoteFingerprint);
          evidence.beforeDelivery = await clientState(page);
          expect(evidence.beforeDelivery.form).toEqual(evidence.initial.form);
          expect(evidence.beforeDelivery.session).toBeNull();
          expect(evidence.beforeDelivery.hold.holdId).toBe(holdId);
          evidence.setupComplete = true;
          await testInfo.attach("claimed-start-before-response", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
          release();
          await expect.poll(() => first.fulfilledAt || 0).toBeGreaterThan(0);
          const change = page.getByRole("button", { name: "Change payment method", exact: true });
          await soft(change).toBeVisible({ timeout: 3000 });
          await soft.poll(async () => (await clientState(page)).session?.paymentAccessToken, { timeout: 3000 }).toBe(first.data.paymentAccessToken);
          evidence.afterDelivery = await clientState(page);
          soft(evidence.handoffs).toEqual([]);
          soft(evidence.afterDelivery.form).toEqual(evidence.initial.form);
          soft(evidence.afterDelivery.hold.holdId).toBe(holdId);
          await soft(page).toHaveURL(/\/payment(?:\?|$)/);
          if (!await change.isVisible()) {
            const revisedButton = page.getByRole("button", { name: kind === "free" ? "Confirm Free Booking" : "Pay your way", exact: true });
            await expect(revisedButton).toBeEnabled();
            await revisedButton.click();
            await expect.poll(() => evidence.calls.filter(call => call.path === "/api/payment/start" && call !== first && call.response).length).toBe(1);
            evidence.actualRefusal = evidence.calls.filter(call => call.path === "/api/payment/start" && call !== first).at(-1);
            expect(evidence.actualRefusal.response.status).toBe(409);
            expect(evidence.actualRefusal.data.code).toBe(kind === "free" ? "payment_provider_already_claimed" : "payment_quote_already_claimed");
            expect(evidence.actualRefusal.body).toMatchObject({ provider: kind === "free" ? "free" : "dodo", bookingPayload: { couponCode: code } });
            evidence.snapshots.refused = await native.snapshot();
            expect(liveClaims(evidence.snapshots.refused, holdId)).toHaveLength(1);
            expect((await native.state()).bookings.length).toBe(evidence.beforeState.bookings.length);
            return;
          }
          expect(evidence.afterDelivery.session.provider).toBe("dodo");
          expect(evidence.afterDelivery.session.result.quote).toMatchObject({ grossAmount: 54.95, netAmount: 54.95 });
          expect(JSON.parse(evidence.afterDelivery.session.fingerprint).couponCode).toBe("");
          await change.click();
          await expect.poll(() => evidence.calls.filter(call => call.path === "/api/payment/cancel" && call.fulfilledAt).length).toBe(1);
          const cancellation = evidence.calls.find(call => call.path === "/api/payment/cancel");
          expect(cancellation).toMatchObject({ method: "POST", body: {}, authorization: `Bearer ${first.data.paymentAccessToken}`, response: { status: 200 }, data: { ok: true, cancelled: true } });
          await expect.poll(async () => (await clientState(page)).session).toBeNull();
          evidence.cancelled = await clientState(page);
          expect(evidence.cancelled.form).toEqual(evidence.initial.form);
          expect(evidence.cancelled.hold.holdId).toBe(holdId);
          const nextNonce = tokenNonce(evidence.cancelled.hold.holdToken);
          expect(nextNonce).not.toBe(initialNonce);
          evidence.snapshots.cancelled = await native.snapshot();
          expect(liveClaims(evidence.snapshots.cancelled, holdId)).toHaveLength(0);
          expect(nativeHold(evidence.snapshots.cancelled, holdId)).toMatchObject({ phase: "active", payment_record_id: null,
            owner_token_hash: createHash("sha256").update(nextNonce).digest("hex") });
          await expect(input).toHaveValue(code);
          const summary = page.getByRole("heading", { name: "Booking Summary", exact: true }).locator("..");
          await expect(summary.getByText(`$${net.toFixed(2)} USD`, { exact: true })).toBeVisible();
          await page.getByRole("button", { name: kind === "free" ? "Confirm Free Booking" : "Pay your way", exact: true }).click();
          await expect.poll(() => evidence.calls.filter(call => call.path === "/api/payment/start" && call !== first && call.response).length).toBe(1);
          const revised = evidence.calls.filter(call => call.path === "/api/payment/start" && call !== first).at(-1);
          expect(revised).toMatchObject({ response: { status: 200 }, body: { provider: kind === "free" ? "free" : "dodo",
            bookingPayload: { couponCode: code, slotHoldId: holdId, slotHoldToken: evidence.cancelled.hold.holdToken } } });
          expect(revised.data.quote).toMatchObject({ grossAmount: 54.95, netAmount: net });
          evidence.snapshots.revised = await native.snapshot();
          const after = await native.state();
          if (kind === "paid") {
            await expect(page.getByRole("heading", { name: "Fixture Dodo test checkout", exact: true })).toBeVisible();
            expect(evidence.handoffs).toHaveLength(1);
            expect(evidence.handoffs[0].url).toBe(revised.data.providerPayload.checkoutUrl);
            expect(liveClaims(evidence.snapshots.revised, holdId)).toHaveLength(1);
            expect(after.bookings.length).toBe(evidence.beforeState.bookings.length);
          } else {
            await expect(page).toHaveURL(/\/thank-you$/);
            await expect(page.getByRole("heading", { name: "Thank You!", exact: true })).toBeVisible();
            expect(after.bookings.length).toBe(evidence.beforeState.bookings.length + 1);
            expect(after.bookings.find(booking => booking._id === revised.data.bookingId)).toMatchObject({ paymentProvider: "free", netAmount: 0, couponCode: code });
            expect(liveClaims(evidence.snapshots.revised, holdId)).toHaveLength(0);
          }
          expect(after.earnings.total).toBe(evidence.beforeState.earnings.total);
        } finally {
          release();
          evidence.finalNative = await native.snapshot();
          evidence.finalState = await native.state();
          evidence.finalClient = await clientState(page);
          await testInfo.attach("claimed-start-complete", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
          await testInfo.attach("claimed-start-final-page", { body: await page.screenshot(), contentType: "image/png" });
          soft(evidence.pageErrors).toEqual([]);
          soft(evidence.aborted).toEqual([]);
        }
      });
  }
});
