const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

const expiredMessage = "The reservation expired. Please choose a slot again.";
const holdLifetime = 21 * 60 * 1000;
const shortHold = 15000;

const storedHold = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold") || "null"));
const draftEmail = page => page.evaluate(() => {
  const draft = JSON.parse(sessionStorage.getItem("booking_draft") || "null");
  return Object.values(draft?.packages || {}).map(entry => entry?.form?.email).find(Boolean) || null;
});

const reserveAgainKeepsDetails = async (page, flow, holdMs = 20 * 60 * 1000) => {
  flow.state.holds.clear();
  flow.state.holdMs = holdMs;
  const slot = page.getByRole("button", { name: "10:00 AM", exact: true });
  if (!await slot.isVisible()) await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await slot.click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("visitor@example.invalid");
  await expect(page.getByRole("textbox", { name: "Discord username", exact: true })).toHaveValue("fixture_visitor");
};

test("expiry on the details step keeps the booking open with the typed details", async ({ page, flow }) => {
  flow.state.holdMs = shortHold;
  await flow.reserve();
  await flow.details();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
  await expect(page.getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible({ timeout: 25000 });
  await expect(page).toHaveURL(/\/booking$/);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "10:00 AM", exact: true })).toBeVisible();
  expect(await storedHold(page)).toBeNull();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
  await page.reload();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
  await reserveAgainKeepsDetails(page, flow);
});

test("a full browser store still keeps the typed details when the reservation expires", async ({ page, flow }) => {
  flow.state.holdMs = shortHold;
  await flow.reserve();
  await flow.details();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
  const quota = await page.evaluate(() => {
    const text = "x".repeat(8 * 1024 * 1024);
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      try {
        sessionStorage.setItem("roo-hold-quota", text.slice(0, middle));
        low = middle;
      } catch {
        high = middle - 1;
      }
    }
    try {
      sessionStorage.setItem("roo-hold-quota-extra", "x");
      return "";
    } catch (error) {
      return error.name;
    }
  });
  expect(quota).toBe("QuotaExceededError");
  await expect(page.getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible({ timeout: 25000 });
  expect(await storedHold(page)).toBeNull();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
  await page.reload();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
});

test("expiry on the payment page returns to slot selection with the reason", async ({ page, flow }) => {
  flow.state.holdMs = shortHold;
  await flow.review();
  await flow.payment();
  await expect(page).toHaveURL(/\/booking$/, { timeout: 25000 });
  await expect(page.getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await storedHold(page)).toBeNull();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
  await reserveAgainKeepsDetails(page, flow);
});

test("details typed after the browser store filled survive expiry on the payment page", async ({ page, flow }) => {
  flow.state.holdMs = shortHold;
  await flow.reserve();
  await page.evaluate(() => {
    const text = "x".repeat(8 * 1024 * 1024);
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      try {
        sessionStorage.setItem("roo-hold-quota", text.slice(0, middle));
        low = middle;
      } catch {
        high = middle - 1;
      }
    }
  });
  await flow.details();
  expect(await draftEmail(page)).toBeNull();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await flow.payment();
  await expect(page).toHaveURL(/\/booking$/, { timeout: 25000 });
  await expect(page.getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible();
  await page.evaluate(() => sessionStorage.removeItem("roo-hold-quota"));
  await reserveAgainKeepsDetails(page, flow);
  await expect(page.getByRole("textbox", { name: "PC specifications", exact: true })).toHaveValue("Ryzen 7700 / RTX 4070");
});

for (const route of ["/booking", "/payment"]) {
  test(`reloading ${route} after the reservation expired keeps the typed details`, async ({ page, flow }) => {
    if (route === "/payment") {
      await flow.review();
      await flow.payment();
    } else {
      await flow.reserve();
      await flow.details();
    }
    await page.evaluate(() => {
      const expiresAt = new Date(Date.now() - 60000).toISOString();
      const hold = JSON.parse(sessionStorage.getItem("my_slot_hold"));
      sessionStorage.setItem("my_slot_hold", JSON.stringify({ ...hold, expiresAt }));
      const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "null");
      if (checkout) sessionStorage.setItem("checkout_booking_state", JSON.stringify({ ...checkout, slotHoldExpiresAt: expiresAt }));
      const state = history.state;
      if (state?.usr?.bookingData) {
        history.replaceState({ ...state, usr: { ...state.usr, bookingData: { ...state.usr.bookingData, slotHoldExpiresAt: expiresAt } } }, "");
      }
    });
    await page.reload();
    await expect(page).toHaveURL(/\/booking$/);
    await expect(page.getByRole("dialog").getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible();
    expect(await storedHold(page)).toBeNull();
    expect(await draftEmail(page)).toBe("visitor@example.invalid");
    await reserveAgainKeepsDetails(page, flow);
  });
}

