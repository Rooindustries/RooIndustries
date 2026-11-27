const { evaluateBrowserTask } = require("./fixtures/browser-task.cjs");
const {
  test, expect, analyticsWaitLimitMs, recordCheckoutTimes, checkoutTimes, withinAnalyticsWait,
} = require("./fixtures/booking-flow.cjs");
const { holdChunks, holdRoute } = require("./fixtures/held-routes.cjs");

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

test("coupon and referral changes stay locked while a paid checkout is starting", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => {
    const couponCode = route.request().postDataJSON()?.couponCode || "";
    const discount = couponCode === "save20" ? 17 : couponCode === "save10" ? 8.5 : 0;
    return route.fulfill({ json: {
      ok: true, quoteFingerprint: `fixture-quote-${couponCode || "none"}`, providers,
      quote: { grossAmount: 84.99, netAmount: Number((84.99 - discount).toFixed(2)), isFree: false },
    } });
  });
  await page.route("**/api/ref/validateCoupon?code=save10*", route => route.fulfill({
    json: { ok: true, coupon: { code: "save10", discountType: "percent", discountPercent: 10, canCombineWithReferral: true } },
  }));
  let releaseCoupon;
  const couponGate = new Promise(resolve => { releaseCoupon = resolve; });
  await page.route("**/api/ref/validateCoupon?code=save20*", async route => {
    await couponGate;
    return route.fulfill({
      json: { ok: true, coupon: { code: "save20", discountType: "percent", discountPercent: 20, canCombineWithReferral: true } },
    });
  });
  let releaseStart;
  const startGate = new Promise(resolve => { releaseStart = resolve; });
  let claimedQuote = "";
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    const body = route.request().postDataJSON();
    starts.push({ provider: body?.provider || "unknown", quoteFingerprint: body?.quoteFingerprint || "" });
    if (claimedQuote && body?.quoteFingerprint !== claimedQuote) {
      return route.fulfill({ status: 409, json: { ok: false, code: "payment_quote_already_claimed", error: "This reservation is already bound to a different quote." } });
    }
    claimedQuote = body?.quoteFingerprint || "";
    await startGate;
    await route.fallback();
  });

  await flow.review();
  await flow.payment();
  const coupon = page.locator("#payment-coupon-code");
  const couponApply = coupon.locator("..").getByRole("button", { name: /^(Apply|Checking\.\.\.)$/ });
  const referral = page.locator("#payment-referral-code");
  const referralApply = referral.locator("..").getByRole("button", { name: "Apply", exact: true });
  await coupon.fill("save10");
  await couponApply.click();
  const removeCoupon = page.getByRole("button", { name: "Remove coupon", exact: true });
  await expect(removeCoupon).toBeVisible();

  await coupon.fill("save20");
  await couponApply.click();
  await expect(coupon.locator("..").getByRole("button", { name: "Checking..." })).toBeVisible();

  const razorpay = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
  await expect(razorpay).toBeEnabled();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);

  await expect(coupon).toBeDisabled();
  await expect(couponApply).toBeDisabled();
  await expect(removeCoupon).toBeDisabled();
  await expect(referral).toBeDisabled();
  await expect(referralApply).toBeDisabled();
  await expect(razorpay).toBeDisabled();
  await removeCoupon.click({ force: true });
  await razorpay.click({ force: true });

  releaseCoupon();
  await expect(coupon.locator("..").getByRole("button", { name: "Checking..." })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Opening checkout...", exact: true })).toBeDisabled();
  await expect(razorpay).toBeDisabled();
  expect(starts).toEqual([{ provider: "dodo", quoteFingerprint: "fixture-quote-save10" }]);

  releaseStart();
  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(starts).toEqual([{ provider: "dodo", quoteFingerprint: "fixture-quote-save10" }]);
});

test("a failed checkout start re-enables code edits and payment methods for retry", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: `fixture-quote-${route.request().postDataJSON()?.couponCode || "none"}`, providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  await page.route("**/api/ref/validateCoupon?code=save20*", route => route.fulfill({
    json: { ok: true, coupon: { code: "save20", discountType: "percent", discountPercent: 20, canCombineWithReferral: true } },
  }));
  let releaseFirst;
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    const body = route.request().postDataJSON();
    starts.push({ provider: body?.provider || "unknown", quoteFingerprint: body?.quoteFingerprint || "" });
    if (starts.length === 1) {
      await new Promise(resolve => { releaseFirst = resolve; });
      return route.fulfill({ status: 409, json: { ok: false, code: "quote_fingerprint_mismatch", error: "The price changed." } });
    }
    return route.fallback();
  });

  await flow.review();
  await flow.payment();
  const coupon = page.locator("#payment-coupon-code");
  const couponApply = coupon.locator("..").getByRole("button", { name: "Apply", exact: true });
  const razorpay = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
  await expect(razorpay).toBeEnabled();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);
  await expect(coupon).toBeDisabled();
  await expect(couponApply).toBeDisabled();
  await expect(razorpay).toBeDisabled();

  releaseFirst();
  await expect(page.getByText("The price changed. Review the updated total and click again.", { exact: true })).toBeVisible();
  await expect(razorpay).toBeEnabled();
  await expect(coupon).toBeEnabled();
  await expect(couponApply).toBeEnabled();

  await coupon.fill("save20");
  await couponApply.click();
  await expect(page.getByRole("button", { name: "Remove coupon", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(starts).toEqual([
    { provider: "dodo", quoteFingerprint: "fixture-quote-none" },
    { provider: "dodo", quoteFingerprint: "fixture-quote-save20" },
  ]);
});

const payButton = (page) => page.getByRole("button", { name: "Pay your way", exact: true });

const holdSalesAttribution = (page, baseURL) =>
  holdChunks(page, { origin: new URL(baseURL).origin }, (body) => body.includes("first_source"));

test("leaving checkout while sales attribution loads starts no payment", async ({ page, flow, baseURL }) => {
  await recordCheckoutTimes(page);
  const attribution = await holdSalesAttribution(page, baseURL);
  const starts = () => flow.state.calls.filter(({ path }) => path === "/api/payment/start");

  await flow.review();
  await flow.payment();
  await expect.poll(() => attribution.held).toBe(true);
  await payButton(page).evaluate((button) => {
    button.click();
    window.history.back();
  });
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await page.waitForFunction(
    (limit) => performance.now() - window.__checkoutTimes.pressed > limit, analyticsWaitLimitMs);
  attribution.release();
  expect(starts()).toEqual([]);

  await flow.payment();
  await payButton(page).click();
  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(starts()).toHaveLength(1);
});

test("a sales attribution module that never loads holds the payment start back no longer than the wait limit", async ({
  page, flow, baseURL,
}) => {
  await recordCheckoutTimes(page);
  const attribution = await holdSalesAttribution(page, baseURL);
  const starts = () => flow.state.calls.filter(({ path }) => path === "/api/payment/start");

  await flow.review();
  await flow.payment();
  await expect.poll(() => attribution.held).toBe(true);
  const start = await holdRoute(page, "**/api/payment/start", (route) => route.fallback(), { times: 1 });
  await payButton(page).click();
  await expect.poll(() => start.held).toBe(true);
  const { pressed, started } = await checkoutTimes(page);
  withinAnalyticsWait(pressed, started);
  start.release();
  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(starts()).toHaveLength(1);
  expect(starts()[0].body.bookingPayload.salesAttribution).toBeNull();
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
        container.appendChild(button);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
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

test("a free booking can't interrupt a paid checkout start and works once an unclaimed start fails", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  let releaseFree;
  const freeGate = new Promise(resolve => { releaseFree = resolve; });
  let freeCalls = 0;
  await page.route("**/api/ref/validateCoupon?code=free100*", async route => {
    freeCalls += 1;
    if (freeCalls === 1) await freeGate;
    return route.fulfill({
      json: { ok: true, coupon: { code: "free100", discountType: "percent", discountPercent: 100, canCombineWithReferral: true } },
    });
  });
  await page.route("**/api/payment/quote", route => {
    const free = route.request().postDataJSON()?.couponCode === "free100";
    return route.fulfill({ json: {
      ok: true, quoteFingerprint: free ? "fixture-quote-free" : "fixture-quote", providers,
      quote: { grossAmount: 84.99, netAmount: free ? 0 : 84.99, isFree: free },
    } });
  });
  let releaseStart;
  const startGate = new Promise(resolve => { releaseStart = resolve; });
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    await startGate;
    return route.fulfill({ status: 503, json: { ok: false, error: "Temporary checkout outage." } });
  });

  await flow.review();
  await flow.payment();
  const coupon = page.locator("#payment-coupon-code");
  const couponApply = coupon.locator("..").getByRole("button", { name: /^(Apply|Checking\.\.\.)$/ });
  await coupon.fill("free100");
  await couponApply.click();
  await expect(coupon.locator("..").getByRole("button", { name: "Checking..." })).toBeVisible();

  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);
  await expect(coupon).toBeDisabled();
  await expect(couponApply).toBeDisabled();

  releaseFree();
  await expect(coupon.locator("..").getByRole("button", { name: "Checking..." })).toHaveCount(0);
  const confirmFree = page.getByRole("button", { name: "Confirm Free Booking", exact: true });
  await expect(confirmFree).toHaveCount(0);
  expect(starts).toEqual(["dodo"]);

  releaseStart();
  await expect(page.getByText("Temporary checkout outage.", { exact: true })).toBeVisible();
  await expect(coupon).toBeEnabled();
  await couponApply.click();
  await expect(confirmFree).toBeVisible();
  await expect(confirmFree).toBeEnabled();
  await expect(page).toHaveURL(/\/payment$/);
  expect(starts).toEqual(["dodo"]);
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
});

