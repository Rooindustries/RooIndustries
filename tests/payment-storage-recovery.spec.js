const fs = require("node:fs");
const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", viewport: { width: 390, height: 844 } });

test("a claimed payment keeps authenticated recovery when storage reads fail", async ({ page, flow }, testInfo) => {
  await flow.review();
  await flow.payment();
  const pay = page.getByRole("button", { name: "Pay your way", exact: true });
  await expect(pay).toBeEnabled();
  const original = await page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")));
  let pending;
  let startBody;
  await page.route("**/api/payment/start", route => {
    pending = route;
    startBody = route.request().postDataJSON();
  });
  const cancellations = [];
  const refreshedHold = { slotHoldId: original.holdId, slotHoldToken: `${original.holdToken}-cancelled`,
    slotHoldExpiresAt: original.expiresAt, phase: "holding" };
  await page.route("**/api/payment/cancel", async route => {
    cancellations.push({ authorization: route.request().headers().authorization, body: route.request().postDataJSON() });
    await route.fulfill({ json: { ok: true, cancelled: true, refreshedHold } });
  });
  await pay.click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  const coupon = page.locator("#payment-coupon-code");
  await coupon.fill("save20");
  await coupon.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => flow.state.calls.filter(call => call.path === "/api/payment/quote").at(-1)?.body.couponCode).toBe("save20");
  await expect(pay).toBeEnabled();

  await page.evaluate(() => {
    window.__storageRecoveryGet = Storage.prototype.getItem;
    window.__storageRecoveryFailures = [];
    Storage.prototype.getItem = function(key) {
      if (this === sessionStorage && ["my_slot_hold", "checkout_booking_state", "payment_session_state"].includes(key)) {
        window.__storageRecoveryFailures.push(key);
        throw new DOMException("Fixture storage reads denied", "SecurityError");
      }
      return window.__storageRecoveryGet.call(this, key);
    };
  });
  try {
    await pending.fulfill({ json: {
      ok: true, provider: "dodo", status: "started", paymentAccessToken: "fixture-storage-recovery-token",
      quoteFingerprint: startBody.quoteFingerprint, sessionExpiresAt: original.expiresAt,
      providerPayload: { checkoutUrl: new URL("/__test/checkout-handoff", page.url()).href },
      quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
      refreshedHold: { slotHoldId: original.holdId, slotHoldToken: original.holdToken,
        slotHoldExpiresAt: original.expiresAt, phase: "payment_pending" },
    } });
    await expect(page.getByRole("button", { name: "Change payment method", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/payment$/);
    await expect(page.getByText("Your browser could not save this payment session. Keep this page open and change payment method before trying again.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Change payment method", exact: true }).click();
    await expect.poll(() => cancellations.length).toBe(1);
    expect(cancellations).toEqual([{ authorization: "Bearer fixture-storage-recovery-token", body: {} }]);
    await expect(page.getByText("Payment method released. Choose a payment method below.", { exact: true })).toBeVisible();
  } finally {
    await page.evaluate(() => { Storage.prototype.getItem = window.__storageRecoveryGet; });
  }
  const saved = await page.evaluate(() => ({
    failures: window.__storageRecoveryFailures,
    hold: JSON.parse(sessionStorage.getItem("my_slot_hold")),
    checkout: JSON.parse(sessionStorage.getItem("checkout_booking_state")),
    session: sessionStorage.getItem("payment_session_state"),
  }));
  expect(saved.failures).toContain("my_slot_hold");
  expect(saved.hold).toMatchObject({ holdId: original.holdId, holdToken: refreshedHold.slotHoldToken });
  expect(saved.checkout).toMatchObject({ email: "visitor@example.invalid", couponCode: "save20", slotHoldToken: refreshedHold.slotHoldToken });
  expect(saved.session).toBeNull();
  expect(flow.state.aborted).toEqual([]);
  const artifact = testInfo.outputPath("storage-read-recovery.json");
  fs.mkdirSync(testInfo.outputDir, { recursive: true });
  fs.writeFileSync(artifact, JSON.stringify({ startBody, cancellations, saved }, null, 2));
  await testInfo.attach("storage-read-recovery", { path: artifact, contentType: "application/json" });
});