test("same-tab payment expiry on the booking step stays in the booking flow", async ({ page, flow }) => {
  await page.clock.install();
  await flow.reserve();
  await flow.details();
  const original = { ...await storedHold(page), phase: "payment_pending" };
  await page.evaluate(value => sessionStorage.setItem("my_slot_hold", JSON.stringify(value)), original);
  await page.reload();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.clock.fastForward(holdLifetime);
  await page.clock.runFor(2000);
  await expect(page).toHaveURL(/\/booking$/);
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await storedHold(page)).toMatchObject({ holdId: original.holdId, phase: "payment_pending" });
});

test("releasing a payment after the reservation expired keeps the typed details", async ({ page, flow }) => {
  flow.state.holdMs = shortHold;
  await flow.reserve();
  await flow.details();
  const original = { ...await storedHold(page), phase: "payment_pending" };
  await page.evaluate(value => {
    sessionStorage.setItem("my_slot_hold", JSON.stringify(value));
    sessionStorage.setItem("payment_session_state", JSON.stringify({ paymentAccessToken: "fixture-payment" }));
  }, original);
  await page.route("**/api/payment/cancel", route => route.fulfill({ json: { ok: true, cancelled: true, slotReleased: true } }));
  await page.reload();
  const releasePayment = page.getByRole("button", { name: "Release payment", exact: true });
  await expect(releasePayment).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "This reservation expired while payment is still pending." })).toBeVisible({ timeout: 25000 });
  await releasePayment.click();
  await expect(page.getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible();
  expect(await storedHold(page)).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
  await page.reload();
  await expect(page.getByRole("dialog")).toBeVisible();
  await reserveAgainKeepsDetails(page, flow);
});

