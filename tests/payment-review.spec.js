const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", headless: true, video: "on" });

for (const [width, terminal] of [[360, 'booked'], [390, 'booked'], [1440, 'booked'], [390, 'failed'], [390, 'refunded']]) {
  test(`review keeps the booking until ${terminal} at ${width}px`, async ({ page, context, flow }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    let approved = false;
    let reviewing = false;
    let checkout;
    let starts = 0;
    const statusBody = () => approved ? {
      ok: true, status: terminal, bookingId: terminal === 'booked' ? "review-booking" : "", provider: "dodo",
      bookingSummary: { packageTitle: checkout.packageTitle, email: checkout.email,
        startTimeUTC: checkout.startTimeUTC, localTimeZone: checkout.localTimeZone,
        netAmount: 84.99, currency: "USD" },
      emailDispatch: { allSent: true },
    } : reviewing ? {
      ok: true, status: "needs_recovery", provider: "dodo", reviewPending: true,
      recoveryReason: "Your booking is pending review. Your time is reserved and your details are saved. It will confirm automatically when the review clears.",
      refreshedHold: { slotHoldId: checkout.slotHoldId, slotHoldToken: "review-held-token",
        slotHoldExpiresAt: "9999-12-31T23:59:59.999Z", phase: "payment_pending" },
    } : { ok: true, status: "started", provider: "dodo" };
    await context.route("**/api/payment/status", route => route.fulfill({ json: statusBody() }));
    await context.route("**/api/payment/finalize", route => route.fulfill({ json: statusBody() }));
    await context.route("**/api/payment/start", async route => {
      starts += 1;
      checkout = route.request().postDataJSON().bookingPayload;
      await route.fulfill({ json: {
        ok: true, status: "started", provider: "dodo", paymentAccessToken: "review-payment-token",
        providerPayload: { checkoutUrl: `${new URL(page.url()).origin}/__test/checkout-handoff` },
        refreshedHold: { slotHoldId: checkout.slotHoldId, slotHoldToken: checkout.slotHoldToken,
          slotHoldExpiresAt: new Date(Date.now() + 1200000).toISOString(), phase: "payment_pending" },
      } });
    });
    await flow.review();
    await flow.payment();
    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page).toHaveURL(/checkout-handoff$/);
    reviewing = true;
    await page.goBack();
    await expect(page.getByText(/Your booking is pending review/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeDisabled();
    await expect(page.getByText("Reserved while your payment is reviewed", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("pending-review.png") });
    await page.getByRole("button", { name: "Resume checkout", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("pending-review-controls.png") });
    await page.reload();
    await expect(page.getByText(/Your booking is pending review/)).toBeVisible();
    await page.goto("/about");
    await page.goBack();
    await expect(page.getByText(/Your booking is pending review/)).toBeVisible();
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state")));
    expect(saved.email).toBe(checkout.email);
    expect(saved.slotHoldToken).toBe("review-held-token");
    let secondTab;
    if (width === 390) {
      const opened = context.waitForEvent("page");
      await page.evaluate(() => window.open("/payment", "_blank"));
      secondTab = await opened;
      await expect(secondTab.getByText(/Your booking is pending review/)).toBeVisible();
    }
    approved = true;
    if (terminal === 'booked') {
      await expect(page).toHaveURL(/\/payment-success$/, { timeout: 15000 });
      if (secondTab) await expect(secondTab).toHaveURL(/\/payment-success$/, { timeout: 15000 });
    } else {
      const message = terminal === 'refunded' ? /This payment was refunded/ : /Payment was not completed and the slot was released/;
      await expect(page.getByText(message)).toBeVisible({ timeout: 15000 });
      if (secondTab) await expect(secondTab.getByText(message)).toBeVisible({ timeout: 15000 });
      expect(await page.evaluate(() => sessionStorage.getItem('my_slot_hold'))).toBeNull();
      const retained = await page.evaluate(() => JSON.parse(sessionStorage.getItem('checkout_booking_state')));
      expect(retained.email).toBe(checkout.email);
      expect(retained.slotHoldToken).toBe('');
    }
    if (secondTab) await secondTab.close();
    expect(starts).toBe(1);
    await page.screenshot({ path: testInfo.outputPath(`${terminal}.png`) });
    await testInfo.attach("review-flow", { body: JSON.stringify({ starts, width,
      storedDetailsKept: saved.email === checkout.email, terminal }),
    contentType: "application/json" });
  });
}