test("after a timed-out start that claimed the quote on the server, retry restores Change payment method so the customer can release and apply a coupon", async ({ page, flow }) => {
  test.setTimeout(60_000);
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/ref/validateCoupon?code=save20*", route => route.fulfill({
    json: { ok: true, coupon: { code: "save20", discountType: "percent", discountPercent: 20, canCombineWithReferral: true } },
  }));
  await page.route("**/api/payment/quote", route => {
    const hasSave20 = route.request().postDataJSON()?.couponCode === "save20";
    return route.fulfill({ json: {
      ok: true, quoteFingerprint: hasSave20 ? "fixture-quote-save20" : "fixture-quote-none", providers,
      quote: {
        grossAmount: 84.99, netAmount: hasSave20 ? 67.99 : 84.99, isFree: false,
        couponDiscountAmount: hasSave20 ? 17 : 0, couponDiscountPercent: hasSave20 ? 20 : 0,
      },
    } });
  });
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  let claimed = false;
  let cancelAuth = "";
  const submitted = [];
  await page.route("**/api/payment/start", async route => {
    const body = route.request().postDataJSON();
    holdId = body.bookingPayload.slotHoldId;
    submitted.push({ token: body.bookingPayload.slotHoldToken, fp: body.quoteFingerprint });
    if (submitted.length === 1) {
      claimed = true;
      await new Promise(resolve => setTimeout(resolve, 16_500));
      return route.fulfill({ status: 200, json: { ok: true } }).catch(() => {});
    }
    if (claimed && body.quoteFingerprint !== "fixture-quote-none") {
      return route.fulfill({
        status: 409,
        json: {
          ok: false,
          code: "payment_quote_already_claimed",
          error: "This reservation is already bound to a different quote.",
          claimedSession: {
            provider: "dodo",
            status: "started",
            paymentAccessToken: "dodo-claimed-pat",
            providerPayload: { orderId: "cks_claimed", checkoutUrl: "/__test/checkout-handoff", taxInclusive: false },
            quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false, couponDiscountAmount: 0, couponDiscountPercent: 0 },
            quoteFingerprint: "fixture-quote-none",
            sessionExpiresAt: expiry,
            refreshedHold: { slotHoldId: holdId, slotHoldToken: "claimed-start-hold-token", slotHoldExpiresAt: expiry, phase: "payment_pending" },
            referralCode: "",
            couponCode: "",
          },
        },
      });
    }
    return route.fulfill({
      status: body.bookingPayload.slotHoldToken === "released-hold-token" ? 200 : 403,
      json: {
        ok: true, status: "started", checkoutCreated: true, paymentAccessToken: "dodo-after-release",
        sessionExpiresAt: expiry, quoteFingerprint: body.quoteFingerprint,
        providerPayload: { orderId: "cks_after_release", checkoutUrl: "/__test/checkout-handoff", taxInclusive: false },
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "after-release-hold-token", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  await page.route("**/api/payment/cancel", route => {
    cancelAuth = route.request().headers().authorization || "";
    claimed = false;
    return route.fulfill({
      json: {
        ok: true, status: "abandoned", cancelled: true, terminalOutcomeComplete: true,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "released-hold-token", slotHoldExpiresAt: expiry, phase: "holding" },
      },
    });
  });

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByText("Checkout timed out. Please try again.", { exact: true })).toBeVisible({ timeout: 20_000 });

  const coupon = page.locator("#payment-coupon-code");
  await coupon.fill("save20");
  await coupon.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("$67.99")).toBeVisible();

  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  const changeMethod = page.getByRole("button", { name: "Change payment method", exact: true });
  await expect(changeMethod).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeVisible();
  await expect(page.getByText("$84.99").first()).toBeVisible();
  await expect(coupon).toHaveValue("");

  await changeMethod.click();
  await expect(page.getByText("Payment method released. Choose a payment method below.")).toBeVisible();
  expect(cancelAuth).toBe("Bearer dodo-claimed-pat");

  await coupon.fill("save20");
  await coupon.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("$67.99")).toBeVisible();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(submitted.at(-1)).toEqual({ token: "released-hold-token", fp: "fixture-quote-save20" });
});

test("after a conflict saves an in-progress Dodo claim with no URL yet, Resume checkout picks up the checkout URL once ready", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/ref/validateCoupon?code=save20*", route => route.fulfill({
    json: { ok: true, coupon: { code: "save20", discountType: "percent", discountPercent: 20, canCombineWithReferral: true } },
  }));
  await page.route("**/api/payment/quote", route => {
    const hasSave20 = route.request().postDataJSON()?.couponCode === "save20";
    return route.fulfill({ json: {
      ok: true, quoteFingerprint: hasSave20 ? "fixture-quote-save20" : "fixture-quote-none", providers,
      quote: {
        grossAmount: 84.99, netAmount: hasSave20 ? 67.99 : 84.99, isFree: false,
        couponDiscountAmount: hasSave20 ? 17 : 0, couponDiscountPercent: hasSave20 ? 20 : 0,
      },
    } });
  });
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let startCount = 0;
  let statusCount = 0;
  await page.route("**/api/payment/start", route => {
    startCount += 1;
    if (startCount === 1) return route.abort("failed");
    const holdId = route.request().postDataJSON().bookingPayload.slotHoldId;
    return route.fulfill({
      status: 409,
      json: {
        ok: false,
        code: "payment_quote_already_claimed",
        error: "This reservation is already bound to a different quote.",
        claimedSession: {
          provider: "dodo",
          status: "started",
          paymentAccessToken: "dodo-creating-pat",
          providerPayload: { orderId: "", checkoutUrl: "", taxInclusive: false },
          quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
          quoteFingerprint: "fixture-quote-none",
          sessionExpiresAt: expiry,
          refreshedHold: { slotHoldId: holdId, slotHoldToken: "creating-hold-token", slotHoldExpiresAt: expiry, phase: "payment_pending" },
          referralCode: "",
          couponCode: "",
        },
      },
    });
  });
  await page.route("**/api/payment/status", route => {
    statusCount += 1;
    if (statusCount === 1) {
      return route.fulfill({ json: { ok: true, status: "started", provider: "dodo" } });
    }
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "dodo",
        providerOrderReady: true,
        quoteFingerprint: "fixture-quote-none",
        quoteFingerprintValid: true,
        quote: { currency: "USD", grossAmount: 84.99, netAmount: 84.99, isFree: false },
        providerPayload: { orderId: "cks_ready", checkoutUrl: "/__test/checkout-handoff", taxInclusive: false },
      },
    });
  });

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /failed|unable|timed out/i })).toBeVisible();

  const coupon = page.locator("#payment-coupon-code");
  await coupon.fill("save20");
  await coupon.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("$67.99")).toBeVisible();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();

  const resume = page.getByRole("button", { name: "Resume checkout", exact: true });
  await expect(resume).toBeVisible();
  await resume.click();
  await expect(page.getByText("Checkout is being recovered. Check the payment status shortly.", { exact: true })).toBeVisible();

  await resume.click();
  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(statusCount).toBe(2);
});

