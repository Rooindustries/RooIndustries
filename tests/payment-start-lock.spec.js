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
