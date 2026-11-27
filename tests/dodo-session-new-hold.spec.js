const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

const storedHold = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold") || "null"));

const makeHoldToken = (nonce, holdId = "slotHold.pr10") =>
  `${Buffer.from(JSON.stringify({ v: 1, hid: holdId, n: nonce })).toString("base64url")}.sig`;

const makePaymentToken = (id, provider = "dodo") =>
  `${Buffer.from(JSON.stringify({ paymentRecordId: id, provider, purpose: "payment-session" })).toString("base64url")}.sig`;

const routeAbandonedDodo = async page => {
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    const { bookingPayload } = route.request().postDataJSON();
    starts.push(bookingPayload);
    await route.fulfill({ json: {
      ok: true, status: "started", provider: "dodo",
      paymentAccessToken: `fixture-payment-${starts.length}`,
      providerPayload: { checkoutUrl: `${new URL(page.url()).origin}/__test/checkout-handoff`, dodoReturnTag: `fixture-tag-${starts.length}` },
      sessionExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      refreshedHold: {
        slotHoldId: bookingPayload.slotHoldId,
        slotHoldToken: `${bookingPayload.slotHoldToken}-started`,
        slotHoldExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
        phase: "payment_pending",
      },
    } });
  });
  await page.route("**/api/payment/status", route => route.fulfill({ json: { ok: true, status: "abandoned", provider: "dodo", providerPaymentState: "cancelled", terminalOutcomeComplete: true, cleanupPending: false, manualReviewRequired: false } }));
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

