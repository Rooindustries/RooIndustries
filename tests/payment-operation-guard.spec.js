const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce" });

const storage = page => page.evaluate(() => ({
  session: JSON.parse(sessionStorage.getItem("payment_session_state") || "null"),
  checkout: JSON.parse(sessionStorage.getItem("checkout_booking_state") || "null"),
}));
const renderNextFrame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test("a fresh checkout start stays stale after the customer applies a different code", async ({ page, flow }, testInfo) => {
  let pending;
  await page.route("**/api/payment/start", route => { pending = route; });
  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.locator("#payment-coupon-code").fill("save20");
  await page.locator("#payment-coupon-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove coupon", exact: true })).toBeVisible();
  const before = await storage(page);
  const delivered = page.waitForResponse("**/api/payment/start");
  await pending.fallback();
  await delivered;
  await renderNextFrame(page);
  await expect(page).toHaveURL(/\/payment$/);
  expect(await storage(page)).toEqual(before);
  await testInfo.attach("stale-start", { body: JSON.stringify({ before, after: await storage(page) }), contentType: "application/json" });
});

for (const field of ["paymentAccessToken", "packageTitle", "originalOrderId", "startTimeUTC", "email", "navigation"]) {
  test(`a late Dodo result cannot replace checkout after ${field} changes`, async ({ page, flow }, testInfo) => {
    let pending;
    await page.route("**/api/payment/finalize", route => { pending = route; });
    await flow.review();
    await flow.payment();
    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page).toHaveURL(/checkout-handoff$/);
    await page.goto("/payment?dodo_return=1");
    await expect.poll(() => Boolean(pending)).toBe(true);
    if (field === "navigation") {
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page).toHaveURL(/\/$/);
    } else {
      await page.evaluate(field => {
        const session = JSON.parse(sessionStorage.getItem("payment_session_state"));
        if (field === "paymentAccessToken") session.paymentAccessToken = "replacement-session-token";
        else {
          const fingerprint = JSON.parse(session.fingerprint);
          fingerprint[field] = "different-checkout-value";
          session.fingerprint = JSON.stringify(fingerprint);
        }
        sessionStorage.setItem("payment_session_state", JSON.stringify(session));
      }, field);
    }
    const before = await storage(page);
    const delivered = page.waitForResponse("**/api/payment/finalize");
    await pending.fulfill({ json: { ok: true, status: "booked", bookingId: "booking.stale-result" } });
    await delivered;
    await renderNextFrame(page);
    await expect(page).toHaveURL(field === "navigation" ? /\/$/ : /\/payment\?dodo_return=1$/);
    expect(await storage(page)).toEqual(before);
    await testInfo.attach("stale-result", { body: JSON.stringify({ field, before, after: await storage(page), url: page.url() }), contentType: "application/json" });
  });
}
