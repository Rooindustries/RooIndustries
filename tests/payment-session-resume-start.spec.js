const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

const makeHoldToken = (nonce, holdId = "slotHold.1") =>
  `${Buffer.from(JSON.stringify({ v: 1, hid: holdId, n: nonce })).toString("base64url")}.sig`;

const makePaymentToken = (id) =>
  `${Buffer.from(JSON.stringify({ paymentRecordId: id, provider: "dodo", purpose: "payment-session" })).toString("base64url")}.sig`;

test("ActiveUpgradeBlocker isolates blocking upgrade status and release actions across intent switches", async ({ page, flow }) => {
  let releaseStatus;
  let statusCalls = 0;
  await page.route("**/api/payment/start", (route) =>
    route.fulfill({
      status: 409,
      json: {
        ok: false,
        code: "upgrade_already_in_progress",
        error: "Another upgrade checkout is already in progress.",
        lockedSession: {
          paymentAccessToken: makePaymentToken("pr-block-1"),
          upgradeIntentId: "intent-block-1",
          packageTitle: "Performance Vertex Max",
          provider: "dodo",
          providerOrderReady: true,
          quote: { currency: "USD", grossAmount: 45, netAmount: 45, isFree: false },
        },
      },
    })
  );
  await page.route("**/api/payment/status", async (route) => {
    statusCalls += 1;
    await new Promise((resolve) => { releaseStatus = resolve; });
    await route.fulfill({
      json: { ok: true, status: "booked", bookingId: "booking-stale-upgrade" },
    });
  });

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByText(/Another upgrade checkout is already in progress/i)).toBeVisible();
  await expect(page.getByText("$45.00 USD")).toBeVisible();

  await page.getByRole("button", { name: "Check active upgrade", exact: true }).click();
  await expect.poll(() => statusCalls).toBe(1);

  const nextUpgrade = {
    originalOrderId: "booking-orig-2",
    upgradeIntentToken: makeHoldToken("intent-2", "upgrade"),
    packageTitle: "Performance Vertex Max",
    packagePrice: "$45.00",
    startTimeUTC: "2099-03-03T10:00:00.000Z",
    displayDate: "March 3, 2099",
    displayTime: "10:00 AM",
    localTimeZone: "UTC",
    email: "buyer@example.invalid",
  };
  await page.evaluate((u) => {
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(u));
    window.history.pushState({ usr: { bookingData: u } }, "", "/payment");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, nextUpgrade);

  await expect(page.getByText(/Another upgrade checkout is already in progress/i)).toBeHidden();
  releaseStatus();
  await expect(page.getByText(/already owns/i)).toHaveCount(0);
});

test("Dodo status button routes providerOrderReady false through /api/payment/status and transitions to ready", async ({ page, flow }) => {
  let statusCalls = 0;
  let finalizeCalls = 0;
  await page.route("**/api/payment/start", (route) =>
    route.fulfill({
      json: {
        ok: true,
        status: "started",
        paymentAccessToken: makePaymentToken("pr-prep-1"),
        providerOrderReady: false,
        providerPayload: { orderId: "ord-prep-1", dodoReturnTag: "tag-prep-1" },
        quote: { currency: "USD", grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
      },
    })
  );
  await page.route("**/api/payment/finalize", (route) => {
    finalizeCalls += 1;
    return route.fulfill({ status: 500, json: { ok: false, error: "must not call finalize" } });
  });
  await page.route("**/api/payment/status", (route) => {
    statusCalls += 1;
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "dodo",
        providerOrderReady: true,
        quoteFingerprint: "fixture-quote",
        quoteFingerprintValid: true,
        quote: { currency: "USD", grossAmount: 84.99, netAmount: 84.99, isFree: false },
        providerPayload: {
          orderId: "ord-prep-1",
          checkoutUrl: `${new URL(route.request().url()).origin}/__test/checkout-handoff`,
          dodoReturnTag: "tag-prep-1",
        },
      },
    });
  });

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByText(/still preparing/i)).toBeVisible();
  await expect(page).toHaveURL(/\/payment$/);

  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect.poll(() => statusCalls).toBe(1);
  expect(finalizeCalls).toBe(0);
  await expect(page.getByText(/Your payment session is ready/i)).toBeVisible();

  await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
  await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
});

