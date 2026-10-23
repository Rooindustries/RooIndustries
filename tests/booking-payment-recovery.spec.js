const fs = require("node:fs");
const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

for (const width of [1280, 360, 390]) {
  for (const outcome of ["booked", "missing-token", "review", "unavailable", "unauthorized"]) {
    const savedToken = outcome !== "missing-token";
    test(`${width}px returning to an expired pending payment ${outcome}`, async ({ page, flow }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await flow.review();
      await flow.payment();
      await page.evaluate(saved => {
        const hold = JSON.parse(sessionStorage.getItem("my_slot_hold"));
        hold.phase = "payment_pending";
        hold.expiresAt = new Date(Date.now() - 60000).toISOString();
        const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state"));
        checkout.slotHoldExpiresAt = hold.expiresAt;
        sessionStorage.setItem("my_slot_hold", JSON.stringify(hold));
        sessionStorage.setItem("checkout_booking_state", JSON.stringify(checkout));
        if (saved) sessionStorage.setItem("payment_session_state", JSON.stringify({
          provider: "dodo", paymentAccessToken: "fixture-return-access", providerPayload: { checkoutUrl: "/__test/checkout-handoff" },
          fingerprint: JSON.stringify({ packageTitle: checkout.packageTitle, originalOrderId: "", startTimeUTC: checkout.startTimeUTC,
            email: checkout.email, referralCode: "", couponCode: "" }),
        }));
        else sessionStorage.removeItem("payment_session_state");
      }, savedToken);
      await page.goto("/booking");
      await page.getByRole("button", { name: "Return to payment", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
      if (savedToken) {
        const before = await page.evaluate(() => Object.fromEntries(
          ["my_slot_hold", "booking_draft", "checkout_booking_state", "payment_session_state"].map(key => [key, sessionStorage.getItem(key)])
        ));
        const reply = outcome === "review" ? { status: 200, json: { ok: true, manualReviewRequired: true, recoveryReason: "Fixture payment needs review." } }
          : outcome === "unavailable" || outcome === "unauthorized" ? { status: outcome === "unavailable" ? 503 : 401, json: { ok: false, error: "Fixture payment check unavailable." } }
          : { json: {
          ok: true, status: "booked", bookingId: "fixture-expired-paid", emailDispatch: { allSent: true },
        } };
        await page.route("**/api/payment/finalize", route => route.fulfill(reply));
        await page.getByRole("button", { name: "Check payment status", exact: true }).click();
        if (outcome === "booked") {
          await expect(page.getByRole("heading", { name: "Payment Successful", exact: true })).toBeVisible();
        } else {
          await expect(page.getByText(outcome === "review" ? "Fixture payment needs review." : "Fixture payment check unavailable.", { exact: true })).toBeVisible();
          await expect(page).toHaveURL(url => url.pathname === "/payment");
          const after = await page.evaluate(() => Object.fromEntries(
            ["my_slot_hold", "booking_draft", "checkout_booking_state", "payment_session_state"].map(key => [key, sessionStorage.getItem(key)])
          ));
          expect(after).toEqual(before);
          await testInfo.attach("retained-pending-payment", { body: JSON.stringify({ outcome, before, after }), contentType: "application/json" });
        }
      } else {
        await expect(page.getByText("Your payment reservation is saved. Go back to booking and choose Check again to recover it.", { exact: true })).toBeVisible();
        await expect(page).toHaveURL(url => url.pathname === "/payment");
        expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")).phase)).toBe("payment_pending");
        await page.goto("/booking");
        flow.state.holds.clear();
        await page.getByRole("button", { name: "Check again", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("visitor@example.invalid");
      }
    });
  }
}

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
