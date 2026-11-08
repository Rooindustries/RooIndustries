const { evaluateBrowserTask } = require("./fixtures/browser-task.cjs");
const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

const providers = {
  dodo: { enabled: true, mode: "test" },
  razorpay: { enabled: true, mode: "test" },
  paypal: { enabled: false, mode: "disabled" },
};

test("while one payment method is starting checkout, another can't start a second one", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    if (route.request().postDataJSON()?.recoverOnly) return route.fallback();
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    await gate;
    await route.fallback();
  });

  await flow.review();
  await flow.payment();
  const razorpay = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
  await expect(razorpay).toBeEnabled();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);
  await expect(razorpay).toBeDisabled();
  await razorpay.click({ force: true });
  await page.waitForTimeout(500);
  expect(starts).toHaveLength(1);

  release();
  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(starts).toHaveLength(1);
});

test("a coupon edit shares the pending start and keeps the original checkout", async ({ page, flow }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    if (route.request().postDataJSON()?.recoverOnly) return route.fallback();
    starts.push(route.request().postDataJSON());
    await gate;
    await route.fallback();
  });
  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);
  const coupon = page.locator("#payment-coupon-code");
  await coupon.fill("save20");
  await coupon.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  release();
  await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeVisible();
  expect(starts).toHaveLength(1);
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem("payment_session_state")));
  expect(saved.provider).toBe("dodo");
  expect(JSON.parse(saved.fingerprint).couponCode).toBe("");
  await expect(page).toHaveURL(/\/payment$/);
});

for (const status of ["started", "captured_client", "needs_recovery"]) {
  test(`a saved ${status} checkout uses its status without restarting`, async ({ page, flow, baseURL }) => {
    let starts = 0;
    let finalizes = 0;
    await page.route("**/api/payment/start", route => {
      starts++;
      return route.fulfill({ json: { ok: true, status: "started", provider: "dodo",
        paymentAccessToken: "saved-payment", quoteFingerprint: "locked-quote",
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        sessionExpiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
        providerPayload: { orderId: "saved-order", checkoutUrl: `${baseURL}/__test/checkout-handoff` },
      } });
    });
    await page.route("**/api/payment/status", route => route.fulfill({ json: { ok: true, status } }));
    await page.route("**/api/payment/finalize", route => {
      finalizes++;
      return route.fulfill({ json: { ok: true, status: "booked", bookingId: "fixture-booking",
        bookingSummary: { bookingId: "fixture-booking", packageTitle: "Performance Vertex Overhaul",
          startTimeUTC: new Date(Date.now() + 86400000).toISOString(), email: "visitor@example.invalid" },
      } });
    });
    await flow.review();
    await flow.payment();
    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page).toHaveURL(/checkout-handoff$/);
    await page.goBack();
    await page.route("**/api/payment/quote", route => route.fulfill({ status: 409,
      json: { ok: false, error: "The coupon has expired and the price changed." } }));
    await page.reload();
    await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
    await expect(page).toHaveURL(status === "started" ? /checkout-handoff$/ : /payment-success$/);
    expect(starts).toBe(1);
    expect(finalizes).toBe(status === "started" ? 0 : 1);
  });
}

test("a nonpayable saved checkout remains readable after rollback", async ({ page, flow, baseURL }) => {
  await page.route("**/api/payment/start", route => route.fulfill({ json: {
    ok: true, status: "started", provider: "dodo", paymentAccessToken: "saved-payment",
    quoteFingerprint: "locked-quote", quote: { grossAmount: 84.99, netAmount: 84.99 },
    sessionExpiresAt: new Date(Date.now() - 1000).toISOString(),
    providerPayload: { orderId: "saved-order", checkoutUrl: `${baseURL}/__test/checkout-handoff` },
  } }));
  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const parsed = JSON.parse(sessionStorage.getItem("payment_session_state"));
    return Boolean(parsed?.paymentAccessToken && parsed.provider && parsed.fingerprint && parsed.providerPayload);
  })).toBe(true);
  const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem("payment_session_state")));
  expect(session.providerPayload).toEqual({});
  expect(session.result.checkoutState).toBe("start_again");
  await page.reload();
  await expect(page.getByRole("button", { name: "Start again", exact: true })).toBeVisible();
});