test("Dodo failure retains hold with retry countdown and releases slot with Choose a new time on final failure", async ({ page, flow }) => {
  const n1 = makeHoldToken("n-retry-1", "slotHold.retry");
  const n2 = makeHoldToken("n-retry-2", "slotHold.retry");
  const expIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  let finalizeStep = "retain";

  await page.route("**/api/payment/finalize", (route) => {
    if (finalizeStep === "retain") {
      return route.fulfill({
        status: 200,
        json: {
          ok: true,
          status: "failed",
          terminalOutcomeComplete: true,
          cleanupPending: false,
          manualReviewRequired: false,
          paymentFailureCode: "insufficient_funds",
          paymentFailureMessage: "Your card has insufficient funds. Please try another card or payment method.",
          holdRetained: true,
          slotReleased: false,
          retriesRemaining: 2,
          refreshedHold: {
            slotHoldId: "slotHold.retry",
            slotHoldToken: n2,
            slotHoldExpiresAt: expIso,
            phase: "active",
          },
        },
      });
    }
    return route.fulfill({
      status: 200,
      json: {
        ok: true,
        status: "failed",
        terminalOutcomeComplete: true,
        cleanupPending: false,
        manualReviewRequired: false,
        paymentFailureCode: "card_declined",
        paymentFailureMessage: "Your card was declined by your bank. Please try another card or payment method.",
        holdRetained: false,
        slotReleased: true,
        retriesRemaining: 0,
      },
    });
  });

  await flow.review();
  await flow.payment();
  const seedRetrySession = async (tokenId, holdTok) => {
    const tok = makePaymentToken(tokenId);
    await page.evaluate(({ tok, tokenId, holdTok, expIso }) => {
      const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}");
      const nextB = { ...checkout, slotHoldId: "slotHold.retry", slotHoldToken: holdTok, slotHoldExpiresAt: expIso };
      const fp = JSON.stringify({
        packageTitle: nextB.packageTitle || "",
        originalOrderId: "",
        startTimeUTC: nextB.startTimeUTC || "",
        email: nextB.email || "",
        referralCode: "",
        couponCode: "",
      });
      sessionStorage.setItem("checkout_booking_state", JSON.stringify(nextB));
      sessionStorage.setItem("my_slot_hold", JSON.stringify({
        holdId: "slotHold.retry", holdToken: holdTok, expiresAt: expIso,
        startTimeUTC: nextB.startTimeUTC, packageTitle: nextB.packageTitle, phase: "payment_pending",
      }));
      sessionStorage.setItem("payment_session_state", JSON.stringify({
        provider: "dodo",
        fingerprint: fp,
        sessionHoldId: "slotHold.retry",
        sessionHoldNonce: holdTok,
        paymentAccessToken: tok,
        providerOrderReady: true,
        providerPayload: { orderId: `ord-${tokenId}`, checkoutUrl: `${location.origin}/__test/handoff` },
        result: { refreshedHold: { slotHoldId: "slotHold.retry", slotHoldToken: holdTok, slotHoldExpiresAt: expIso } },
      }));
      window.history.replaceState({ usr: { bookingData: nextB } }, "", "/payment");
    }, { tok, tokenId, holdTok, expIso });
  };

  await seedRetrySession("pr-retry-1", n1);
  await page.reload();
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();

  const retainAlert = page.getByRole("alert").filter({ hasText: "Your card has insufficient funds." });
  await expect(retainAlert).toContainText("Your card has insufficient funds. Please try another card or payment method.");
  await expect(retainAlert).toContainText("Your time slot is still reserved (2 retries left).");
  await expect(retainAlert.getByRole("button", { name: "Choose a new time", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
  expect(await storedHold(page)).toMatchObject({ holdId: "slotHold.retry", holdToken: n2, phase: "active" });

  finalizeStep = "release";
  await seedRetrySession("pr-retry-4", n2);
  await page.reload();
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();

  const releaseAlert = page.getByRole("alert").filter({ hasText: "Your card was declined by your bank." });
  await expect(releaseAlert).toContainText("Your card was declined by your bank.");
  await expect(releaseAlert).toContainText("Your reserved time slot was released.");
  expect(await storedHold(page)).toBeNull();
  await releaseAlert.getByRole("button", { name: "Choose a new time", exact: true }).click();
  await expect(page).toHaveURL(/\/booking/);
});

test("ready session Check payment status falls back from /finalize 401 to /status and resolves failure", async ({ page, flow }) => {
  let finalizeCalls = 0;
  let statusCalls = 0;
  await page.route("**/api/payment/finalize", (route) => {
    finalizeCalls += 1;
    return route.fulfill({ status: 401, json: { ok: false, error: "Payment access token expired." } });
  });
  await page.route("**/api/payment/status", (route) => {
    statusCalls += 1;
    return route.fulfill({
      status: 200,
      json: {
        ok: true,
        status: "failed",
        terminalOutcomeComplete: true,
        cleanupPending: false,
        manualReviewRequired: false,
        paymentFailureCode: "expired_card",
        paymentFailureMessage: "Your card has expired. Please use a different card or payment method.",
        holdRetained: false,
        slotReleased: true,
        retriesRemaining: 0,
      },
    });
  });

  await flow.review();
  await flow.payment();
  const tok = makePaymentToken("pr-fin-401");
  await page.evaluate(({ tok }) => {
    const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}");
    const hold = JSON.parse(sessionStorage.getItem("my_slot_hold") || "{}");
    const fp = JSON.stringify({
      packageTitle: checkout.packageTitle || "",
      originalOrderId: "",
      startTimeUTC: checkout.startTimeUTC || "",
      email: checkout.email || "",
      referralCode: "",
      couponCode: "",
    });
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo",
      fingerprint: fp,
      sessionHoldId: hold.holdId,
      sessionHoldNonce: hold.holdToken,
      paymentAccessToken: tok,
      providerOrderReady: true,
      providerPayload: { orderId: "ord-fin-401", checkoutUrl: `${location.origin}/__test/handoff` },
      result: { refreshedHold: { slotHoldId: hold.holdId, slotHoldToken: hold.holdToken, slotHoldExpiresAt: hold.expiresAt } },
    }));
  }, { tok });

  await page.reload();
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();

  await expect.poll(() => finalizeCalls).toBe(1);
  await expect.poll(() => statusCalls).toBe(1);
  await expect(page.getByRole("alert").filter({ hasText: "Your card has expired." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose a new time", exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
});

for (const hasCompletedDraft of [true, false]) {
  test(`one-store my_slot_hold-only T2 returns to /booking ${hasCompletedDraft ? "Review" : "Details"} after T1 failure without mixing T2 into T1`, async ({ page, flow }) => {
    void flow;
    const t1Start = "2099-06-10T04:30:00.000Z";
    const t2Start = "2099-06-11T04:30:00.000Z";
    const expIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const t1Token = makePaymentToken("pr-one-hold-t1");
    const t2HoldToken = makeHoldToken("n-t2-hold-only", "hold_t2_only");
    let finalizeAuth = "";

    await page.route("**/api/payment/finalize", (route) => {
      finalizeAuth = route.request().headers().authorization || "";
      return route.fulfill({
        status: 200,
        json: {
          ok: true,
          status: "failed",
          terminalOutcomeComplete: true,
          cleanupPending: false,
          manualReviewRequired: false,
          paymentFailureCode: "insufficient_funds",
          paymentFailureMessage: "Your card has insufficient funds. Please try another card or payment method.",
          holdRetained: false,
          slotReleased: true,
          retriesRemaining: 0,
        },
      });
    });

    await page.goto("/");
    await page.evaluate(({ t1Start, t2Start, expIso, t1Token, t2HoldToken, hasCompletedDraft }) => {
      sessionStorage.clear();
      sessionStorage.setItem("payment_session_state", JSON.stringify({
        provider: "dodo",
        paymentAccessToken: t1Token,
        sessionHoldId: "hold_t1_only",
        sessionHoldNonce: "n-t1-only",
        providerOrderReady: true,
        providerPayload: { orderId: "cks_t1_only", checkoutUrl: `${location.origin}/__test/handoff` },
        fingerprint: JSON.stringify({
          packageTitle: "Performance Vertex Overhaul",
          originalOrderId: "",
          startTimeUTC: t1Start,
          email: "t1@example.invalid",
          referralCode: "",
          couponCode: "",
        }),
        result: { refreshedHold: { slotHoldId: "hold_t1_only", slotHoldToken: "n-t1-only", slotHoldExpiresAt: expIso } },
      }));
      sessionStorage.setItem("my_slot_hold", JSON.stringify({
        holdId: "hold_t2_only",
        holdToken: t2HoldToken,
        expiresAt: expIso,
        startTimeUTC: t2Start,
        packageTitle: "Performance Vertex Overhaul",
        packagePrice: "$84.99",
        phase: "active",
      }));
      sessionStorage.setItem("booking_modal_state", JSON.stringify({
        packageTitle: "Performance Vertex Overhaul",
        step: 3,
      }));
      if (hasCompletedDraft) {
        sessionStorage.setItem("booking_draft", JSON.stringify({
          lastTitle: "Performance Vertex Overhaul",
          packages: {
            "Performance Vertex Overhaul": {
              selectedPackage: { title: "Performance Vertex Overhaul", price: "$84.99" },
              form: {
                discord: "t2_player",
                email: "t2@example.invalid",
                specs: "Ryzen 7800X3D / RTX 4080",
                mainGame: "Valorant",
                notes: "",
              },
            },
          },
        }));
      }
    }, { t1Start, t2Start, expIso, t1Token, t2HoldToken, hasCompletedDraft });

    await page.goto("/payment");
    await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeVisible();
    await expect(page.getByText(/June 10, 2099/)).toBeVisible();

    await page.getByRole("button", { name: "Check payment status", exact: true }).click();
    await expect(page).toHaveURL(/\/booking/);
    expect(finalizeAuth).toBe(`Bearer ${t1Token}`);
    expect(await storedHold(page)).toMatchObject({ holdId: "hold_t2_only", holdToken: t2HoldToken });
    expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();

    if (hasCompletedDraft) {
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
      await expect(page.getByText("t2_player", { exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole("textbox", { name: "Discord username", exact: true })).toBeVisible();
    }
  });
}

test("one-store checkout_booking_state-only T2 never borrows T1 hold on failure and clears T1 hold on T1 booked", async ({ page, flow }) => {
  void flow;
  const t1Start = "2099-06-10T04:30:00.000Z";
  const t2Start = "2099-06-11T04:30:00.000Z";
  const expIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const t1HoldTok = makeHoldToken("n-t1-cbo", "hold_t1_cbo");
  const t2HoldTok = makeHoldToken("n-t2-cbo", "hold_t2_cbo");
  let outcome = "failed";

  await page.route("**/api/payment/finalize", (route) => {
    if (outcome === "failed") {
      return route.fulfill({
        status: 200,
        json: {
          ok: true,
          status: "failed",
          terminalOutcomeComplete: true,
          cleanupPending: false,
          manualReviewRequired: false,
          paymentFailureCode: "card_declined",
          paymentFailureMessage: "Your card was declined by your bank. Please try another card or payment method.",
          holdRetained: true,
          slotReleased: false,
          retriesRemaining: 2,
          refreshedHold: { slotHoldId: "hold_t1_cbo", slotHoldToken: makeHoldToken("n-t1-rot", "hold_t1_cbo"), slotHoldExpiresAt: expIso },
        },
      });
    }
    return route.fulfill({
      status: 200,
      json: { ok: true, status: "booked", bookingId: "bk_t1_cbo_booked", emailDispatchToken: "ed_cbo" },
    });
  });

  const seed = async (tokenId) => {
    const t1Tok = makePaymentToken(tokenId);
    await page.goto("/");
    await page.evaluate(({ t1Start, t2Start, expIso, t1HoldTok, t2HoldTok, t1Tok }) => {
      sessionStorage.clear();
      sessionStorage.setItem("payment_session_state", JSON.stringify({
        provider: "dodo",
        paymentAccessToken: t1Tok,
        sessionHoldId: "hold_t1_cbo",
        sessionHoldNonce: "n-t1-cbo",
        providerOrderReady: true,
        providerPayload: { orderId: "cks_t1_cbo", checkoutUrl: `${location.origin}/__test/handoff` },
        fingerprint: JSON.stringify({
          packageTitle: "Performance Vertex Overhaul",
          originalOrderId: "",
          startTimeUTC: t1Start,
          email: "cbo@example.invalid",
          referralCode: "",
          couponCode: "",
        }),
        result: { refreshedHold: { slotHoldId: "hold_t1_cbo", slotHoldToken: t1HoldTok, slotHoldExpiresAt: expIso } },
      }));
      sessionStorage.setItem("my_slot_hold", JSON.stringify({
        holdId: "hold_t1_cbo",
        holdToken: t1HoldTok,
        expiresAt: expIso,
        startTimeUTC: t1Start,
        packageTitle: "Performance Vertex Overhaul",
        phase: "payment_pending",
      }));
      sessionStorage.setItem("checkout_booking_state", JSON.stringify({
        discord: "cbo_user",
        email: "cbo@example.invalid",
        specs: "RTX 4070",
        mainGame: "CS2",
        packageTitle: "Performance Vertex Overhaul",
        packagePrice: "$84.99",
        displayDate: "Thursday, June 11, 2099",
        displayTime: "10:00 AM",
        localTimeZone: "Asia/Kolkata",
        startTimeUTC: t2Start,
        slotHoldId: "hold_t2_cbo",
        slotHoldToken: t2HoldTok,
        slotHoldExpiresAt: expIso,
        expectedClientTotal: 84.99,
        expectedClientCurrency: "USD",
        acceptedQuoteTotal: 84.99,
        acceptedQuoteCurrency: "USD",
      }));
    }, { t1Start, t2Start, expIso, t1HoldTok, t2HoldTok, t1Tok });
  };

  outcome = "failed";
  await seed("pr-cbo-fail");
  await page.goto("/payment");
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
  const afterFail = await page.evaluate(() => ({
    checkout: JSON.parse(sessionStorage.getItem("checkout_booking_state") || "null"),
    session: sessionStorage.getItem("payment_session_state"),
  }));
  expect(afterFail.session).toBeNull();
  expect(afterFail.checkout?.slotHoldId).toBe("hold_t2_cbo");
  expect(afterFail.checkout?.slotHoldToken).toBe(t2HoldTok);

  outcome = "booked";
  await seed("pr-cbo-booked");
  await page.goto("/payment");
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page).toHaveURL(/\/payment-success/);
  const afterBooked = await page.evaluate(() => ({
    hold: JSON.parse(sessionStorage.getItem("my_slot_hold") || "null"),
    checkout: JSON.parse(sessionStorage.getItem("checkout_booking_state") || "null"),
    session: sessionStorage.getItem("payment_session_state"),
  }));
  expect(afterBooked.session).toBeNull();
  expect(afterBooked.hold).toBeNull();
  expect(afterBooked.checkout?.slotHoldId).toBe("hold_t2_cbo");

  await page.goto("/booking");
  await expect(page.getByText("Select a Date and Time for Your Session")).toBeVisible();
  expect(await storedHold(page)).toBeNull();
});

test("unresolved upgrade session never borrows or clears a newer booking hold on confirmation or expiry", async ({ page, flow }) => {
  void flow;
  const t2Start = "2099-06-12T04:30:00.000Z";
  const expIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const t2HoldTok = makeHoldToken("n-t2-upg", "hold_t2_upg");
  const upgTok = makePaymentToken("pr-upg-iso");

  await page.route("**/api/payment/finalize", (route) =>
    route.fulfill({ status: 200, json: { ok: true, status: "booked", bookingId: "bk_upg_booked", emailDispatchToken: "ed_upg" } })
  );

  await page.goto("/");
  await page.evaluate(({ t2Start, expIso, t2HoldTok, upgTok }) => {
    sessionStorage.clear();
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo",
      paymentAccessToken: upgTok,
      sessionHoldId: "",
      sessionHoldNonce: "",
      providerOrderReady: true,
      providerPayload: { orderId: "cks_upg", checkoutUrl: `${location.origin}/__test/handoff` },
      fingerprint: JSON.stringify({
        packageTitle: "Performance Vertex Max (Upgrade)",
        originalOrderId: "orig_booking_1",
        startTimeUTC: "2099-06-09T04:30:00.000Z",
        email: "upg@example.invalid",
        referralCode: "",
        couponCode: "",
      }),
    }));
    sessionStorage.setItem("my_slot_hold", JSON.stringify({
      holdId: "hold_t2_upg",
      holdToken: t2HoldTok,
      expiresAt: expIso,
      startTimeUTC: t2Start,
      packageTitle: "Performance Vertex Overhaul",
      phase: "active",
    }));
    sessionStorage.setItem("checkout_booking_state", JSON.stringify({
      discord: "upg_user",
      email: "upg@example.invalid",
      specs: "RTX 4090",
      mainGame: "Apex",
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$84.99",
      displayDate: "Friday, June 12, 2099",
      displayTime: "10:00 AM",
      localTimeZone: "Asia/Kolkata",
      startTimeUTC: t2Start,
      slotHoldId: "hold_t2_upg",
      slotHoldToken: t2HoldTok,
      slotHoldExpiresAt: expIso,
      expectedClientTotal: 84.99,
      expectedClientCurrency: "USD",
      acceptedQuoteTotal: 84.99,
      acceptedQuoteCurrency: "USD",
    }));
  }, { t2Start, expIso, t2HoldTok, upgTok });

  await page.goto("/payment");
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page).toHaveURL(/\/payment-success/);
  const stores = await page.evaluate(() => ({
    hold: JSON.parse(sessionStorage.getItem("my_slot_hold") || "null"),
    checkout: JSON.parse(sessionStorage.getItem("checkout_booking_state") || "null"),
    session: sessionStorage.getItem("payment_session_state"),
  }));
  expect(stores.session).toBeNull();
  expect(stores.hold?.holdId).toBe("hold_t2_upg");
  expect(stores.checkout?.slotHoldId).toBe("hold_t2_upg");

  await page.goto("/");
  await page.evaluate(({ t2Start, t2HoldTok }) => {
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    sessionStorage.clear();
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo",
      paymentAccessToken: "eyJwYXltZW50UmVjb3JkSWQiOiJwci11cGctZXhwIiwicHJvdmlkZXIiOiJkb2RvIn0.sig",
      sessionHoldId: "",
      sessionHoldNonce: "",
      providerPayload: { orderId: "cks_upg_exp" },
      fingerprint: JSON.stringify({
        packageTitle: "Performance Vertex Max (Upgrade)",
        originalOrderId: "orig_booking_2",
        startTimeUTC: "2099-06-09T04:30:00.000Z",
        email: "upg@example.invalid",
        referralCode: "",
        couponCode: "",
      }),
    }));
    sessionStorage.setItem("my_slot_hold", JSON.stringify({
      holdId: "hold_t2_exp",
      holdToken: t2HoldTok,
      expiresAt: pastIso,
      startTimeUTC: t2Start,
      packageTitle: "Performance Vertex Overhaul",
      phase: "active",
    }));
  }, { t2Start, t2HoldTok });
  await page.goto("/booking");
  await expect(page.getByText("Select a Date and Time for Your Session")).toBeVisible();
  expect(await storedHold(page)).toBeNull();
});