test("after cancel rotates N1 to N2, stale history N1 does not block starting payment for stored N2", async ({ page, flow }) => {
  const n1 = makeHoldToken("nonce-n1", "slotHold.rot");
  const n2 = makeHoldToken("nonce-n2", "slotHold.rot");
  let startCount = 0;

  await flow.review();
  await flow.payment();

  await page.route("**/api/payment/cancel", (route) =>
    route.fulfill({
      json: {
        ok: true,
        cancelled: true,
        status: "abandoned",
        providerPaymentState: "cancelled",
        terminalOutcomeComplete: true,
        refreshedHold: {
          slotHoldId: "slotHold.rot",
          slotHoldToken: n2,
          slotHoldExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
          phase: "holding",
        },
      },
    })
  );
  await page.route("**/api/payment/start", (route) => {
    startCount += 1;
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        paymentAccessToken: makePaymentToken("pr-after-rot"),
        providerOrderReady: true,
        providerPayload: {
          orderId: "ord-after-rot",
          checkoutUrl: `${new URL(route.request().url()).origin}/__test/checkout-handoff`,
          dodoReturnTag: "tag-after-rot",
        },
        quote: { currency: "USD", grossAmount: 84.99, netAmount: 84.99, isFree: false },
        quoteFingerprint: "fixture-quote",
      },
    });
  });

  await page.evaluate(({ tok1 }) => {
    const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}");
    const nextB = { ...checkout, slotHoldId: "slotHold.rot", slotHoldToken: tok1 };
    const fp = JSON.stringify({
      packageTitle: nextB.packageTitle || "",
      originalOrderId: nextB.originalOrderId || "",
      startTimeUTC: nextB.startTimeUTC || "",
      email: nextB.email || "",
      referralCode: nextB.referralCode || "",
      couponCode: nextB.couponCode || "",
    });
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(nextB));
    sessionStorage.setItem("my_slot_hold", JSON.stringify({
      holdId: "slotHold.rot", holdToken: tok1, expiresAt: nextB.slotHoldExpiresAt,
      startTimeUTC: nextB.startTimeUTC, packageTitle: nextB.packageTitle, phase: "payment_pending",
    }));
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo",
      fingerprint: fp,
      paymentAccessToken: "eyJwYXltZW50UmVjb3JkSWQiOiJwci1uMSIsInByb3ZpZGVyIjoiZG9kbyJ9.sig",
      providerPayload: { orderId: "ord-n1", checkoutUrl: `${location.origin}/__test/checkout-handoff`, dodoReturnTag: "tag-n1" },
      result: { refreshedHold: { slotHoldId: "slotHold.rot", slotHoldToken: tok1 } },
    }));
    window.history.replaceState({ usr: { bookingData: nextB } }, "", "/payment");
  }, { tok1: n1 });

  await page.reload();
  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await expect(page.getByText(/Payment method released/i)).toBeVisible();

  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
  expect(startCount).toBe(1);
});