const paypalSdkStub = `
window.paypal = {
  version: "5.0.0",
  Buttons(options) {
    return {
      isEligible: () => true,
      render(container) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Fixture PayPal";
        button.addEventListener("click", async () => {
          const result = await options.onClick({}, { resolve: () => "resolved", reject: () => "rejected" });
          window.__paypalClickResult = result;
          if (result === "resolved") window.__paypalCreateOrder = () => options.createOrder({}, {});
        });
        this.button = button;
        container.appendChild(button);
        return Promise.resolve();
      },
      close() { this.button?.remove(); return Promise.resolve(); },
      updateProps: () => Promise.resolve(),
    };
  },
};
`;

test("a PayPal order created after another method started checkout is refused", async ({ page, flow }) => {
  const withPaypal = { ...providers, paypal: { enabled: true, mode: "sandbox", clientId: "fixture-client" } };
  await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, route => route.fulfill({
    contentType: "application/javascript", body: paypalSdkStub,
  }));
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers: withPaypal } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers: withPaypal,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    if (route.request().postDataJSON()?.recoverOnly) return route.fallback();
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    await gate;
    await route.fallback();
  });

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Fixture PayPal", exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.__paypalCreateOrder)).toBe("function");
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);

  const created = await evaluateBrowserTask(page, () => window.__paypalCreateOrder().then(() => "created", error => String(error?.message || error)));
  expect(created).toContain("Another payment method is still starting");
  expect(starts).toHaveLength(1);

  release();
  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(starts).toHaveLength(1);
});

test("clicking PayPal while another method is starting checkout is refused", async ({ page, flow }) => {
  const withPaypal = { ...providers, paypal: { enabled: true, mode: "sandbox", clientId: "fixture-client" } };
  await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, route => route.fulfill({
    contentType: "application/javascript", body: paypalSdkStub,
  }));
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers: withPaypal } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers: withPaypal,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    if (route.request().postDataJSON()?.recoverOnly) return route.fallback();
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    await gate;
    await route.fallback();
  });

  await flow.review();
  await flow.payment();
  await expect(page.getByRole("button", { name: "Fixture PayPal", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);

  await page.getByRole("button", { name: "Fixture PayPal", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__paypalClickResult)).toBe("rejected");
  expect(await page.evaluate(() => typeof window.__paypalCreateOrder)).toBe("undefined");
  expect(starts).toEqual(["dodo"]);

  release();
  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(starts).toEqual(["dodo"]);
});

test("while Razorpay is starting checkout, Pay your way can't start a second one", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() { window.__razorpayOpened = (window.__razorpayOpened || 0) + 1; }, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    if (route.request().postDataJSON()?.recoverOnly) return route.fallback();
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    await gate;
    await route.fallback();
  });

  await flow.review();
  await flow.payment();
  const dodo = page.getByRole("button", { name: "Pay your way", exact: true });
  const razorpay = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
  await expect(dodo).toBeEnabled();
  await expect(razorpay).toBeEnabled();
  await razorpay.click();
  await expect.poll(() => starts.length).toBe(1);
  await expect(dodo).toBeDisabled();
  await dodo.click({ force: true });
  await page.waitForTimeout(500);
  expect(starts).toEqual(["razorpay"]);

  release();
  await page.waitForTimeout(500);
  expect(starts).toEqual(["razorpay"]);
  await expect(page).not.toHaveURL(/checkout-handoff$/);
});

