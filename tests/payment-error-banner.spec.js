const { test, expect } = require("./fixtures/booking-flow.cjs");
const cancelResponses = require("./fixtures/payment-cancel.json");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", actionTimeout: 10000, reducedMotion: "reduce" });

const recoveryMessage = "Fixture recovery message for a payment that is still being confirmed.";

const openStartedPayment = async (page, flow, cancelResponse) => {
  await page.route("**/api/payment/cancel", route => route.fulfill(cancelResponse));
  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page).toHaveURL(/checkout-handoff$/);
  await page.goto("/payment");
  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
};

const placement = locator => locator.evaluate(element => {
  const rect = element.getBoundingClientRect();
  const scroller = element.closest(".booking-dialog-body");
  const viewport = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  return {
    top: rect.top,
    bottom: rect.bottom,
    viewportTop: viewport.top,
    viewportBottom: viewport.bottom,
    inView: rect.top >= viewport.top && rect.bottom <= viewport.bottom,
  };
});

const settled = locator => locator.evaluate(element => {
  for (let node = element; node; node = node.parentElement) {
    if (Number(getComputedStyle(node).opacity) < 0.999) return false;
  }
  return true;
});

for (const viewport of [null, { width: 390, height: 844 }]) {
  test(`payment error raised below the banner is brought into view and stays${viewport ? " on mobile" : ""}`, async ({ page, flow }, info) => {
    if (viewport) await page.setViewportSize(viewport);
    await openStartedPayment(page, flow, {
      status: 409,
      json: { ...cancelResponses.needs_recovery.body, recoveryReason: recoveryMessage, error: recoveryMessage },
    });
    const alert = page.getByRole("alert").filter({ hasText: recoveryMessage });
    await expect(alert).toBeVisible();
    await expect.poll(() => settled(alert)).toBe(true);
    await expect.poll(() => placement(alert).then(result => result.inView)).toBe(true);
    await page.waitForTimeout(5000);
    await expect(alert).toBeVisible();
    expect(await placement(alert)).toMatchObject({ inView: true });
    await page.screenshot({ path: info.outputPath("payment-error-in-view.png") });
    await alert.getByRole("button", { name: "Close", exact: true }).click();
    await expect(alert).toHaveCount(0);
  });

  for (const action of ["Check payment status", "Resume checkout"]) {
    test(`payment recovery instructions raised below the banner are brought into view after ${action}${viewport ? " on mobile" : ""}`, async ({ page, flow }, info) => {
      await page.setViewportSize(viewport || { width: 1440, height: 900 });
      await flow.upgrade();
      await page.getByRole("button", { name: "Check eligibility", exact: true }).click();
      await page.getByRole("button", { name: "Proceed to Payment", exact: true }).click();
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect(page).toHaveURL(/checkout-handoff$/);
      await page.goto("/payment");
      const message = "Your payment was received. Roo Industries will contact you about your upgrade.";
      const response = {
        status: 200,
        json: { ok: true, status: "needs_recovery", provider: "dodo", manualReviewRequired: true, recoveryReason: message },
      };
      await page.route("**/api/payment/finalize", route => route.fulfill(response));
      await page.route("**/api/payment/status", route => route.fulfill(response));
      await page.getByRole("button", { name: action, exact: true }).click();
      const status = page.getByRole("status").filter({ hasText: message });
      await expect(status).toBeVisible();
      await expect.poll(() => settled(status)).toBe(true);
      await expect.poll(() => placement(status).then(result => result.inView)).toBe(true);
      await page.waitForTimeout(5000);
      await expect(status).toBeVisible();
      expect(await placement(status)).toMatchObject({ inView: true });
      await page.screenshot({ path: info.outputPath("payment-recovery-in-view.png") });
    });
  }
}

test("payment success banner still clears itself", async ({ page, flow }) => {
  await openStartedPayment(page, flow, {
    status: 200,
    json: {
      ok: true,
      cancelled: true,
      refreshedHold: {
        slotHoldId: "slotHold.fixture",
        slotHoldToken: "fixture-hold-token",
        slotHoldExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    },
  });
  const status = page.getByRole("status").filter({ hasText: "Payment method released. Choose a payment method below." });
  await expect(status).toBeVisible();
  await expect.poll(() => settled(status)).toBe(true);
  await expect(status).toHaveCount(0, { timeout: 6000 });
});

test("a captured upgrade opens its receipt after closing during Change payment method", async ({ page, flow }) => {
  await flow.upgrade();
  await page.getByRole("button", { name: "Check eligibility", exact: true }).click();
  await page.getByRole("button", { name: "Proceed to Payment", exact: true }).click();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page).toHaveURL(/checkout-handoff$/);
  await page.goto("/payment");
  let requested = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/payment/cancel", async route => {
    requested = true;
    await gate;
    await route.fulfill({ status: 200, json: { captured: true, status: "booked", bookingId: "upgrade-confirmed" } });
  });
  try {
    await page.getByRole("button", { name: "Change payment method", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    const newer = { holdId: "new-hold", holdToken: "new-token", startTimeUTC: "2099-01-05T04:30:00.000Z",
      expiresAt: "2099-01-05T04:45:00.000Z", phase: "active" };
    const checkout = { slotHoldId: newer.holdId, slotHoldToken: newer.holdToken };
    await page.evaluate(({ newer, checkout }) => {
      sessionStorage.setItem("my_slot_hold", JSON.stringify(newer));
      sessionStorage.setItem("checkout_booking_state", JSON.stringify(checkout));
    }, { newer, checkout });
    release();
    await expect(page).toHaveURL(/\/payment-success$/);
    expect(await page.evaluate(() => history.state.usr.bookingConfirmation.bookingId)).toBe("upgrade-confirmed");
    await expect(page.getByRole("heading", { name: "Payment Successful", exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")))).toEqual(newer);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state")))).toEqual(checkout);
  } finally { release(); }
});
