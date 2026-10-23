const fs = require("node:fs");
const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

for (const width of [1280, 360, 390]) {
  test(`${width}px a pending payment without its saved token can recheck the reservation`, async ({ page, flow }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 568 : 900 });
    await flow.review();
    await flow.payment();
    const original = await page.evaluate(() => {
      const hold = JSON.parse(sessionStorage.getItem("my_slot_hold"));
      hold.phase = "payment_pending";
      hold.expiresAt = new Date(Date.now() - 60000).toISOString();
      const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state"));
      checkout.slotHoldExpiresAt = hold.expiresAt;
      sessionStorage.setItem("my_slot_hold", JSON.stringify(hold));
      sessionStorage.setItem("checkout_booking_state", JSON.stringify(checkout));
      sessionStorage.removeItem("payment_session_state");
      return hold;
    });
    await page.goto("/booking");
    await expect(page.getByRole("button", { name: "Release payment", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Release payment", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Return to payment once so the active session can be checked." })).toBeVisible();
    const recheck = page.getByRole("button", { name: "Check again", exact: true });
    await expect(recheck).toBeVisible();
    await expect(recheck).toBeInViewport();
    await page.route("**/api/holdSlot", route => route.fulfill({ status: 409, json: {
      ok: false, code: "hold_payment_in_progress", message: "This hold belongs to an active payment session.",
    } }));
    await recheck.click();
    await expect(recheck).toBeEnabled();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")))).toEqual({ ...original, paymentStartedElsewhere: true });
    await page.unroute("**/api/holdSlot");
    flow.state.holds.clear();
    await recheck.click();
    await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("visitor@example.invalid");
    const recovered = await page.evaluate(() => ({
      hold: JSON.parse(sessionStorage.getItem("my_slot_hold")),
      draft: JSON.parse(sessionStorage.getItem("booking_draft")),
    }));
    expect(recovered.hold.phase).toBe("active");
    expect(recovered.hold.holdToken).not.toBe(original.holdToken);
    await page.getByRole("button", { name: "Review before payment", exact: true }).click();
    await flow.payment();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state")).slotHoldToken)).toBe(recovered.hold.holdToken);
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(testInfo.outputPath("missing-payment-token.json"), JSON.stringify({ original, recovered }, null, 2));
  });
}

for (const width of [1280, 360, 390]) {
  test(`${width}px a pending server release keeps the payment reservation and details`, async ({ page, flow }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await flow.review();
    await flow.payment();
    await page.evaluate(() => {
      const hold = JSON.parse(sessionStorage.getItem("my_slot_hold"));
      hold.phase = "payment_pending";
      sessionStorage.setItem("my_slot_hold", JSON.stringify(hold));
      sessionStorage.setItem("payment_session_state", JSON.stringify({ paymentAccessToken: "fixture-pending-release" }));
    });
    await page.goto("/booking");
    const release = page.getByRole("button", { name: "Release payment", exact: true });
    await expect(release).toBeVisible();
    const snapshot = () => page.evaluate(() => Object.fromEntries(
      ["my_slot_hold", "booking_draft", "checkout_booking_state", "payment_session_state", "booking_hold_expired"]
        .map(key => [key, sessionStorage.getItem(key)]),
    ));
    const before = await snapshot();
    await page.route("**/api/payment/cancel", route => route.fulfill({ status: 202, json: {
      ok: false, cancelled: false, status: "abandoned", error: "Your payment is still being released. Please try again.",
    } }));
    await release.click();
    await expect(page.getByRole("alert").filter({ hasText: "Your payment is still being released. Please try again." })).toBeVisible();
    await expect(release).toBeEnabled();
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(after.booking_hold_expired).toBeNull();
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(testInfo.outputPath("pending-server-release.json"), JSON.stringify({ before, after }, null, 2));
  });
}
