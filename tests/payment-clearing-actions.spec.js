const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

const makeHoldToken = (nonce, holdId = "slotHold.clr") =>
  `${Buffer.from(JSON.stringify({ v: 1, hid: holdId, n: nonce })).toString("base64url")}.sig`;

const makePaymentToken = (id, provider = "dodo") =>
  `${Buffer.from(JSON.stringify({ paymentRecordId: id, provider, purpose: "payment-session" })).toString("base64url")}.sig`;

const seedPaymentSession = async (page, { tokenId, provider = "dodo", orderReady = true, returnTag = "tag-clr-1", holdPhase = "payment_pending", holdId = null, holdToken = null }) => {
  const token = makePaymentToken(tokenId, provider);
  await page.evaluate(({ token, provider, orderReady, returnTag, holdPhase, holdId, holdToken }) => {
    const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}");
    const hold = JSON.parse(sessionStorage.getItem("my_slot_hold") || "{}");
    const effectiveHoldId = holdId || hold.holdId || checkout.slotHoldId;
    const effectiveHoldToken = holdToken || hold.holdToken || checkout.slotHoldToken;
    const nextCheckout = { ...checkout, slotHoldId: effectiveHoldId, slotHoldToken: effectiveHoldToken };
    const nextHold = { ...hold, holdId: effectiveHoldId, holdToken: effectiveHoldToken, phase: holdPhase };
    const fp = JSON.stringify({
      packageTitle: nextCheckout.packageTitle || "",
      originalOrderId: nextCheckout.originalOrderId || "",
      startTimeUTC: nextCheckout.startTimeUTC || "",
      email: nextCheckout.email || "",
      referralCode: nextCheckout.referralCode || "",
      couponCode: nextCheckout.couponCode || "",
    });
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(nextCheckout));
    sessionStorage.setItem("my_slot_hold", JSON.stringify(nextHold));
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider,
      fingerprint: fp,
      paymentAccessToken: token,
      providerOrderReady: orderReady,
      providerPayload: {
        orderId: `ord-${token.slice(0, 8)}`,
        checkoutUrl: `${location.origin}/__test/checkout-handoff`,
        dodoReturnTag: returnTag,
      },
      result: {
        refreshedHold: {
          slotHoldId: effectiveHoldId,
          slotHoldToken: effectiveHoldToken,
          slotHoldExpiresAt: nextHold.expiresAt,
        },
      },
    }));
    window.history.replaceState({ usr: { bookingData: nextCheckout } }, "", location.pathname + location.search);
  }, { token, provider, orderReady, returnTag, holdPhase, holdId, holdToken });
  return token;
};

