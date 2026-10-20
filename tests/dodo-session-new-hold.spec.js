const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

const storedHold = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold") || "null"));

test("a new reservation after an abandoned checkout opens a fresh checkout and keeps the new hold", async ({ page, flow }) => {
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    const { bookingPayload } = route.request().postDataJSON();
    starts.push(bookingPayload);
    await route.fulfill({ json: {
      ok: true, status: "started", provider: "dodo",
      paymentAccessToken: `fixture-payment-${starts.length}`,
      providerPayload: { checkoutUrl: `${new URL(page.url()).origin}/__test/checkout-handoff` },
      sessionExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      refreshedHold: {
        slotHoldId: bookingPayload.slotHoldId,
        slotHoldToken: bookingPayload.slotHoldToken,
        slotHoldExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
        phase: "payment_pending",
      },
    } });
  });
  await page.route("**/api/payment/status", route => route.fulfill({ json: { ok: true, status: "abandoned", provider: "dodo" } }));

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(starts).toHaveLength(1);

  await page.evaluate(() => {
    sessionStorage.removeItem("my_slot_hold");
    sessionStorage.removeItem("checkout_booking_state");
  });
  flow.state.holds.clear();
  await flow.review();
  const newHold = await storedHold(page);
  expect(newHold.holdToken).not.toBe(starts[0].slotHoldToken);
  await flow.payment();
  await page.getByRole("button", { name: "Resume checkout", exact: true }).click();

  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(starts).toHaveLength(2);
  expect(starts[1]).toMatchObject({ slotHoldId: newHold.holdId, slotHoldToken: newHold.holdToken });
  expect(await storedHold(page)).toMatchObject({ holdId: newHold.holdId, holdToken: newHold.holdToken });
});