test("after a PayPal claim recovers from ambiguous creation, PayPal retries receive the order ID and Change payment method releases cleanly", async ({ page, flow }) => {
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
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let startCalls = 0;
  let statusCalls = 0;
  let holdId = "";
  await page.route("**/api/payment/start", route => {
    startCalls += 1;
    const body = route.request().postDataJSON();
    holdId = body.bookingPayload.slotHoldId;
    if (startCalls === 1) return route.abort("failed");
    return route.fulfill({
      status: 409,
      json: {
        ok: false,
        code: "payment_provider_already_claimed",
        error: "This reservation already has a payment provider selected.",
        claimedSession: {
          provider: "paypal",
          status: "needs_recovery",
          paymentAccessToken: "paypal-ambig-pat",
          providerPayload: { orderId: "" },
          quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
          quoteFingerprint: "fixture-quote",
          sessionExpiresAt: expiry,
          refreshedHold: { slotHoldId: holdId, slotHoldToken: "paypal-ambig-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
          referralCode: "",
          couponCode: "",
        },
      },
    });
  });
  await page.route("**/api/payment/status", route => {
    statusCalls += 1;
    if (statusCalls === 1) {
      return route.fulfill({ json: { ok: true, status: "needs_recovery", provider: "paypal" } });
    }
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "paypal",
        providerOrderReady: true,
        quoteFingerprint: "fixture-quote",
        quoteFingerprintValid: true,
        quote: { currency: "USD", grossAmount: 84.99, netAmount: 84.99, isFree: false },
        providerPayload: { orderId: "paypal_recovered_1", currency: "USD", amount: 8499 },
      },
    });
  });
  await page.route("**/api/payment/cancel", route => route.fulfill({
    json: {
      ok: true,
      status: "abandoned",
      cancelled: true,
      terminalOutcomeComplete: true,
      refreshedHold: { slotHoldId: holdId, slotHoldToken: "paypal-released-hold", slotHoldExpiresAt: expiry, phase: "holding" },
    },
  }));

  await flow.review();
  await flow.payment();
  const paypalBtn = page.getByRole("button", { name: "Fixture PayPal", exact: true });
  await expect(paypalBtn).toBeVisible();
  await paypalBtn.click();
  await expect.poll(() => page.evaluate(() => typeof window.__paypalCreateOrder)).toBe("function");
  const firstStart = await evaluateBrowserTask(page, () => window.__paypalCreateOrder().then(() => "ok", e => String(e?.message || e)));
  expect(firstStart).toBeTruthy();

  await page.getByRole("button", { name: "Pay with Razorpay", exact: true }).click();
  const changeMethod = page.getByRole("button", { name: "Change payment method", exact: true });
  await expect(changeMethod).toBeVisible();

  await paypalBtn.click();
  const beforeRecover = await evaluateBrowserTask(page, () => window.__paypalCreateOrder().then(id => id, e => String(e?.message || e)));
  expect(beforeRecover).toContain("Checkout is being recovered");

  await paypalBtn.click();
  const afterRecover = await evaluateBrowserTask(page, () => window.__paypalCreateOrder());
  expect(afterRecover).toBe("paypal_recovered_1");

  await changeMethod.click();
  await expect(page.getByText("Payment method released. Choose a payment method below.")).toBeVisible();
});

test("Resume checkout refuses to open a saved Dodo URL when status returns needs_recovery without providerPayload", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      status: 409,
      json: {
        ok: false,
        code: "payment_quote_already_claimed",
        error: "This reservation is already bound to a different quote.",
        claimedSession: {
          provider: "dodo",
          status: "started",
          paymentAccessToken: "dodo-saved-url-pat",
          providerPayload: { orderId: "cs_dodo_failed_1", checkoutUrl: "/__test/checkout-handoff" },
          quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
          quoteFingerprint: "fixture-quote",
          sessionExpiresAt: expiry,
          refreshedHold: { slotHoldId: body.bookingPayload.slotHoldId, slotHoldToken: "dodo-saved-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
          referralCode: "",
          couponCode: "",
        },
      },
    });
  });
  let statusCalls = 0;
  await page.route("**/api/payment/status", route => {
    statusCalls += 1;
    if (statusCalls === 1) {
      return route.fulfill({
        json: {
          ok: true,
          status: "needs_recovery",
          provider: "dodo",
          recoveryReason: "Payment confirmation is taking longer than expected.",
        },
      });
    }
    return route.fulfill({ status: 503, json: { ok: false, error: "Temporary status outage." } });
  });

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  const resumeBtn = page.getByRole("button", { name: "Resume checkout", exact: true });
  await expect(resumeBtn).toBeVisible();

  await resumeBtn.click();
  await expect(page.getByText("Payment confirmation is taking longer than expected.")).toBeVisible();
  await expect(page).toHaveURL(/\/payment$/);

  await resumeBtn.click();
  await expect(page.getByText("Temporary status outage.")).toBeVisible();
  await expect(page).toHaveURL(/\/payment$/);
  expect(statusCalls).toBe(2);
});

test("Resume checkout scrubs a saved Dodo URL on manualReviewRequired, rejects 503, and unlocks once refunded", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      status: 409,
      json: {
        ok: false,
        code: "payment_quote_already_claimed",
        error: "This reservation is already bound to a different quote.",
        claimedSession: {
          provider: "dodo",
          status: "started",
          paymentAccessToken: "dodo-manual-review-pat",
          providerPayload: { orderId: "cs_dodo_upgrade_1", checkoutUrl: "/__test/checkout-handoff", taxInclusive: false },
          quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
          quoteFingerprint: "fixture-quote",
          sessionExpiresAt: expiry,
          refreshedHold: { slotHoldId: body.bookingPayload.slotHoldId, slotHoldToken: "dodo-review-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
          referralCode: "",
          couponCode: "",
        },
      },
    });
  });
  let statusCalls = 0;
  await page.route("**/api/payment/status", route => {
    statusCalls += 1;
    if (statusCalls === 1) {
      return route.fulfill({
        json: {
          ok: true,
          status: "needs_recovery",
          provider: "dodo",
          manualReviewRequired: true,
          recoveryReason: "Your payment was received. Roo Industries will contact you about your upgrade.",
        },
      });
    }
    if (statusCalls === 2) {
      return route.fulfill({ status: 503, json: { ok: false, error: "Temporary status outage." } });
    }
    return route.fulfill({
      json: { ok: true, status: "refunded", provider: "dodo", recoveryReason: "This payment has been refunded." },
    });
  });

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  const resumeBtn = page.getByRole("button", { name: "Resume checkout", exact: true });
  await expect(resumeBtn).toBeVisible();

  await resumeBtn.click();
  await expect(page.getByText("Your payment was received. Roo Industries will contact you about your upgrade.")).toBeVisible();
  await expect(page).toHaveURL(/\/payment$/);

  await resumeBtn.click();
  await expect(page.getByText("Temporary status outage.")).toBeVisible();
  await expect(page).toHaveURL(/\/payment$/);

  await resumeBtn.click();
  await expect(page.getByText("This payment was refunded. Go back to booking to choose a time.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
  await expect(resumeBtn).toHaveCount(0);
  expect(statusCalls).toBe(3);
});

const setupLockedDodo = async (page, flow, token) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      status: 409,
      json: {
        ok: false,
        code: "payment_quote_already_claimed",
        error: "This reservation is already bound to a different quote.",
        claimedSession: {
          provider: "dodo",
          status: "started",
          paymentAccessToken: token,
          providerPayload: { orderId: "cs_dodo_nr_1", checkoutUrl: "/__test/checkout-handoff", taxInclusive: false, dodoReturnTag: "fixture-dodo-tag" },
          quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
          quoteFingerprint: "fixture-quote",
          sessionExpiresAt: expiry,
          refreshedHold: { slotHoldId: body.bookingPayload.slotHoldId, slotHoldToken: `${token}-hold`, slotHoldExpiresAt: expiry, phase: "payment_pending" },
          referralCode: "",
          couponCode: "",
        },
      },
    });
  });
  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeVisible();
};

test("cancel 409 manual review scrubs saved Dodo URL and 503 status does not reopen checkout", async ({ page, flow }) => {
  await page.route("**/api/payment/cancel", route => route.fulfill({
    status: 409,
    json: { ok: false, status: "needs_recovery", manualReviewRequired: true, recoveryReason: "Manual review required.", error: "Manual review required." },
  }));
  await page.route("**/api/payment/status", route => route.fulfill({ status: 503, json: { ok: false, error: "Status temporarily unavailable." } }));
  await setupLockedDodo(page, flow, "dodo-cancel409-pat");
  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await expect(page.getByText("Manual review required.")).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("payment_session_state")).providerPayload.checkoutUrl)).toBeUndefined();
  await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
  await expect(page.getByText("Status temporarily unavailable.")).toBeVisible();
  await expect(page).toHaveURL(/\/payment$/);
});

test("finalize 503 needs_recovery scrubs saved Dodo URL and 503 status does not reopen checkout", async ({ page, flow }) => {
  await page.route("**/api/payment/finalize", route => route.fulfill({
    status: 503, json: { ok: false, status: "needs_recovery", error: "Finalize temporarily unavailable." },
  }));
  await page.route("**/api/payment/status", route => route.fulfill({ status: 503, json: { ok: false, error: "Status temporarily unavailable." } }));
  await setupLockedDodo(page, flow, "dodo-fin503-pat");
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page.getByText("Finalize temporarily unavailable.")).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("payment_session_state")).providerPayload.checkoutUrl)).toBeUndefined();
  await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
  await expect(page.getByText("Status temporarily unavailable.")).toBeVisible();
  await expect(page).toHaveURL(/\/payment$/);
});