test("resume, check status, and change payment method clear only on HTTP 200 with affirmative terminalOutcomeComplete", async ({ page, flow }) => {
  let statusResponse = {
    status: 202,
    json: { ok: true, status: "failed", providerPaymentState: "failed", terminalOutcomeComplete: true, cleanupPending: false, manualReviewRequired: false, recoveryReason: "Cleanup still running." },
  };
  let cancelResponse = {
    status: 202,
    json: { ok: true, cancelled: true, status: "abandoned", terminalOutcomeComplete: true, cleanupPending: false, manualReviewRequired: false, recoveryReason: "Cancel pending." },
  };
  await page.route("**/api/payment/status", (route) => route.fulfill(statusResponse));
  await page.route("**/api/payment/cancel", (route) => route.fulfill(cancelResponse));

  await flow.review();
  await flow.payment();
  await seedPaymentSession(page, { tokenId: "pr-resume-gate", orderReady: false });

  await page.reload();
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page.getByText("Cleanup still running.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).not.toBeNull();

  statusResponse = {
    status: 200,
    json: { ok: true, status: "failed", providerPaymentState: "failed", cleanupPending: false, manualReviewRequired: false, recoveryReason: "Missing completion flag." },
  };
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page.getByText("Missing completion flag.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).not.toBeNull();

  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await expect(page.getByText("Cancel pending.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).not.toBeNull();

  cancelResponse = {
    status: 200,
    json: { ok: true, cancelled: true, status: "abandoned", cleanupPending: false, manualReviewRequired: false, recoveryReason: "Cancel lacks affirmative flag." },
  };
  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await expect(page.getByText("Cancel lacks affirmative flag.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).not.toBeNull();

  cancelResponse = {
    status: 200,
    json: { ok: true, cancelled: false, status: "failed", providerPaymentState: "failed", terminalOutcomeComplete: true, cleanupPending: false, manualReviewRequired: false },
  };
  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await expect(page.getByText(/Payment method released/i)).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
});

test("finalize polling and legacy Dodo return status clear only on HTTP 200 with affirmative terminalOutcomeComplete", async ({ page, flow }) => {
  let statusCalls = 0;
  let finalizeStep = "poll_202";
  await page.route("**/api/payment/finalize", (route) => {
    if (finalizeStep === "direct_202") {
      return route.fulfill({
        status: 202,
        json: { ok: true, status: "failed", terminalOutcomeComplete: true, cleanupPending: false, manualReviewRequired: false, recoveryReason: "Finalize still finishing." },
      });
    }
    return route.fulfill({
      status: 200,
      json: { ok: true, status: "finalizing" },
    });
  });
  await page.route("**/api/payment/status", (route) => {
    statusCalls += 1;
    if (finalizeStep === "poll_202") {
      return route.fulfill({
        status: 202,
        json: { ok: true, status: "failed", terminalOutcomeComplete: true, cleanupPending: false, manualReviewRequired: false, recoveryReason: "Poll returned 202." },
      });
    }
    return route.fulfill({
      status: 200,
      json: { ok: true, status: "failed", providerPaymentState: "failed", terminalOutcomeComplete: true, cleanupPending: false, manualReviewRequired: false },
    });
  });

  await flow.review();
  await flow.payment();
  await seedPaymentSession(page, { tokenId: "pr-fin-poll", orderReady: true });
  await page.reload();

  finalizeStep = "direct_202";
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page.getByText("Finalize still finishing.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).not.toBeNull();

  finalizeStep = "poll_202";
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect.poll(() => statusCalls).toBeGreaterThanOrEqual(1);
  await expect(page.getByText("Poll returned 202.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).not.toBeNull();

  finalizeStep = "poll_200_complete";
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page.getByText(/Go back to booking to choose a time/i)).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
});

test("ActiveUpgradeBlocker status and release enforce HTTP 200 + terminalOutcomeComplete and accept Dodo failed release", async ({ page, flow }) => {
  let statusResp = { status: 202, json: { ok: true, status: "failed", terminalOutcomeComplete: true, cleanupPending: false, manualReviewRequired: false, recoveryReason: "Upgrade status pending." } };
  let cancelResp = { status: 202, json: { ok: true, status: "failed", cancelled: false, terminalOutcomeComplete: true, cleanupPending: false, manualReviewRequired: false, recoveryReason: "Upgrade cancel pending." } };
  await page.route("**/api/payment/start", (route) =>
    route.fulfill({
      status: 409,
      json: {
        ok: false,
        code: "upgrade_already_in_progress",
        error: "Another upgrade checkout is already in progress.",
        lockedSession: {
          paymentAccessToken: makePaymentToken("pr-upg-block"),
          upgradeIntentId: "intent-upg-1",
          packageTitle: "Performance Vertex Max",
          provider: "dodo",
          providerOrderReady: true,
          quote: { currency: "USD", grossAmount: 45, netAmount: 45, isFree: false },
        },
      },
    })
  );
  await page.route("**/api/payment/status", (route) => route.fulfill(statusResp));
  await page.route("**/api/payment/cancel", (route) => route.fulfill(cancelResp));

  await flow.review();
  await flow.payment();
  const unrelatedToken = makePaymentToken("pr-other-lock");

  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByText(/Another upgrade checkout is already in progress/i)).toBeVisible();
  await page.evaluate((tok) => {
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo",
      fingerprint: "other-fp",
      paymentAccessToken: tok,
      providerPayload: { orderId: "ord-other" },
    }));
  }, unrelatedToken);

  await page.getByRole("button", { name: "Check active upgrade", exact: true }).click();
  await expect(page.getByText("Upgrade status pending.")).toBeVisible();

  await page.getByRole("button", { name: "Release active upgrade", exact: true }).click();
  await expect(page.getByText("Upgrade cancel pending.")).toBeVisible();

  cancelResp = {
    status: 200,
    json: { ok: true, status: "failed", cancelled: false, terminalOutcomeComplete: true, cleanupPending: false, manualReviewRequired: false },
  };
  await page.getByRole("button", { name: "Release active upgrade", exact: true }).click();
  await expect(page.getByText(/The previous upgrade session closed/i)).toBeVisible();
  const state = await page.evaluate(() => ({
    sess: JSON.parse(sessionStorage.getItem("payment_session_state") || "null"),
    tomb: JSON.parse(sessionStorage.getItem("roo_released_payment_locks") || "{}"),
  }));
  expect(state.tomb["pr-upg-block"]).toBe(true);
  expect(state.sess?.paymentAccessToken).toBe(unrelatedToken);
});

test("/booking Release enforces HTTP 200 + terminalOutcomeComplete and accepts Dodo failed release with and without refreshedHold", async ({ page, flow }) => {
  const n1 = makeHoldToken("nonce-bk-1", "slotHold.bk");
  const n2 = makeHoldToken("nonce-bk-2", "slotHold.bk");
  let cancelResp = {
    status: 202,
    json: { ok: true, status: "failed", cancelled: false, terminalOutcomeComplete: true, cleanupPending: false, manualReviewRequired: false, recoveryReason: "Release still pending." },
  };
  await page.route("**/api/payment/cancel", (route) => route.fulfill(cancelResp));

  await flow.review();
  await seedPaymentSession(page, { tokenId: "pr-bk-1", holdId: "slotHold.bk", holdToken: n1, holdPhase: "payment_pending" });
  await page.reload();

  await expect(page.getByRole("button", { name: "Release payment", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Release payment", exact: true }).click();
  await expect(page.getByText("Release still pending.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).not.toBeNull();

  cancelResp = {
    status: 200,
    json: { ok: true, status: "failed", cancelled: false, cleanupPending: false, manualReviewRequired: false, recoveryReason: "Missing complete flag on booking." },
  };
  await page.getByRole("button", { name: "Release payment", exact: true }).click();
  await expect(page.getByText("Missing complete flag on booking.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).not.toBeNull();

  const refreshedExpires = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  cancelResp = {
    status: 200,
    json: {
      ok: true,
      status: "failed",
      cancelled: false,
      terminalOutcomeComplete: true,
      cleanupPending: false,
      manualReviewRequired: false,
      refreshedHold: {
        slotHoldId: "slotHold.bk",
        slotHoldToken: n2,
        slotHoldExpiresAt: refreshedExpires,
        phase: "holding",
      },
    },
  };
  await page.getByRole("button", { name: "Release payment", exact: true }).click();
  await expect(page.getByText(/Payment method released/i)).toBeVisible();
  const afterWithHold = await page.evaluate(() => ({
    sess: sessionStorage.getItem("payment_session_state"),
    hold: JSON.parse(sessionStorage.getItem("my_slot_hold") || "null"),
  }));
  expect(afterWithHold.sess).toBeNull();
  expect(afterWithHold.hold?.holdToken).toBe(n2);
  expect(afterWithHold.hold?.phase).toBe("holding");

  await seedPaymentSession(page, { tokenId: "pr-bk-2", holdId: "slotHold.bk", holdToken: n2, holdPhase: "payment_pending" });
  await page.reload();
  cancelResp = {
    status: 200,
    json: {
      ok: true,
      status: "failed",
      cancelled: false,
      terminalOutcomeComplete: true,
      cleanupPending: false,
      manualReviewRequired: false,
    },
  };
  await page.getByRole("button", { name: "Release payment", exact: true }).click();
  await expect(page.getByText(/previous payment attempt failed and the reservation expired/i)).toBeVisible();
  const afterWithoutHold = await page.evaluate(() => ({
    sess: sessionStorage.getItem("payment_session_state"),
    hold: sessionStorage.getItem("my_slot_hold"),
  }));
  expect(afterWithoutHold.sess).toBeNull();
  expect(afterWithoutHold.hold).toBeNull();
});
