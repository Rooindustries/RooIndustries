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