test("poll finalizing after finalize started scrubs saved Dodo URL and 503 status does not reopen checkout", async ({ page, flow }) => {
  let pollStep = 0;
  await page.route("**/api/payment/finalize", route => route.fulfill({ status: 202, json: { ok: true, status: "started" } }));
  await page.route("**/api/payment/status", route => {
    pollStep += 1;
    if (pollStep === 1) return route.fulfill({ json: { ok: true, status: "finalizing" } });
    return route.fulfill({ status: 503, json: { ok: false, error: "Poll status unavailable." } });
  });
  await setupLockedDodo(page, flow, "dodo-pollfin-pat");
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page.getByText("Poll status unavailable.")).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("payment_session_state")).providerPayload.checkoutUrl)).toBeUndefined();
  await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
  await expect(page).toHaveURL(/\/payment$/);
});

test("Change payment method and Check payment status stay disabled while Resume checkout is awaiting status", async ({ page, flow }) => {
  let releaseStatus;
  await page.route("**/api/payment/status", async route => {
    await new Promise(resolve => { releaseStatus = resolve; });
    await route.fulfill({ status: 503, json: { ok: false, error: "Status check aborted." } });
  });
  await setupLockedDodo(page, flow, "dodo-busy-lock-pat");
  await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
  await expect.poll(() => typeof releaseStatus).toBe("function");
  await expect(page.getByRole("button", { name: "Change payment method", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeDisabled();
  releaseStatus();
  await expect(page.getByText("Status check aborted.")).toBeVisible();
  await expect(page).toHaveURL(/\/payment$/);
});

test("Razorpay stays disabled and does not open while Change payment method cancellation is pending", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.__rzpOpened = 0; window.Razorpay = function () { window.__rzpOpened += 1; return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    holdId = body.bookingPayload.slotHoldId;
    return route.fulfill({
      status: 409,
      json: {
        ok: false,
        code: "payment_quote_already_claimed",
        error: "This reservation is already bound to a different quote.",
        claimedSession: {
          provider: "razorpay",
          status: "started",
          paymentAccessToken: "rzp-cancel-race-pat",
          providerPayload: { orderId: "order_rzp_cancel_1", amount: 8499, currency: "USD", key: "rzp_test_fixture" },
          quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
          quoteFingerprint: "fixture-quote",
          sessionExpiresAt: expiry,
          refreshedHold: { slotHoldId: holdId, slotHoldToken: "rzp-cancel-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
          referralCode: "",
          couponCode: "",
        },
      },
    });
  });
  let statusCalls = 0;
  await page.route("**/api/payment/status", route => {
    statusCalls += 1;
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "razorpay",
        providerOrderReady: true,
        quoteFingerprint: "fixture-quote",
        quoteFingerprintValid: true,
        quote: { currency: "USD", grossAmount: 84.99, netAmount: 84.99, isFree: false },
        providerPayload: { orderId: "order_rzp_cancel_1", amount: 8499, currency: "USD", key: "rzp_test_fixture" },
      },
    });
  });
  let releaseCancel;
  await page.route("**/api/payment/cancel", async route => {
    await new Promise(resolve => { releaseCancel = resolve; });
    await route.fulfill({
      json: {
        ok: true,
        cancelled: true,
        status: "abandoned",
        terminalOutcomeComplete: true,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "rzp-released-hold", slotHoldExpiresAt: expiry, phase: "holding" },
      },
    });
  });

  await flow.review();
  await flow.payment();
  const razorpayBtn = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
  await expect(razorpayBtn).toBeEnabled();
  await razorpayBtn.click();
  const changeBtn = page.getByRole("button", { name: "Change payment method", exact: true });
  await expect(changeBtn).toBeVisible();

  await changeBtn.click();
  await expect.poll(() => typeof releaseCancel).toBe("function");
  await expect(razorpayBtn).toBeDisabled();
  await razorpayBtn.click({ force: true });
  expect(statusCalls).toBe(0);
  expect(await page.evaluate(() => window.__rzpOpened)).toBe(0);

  releaseCancel();
  await expect(page.getByText("Payment method released. Choose a payment method below.")).toBeVisible();
  await expect(razorpayBtn).toBeEnabled();
  expect(statusCalls).toBe(0);
  expect(await page.evaluate(() => window.__rzpOpened)).toBe(0);
});

test("PayPal rejects clicks and createOrder while Change payment method cancellation is pending", async ({ page, flow }) => {
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
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    holdId = body.bookingPayload.slotHoldId;
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "paypal",
        paymentAccessToken: "paypal-cancel-race-pat",
        providerPayload: { orderId: "paypal_cancel_1", currency: "USD", amount: 8499 },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "paypal-cancel-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  let statusCalls = 0;
  await page.route("**/api/payment/status", route => {
    statusCalls += 1;
    return route.fulfill({
      json: { ok: true, status: "started", provider: "paypal", providerOrderReady: true, quoteFingerprint: "fixture-quote", quoteFingerprintValid: true, quote: { currency: "USD", grossAmount: 84.99, netAmount: 84.99, isFree: false }, providerPayload: { orderId: "paypal_cancel_1", currency: "USD", amount: 8499 } },
    });
  });
  let releaseCancel;
  await page.route("**/api/payment/cancel", async route => {
    await new Promise(resolve => { releaseCancel = resolve; });
    await route.fulfill({
      json: {
        ok: true,
        cancelled: true,
        status: "abandoned",
        terminalOutcomeComplete: true,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "paypal-released-hold", slotHoldExpiresAt: expiry, phase: "holding" },
      },
    });
  });

  await flow.review();
  await flow.payment();
  const paypalBtn = page.getByRole("button", { name: "Fixture PayPal", exact: true });
  await expect(paypalBtn).toBeVisible();
  await paypalBtn.click();
  await expect.poll(() => page.evaluate(() => typeof window.__paypalCreateOrder)).toBe("function");
  expect(await evaluateBrowserTask(page, () => window.__paypalCreateOrder())).toBe("paypal_cancel_1");
  const changeBtn = page.getByRole("button", { name: "Change payment method", exact: true });
  await expect(changeBtn).toBeVisible();

  await changeBtn.click();
  await expect.poll(() => typeof releaseCancel).toBe("function");
  await paypalBtn.click({ force: true });
  await expect.poll(() => page.evaluate(() => window.__paypalClickResult)).toBe("rejected");
  const createDuringCancel = await evaluateBrowserTask(page, () => window.__paypalCreateOrder().then(id => `created:${id}`, err => String(err?.message || err)));
  expect(createDuringCancel).toBe("Payment method release is in progress.");
  expect(statusCalls).toBe(0);

  releaseCancel();
  await expect(page.getByText("Payment method released. Choose a payment method below.")).toBeVisible();
  expect(statusCalls).toBe(0);
});

test("Change payment method stays disabled while PayPal resume is awaiting status", async ({ page, flow }) => {
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
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    holdId = body.bookingPayload.slotHoldId;
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "paypal",
        paymentAccessToken: "paypal-resume-lock-pat",
        providerPayload: { orderId: "paypal_resume_1", currency: "USD", amount: 8499 },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "paypal-resume-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  let releaseStatus;
  await page.route("**/api/payment/status", async route => {
    await new Promise(resolve => { releaseStatus = resolve; });
    await route.fulfill({
      json: { ok: true, status: "started", provider: "paypal", providerOrderReady: true, quoteFingerprint: "fixture-quote", quoteFingerprintValid: true, quote: { currency: "USD", grossAmount: 84.99, netAmount: 84.99, isFree: false }, providerPayload: { orderId: "paypal_resume_1", currency: "USD", amount: 8499 } },
    });
  });
  let cancelCalls = 0;
  await page.route("**/api/payment/cancel", route => {
    cancelCalls += 1;
    return route.fulfill({ json: { ok: true, cancelled: true, status: "abandoned", terminalOutcomeComplete: true } });
  });

  await flow.review();
  await flow.payment();
  const paypalBtn = page.getByRole("button", { name: "Fixture PayPal", exact: true });
  await expect(paypalBtn).toBeVisible();
  await paypalBtn.click();
  await expect.poll(() => page.evaluate(() => typeof window.__paypalCreateOrder)).toBe("function");
  expect(await evaluateBrowserTask(page, () => window.__paypalCreateOrder())).toBe("paypal_resume_1");
  const changeBtn = page.getByRole("button", { name: "Change payment method", exact: true });
  await expect(changeBtn).toBeEnabled();

  await paypalBtn.click();
  await page.evaluate(() => { window.__resumePromise = window.__paypalCreateOrder(); });
  await expect.poll(() => typeof releaseStatus).toBe("function");
  await expect(changeBtn).toBeDisabled();
  await changeBtn.click({ force: true });
  expect(cancelCalls).toBe(0);

  releaseStatus();
  expect(await evaluateBrowserTask(page, () => window.__resumePromise)).toBe("paypal_resume_1");
  await expect(changeBtn).toBeEnabled();
  expect(cancelCalls).toBe(0);
});