test("a free booking can't be confirmed while a paid checkout is starting", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/ref/validateCoupon?code=free100*", route => route.fulfill({
    json: { ok: true, coupon: { code: "free100", discountType: "percent", discountPercent: 100, canCombineWithReferral: true } },
  }));
  await page.route("**/api/payment/quote", route => {
    const free = route.request().postDataJSON()?.couponCode === "free100";
    return route.fulfill({ json: {
      ok: true, quoteFingerprint: free ? "fixture-quote-free" : "fixture-quote", providers,
      quote: { grossAmount: 84.99, netAmount: free ? 0 : 84.99, isFree: free },
    } });
  });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    if (route.request().postDataJSON()?.recoverOnly) return route.fallback();
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    await gate;
    await route.fallback();
  });

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);

  const coupon = page.locator("#payment-coupon-code");
  await coupon.fill("free100");
  await coupon.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  const confirmFree = page.getByRole("button", { name: "Confirm Free Booking", exact: true });
  await expect(confirmFree).toBeVisible();
  await expect(confirmFree).toBeDisabled();
  await confirmFree.click({ force: true });
  await page.waitForTimeout(500);
  expect(starts).toEqual(["dodo"]);

  release();
  await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeEnabled();
  await expect(confirmFree).toHaveCount(0);
  await expect(page).toHaveURL(/\/payment$/);
  expect(starts).toEqual(["dodo"]);
  expect((await page.evaluate(() => JSON.parse(sessionStorage.getItem("payment_session_state")))).provider).toBe("dodo");
});