test("releasing the slot right after it expired keeps the typed details", async ({ page, flow }) => {
  await page.clock.install();
  await flow.reserve();
  await flow.details();
  const { expiresAt } = await storedHold(page);
  await page.clock.setSystemTime(Date.parse(expiresAt) + 100);
  await page.getByRole("button", { name: "Release Slot", exact: true }).click();
  await expect.poll(() => storedHold(page)).toBeNull();
  await expect(page.getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
  await reserveAgainKeepsDetails(page, flow, 60 * 60 * 1000);
});

test("a release that finishes after the deadline keeps the typed details and the reason", async ({ page, flow }) => {
  await page.clock.install();
  await flow.reserve();
  await flow.details();
  const { expiresAt } = await storedHold(page);
  let finishRelease;
  const releaseFinished = new Promise((resolve) => {
    finishRelease = resolve;
  });
  await page.route("**/api/releaseHold", async (route) => {
    await releaseFinished;
    await route.fulfill({ json: { ok: true } });
  });
  const releaseStarted = page.waitForRequest("**/api/releaseHold");
  const releaseClick = page.getByRole("button", { name: "Release Slot", exact: true }).click();
  await releaseStarted;
  await page.clock.setSystemTime(Date.parse(expiresAt) + 1000);
  finishRelease();
  await releaseClick;
  await expect(page.getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible();
  expect(await storedHold(page)).toBeNull();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
  expect(await page.evaluate(() => sessionStorage.getItem("booking_hold_expired"))).toBe("1");
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
});

const startPayment = async (page, flow) => {
  await page.clock.install();
  await flow.reserve();
  await flow.details();
  const hold = { ...await storedHold(page), phase: "payment_pending" };
  await page.evaluate(value => {
    sessionStorage.setItem("my_slot_hold", JSON.stringify(value));
    sessionStorage.setItem("payment_session_state", JSON.stringify({ paymentAccessToken: "fixture-payment" }));
  }, hold);
  return hold;
};
const paymentSession = page => page.evaluate(() => sessionStorage.getItem("payment_session_state"));

test("reloading after a payment-pending reservation expired keeps its payment controls", async ({ page, flow }) => {
  const hold = await startPayment(page, flow);
  await page.clock.setSystemTime(Date.parse(hold.expiresAt) + 1000);
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "This reservation expired while payment is still pending." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Release payment", exact: true })).toBeVisible();
  expect(await storedHold(page)).toMatchObject({ holdId: hold.holdId, phase: "payment_pending" });
  expect(await paymentSession(page)).not.toBeNull();
});

test("a payment-pending reservation that expires away from the booking flow is kept for its payment", async ({ page, flow }) => {
  const hold = await startPayment(page, flow);
  await page.reload();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.clock.fastForward(holdLifetime);
  await page.clock.runFor(2000);
  expect(await storedHold(page)).toMatchObject({ holdId: hold.holdId, phase: "payment_pending" });
  expect(await paymentSession(page)).not.toBeNull();
  await page.clock.setSystemTime(Date.parse(hold.expiresAt) + 5000);
  await page.reload();
  expect(await storedHold(page)).toMatchObject({ holdId: hold.holdId, phase: "payment_pending" });
});

test("a banner release that lands after the deadline keeps the typed details", async ({ page, flow }) => {
  await page.clock.install();
  await flow.reserve();
  await flow.details();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const { expiresAt } = await storedHold(page);
  await page.clock.setSystemTime(Date.parse(expiresAt) - 300);
  await page.route("**/api/releaseHold", async route => {
    await page.clock.setSystemTime(Date.parse(expiresAt) + 200);
    await route.fulfill({ json: { ok: true } });
  });
  await page.getByRole("button", { name: "Release", exact: true }).click();
  await expect.poll(() => storedHold(page)).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("booking_hold_expired"))).toBe("1");
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
});

test("expiry away from the booking flow clears the reservation without moving the visitor and keeps the details", async ({ page, flow }) => {
  flow.state.holdMs = shortHold;
  await flow.reserve();
  await flow.details();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const continueBooking = page.getByRole("button", { name: "Continue booking", exact: true });
  await expect(continueBooking).toBeVisible();
  const url = page.url();
  await expect(continueBooking).toHaveCount(0, { timeout: 25000 });
  expect(page.url()).toBe(url);
  expect(await storedHold(page)).toBeNull();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
  await page.goto("/booking");
  await expect(page.getByRole("dialog")).toBeVisible();
  await reserveAgainKeepsDetails(page, flow);
});