test("PayPal onApprove still captures and confirms when Change payment method cancellation is pending and returns 409", async ({ page, flow }) => {
  const withPaypal = { ...providers, paypal: { enabled: true, mode: "sandbox", clientId: "fixture-client" } };
  const approveStub = `
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
            if (result === "resolved") {
              window.__paypalCreateOrder = () => options.createOrder({}, {});
              window.__paypalApprove = () => options.onApprove(
                { orderID: "paypal_approve_1" },
                { order: { capture: async () => ({ id: "paypal_approve_1", payer: { email_address: "buyer@example.com" } }) } },
              );
            }
          });
          container.appendChild(button);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
        updateProps: () => Promise.resolve(),
      };
    },
  };
  `;
  await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, route => route.fulfill({
    contentType: "application/javascript", body: approveStub,
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
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "paypal",
        paymentAccessToken: "paypal-approve-cancel-pat",
        providerPayload: { orderId: "paypal_approve_1", currency: "USD", amount: 8499 },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: body.bookingPayload.slotHoldId, slotHoldToken: "paypal-approve-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  let releaseCancel;
  await page.route("**/api/payment/cancel", async route => {
    await new Promise(resolve => { releaseCancel = resolve; });
    await route.fulfill({ status: 409, json: { ok: false, code: "provider_pending", error: "Payment is already in progress." } });
  });
  let releaseFinalize;
  let finalizeCalls = 0;
  await page.route("**/api/payment/finalize", async route => {
    finalizeCalls += 1;
    await new Promise(resolve => { releaseFinalize = resolve; });
    await route.fulfill({ json: { ok: true, status: "booked", bookingId: "booking-pp-f22" } });
  });

  await flow.review();
  await flow.payment();
  const paypalBtn = page.getByRole("button", { name: "Fixture PayPal", exact: true });
  await expect(paypalBtn).toBeVisible();
  await paypalBtn.click();
  await expect.poll(() => page.evaluate(() => typeof window.__paypalCreateOrder)).toBe("function");
  expect(await evaluateBrowserTask(page, () => window.__paypalCreateOrder())).toBe("paypal_approve_1");

  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await expect.poll(() => typeof releaseCancel).toBe("function");

  await page.evaluate(() => { window.__approvePromise = window.__paypalApprove(); });
  await expect.poll(() => finalizeCalls, { timeout: 5000 }).toBe(1);
  const cancelDone = page.waitForResponse("**/api/payment/cancel");
  releaseCancel();
  await cancelDone;
  releaseFinalize();
  await expect(page).toHaveURL(/\/payment-success$/);
});

test("Razorpay success handler still finalizes and confirms when Change payment method cancellation is pending and returns 409", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function (opts) { window.__rzpHandler = opts.handler; return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "razorpay",
        paymentAccessToken: "rzp-handler-cancel-pat",
        providerPayload: { orderId: "order_rzp_f22", amount: 8499, currency: "USD", key: "rzp_test_fixture" },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: body.bookingPayload.slotHoldId, slotHoldToken: "rzp-handler-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  let releaseCancel;
  await page.route("**/api/payment/cancel", async route => {
    await new Promise(resolve => { releaseCancel = resolve; });
    await route.fulfill({ status: 409, json: { ok: false, code: "provider_pending", error: "Payment is already in progress." } });
  });
  let releaseFinalize;
  let finalizeCalls = 0;
  await page.route("**/api/payment/finalize", async route => {
    finalizeCalls += 1;
    await new Promise(resolve => { releaseFinalize = resolve; });
    await route.fulfill({ json: { ok: true, status: "booked", bookingId: "booking-rzp-f22" } });
  });

  await flow.review();
  await flow.payment();
  const razorpayBtn = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
  await expect(razorpayBtn).toBeEnabled();
  await razorpayBtn.click();
  await expect.poll(() => page.evaluate(() => typeof window.__rzpHandler)).toBe("function");

  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await expect.poll(() => typeof releaseCancel).toBe("function");

  await page.evaluate(() => {
    window.__rzpFinalizePromise = window.__rzpHandler({
      razorpay_order_id: "order_rzp_f22",
      razorpay_payment_id: "pay_rzp_f22",
      razorpay_signature: "sig_rzp_f22",
    });
  });
  await expect.poll(() => finalizeCalls, { timeout: 5000 }).toBe(1);
  const cancelDone = page.waitForResponse("**/api/payment/cancel");
  releaseCancel();
  await cancelDone;
  releaseFinalize();
  await expect(page).toHaveURL(/\/payment-success$/);
});

test("delayed cancel 409 does not replace PayPal manual-review notice after onApprove finalizes", async ({ page, flow }) => {
  const withPaypal = { ...providers, paypal: { enabled: true, mode: "sandbox", clientId: "fixture-client" } };
  const approveStub = `
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
            if (result === "resolved") {
              window.__paypalCreateOrder = () => options.createOrder({}, {});
              window.__paypalApprove = () => options.onApprove(
                { orderID: "paypal_review_1" },
                { order: { capture: async () => ({ id: "paypal_review_1", payer: { email_address: "buyer@example.com" } }) } },
              );
            }
          });
          container.appendChild(button);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
        updateProps: () => Promise.resolve(),
      };
    },
  };
  `;
  await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, route => route.fulfill({
    contentType: "application/javascript", body: approveStub,
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
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "paypal",
        paymentAccessToken: "paypal-review-cancel-pat",
        providerPayload: { orderId: "paypal_review_1", currency: "USD", amount: 8499 },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: body.bookingPayload.slotHoldId, slotHoldToken: "paypal-review-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  let releaseCancel;
  await page.route("**/api/payment/cancel", async route => {
    await new Promise(resolve => { releaseCancel = resolve; });
    await route.fulfill({ status: 409, json: { ok: false, code: "provider_pending", error: "Payment is already in progress." } });
  });
  await page.route("**/api/payment/finalize", route => route.fulfill({
    json: {
      ok: true,
      status: "needs_recovery",
      manualReviewRequired: true,
      recoveryReason: "Your payment was received. Roo Industries will contact you about your upgrade.",
    },
  }));

  await flow.review();
  await flow.payment();
  const paypalBtn = page.getByRole("button", { name: "Fixture PayPal", exact: true });
  await expect(paypalBtn).toBeVisible();
  await paypalBtn.click();
  await expect.poll(() => page.evaluate(() => typeof window.__paypalCreateOrder)).toBe("function");
  expect(await evaluateBrowserTask(page, () => window.__paypalCreateOrder())).toBe("paypal_review_1");

  const changeBtn = page.getByRole("button", { name: "Change payment method", exact: true });
  await changeBtn.click();
  await expect.poll(() => typeof releaseCancel).toBe("function");

  await page.evaluate(() => { window.__approvePromise = window.__paypalApprove(); });
  const reviewNotice = page.getByText("Your payment was received. Roo Industries will contact you about your upgrade.");
  await expect(reviewNotice).toBeVisible();

  const cancelDone = page.waitForResponse("**/api/payment/cancel");
  releaseCancel();
  await cancelDone;
  await expect(changeBtn).toBeEnabled();
  await expect(reviewNotice).toBeVisible();
  await expect(page.getByText("Payment is already in progress.")).toHaveCount(0);
});

test("delayed cancel 409 does not replace Razorpay manual-review notice after handler finalizes", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function (opts) { window.__rzpHandler = opts.handler; return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "razorpay",
        paymentAccessToken: "rzp-review-cancel-pat",
        providerPayload: { orderId: "order_rzp_review_1", amount: 8499, currency: "USD", key: "rzp_test_fixture" },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: body.bookingPayload.slotHoldId, slotHoldToken: "rzp-review-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  let releaseCancel;
  await page.route("**/api/payment/cancel", async route => {
    await new Promise(resolve => { releaseCancel = resolve; });
    await route.fulfill({ status: 409, json: { ok: false, code: "provider_pending", error: "Payment is already in progress." } });
  });
  await page.route("**/api/payment/finalize", route => route.fulfill({
    json: {
      ok: true,
      status: "needs_recovery",
      manualReviewRequired: true,
      recoveryReason: "Your payment was received. Roo Industries will contact you about your upgrade.",
    },
  }));

  await flow.review();
  await flow.payment();
  const razorpayBtn = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
  await expect(razorpayBtn).toBeEnabled();
  await razorpayBtn.click();
  await expect.poll(() => page.evaluate(() => typeof window.__rzpHandler)).toBe("function");

  const changeBtn = page.getByRole("button", { name: "Change payment method", exact: true });
  await changeBtn.click();
  await expect.poll(() => typeof releaseCancel).toBe("function");

  await page.evaluate(() => {
    window.__rzpFinalizePromise = window.__rzpHandler({
      razorpay_order_id: "order_rzp_review_1",
      razorpay_payment_id: "pay_rzp_review_1",
      razorpay_signature: "sig_rzp_review_1",
    });
  });
  const reviewNotice = page.getByText("Your payment was received. Roo Industries will contact you about your upgrade.");
  await expect(reviewNotice).toBeVisible();

  const cancelDone = page.waitForResponse("**/api/payment/cancel");
  releaseCancel();
  await cancelDone;
  await expect(changeBtn).toBeEnabled();
  await expect(reviewNotice).toBeVisible();
  await expect(page.getByText("Payment is already in progress.")).toHaveCount(0);
});

test("cancel 200 captured booked still confirms after PayPal capture reply is lost", async ({ page, flow }) => {
  const withPaypal = { ...providers, paypal: { enabled: true, mode: "sandbox", clientId: "fixture-client" } };
  const lostCaptureStub = `
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
            if (result === "resolved") {
              window.__paypalCreateOrder = () => options.createOrder({}, {});
              window.__paypalApprove = () => options.onApprove(
                { orderID: "paypal_lost_reply_1" },
                { order: { capture: async () => { throw new Error("Lost capture reply"); } } },
              );
            }
          });
          container.appendChild(button);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
        updateProps: () => Promise.resolve(),
      };
    },
  };
  `;
  await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, route => route.fulfill({
    contentType: "application/javascript", body: lostCaptureStub,
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
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "paypal",
        paymentAccessToken: "paypal-lost-capture-pat",
        providerPayload: { orderId: "paypal_lost_reply_1", currency: "USD", amount: 8499 },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: body.bookingPayload.slotHoldId, slotHoldToken: "paypal-lost-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  let releaseCancel;
  await page.route("**/api/payment/cancel", async route => {
    await new Promise(resolve => { releaseCancel = resolve; });
    await route.fulfill({ json: { ok: true, captured: true, status: "booked", bookingId: "booking-pp-f24" } });
  });

  await flow.review();
  await flow.payment();
  const paypalBtn = page.getByRole("button", { name: "Fixture PayPal", exact: true });
  await expect(paypalBtn).toBeVisible();
  await paypalBtn.click();
  await expect.poll(() => page.evaluate(() => typeof window.__paypalCreateOrder)).toBe("function");
  expect(await evaluateBrowserTask(page, () => window.__paypalCreateOrder())).toBe("paypal_lost_reply_1");

  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await expect.poll(() => typeof releaseCancel).toBe("function");

  await evaluateBrowserTask(page, () => window.__paypalApprove());
  await expect(page.getByText("Payment succeeded but something went wrong saving your booking. Please contact support.")).toBeVisible();

  releaseCancel();
  await expect(page).toHaveURL(/\/payment-success$/);
});

test("cancel 200 captured booked still confirms after Razorpay finalize request fails", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function (opts) { window.__rzpHandler = opts.handler; return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "razorpay",
        paymentAccessToken: "rzp-finalize-fail-pat",
        providerPayload: { orderId: "order_rzp_f24", amount: 8499, currency: "USD", key: "rzp_test_fixture" },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: body.bookingPayload.slotHoldId, slotHoldToken: "rzp-f24-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  let releaseCancel;
  await page.route("**/api/payment/cancel", async route => {
    await new Promise(resolve => { releaseCancel = resolve; });
    await route.fulfill({ json: { ok: true, captured: true, status: "booked", bookingId: "booking-rzp-f24" } });
  });
  await page.route("**/api/payment/finalize", route => route.fulfill({
    status: 503, json: { ok: false, error: "Temporary finalize error." },
  }));

  await flow.review();
  await flow.payment();
  const razorpayBtn = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
  await expect(razorpayBtn).toBeEnabled();
  await razorpayBtn.click();
  await expect.poll(() => page.evaluate(() => typeof window.__rzpHandler)).toBe("function");

  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await expect.poll(() => typeof releaseCancel).toBe("function");

  await evaluateBrowserTask(page, () => window.__rzpHandler({
    razorpay_order_id: "order_rzp_f24",
    razorpay_payment_id: "pay_rzp_f24",
    razorpay_signature: "sig_rzp_f24",
  }));
  await expect(page.getByText("Payment succeeded but something went wrong saving your booking. Please contact support.")).toBeVisible();

  releaseCancel();
  await expect(page).toHaveURL(/\/payment-success$/);
});

test("cancel 200 abandoned does not unlock Pay your way while PayPal capture is pending", async ({ page, flow }) => {
  const withPaypal = { ...providers, paypal: { enabled: true, mode: "sandbox", clientId: "fixture-client" } };
  const heldCaptureStub = `
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
            if (result === "resolved") {
              window.__paypalCreateOrder = () => options.createOrder({}, {});
              window.__paypalApprove = () => options.onApprove(
                { orderID: "paypal_capture_pending_1" },
                { order: { capture: () => new Promise((resolve) => { window.__releasePaypalCapture = () => resolve({ id: "paypal_capture_pending_1", payer: { email_address: "buyer@example.com" } }); }) } },
              );
            }
          });
          container.appendChild(button);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
        updateProps: () => Promise.resolve(),
      };
    },
  };
  `;
  await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, route => route.fulfill({
    contentType: "application/javascript", body: heldCaptureStub,
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
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  let dodoStarts = 0;
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    if (body?.provider === "dodo") {
      dodoStarts += 1;
      return route.fulfill({ status: 409, json: { ok: false, error: "Unexpected Dodo start." } });
    }
    holdId = body.bookingPayload.slotHoldId;
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "paypal",
        paymentAccessToken: "paypal-capture-pending-pat",
        providerPayload: { orderId: "paypal_capture_pending_1", currency: "USD", amount: 8499 },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "paypal-capture-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  let releaseCancel;
  await page.route("**/api/payment/cancel", async route => {
    await new Promise(resolve => { releaseCancel = resolve; });
    await route.fulfill({
      json: {
        ok: true,
        cancelled: true,
        status: "abandoned",
        terminalOutcomeComplete: true,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "paypal-abandoned-hold", slotHoldExpiresAt: expiry, phase: "holding" },
      },
    });
  });
  await page.route("**/api/payment/finalize", route => route.fulfill({
    json: { ok: true, status: "booked", bookingId: "booking-pp-f25" },
  }));

  await flow.review();
  await flow.payment();
  const paypalBtn = page.getByRole("button", { name: "Fixture PayPal", exact: true });
  await expect(paypalBtn).toBeVisible();
  await paypalBtn.click();
  await expect.poll(() => page.evaluate(() => typeof window.__paypalCreateOrder)).toBe("function");
  expect(await evaluateBrowserTask(page, () => window.__paypalCreateOrder())).toBe("paypal_capture_pending_1");

  const changeBtn = page.getByRole("button", { name: "Change payment method", exact: true });
  const dodoBtn = page.getByRole("button", { name: "Pay your way", exact: true });
  await changeBtn.click();
  await expect.poll(() => typeof releaseCancel).toBe("function");

  await page.evaluate(() => { window.__approvePending = window.__paypalApprove(); });
  await expect.poll(() => page.evaluate(() => typeof window.__releasePaypalCapture)).toBe("function");

  const cancelDone = page.waitForResponse("**/api/payment/cancel");
  releaseCancel();
  await cancelDone;
  await expect(dodoBtn).toBeDisabled();
  await expect(changeBtn).toBeDisabled();
  await dodoBtn.click({ force: true });
  expect(dodoStarts).toBe(0);
  await expect(page.getByText("Payment method released. Choose a payment method below.")).toHaveCount(0);

  await page.evaluate(() => window.__releasePaypalCapture());
  await expect(page).toHaveURL(/\/payment-success$/);
  expect(dodoStarts).toBe(0);
});

test("cancel 200 abandoned preserves replacement hold token if pending PayPal capture later fails", async ({ page, flow }) => {
  const withPaypal = { ...providers, paypal: { enabled: true, mode: "sandbox", clientId: "fixture-client" } };
  const rejectableCaptureStub = `
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
            if (result === "resolved") {
              window.__paypalCreateOrder = () => options.createOrder({}, {});
              window.__paypalApprove = () => options.onApprove(
                { orderID: "paypal_fail_after_cancel_1" },
                { order: { capture: () => new Promise((_, reject) => { window.__rejectPaypalCapture = () => reject(new Error("Capture voided")); }) } },
              );
            }
          });
          container.appendChild(button);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
        updateProps: () => Promise.resolve(),
      };
    },
  };
  `;
  await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, route => route.fulfill({
    contentType: "application/javascript", body: rejectableCaptureStub,
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
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  let initialHoldToken = "";
  let dodoStartToken = "";
  let paypalStartCount = 0;
  let paypalRetryToken = "";
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    if (body?.provider === "dodo") {
      dodoStartToken = String(body?.bookingPayload?.slotHoldToken || "");
      return route.fulfill({
        json: {
          ok: true,
          status: "started",
          provider: "dodo",
          paymentAccessToken: "dodo-after-replacement-pat",
          providerPayload: { orderId: "cs_dodo_f26", checkoutUrl: "/__test/checkout-handoff" },
          quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
          quoteFingerprint: "fixture-quote",
          sessionExpiresAt: expiry,
          refreshedHold: { slotHoldId: holdId, slotHoldToken: "dodo-f26-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
        },
      });
    }
    paypalStartCount += 1;
    if (paypalStartCount > 1) {
      paypalRetryToken = String(body?.bookingPayload?.slotHoldToken || "");
      return route.fulfill({ status: 409, json: { ok: false, error: "Switch to another method." } });
    }
    holdId = body.bookingPayload.slotHoldId;
    initialHoldToken = String(body.bookingPayload.slotHoldToken || "");
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "paypal",
        paymentAccessToken: "paypal-fail-after-cancel-pat",
        providerPayload: { orderId: "paypal_fail_after_cancel_1", currency: "USD", amount: 8499 },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: initialHoldToken, slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  let cancelCalls = 0;
  let releaseCancel;
  await page.route("**/api/payment/cancel", async route => {
    cancelCalls += 1;
    if (cancelCalls === 1) {
      await new Promise(resolve => { releaseCancel = resolve; });
      return route.fulfill({
        json: {
          ok: true,
          cancelled: true,
          status: "abandoned",
          terminalOutcomeComplete: true,
          refreshedHold: { slotHoldId: holdId, slotHoldToken: "paypal-replacement-hold-token", slotHoldExpiresAt: expiry, phase: "holding" },
        },
      });
    }
    return route.fulfill({
      status: 409,
      json: { ok: false, status: "abandoned", error: "This payment session can no longer be changed." },
    });
  });
  await page.route("**/api/payment/status", route => route.fulfill({
    json: { ok: true, status: "abandoned", provider: "paypal", terminalOutcomeComplete: true, recoveryReason: "This payment session was cancelled." },
  }));

  await flow.review();
  await flow.payment();
  const paypalBtn = page.getByRole("button", { name: "Fixture PayPal", exact: true });
  await expect(paypalBtn).toBeVisible();
  await paypalBtn.click();
  await expect.poll(() => page.evaluate(() => typeof window.__paypalCreateOrder)).toBe("function");
  expect(await evaluateBrowserTask(page, () => window.__paypalCreateOrder())).toBe("paypal_fail_after_cancel_1");

  const changeBtn = page.getByRole("button", { name: "Change payment method", exact: true });
  const dodoBtn = page.getByRole("button", { name: "Pay your way", exact: true });
  await changeBtn.click();
  await expect.poll(() => typeof releaseCancel).toBe("function");

  await page.evaluate(() => { window.__approveFailing = window.__paypalApprove(); });
  await expect.poll(() => page.evaluate(() => typeof window.__rejectPaypalCapture)).toBe("function");

  const cancelDone = page.waitForResponse("**/api/payment/cancel");
  releaseCancel();
  await cancelDone;
  await expect(dodoBtn).toBeDisabled();

  await page.evaluate(() => window.__rejectPaypalCapture());
  await expect(page.getByText("Payment succeeded but something went wrong saving your booking. Please contact support.")).toBeVisible();

  await paypalBtn.click();
  await evaluateBrowserTask(page, () => window.__paypalCreateOrder().catch(err => String(err?.message || err)));
  await expect(dodoBtn).toBeEnabled();

  await dodoBtn.click();
  await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
  expect(dodoStartToken).toBe("paypal-replacement-hold-token");
  if (paypalRetryToken) expect(paypalRetryToken).toBe("paypal-replacement-hold-token");
});

test("concurrent Change payment method 409 abandoned keeps retry available to recover replacement hold token", async ({ page, flow }) => {
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
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  let dodoStartToken = "";
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    if (body?.provider === "dodo") {
      dodoStartToken = String(body?.bookingPayload?.slotHoldToken || "");
      return route.fulfill({
        json: {
          ok: true,
          status: "started",
          provider: "dodo",
          paymentAccessToken: "dodo-after-tab-retry-pat",
          providerPayload: { orderId: "cs_dodo_f27", checkoutUrl: "/__test/checkout-handoff" },
          quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
          quoteFingerprint: "fixture-quote",
          sessionExpiresAt: expiry,
          refreshedHold: { slotHoldId: holdId, slotHoldToken: "dodo-f27-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
        },
      });
    }
    holdId = body.bookingPayload.slotHoldId;
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "paypal",
        paymentAccessToken: "paypal-tab-race-pat",
        providerPayload: { orderId: "paypal_tab_race_1", currency: "USD", amount: 8499 },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "paypal-tab-old-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  let cancelCalls = 0;
  await page.route("**/api/payment/cancel", route => {
    cancelCalls += 1;
    if (cancelCalls === 1) {
      return route.fulfill({
        status: 409,
        json: {
          ok: false,
          status: "abandoned",
          captured: false,
          cancelled: false,
          error: "Payment state changed before it could be released.",
        },
      });
    }
    return route.fulfill({
      json: {
        ok: true,
        cancelled: true,
        status: "abandoned",
        terminalOutcomeComplete: true,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "paypal-recovered-tab-hold", slotHoldExpiresAt: expiry, phase: "holding" },
      },
    });
  });

  await flow.review();
  await flow.payment();
  const paypalBtn = page.getByRole("button", { name: "Fixture PayPal", exact: true });
  await expect(paypalBtn).toBeVisible();
  await paypalBtn.click();
  await expect.poll(() => page.evaluate(() => typeof window.__paypalCreateOrder)).toBe("function");
  expect(await evaluateBrowserTask(page, () => window.__paypalCreateOrder())).toBe("paypal_tab_race_1");

  const changeBtn = page.getByRole("button", { name: "Change payment method", exact: true });
  const dodoBtn = page.getByRole("button", { name: "Pay your way", exact: true });
  await changeBtn.click();
  await expect(page.getByText("Payment state changed before it could be released.")).toBeVisible();
  await expect(changeBtn).toBeVisible();
  await expect(changeBtn).toBeEnabled();
  await expect(dodoBtn).toBeDisabled();

  await changeBtn.click();
  await expect(page.getByText("Payment method released. Choose a payment method below.")).toBeVisible();
  await expect(dodoBtn).toBeEnabled();

  await dodoBtn.click();
  await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
  expect(dodoStartToken).toBe("paypal-recovered-tab-hold");
});

test("Dodo Change payment method clears session and hold on 409 failed and 409 refunded", async ({ page, flow }) => {
  await page.route("**/api/payment/cancel", route => route.fulfill({
    status: 409,
    json: { ok: false, status: "failed", terminalOutcomeComplete: true, error: "This payment session can no longer be changed." },
  }));
  await setupLockedDodo(page, flow, "dodo-cancel409-failed-pat");
  const changeBtn = page.getByRole("button", { name: "Change payment method", exact: true });
  await changeBtn.click();
  await expect(page.getByText("Payment was not completed and the slot was released. Go back to booking to choose a time.")).toBeVisible();
  await expect(changeBtn).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("my_slot_hold"))).toBeNull();
});

test("Dodo Change payment method clears session and hold on 409 refunded", async ({ page, flow }) => {
  await page.route("**/api/payment/cancel", route => route.fulfill({
    status: 409,
    json: { ok: false, status: "refunded", error: "This payment session can no longer be changed." },
  }));
  await setupLockedDodo(page, flow, "dodo-cancel409-refunded-pat");
  const changeBtn = page.getByRole("button", { name: "Change payment method", exact: true });
  await changeBtn.click();
  await expect(page.getByText("This payment was refunded. Go back to booking to choose a time.")).toBeVisible();
  await expect(changeBtn).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("my_slot_hold"))).toBeNull();
});

test("Dodo Resume checkout restores refreshedHold on 200 abandoned and starts checkout with the replacement token", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  let startCount = 0;
  let resumedStartToken = "";
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    startCount += 1;
    if (startCount === 1) {
      holdId = body.bookingPayload.slotHoldId;
      return route.fulfill({
        status: 409,
        json: {
          ok: false,
          code: "payment_quote_already_claimed",
          error: "This reservation is already bound to a different quote.",
          claimedSession: {
            provider: "dodo",
            status: "started",
            paymentAccessToken: "dodo-two-tab-pat",
            providerPayload: { orderId: "cs_dodo_tab_1", checkoutUrl: "/__test/checkout-handoff" },
            quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
            quoteFingerprint: "fixture-quote",
            sessionExpiresAt: expiry,
            refreshedHold: { slotHoldId: holdId, slotHoldToken: "dodo-tab-old-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
            referralCode: "",
            couponCode: "",
          },
        },
      });
    }
    resumedStartToken = String(body?.bookingPayload?.slotHoldToken || "");
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "dodo",
        paymentAccessToken: "dodo-two-tab-fresh-pat",
        providerPayload: { orderId: "cs_dodo_tab_2", checkoutUrl: "/__test/checkout-handoff" },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "dodo-tab-fresh-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  await page.route("**/api/payment/status", route => route.fulfill({
    json: {
      ok: true,
      status: "abandoned",
      provider: "dodo",
      terminalOutcomeComplete: true,
      refreshedHold: { slotHoldId: holdId, slotHoldToken: "dodo-tab-replacement-hold", slotHoldExpiresAt: expiry, phase: "holding" },
    },
  }));

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  const resumeBtn = page.getByRole("button", { name: "Resume checkout", exact: true });
  await expect(resumeBtn).toBeVisible();

  await resumeBtn.click();
  await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
  expect(resumedStartToken).toBe("dodo-tab-replacement-hold");
});

test("Dodo Check payment status restores refreshedHold on 200 abandoned and unlocks Pay your way", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  let startCount = 0;
  let retryStartToken = "";
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    startCount += 1;
    if (startCount === 1) {
      holdId = body.bookingPayload.slotHoldId;
      return route.fulfill({
        status: 409,
        json: {
          ok: false,
          code: "payment_quote_already_claimed",
          error: "This reservation is already bound to a different quote.",
          claimedSession: {
            provider: "dodo",
            status: "started",
            paymentAccessToken: "dodo-fin-abandoned-pat",
            providerPayload: { orderId: "cs_dodo_fin_1", checkoutUrl: "/__test/checkout-handoff" },
            quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
            quoteFingerprint: "fixture-quote",
            sessionExpiresAt: expiry,
            refreshedHold: { slotHoldId: holdId, slotHoldToken: "dodo-fin-old-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
            referralCode: "",
            couponCode: "",
          },
        },
      });
    }
    retryStartToken = String(body?.bookingPayload?.slotHoldToken || "");
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "dodo",
        paymentAccessToken: "dodo-fin-fresh-pat",
        providerPayload: { orderId: "cs_dodo_fin_2", checkoutUrl: "/__test/checkout-handoff" },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "dodo-fin-fresh-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  await page.route("**/api/payment/finalize", route => route.fulfill({
    json: {
      ok: true,
      status: "abandoned",
      provider: "dodo",
      terminalOutcomeComplete: true,
      refreshedHold: { slotHoldId: holdId, slotHoldToken: "dodo-fin-replacement-hold", slotHoldExpiresAt: expiry, phase: "holding" },
    },
  }));

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();

  await expect(page.getByText("Payment method released. Choose a payment method below.")).toBeVisible();
  const payBtn = page.getByRole("button", { name: "Pay your way", exact: true });
  await expect(payBtn).toBeEnabled();
  await payBtn.click();
  await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
  expect(retryStartToken).toBe("dodo-fin-replacement-hold");
});

