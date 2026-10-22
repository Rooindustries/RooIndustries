const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

const storedHold = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold") || "null"));

const routeAbandonedDodo = async page => {
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
        slotHoldToken: `${bookingPayload.slotHoldToken}-started`,
        slotHoldExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
        phase: "payment_pending",
      },
    } });
  });
  await page.route("**/api/payment/status", route => route.fulfill({ json: { ok: true, status: "abandoned", provider: "dodo" } }));
  return starts;
};

const startDodoCheckout = async (page, flow, starts) => {
  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(starts).toHaveLength(1);
};

test("a new reservation after an abandoned checkout opens a fresh checkout and keeps the new hold", async ({ page, flow }) => {
  const starts = await routeAbandonedDodo(page);
  await startDodoCheckout(page, flow, starts);

  await page.evaluate(() => {
    sessionStorage.removeItem("my_slot_hold");
    sessionStorage.removeItem("checkout_booking_state");
  });
  await page.route("**/api/holdSlot", route => route.fulfill({ json: {
    ok: true, holdId: starts[0].slotHoldId, holdToken: "fixture-token-new-reservation",
    expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    startTimeUTC: route.request().postDataJSON().startTimeUTC,
  } }));
  await flow.review();
  const newHold = await storedHold(page);
  expect(newHold.holdId).toBe(starts[0].slotHoldId);
  expect(newHold.holdToken).not.toBe(starts[0].slotHoldToken);
  await flow.payment();
  await page.getByRole("button", { name: "Resume checkout", exact: true }).click();

  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(starts).toHaveLength(2);
  expect(starts[1]).toMatchObject({ slotHoldId: newHold.holdId, slotHoldToken: newHold.holdToken });
  expect(await storedHold(page)).toMatchObject({ holdId: newHold.holdId, holdToken: `${newHold.holdToken}-started` });
});

test("an abandoned checkout for the same reservation still releases it after reloading the payment page", async ({ page, flow }) => {
  const starts = await routeAbandonedDodo(page);
  await startDodoCheckout(page, flow, starts);

  await page.goBack();
  await expect(page).toHaveURL(/\/payment$/);
  await page.reload();
  await page.getByRole("button", { name: "Resume checkout", exact: true }).click();

  await expect(page.getByText("Payment was not completed and the slot was released. Go back to booking to choose a time.", { exact: true })).toBeVisible();
  expect(starts).toHaveLength(1);
  expect(await storedHold(page)).toBeNull();
});