test("an applied coupon survives an expiry and reaches the next payment quote", async ({ page, flow }) => {
  flow.state.holdMs = 60000;
  await page.clock.install();
  await flow.review();
  await flow.codeInput("save20");
  await expect(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toBeVisible();
  const { expiresAt } = await storedHold(page);
  await page.clock.setSystemTime(Date.parse(expiresAt) + 1000);
  await page.clock.runFor(2100);
  await expect(page.getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible();
  await reserveAgainKeepsDetails(page, flow, 30 * 60 * 1000);
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await flow.payment();
  await expect.poll(() => flow.state.calls.filter(call => call.path === "/api/payment/quote").length).toBeGreaterThan(0);
  expect(flow.state.calls.filter(call => call.path === "/api/payment/quote").at(-1).body.couponCode).toBe("save20");
});

const lastQuoteCoupon = flow => flow.state.calls.filter(call => call.path === "/api/payment/quote").at(-1)?.body.couponCode;
const quoteSettles = async (page, flow, code) => {
  await expect.poll(() => lastQuoteCoupon(flow)).toBe(code);
  await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
};
const applyPaymentCoupon = async (page, code) => {
  const input = page.getByRole("textbox", { name: "Coupon Code (optional)", exact: true });
  await input.fill(code);
  await input.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
};
const expireAndReturnToPayment = async (page, flow) => {
  await expect(page).toHaveURL(/\/booking$/, { timeout: 25000 });
  await expect(page.getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible();
  await reserveAgainKeepsDetails(page, flow, 30 * 60 * 1000);
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await flow.payment();
};

test("a coupon removed on the payment page stays removed after an expiry", async ({ page, flow }) => {
  flow.state.holdMs = shortHold;
  await flow.review();
  await flow.codeInput("save20");
  await expect(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toBeVisible();
  await flow.payment();
  await quoteSettles(page, flow, "save20");
  await page.getByRole("button", { name: "Remove coupon", exact: true }).click();
  await quoteSettles(page, flow, "");
  await expireAndReturnToPayment(page, flow);
  await quoteSettles(page, flow, "");
});

test("a coupon applied on the payment page survives an expiry", async ({ page, flow }) => {
  flow.state.holdMs = shortHold;
  await flow.review();
  await flow.payment();
  await quoteSettles(page, flow, "");
  await applyPaymentCoupon(page, "save20");
  await quoteSettles(page, flow, "save20");
  await expireAndReturnToPayment(page, flow);
  await quoteSettles(page, flow, "save20");
});

test("a coupon cleared on the payment page stays cleared after a reload", async ({ page, flow }) => {
  await flow.review();
  await flow.codeInput("save20");
  await expect(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toBeVisible();
  await flow.payment();
  await quoteSettles(page, flow, "save20");
  await applyPaymentCoupon(page, "");
  await quoteSettles(page, flow, "");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
  await quoteSettles(page, flow, "");
});

test("an invalid coupon on the payment page keeps its message after replacing the earlier coupon", async ({ page, flow }) => {
  await flow.review();
  await flow.payment();
  await quoteSettles(page, flow, "");
  await applyPaymentCoupon(page, "save20");
  await quoteSettles(page, flow, "save20");
  await applyPaymentCoupon(page, "nosuchcode");
  await expect(page.locator("#payment-coupon-code-error")).toHaveText("Invalid referral or coupon code.");
  await quoteSettles(page, flow, "");
  await expect(page.locator("#payment-coupon-code-error")).toHaveText("Invalid referral or coupon code.");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
  await quoteSettles(page, flow, "");
});

const startNearDeadline = async (page, flow) => {
  flow.state.holdMs = 20000;
  await flow.review();
  await flow.payment();
  await quoteSettles(page, flow, "");
  const start = {};
  await page.route("**/api/payment/start", route => {
    start.route = route;
    start.body = route.request().postDataJSON();
  });
  const original = await storedHold(page);
  await expect.poll(() => Date.parse(original.expiresAt) - Date.now() < 3000, { timeout: 20000 }).toBe(true);
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => Boolean(start.route)).toBe(true);
  await expect.poll(() => Date.now() > Date.parse(original.expiresAt) + 1500, { timeout: 10000 }).toBe(true);
  await expect(page).toHaveURL(/\/payment$/);
  return { original, start };
};

test("a payment start answered after the old deadline keeps the renewed reservation and its payment", async ({ page, flow }) => {
  const { original, start } = await startNearDeadline(page, flow);
  const renewed = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  await start.route.fulfill({ json: {
    ok: true, provider: "dodo", status: "started", paymentAccessToken: "fixture-accepted-payment",
    quoteFingerprint: start.body.quoteFingerprint, sessionExpiresAt: renewed,
    providerPayload: { checkoutUrl: new URL("/__test/checkout-handoff", page.url()).href },
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
    refreshedHold: { slotHoldId: original.holdId, slotHoldToken: original.holdToken, slotHoldExpiresAt: renewed, phase: "payment_pending" },
  } });
  await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
  expect(JSON.parse(await paymentSession(page))).toMatchObject({ paymentAccessToken: "fixture-accepted-payment" });
  expect(await storedHold(page)).toMatchObject({ holdId: original.holdId, phase: "payment_pending", expiresAt: renewed });
});

test("a payment start refused after the old deadline returns to slot selection with the details", async ({ page, flow }) => {
  const { start } = await startNearDeadline(page, flow);
  await start.route.fulfill({ status: 409, json: { ok: false, error: "This reservation expired." } });
  await expect(page).toHaveURL(/\/booking$/, { timeout: 10000 });
  await expect(page.getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible();
  expect(await paymentSession(page)).toBeNull();
  await reserveAgainKeepsDetails(page, flow);
});