test("Dodo Resume checkout keeps newer hold when stale abandoned session returns a superseded refreshedHold", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  let startCount = 0;
  let resumedToken = "";
  await page.route("**/api/payment/start", route => {
    const body = route.request().postDataJSON();
    startCount += 1;
    if (startCount === 1) {
      holdId = body.bookingPayload.slotHoldId;
      return route.fulfill({
        status: 409,
        json: {
          ok: false,
          code: "payment_quote_already_claimed",
          error: "This reservation is already bound to a different quote.",
          claimedSession: {
            provider: "dodo",
            status: "started",
            paymentAccessToken: "dodo-stale-session-pat",
            providerPayload: { orderId: "cs_dodo_stale_1", checkoutUrl: "/__test/checkout-handoff" },
            quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
            quoteFingerprint: "fixture-quote",
            sessionExpiresAt: expiry,
            refreshedHold: { slotHoldId: holdId, slotHoldToken: "dodo-old-session-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
            referralCode: "",
            couponCode: "",
          },
        },
      });
    }
    resumedToken = String(body?.bookingPayload?.slotHoldToken || "");
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "dodo",
        paymentAccessToken: "dodo-newer-hold-pat",
        providerPayload: { orderId: "cs_dodo_newer_2", checkoutUrl: "/__test/checkout-handoff" },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "dodo-newer-hold-next", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  await page.route("**/api/payment/status", route => route.fulfill({
    json: {
      ok: true,
      status: "abandoned",
      provider: "dodo",
      terminalOutcomeComplete: true,
      refreshedHold: { slotHoldId: holdId, slotHoldToken: "dodo-superseded-hold", slotHoldExpiresAt: expiry, phase: "holding" },
    },
  }));

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  const resumeBtn = page.getByRole("button", { name: "Resume checkout", exact: true });
  await expect(resumeBtn).toBeVisible();
  await page.evaluate(({ nextHoldId, nextExpiry }) => {
    const newer = { holdId: nextHoldId, holdToken: "dodo-browser-newer-hold", expiresAt: nextExpiry, phase: "holding" };
    sessionStorage.setItem("my_slot_hold", JSON.stringify(newer));
    sessionStorage.setItem("roo_hold_rotations", JSON.stringify({ [`${nextHoldId}:dodo-old-session-hold`]: "dodo-browser-newer-hold" }));
    const stored = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}");
    const nextBooking = { ...stored, slotHoldToken: "dodo-browser-newer-hold" };
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(nextBooking));
    if (window.history.state?.usr?.bookingData) {
      window.history.replaceState({ ...window.history.state, usr: { ...window.history.state.usr, bookingData: nextBooking } }, "");
    }
  }, { nextHoldId: holdId, nextExpiry: expiry });
  await page.reload();
  await expect(resumeBtn).toBeVisible();

  await resumeBtn.click();
  await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
  expect(resumedToken).toBe("dodo-browser-newer-hold");
});

