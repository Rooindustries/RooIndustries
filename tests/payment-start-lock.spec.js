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

test("an older start that finishes late does not unlock another method while a newer start runs", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: `fixture-quote-${route.request().postDataJSON()?.couponCode || "none"}`, providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  const releases = [];
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    await new Promise(resolve => releases.push(resolve));
    await route.fallback();
  });

  await flow.review();
  await flow.payment();
  const dodo = page.getByRole("button", { name: /^(Pay your way|Opening checkout\.\.\.)$/ });
  const razorpay = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
  await expect(razorpay).toBeEnabled();
  await dodo.click();
  await expect.poll(() => starts.length).toBe(1);

  const coupon = page.locator("#payment-coupon-code");
  await coupon.fill("save20");
  await coupon.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(2);

  releases[0]();
  await page.waitForTimeout(500);
  await expect(razorpay).toBeDisabled();
  await razorpay.click({ force: true });
  await page.waitForTimeout(500);
  expect(starts).toHaveLength(2);

  releases[1]();
  await expect(page).toHaveURL(/checkout-handoff$/);
});

test("a newer start that fails fast does not unlock another method while an older start is still pending", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: `fixture-quote-${route.request().postDataJSON()?.couponCode || "none"}`, providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  let releaseFirst;
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    if (starts.length === 1) {
      await new Promise(resolve => { releaseFirst = resolve; });
      return route.fallback();
    }
    return route.fulfill({ status: 409, json: { ok: false, code: "quote_fingerprint_mismatch", error: "The price changed." } });
  });

  await flow.review();
  await flow.payment();
  const razorpay = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
  await expect(razorpay).toBeEnabled();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);

  const coupon = page.locator("#payment-coupon-code");
  await coupon.fill("save20");
  await coupon.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(2);
  await expect(page.getByText("The price changed. Review the updated total and click again.", { exact: true })).toBeVisible();

  await expect(razorpay).toBeDisabled();
  await razorpay.click({ force: true });
  await page.waitForTimeout(500);
  expect(starts).toHaveLength(2);

  releaseFirst();
  await expect(razorpay).toBeEnabled();
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

  const created = await page.evaluate(() => window.__paypalCreateOrder().then(() => "created", error => String(error?.message || error)));
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
  await expect(confirmFree).toBeEnabled();
  await expect(page).toHaveURL(/\/payment$/);
  expect(starts).toEqual(["dodo"]);
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
});