test.describe("checkout start recovery", () => {
  test.use({ actionTimeout: 10000, navigationTimeout: 20000 });
  test.skip(!process.env.PG_BIN || !process.env.POSTGREST_BIN, "Needs the native PostgreSQL fixture.");

  const routeNative = async (context, native, flow, provider = "dodo") => {
    await native.restoreClock();
    await native.setPaymentProvider(provider);
    await native.setPaymentStatus(null);
    const date = await native.nextSlotDate();
    flow.state.slots = [{ date, times: ["10:00", "11:00"] }];
    await context.route(/\/api\/(holdSlot|releaseHold|payment\/(quote|start|cancel|status|finalize))(?:\?|$)/, async route => {
      const request = route.request();
      const response = await native.post(new URL(request.url()).pathname,
        request.postDataJSON(), request.headers().authorization);
      await route.fulfill({ status: response.status, json: response.body });
    });
    await context.route("https://test.checkout.dodopayments.com/session/**", route => route.fulfill({
      contentType: "text/html", body: "<h1>Reserved checkout</h1>",
    }));
    await context.route("**/api/payment/providers", async route => {
      const response = await native.get("/api/payment/providers");
      await route.fulfill({ status: response.status, json: response.body });
    });
    await context.route("**/api/ref/validateCoupon?**", async route => {
      const url = new URL(route.request().url());
      const response = await native.get(url.pathname + url.search);
      await route.fulfill({ status: response.status, json: response.body });
    });
  };
  const saved = page => page.evaluate(() => ({
    session: JSON.parse(sessionStorage.getItem("payment_session_state")),
    booking: JSON.parse(sessionStorage.getItem("checkout_booking_state")),
  }));
  const changeCoupon = async page => {
    const input = page.locator("#payment-coupon-code");
    await input.fill("save20");
    await input.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
  };

  test("a recovered upgrade order reopens and confirms the same payment",
    async ({ page, context, flow, bookingNative }) => {
      await routeNative(context, bookingNative, flow, "razorpay");
      await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
        contentType: "application/javascript",
        body: "window.Razorpay = function (options) { return { open() { window.__checkout = options; }, on() {} }; };",
      }));
      const booking = await bookingNative.createUpgrade();
      await page.goto("/booking");
      await page.evaluate(value => sessionStorage.setItem("checkout_booking_state", JSON.stringify(value)), booking);
      await bookingNative.loseOrderResponse();
      await page.goto("/payment");
      const pay = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
      await pay.click();
      await expect.poll(async () => (await bookingNative.evidence()).http
        .some(call => call.path === "/api/payment/start" && call.status >= 500)).toBe(true);
      await expect(pay).toBeEnabled();
      await bookingNative.advanceClock(60_000);
      expect((await bookingNative.reconcile()).status).toBe(200);
      await pay.click();
      await expect.poll(() => page.evaluate(() => window.__checkout?.order_id)).toMatch(/^order_fixture_/);
      const session = (await saved(page)).session;
      expect(session.result.checkoutRecovery.kind).toBe("upgrade");
      expect(session.result.checkoutState).toBe("resumable");
      await page.reload();
      await pay.click();
      await expect.poll(() => page.evaluate(() => window.__checkout?.order_id)).toBe(session.providerPayload.orderId);
      await bookingNative.setPaymentStatus("captured");
      const orderId = session.providerPayload.orderId;
      const paymentId = `payment_${orderId}`;
      const signature = require("node:crypto").createHmac("sha256", "fixture-secret")
        .update(`${orderId}|${paymentId}`).digest("hex");
      await page.evaluate(proof => window.__checkout.handler(proof), {
        razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature,
      });
      await expect(page).toHaveURL(/\/payment-success$/);
      const finalized = (await bookingNative.evidence()).http.filter(call => call.path === "/api/payment/finalize").at(-1);
      expect(finalized.response.status).toMatch(/^(booked|email_partial)$/);
      expect(finalized.response.manualReviewRequired).not.toBe(true);
      await bookingNative.reconcile();
      const status = await bookingNative.post("/api/payment/status", {}, `Bearer ${session.paymentAccessToken}`);
      expect(status.body.status).toMatch(/^(booked|email_partial)$/);
    });

  for (const mode of ["pay", "empty", "expired"]) {
    test(`a recovered Razorpay creation ${mode === "expired" ? "keeps its lock while the provider order is live" :
      mode === "empty" ? "refreshes an empty saved checkout" : "can finish payment"}`,
      async ({ page, context, flow, bookingNative }, testInfo) => {
        await routeNative(context, bookingNative, flow, "razorpay");
        const requestOffset = (await bookingNative.evidence()).providerRequests.length;
        await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
          contentType: "application/javascript",
          body: "window.Razorpay = function (options) { return { open() { window.__checkout = options; }, on() {} }; };",
        }));
        await bookingNative.loseOrderResponse();
        await flow.review();
        await flow.payment();
        const pay = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
        await pay.click();
        await expect.poll(async () => (await bookingNative.evidence()).http
          .some(call => call.path === "/api/payment/start" && call.status >= 500)).toBe(true);
        await expect(pay).toBeEnabled();
        await bookingNative.advanceClock(60_000);
        const reconciled = await bookingNative.reconcile();
        expect(reconciled.status).toBe(200);
        const evidence = await bookingNative.evidence();
        const requests = evidence.providerRequests.slice(requestOffset);
        const order = requests.find(call => call.path === "/v1/orders" && call.method === "POST");
        const orderId = requests.find(call => /^\/v1\/orders\/[^/]+\/payments$/.test(call.path))
          .path.split("/")[3];
        if (mode === "expired") await bookingNative.expirePayment(orderId);
        await pay.click();
        if (mode === "empty") {
          await expect.poll(() => page.evaluate(() => window.__checkout?.order_id)).toBe(orderId);
          await page.evaluate(() => {
            const session = JSON.parse(sessionStorage.getItem("payment_session_state"));
            session.providerPayload = {};
            session.result.providerPayload = {};
            sessionStorage.setItem("payment_session_state", JSON.stringify(session));
          });
          await page.reload();
          await pay.click();
        }
        if (mode === "expired") {
          await expect(page.getByRole("button", { name: "Start again", exact: true })).toBeVisible();
          const session = (await saved(page)).session;
          expect(session.providerPayload).toEqual({});
          expect(session.result.checkoutState).toBe("start_again");
          expect(await page.evaluate(() => Boolean(window.__checkout))).toBe(false);
          await page.screenshot({ path: testInfo.outputPath("start-again.png") });
          await page.getByRole("button", { name: "Start again", exact: true }).click();
          await expect(page.getByText("This checkout can still accept payment. Continue with the existing checkout.",
            { exact: true })).toBeVisible();
          await expect(pay).toBeDisabled();
          expect((await bookingNative.evidence()).providerRequests.slice(requestOffset)
            .filter(call => call.path === "/v1/orders" && call.method === "POST")).toHaveLength(1);
          return;
        }
        await expect.poll(() => page.evaluate(() => window.__checkout?.order_id)).toBe(orderId);
        await page.screenshot({ path: testInfo.outputPath("resumed-checkout.png") });
        expect((await saved(page)).session.providerPayload.amount).toBe(order.body.amount);
        await page.reload();
        await pay.click();
        await expect.poll(() => page.evaluate(() => window.__checkout?.order_id)).toBe(orderId);
        await bookingNative.setPaymentStatus("captured");
        const paymentId = `payment_${orderId}`;
        const signature = require("node:crypto").createHmac("sha256", "fixture-secret")
          .update(`${orderId}|${paymentId}`).digest("hex");
        await page.evaluate(proof => window.__checkout.handler(proof), {
          razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature,
        });
        await expect(page).toHaveURL(/\/payment-success$/);
        const completed = await bookingNative.evidence();
        expect(completed.http.filter(call => call.path === "/api/payment/finalize").at(-1).response.status)
          .toMatch(/^(booked|email_partial)$/);
        expect(completed.providerRequests.slice(requestOffset)
          .filter(call => call.path === "/v1/orders" && call.method === "POST")).toHaveLength(1);
      });
  }

  for (const changed of [false, true]) {
    test(`a lost start response recovers the original checkout after ${changed ? "changing" : "keeping"} codes`,
      async ({ page, context, flow, bookingNative }, testInfo) => {
        await routeNative(context, bookingNative, flow);
        if (changed) await bookingNative.createCoupon("save20");
        const before = (await bookingNative.evidence()).providerRequests.filter(call =>
          call.method === "POST" && call.path === "/checkouts").length;
        let first;
        let reserved;
        const lostResponse = new Promise(resolve => { reserved = resolve; });
        await page.route("**/api/payment/start", async route => {
    if (route.request().postDataJSON()?.recoverOnly) return route.fallback();
          if (first) return route.fallback();
          const request = route.request();
          first = await bookingNative.post("/api/payment/start", request.postDataJSON());
          expect(first.status).toBe(200);
          await route.abort("failed");
          reserved();
        });
        await flow.review();
        await flow.payment();
        await page.getByRole("button", { name: "Pay your way", exact: true }).click();
        await lostResponse;
        await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
        expect((await saved(page)).session).toBeNull();
        if (changed) await changeCoupon(page);
        await page.getByRole("button", { name: "Pay your way", exact: true }).click();
        if (changed) {
          await expect(page.getByText(/already started with its original price and codes/)).toBeVisible();
          const recovered = await saved(page);
          expect(recovered.session.providerPayload.orderId).toBe(first.body.providerPayload.orderId);
          expect(recovered.session.result.quote.netAmount).toBe(first.body.quote.netAmount);
          expect(JSON.parse(recovered.session.fingerprint).couponCode).toBe("");
          await expect(page.locator("#payment-coupon-code")).toHaveValue("");
          await expect(page.getByText("$54.95 USD", { exact: true })).toBeVisible();
          await page.screenshot({ path: testInfo.outputPath("recovered-checkout-desktop.png") });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.screenshot({ path: testInfo.outputPath("recovered-checkout-phone.png") });
          await page.reload();
          await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
        }
        await expect(page.getByRole("heading", { name: "Reserved checkout", exact: true })).toBeVisible();
        const evidence = await bookingNative.evidence();
        expect(evidence.providerRequests.filter(call => call.method === "POST" && call.path === "/checkouts"))
          .toHaveLength(before + 1);
        const starts = evidence.http.filter(call => call.path === "/api/payment/start");
        expect(starts.slice(-2).every(call => call.response.providerPayload.orderId === first.body.providerPayload.orderId))
          .toBe(true);
        await testInfo.attach("checkout-recovery", { body: JSON.stringify({ first, starts }), contentType: "application/json" });
      });
  }

  for (const provider of ["paypal", "razorpay"]) {
    for (const lost of [true, false]) {
      test(`a ${lost ? "lost" : "late"} ${provider} start stays usable after a free coupon`,
        async ({ page, context, flow, bookingNative }, testInfo) => {
          await routeNative(context, bookingNative, flow, provider);
          await bookingNative.createCoupon("free100", 100);
          const orderPath = provider === "paypal" ? "/v2/checkout/orders" : "/v1/orders";
          const before = (await bookingNative.evidence()).providerRequests.filter(call =>
            call.method === "POST" && call.path === orderPath).length;
          await page.route("**/api/ref/validateCoupon?code=free100*", route => route.fulfill({ json: {
            ok: true, coupon: { code: "free100", discountType: "percent", discountPercent: 100,
              canCombineWithReferral: true },
          } }));
          await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, route => route.fulfill({
            contentType: "application/javascript", body: paypalSdkStub,
          }));
          await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
            contentType: "application/javascript",
            body: "window.Razorpay = function (options) { return { " +
              "open() { window.__razorpayOrder = options.order_id; }, on() {} }; };",
          }));
          let first;
          let intercepted = false;
          let release;
          const gate = new Promise(resolve => { release = resolve; });
          await page.route("**/api/payment/start", async route => {
    if (route.request().postDataJSON()?.recoverOnly) return route.fallback();
            if (intercepted) return route.fallback();
            intercepted = true;
            first = await bookingNative.post("/api/payment/start", route.request().postDataJSON());
            if (lost) return route.abort("failed");
            await gate;
            await route.fulfill({ status: first.status, json: first.body });
          });
          const start = async () => {
            if (provider === "razorpay") {
              await page.getByRole("button", { name: "Pay with Razorpay", exact: true }).click();
              return;
            }
            await page.getByRole("button", { name: "Fixture PayPal", exact: true }).click();
            await expect.poll(() => page.evaluate(() => typeof window.__paypalCreateOrder)).toBe("function");
            await page.evaluate(() => {
              window.__paypalOrder = "";
              window.__paypalCreateOrder().then(order => { window.__paypalOrder = order; },
                () => { window.__paypalOrder = "failed"; });
            });
          };
          await flow.review();
          await flow.payment();
          await start();
          await expect.poll(() => first?.status).toBe(200);
          if (lost) await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
          const input = page.locator("#payment-coupon-code");
          await input.fill("free100");
          await input.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
          const confirm = page.getByRole("button", { name: "Confirm Free Booking", exact: true });
          await expect(confirm).toBeVisible();
          await page.screenshot({ path: testInfo.outputPath("free-quote.png") });
          if (lost) await confirm.click();
          else release();
          await expect(page.getByText(/already started with its original price and codes/)).toBeVisible();
          await expect.poll(async () => (await saved(page)).session?.providerPayload?.orderId)
            .toBe(first.body.providerPayload.orderId);
          expect((await saved(page)).session.result.quote.netAmount).toBe(first.body.quote.netAmount);
          await expect(input).toHaveValue("");
          await expect(page.getByText("$54.95 USD", { exact: true })).toBeVisible();
          await start();
          const orderKey = provider === "paypal" ? "__paypalOrder" : "__razorpayOrder";
          await expect.poll(() => page.evaluate(key => window[key], orderKey)).toBe(first.body.providerPayload.orderId);
          await page.screenshot({ path: testInfo.outputPath("recovered-paid-checkout.png") });
          await page.reload();
          await start();
          await expect.poll(() => page.evaluate(key => window[key], orderKey)).toBe(first.body.providerPayload.orderId);
          const evidence = await bookingNative.evidence();
          expect(evidence.providerRequests.filter(call => call.method === "POST" && call.path === orderPath))
            .toHaveLength(before + 1);
        });
    }
  }

  test("a late start is saved after a coupon changes and survives Back, Forward and a second tab",
    async ({ page, context, flow, bookingNative }) => {
      await routeNative(context, bookingNative, flow);
      let release;
      let first;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route("**/api/payment/start", async route => {
    if (route.request().postDataJSON()?.recoverOnly) return route.fallback();
        first = await bookingNative.post("/api/payment/start", route.request().postDataJSON());
        await gate;
        await route.fulfill({ status: first.status, json: first.body });
      });
      await bookingNative.createCoupon("save20");
      await flow.review();
      await flow.payment();
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect.poll(() => first?.status).toBe(200);
      await changeCoupon(page);
      release();
      await expect.poll(async () => (await saved(page)).session?.providerPayload?.orderId)
        .toBe(first.body.providerPayload.orderId);
      await expect(page).toHaveURL(/payment/);
      await expect(page.getByText(/already started with its original price and codes/)).toBeVisible();
      await page.goBack();
      await expect(page).not.toHaveURL(/\/payment$/);
      await expect(page.getByRole("button", { name: "Return to payment", exact: true })).toBeVisible();
      await page.goForward();
      await expect(page).toHaveURL(/\/payment$/);
      await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
      const checkout = await saved(page);
      const second = await context.newPage();
      try {
        await second.goto("/booking");
        await second.evaluate(value => {
          sessionStorage.setItem("checkout_booking_state", JSON.stringify(value.booking));
        }, checkout);
        await second.goto("/payment");
        await second.getByRole("button", { name: "Pay your way", exact: true }).click();
        await expect(second.getByRole("heading", { name: "Reserved checkout", exact: true })).toBeVisible();
        await second.goBack();
        await expect(second.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
        expect((await saved(second)).session.providerPayload.orderId).toBe(first.body.providerPayload.orderId);
      } finally { await second.close(); }
    });

  test("another tab cannot release a checkout that still accepts payment", async ({ page, context, flow, bookingNative }) => {
    await routeNative(context, bookingNative, flow);
    const ordersBefore = (await bookingNative.evidence()).providerRequests.filter(call =>
      call.method === "POST" && call.path === "/checkouts").length;
    await flow.review();
    await flow.payment();
    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Reserved checkout", exact: true })).toBeVisible();
    await page.goBack();
    const checkout = await saved(page);
    const second = await context.newPage();
    try {
      await second.goto("/booking");
      await second.evaluate(value => sessionStorage.setItem("checkout_booking_state", JSON.stringify(value)), checkout.booking);
      await second.goto("/payment");
      await second.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect(second.getByRole("heading", { name: "Reserved checkout", exact: true })).toBeVisible();
      await second.goBack();
      await expect(second.getByRole("button", { name: "Resume checkout", exact: true })).toBeEnabled();
      const released = await bookingNative.post("/api/payment/cancel", {},
        "Bearer " + (await saved(second)).session.paymentAccessToken);
      expect(released.status).toBe(409);
      expect(released.body.code).toBe("provider_checkout_live");
      const restarted = await bookingNative.post("/api/payment/start", {
        provider: "razorpay", bookingPayload: checkout.booking, quoteFingerprint: "replacement" });
      expect(restarted.status).toBe(200);
      expect(restarted.body.providerPayload.orderId).toBe(checkout.session.providerPayload.orderId);
      await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Reserved checkout", exact: true })).toBeVisible();
      expect((await bookingNative.evidence()).providerRequests.filter(call =>
        call.method === "POST" && call.path === "/checkouts")).toHaveLength(ordersBefore + 1);
    } finally { await second.close(); }
  });

  for (const provider of ["dodo", "razorpay"]) {
  test(`a captured ${provider} lost start goes straight to confirmation on reload`, async ({ page, context, flow, bookingNative }) => {
    await routeNative(context, bookingNative, flow, provider);
    if (provider === "razorpay") await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
      contentType: "application/javascript", body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
    }));
    await flow.review();
    await flow.payment();
    await page.route("**/api/payment/start", async route => {
      if (route.request().postDataJSON()?.recoverOnly) return route.fallback();
      const response = await bookingNative.post("/api/payment/start", route.request().postDataJSON());
      expect(response.status).toBe(200);
      await bookingNative.setPaymentStatus(provider === "razorpay" ? "captured" : "succeeded");
      await route.abort("failed");
    });
    await page.getByRole("button", { name: provider === "razorpay" ? "Pay with Razorpay" : "Pay your way", exact: true }).click();
    await expect(page.getByText("Failed to fetch", { exact: false })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/payment-success$/);
    expect((await bookingNative.evidence()).http.some(call => call.path === "/api/payment/finalize")).toBe(true);
  });

  }

  test("a provider outage during recovery is visible and reported", async ({ page, context, flow, bookingNative }) => {
    await routeNative(context, bookingNative, flow);
    await page.route("**/api/payment/start", async route => {
      if (route.request().postDataJSON()?.recoverOnly) return route.fallback();
      const result = await bookingNative.post("/api/payment/start", route.request().postDataJSON());
      expect(result.status).toBe(200);
      await route.abort("failed");
    });
    await flow.review();
    await flow.payment();
    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page.getByText("Failed to fetch", { exact: false })).toBeVisible();
    await bookingNative.setProviderOutage(true);
    try {
      await page.reload();
      await expect(page.getByText("The payment provider could not confirm checkout. Please try again.", { exact: true }))
        .toBeVisible();
      const calls = (await bookingNative.evidence()).http.filter(call => call.path === "/api/payment/start");
      expect(calls.at(-1).status).toBe(503);
      expect(calls.at(-1).response.code).toBe("provider_checkout_unavailable");
    } finally { await bookingNative.setProviderOutage(false); }
  });

  for (const free of [false, true]) {
    test(free ? "a completed free upgrade needs no new quote on reload"
      : "a live upgrade survives its expired start authorization", async ({ page, context, flow, bookingNative }) => {
      await routeNative(context, bookingNative, flow);
      if (free) await bookingNative.createCoupon("free-recovery", 100);
      const booking = { ...await bookingNative.createUpgrade(), ...(free ? { couponCode: "free-recovery" } : {}) };
      let started;
      await page.route("**/api/payment/start", async route => {
        if (route.request().postDataJSON()?.recoverOnly) {
          if (!free) return route.fallback();
          const recovered = await bookingNative.post("/api/payment/start", route.request().postDataJSON());
          await expect(page.getByRole("button", { name: "Remove coupon", exact: true })).toBeAttached();
          return route.fulfill({ status: recovered.status, json: recovered.body });
        }
        started = await bookingNative.post("/api/payment/start", route.request().postDataJSON());
        await route.abort("failed");
      });
      await page.goto("/booking");
      await page.evaluate(value => sessionStorage.setItem("checkout_booking_state", JSON.stringify(value)), booking);
      await page.goto("/payment");
      await page.getByRole("button", { name: free ? "Confirm Free Booking" : "Pay your way", exact: true }).click();
      await expect.poll(() => started?.status).toBe(200);
      await expect(page.getByText("Failed to fetch", { exact: false })).toBeVisible();
      if (!free) await bookingNative.advanceClock(16 * 60_000);
      let quotes = 0;
      await page.route("**/api/payment/quote", async route => { quotes++; await route.fallback(); });
      try {
        await page.reload();
        if (free) {
          expect(started.body.status).toMatch(/^(booked|email_partial)$/);
          await expect(page).toHaveURL(/thank-you$/);
        } else {
          await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeEnabled();
          expect((await saved(page)).session.providerPayload.orderId).toBe(started.body.providerPayload.orderId);
          await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
          await expect(page.getByRole("heading", { name: "Reserved checkout", exact: true })).toBeVisible();
        }
        expect(quotes).toBe(0);
      } finally { await bookingNative.restoreClock(); }
    });
  }

  test("a lost start refreshes the hold before the browser leaves payment", async ({ page, context, flow, bookingNative }) => {
    await routeNative(context, bookingNative, flow);
    await page.clock.install();
    let started;
    await page.route("**/api/payment/start", async route => {
      if (route.request().postDataJSON()?.recoverOnly) return route.fallback();
      started = await bookingNative.post("/api/payment/start", route.request().postDataJSON());
      await route.abort("failed");
    });
    await flow.review();
    await flow.payment();
    const before = (await saved(page)).booking.slotHoldExpiresAt;
    const advance = Math.max(0, Date.parse(before) - await page.evaluate(() => Date.now()) - 30_000);
    await bookingNative.advanceClock(advance);
    await page.clock.fastForward(advance);
    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect.poll(() => started?.status).toBe(200);
    await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
    await page.clock.fastForward(Math.max(1, Date.parse(before) - await page.evaluate(() => Date.now()) + 100));
    await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeEnabled();
    await expect(page).toHaveURL(/payment$/);
    expect((await saved(page)).booking.slotHoldExpiresAt).toBe(started.body.refreshedHold.slotHoldExpiresAt);
    await bookingNative.restoreClock();
  });

});