test("Dodo Change payment method clears dead hold when server reports slotReleased after a superseded cancellation", async ({ page, flow }) => {
  await page.route("**/api/payment/cancel", route => route.fulfill({
    json: { ok: true, cancelled: true, status: "abandoned", terminalOutcomeComplete: true, slotReleased: true },
  }));
  await setupLockedDodo(page, flow, "dodo-superseded-cancel-pat");
  const changeBtn = page.getByRole("button", { name: "Change payment method", exact: true });
  await changeBtn.click();
  await expect(page.getByText("Payment was not completed and the slot was released. Go back to booking to choose a time.")).toBeVisible();
  await expect(changeBtn).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("my_slot_hold"))).toBeNull();
});

test("Dodo Resume checkout on leftover dodo_return URL clears query params on failed start so next checkout does not auto-finalize", async ({ page, flow }) => {
  let finalizeCount = 0;
  let startCount = 0;
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  await page.route("**/api/payment/finalize", route => {
    finalizeCount += 1;
    return route.fulfill({ status: 503, json: { ok: false, error: "Temporary status outage." } });
  });
  await page.route("**/api/payment/status", route => route.fulfill({
    json: {
      ok: true,
      status: "abandoned",
      provider: "dodo",
      terminalOutcomeComplete: true,
      refreshedHold: { slotHoldId: holdId, slotHoldToken: "dodo-leftover-replacement-hold", slotHoldExpiresAt: expiry, phase: "holding" },
    },
  }));
  await setupLockedDodo(page, flow, "dodo-leftover-return-pat");
  holdId = await page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold") || "{}").holdId || "");
  await page.route("**/api/payment/start", route => {
    startCount += 1;
    if (startCount === 1) {
      return route.fulfill({ status: 503, json: { ok: false, error: "Dodo temporarily unavailable." } });
    }
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "dodo",
        paymentAccessToken: "dodo-leftover-fresh-pat",
        providerPayload: { orderId: "cs_dodo_leftover_2", checkoutUrl: "/__test/checkout-handoff" },
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
        sessionExpiresAt: expiry,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "dodo-leftover-fresh-hold", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });

  await page.goto("/payment?dodo_return=1&dodo_session=fixture-dodo-tag");
  await expect(page.getByText("Temporary status outage.")).toBeVisible();
  expect(finalizeCount).toBe(1);

  await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
  await expect(page.getByText("Dodo temporarily unavailable.")).toBeVisible();
  await expect(page).toHaveURL(/\/payment$/);

  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
  expect(finalizeCount).toBe(1);
});