test("EUR PayPal reload resume verifies currency and amount before reopening order", async ({ page, flow }) => {
  let statusCalls = 0;
  const eurProviders = {
    dodo: { enabled: false, mode: "disabled", currency: "USD" },
    razorpay: { enabled: false, mode: "disabled", currency: "USD" },
    paypal: { enabled: true, mode: "sandbox", currency: "EUR", clientId: "sb-eur-client" },
  };
  await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "window.paypal = { Buttons: (opts) => { window.__ppResumeOpts = opts; return { isEligible: () => true, render: () => Promise.resolve(), close: () => Promise.resolve() }; } };",
    })
  );
  await page.route("**/api/payment/providers", (route) =>
    route.fulfill({ json: { ok: true, providers: eurProviders } })
  );
  await page.route("**/api/payment/quote", (route) =>
    route.fulfill({
      json: {
        ok: true,
        currency: "EUR",
        quoteFingerprint: "fp-eur-resume",
        quote: { currency: "EUR", grossAmount: 9.99, discountAmount: 0, netAmount: 9.99, isFree: false },
        providers: eurProviders,
      },
    })
  );
  await page.route("**/api/payment/status", (route) => {
    statusCalls += 1;
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "paypal",
        providerOrderReady: true,
        quoteFingerprint: "fp-eur-resume",
        quoteFingerprintValid: true,
        quote: { currency: "EUR", grossAmount: 9.99, netAmount: 9.99, isFree: false },
        providerPayload: { orderId: "pp-eur-order-1", currency: "EUR", amount: 999 },
      },
    });
  });

  await flow.review();
  await flow.payment();
  await page.evaluate(() => {
    const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}");
    const hold = JSON.parse(sessionStorage.getItem("my_slot_hold") || "{}");
    const fp = JSON.stringify({
      packageTitle: checkout.packageTitle || "",
      originalOrderId: checkout.originalOrderId || "",
      startTimeUTC: checkout.startTimeUTC || "",
      email: checkout.email || "",
      referralCode: checkout.referralCode || "",
      couponCode: checkout.couponCode || "",
    });
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "paypal",
      fingerprint: fp,
      paymentAccessToken: "eyJwYXltZW50UmVjb3JkSWQiOiJwci1ldXItMSIsInByb3ZpZGVyIjoicGF5cGFsIn0.sig",
      providerOrderReady: true,
      providerPayload: { orderId: "pp-eur-order-1", currency: "EUR", amount: 999 },
      result: { refreshedHold: { slotHoldId: hold.holdId, slotHoldToken: hold.holdToken, slotHoldExpiresAt: hold.expiresAt } },
    }));
  });

  await page.reload();
  await expect(page.getByText("9.99 EUR")).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__ppResumeOpts?.createOrder));
  const reopenedOrderId = await page.evaluate(() => window.__ppResumeOpts.createOrder());
  expect(reopenedOrderId).toBe("pp-eur-order-1");
  expect(statusCalls).toBe(1);
});

test("Dodo terminal failure clears hold only on affirmative terminalOutcomeComplete", async ({ page, flow }) => {
  let complete = false;
  await page.route("**/api/payment/finalize", (route) =>
    route.fulfill({
      json: complete
        ? { ok: true, status: "failed", providerPaymentState: "failed", terminalOutcomeComplete: true, cleanupPending: false, manualReviewRequired: false }
        : { ok: true, status: "failed", providerPaymentState: "processing", terminalOutcomeComplete: false, cleanupPending: true, manualReviewRequired: false, recoveryReason: "Payment is still being verified." },
    })
  );

  await flow.review();
  await flow.payment();
  await page.evaluate(() => {
    const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}");
    const hold = JSON.parse(sessionStorage.getItem("my_slot_hold") || "{}");
    const fp = JSON.stringify({
      packageTitle: checkout.packageTitle || "",
      originalOrderId: checkout.originalOrderId || "",
      startTimeUTC: checkout.startTimeUTC || "",
      email: checkout.email || "",
      referralCode: checkout.referralCode || "",
      couponCode: checkout.couponCode || "",
    });
    sessionStorage.setItem("my_slot_hold", JSON.stringify({ ...hold, phase: "payment_pending" }));
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo",
      fingerprint: fp,
      paymentAccessToken: "eyJwYXltZW50UmVjb3JkSWQiOiJwci10ZXJtLTEiLCJwcm92aWRlciI6ImRvZG8ifQ.sig",
      providerOrderReady: true,
      providerPayload: { orderId: "ord-term-1", checkoutUrl: `${location.origin}/__test/checkout-handoff`, dodoReturnTag: "tag-term-1" },
      result: { refreshedHold: { slotHoldId: hold.holdId, slotHoldToken: hold.holdToken, slotHoldExpiresAt: hold.expiresAt } },
    }));
  });

  await page.reload();
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page.getByText("Payment is still being verified.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).not.toBeNull();

  complete = true;
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page.getByText(/Go back to booking to choose a time/i)).toBeVisible();
  const after = await page.evaluate(() => ({
    sess: sessionStorage.getItem("payment_session_state"),
    hold: sessionStorage.getItem("my_slot_hold"),
    tomb: JSON.parse(sessionStorage.getItem("roo_released_payment_locks") || "{}"),
  }));
  expect(after.sess).toBeNull();
  expect(after.hold).toBeNull();
  expect(after.tomb["pr-term-1"]).toBe(true);
});
