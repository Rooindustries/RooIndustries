const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

const makeHoldToken = (nonce, holdId = "slotHold.consent") =>
  `${Buffer.from(JSON.stringify({ v: 1, hid: holdId, n: nonce })).toString("base64url")}.sig`;

const makePaymentToken = (id) =>
  `${Buffer.from(JSON.stringify({ paymentRecordId: id, provider: "dodo", purpose: "payment-session" })).toString("base64url")}.sig`;

test("tightened quote ceiling persists across reload and requires explicit accept before launching", async ({ page, flow }) => {
  let quoteNet = 80;
  let startCount = 0;

  await flow.review();
  await flow.payment();

  await page.route("**/api/payment/quote", (route) =>
    route.fulfill({
      json: {
        ok: true,
        currency: "USD",
        quoteFingerprint: `fp-${quoteNet}`,
        providers: { dodo: { enabled: true, mode: "test", currency: "USD" }, razorpay: { enabled: false, mode: "disabled", currency: "USD" }, paypal: { enabled: false, mode: "disabled", currency: "USD" } },
        quote: { currency: "USD", grossAmount: 100, netAmount: quoteNet, isFree: false, couponDiscountAmount: 100 - quoteNet, referralDiscountAmount: 0 },
      },
    })
  );
  await page.route("**/api/payment/start", (route) => {
    startCount += 1;
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        paymentAccessToken: makePaymentToken("pr-cons-1"),
        providerOrderReady: true,
        providerPayload: { orderId: "ord-cons-1", checkoutUrl: `${new URL(route.request().url()).origin}/__test/checkout-handoff`, dodoReturnTag: "tag-cons-1" },
        quote: { currency: "USD", grossAmount: 100, netAmount: quoteNet, isFree: false },
        quoteFingerprint: `fp-${quoteNet}`,
      },
    });
  });

  await page.evaluate(() => {
    const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}");
    const nextB = { ...checkout, packagePrice: "$100.00", expectedClientTotal: 100, expectedClientCurrency: "USD", acceptedQuoteTotal: 100, acceptedQuoteCurrency: "USD" };
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(nextB));
    window.history.replaceState({ usr: { bookingData: nextB } }, "", "/payment");
  });

  await page.reload();
  await expect(page.getByText("$80.00 USD")).toBeVisible();
  const tightened = await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}"));
  expect(tightened.acceptedQuoteTotal).toBe(80);
  expect(tightened.expectedClientTotal).toBe(100);

  quoteNet = 95;
  await page.reload();
  const acceptBtn = page.getByRole("button", { name: "Accept updated price", exact: true });
  await expect(acceptBtn).toBeVisible();
  await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeDisabled();
  expect(startCount).toBe(0);

  await acceptBtn.click();
  await expect(acceptBtn).toBeHidden();
  await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
  expect(startCount).toBe(1);
});

test("equal-amount cross-currency change (80 USD to 80 KWD) holds across quote, reload, and status resume", async ({ page, flow }) => {
  let startCount = 0;
  const kwdProviders = {
    dodo: { enabled: true, mode: "test", currency: "KWD" },
    razorpay: { enabled: false, mode: "disabled", currency: "USD" },
    paypal: { enabled: false, mode: "disabled", currency: "USD" },
  };

  await flow.review();
  await flow.payment();

  await page.route("**/api/payment/providers", (route) => route.fulfill({ json: { ok: true, providers: kwdProviders } }));
  await page.route("**/api/payment/quote", (route) =>
    route.fulfill({
      json: {
        ok: true,
        currency: "KWD",
        quoteFingerprint: "fp-80-kwd",
        providers: kwdProviders,
        quote: { currency: "KWD", grossAmount: 80, netAmount: 80, isFree: false },
      },
    })
  );
  await page.route("**/api/payment/start", (route) => {
    startCount += 1;
    return route.fulfill({ status: 500, json: { ok: false } });
  });

  await page.evaluate(() => {
    const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}");
    const nextB = { ...checkout, packagePrice: "$80.00", expectedClientTotal: 80, expectedClientCurrency: "USD", acceptedQuoteTotal: 80, acceptedQuoteCurrency: "USD" };
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(nextB));
    window.history.replaceState({ usr: { bookingData: nextB } }, "", "/payment");
  });

  await page.reload();
  const acceptBtn = page.getByRole("button", { name: "Accept updated price", exact: true });
  await expect(acceptBtn).toBeVisible();
  await expect(page.getByRole("region", { name: "Updated checkout price" })).toContainText("80.000 KWD");
  await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeDisabled();
  expect(startCount).toBe(0);

  await page.reload();
  await expect(acceptBtn).toBeVisible();
  expect(startCount).toBe(0);

  let statusCalls = 0;
  await page.route("**/api/payment/quote", (route) =>
    route.fulfill({
      json: {
        ok: true,
        currency: "USD",
        quoteFingerprint: "fp-80-usd",
        providers: { dodo: { enabled: true, mode: "test", currency: "USD" }, razorpay: { enabled: false, mode: "disabled", currency: "USD" }, paypal: { enabled: false, mode: "disabled", currency: "USD" } },
        quote: { currency: "USD", grossAmount: 80, netAmount: 80, isFree: false },
      },
    })
  );
  await page.route("**/api/payment/status", (route) => {
    statusCalls += 1;
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "dodo",
        providerOrderReady: true,
        quoteFingerprint: "fp-80-kwd",
        quoteFingerprintValid: true,
        quote: { currency: "KWD", grossAmount: 80, netAmount: 80, isFree: false },
        providerPayload: { orderId: "ord-kwd-res", checkoutUrl: `${new URL(route.request().url()).origin}/__test/checkout-handoff`, dodoReturnTag: "tag-kwd-res" },
      },
    });
  });

  await page.evaluate(({ tok }) => {
    const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}");
    const nextB = { ...checkout, slotHoldId: "slotHold.consent", slotHoldToken: tok, packagePrice: "$80.00", acceptedQuoteTotal: 80, acceptedQuoteCurrency: "USD" };
    const fp = JSON.stringify({ packageTitle: nextB.packageTitle || "", originalOrderId: nextB.originalOrderId || "", startTimeUTC: nextB.startTimeUTC || "", email: nextB.email || "", referralCode: "", couponCode: "" });
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(nextB));
    sessionStorage.setItem("my_slot_hold", JSON.stringify({ holdId: "slotHold.consent", holdToken: tok, expiresAt: nextB.slotHoldExpiresAt, startTimeUTC: nextB.startTimeUTC, packageTitle: nextB.packageTitle, phase: "payment_pending" }));
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo", fingerprint: fp, paymentAccessToken: "eyJwYXltZW50UmVjb3JkSWQiOiJwci1rd2QtMSIsInByb3ZpZGVyIjoiZG9kbyJ9.sig",
      providerPayload: { orderId: "ord-kwd-res", checkoutUrl: `${location.origin}/__test/checkout-handoff`, dodoReturnTag: "tag-kwd-res" },
      result: { refreshedHold: { slotHoldId: "slotHold.consent", slotHoldToken: tok } },
    }));
    window.history.replaceState({ usr: { bookingData: nextB } }, "", "/payment");
  }, { tok: makeHoldToken("n-kwd-res") });

  await page.reload();
  await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
  await expect.poll(() => statusCalls).toBe(1);
  await expect(acceptBtn).toBeVisible();
  await expect(page).toHaveURL(/\/payment$/);
});

test("legacy saved upgrade with only packagePrice uses USD ceiling and holds higher quotes across reload", async ({ page, flow }) => {
  await flow.review();
  await flow.payment();

  await page.route("**/api/payment/quote", (route) =>
    route.fulfill({
      json: {
        ok: true,
        currency: "USD",
        quoteFingerprint: "fp-up-95",
        providers: { dodo: { enabled: true, mode: "test", currency: "USD" }, razorpay: { enabled: false, mode: "disabled", currency: "USD" }, paypal: { enabled: false, mode: "disabled", currency: "USD" } },
        quote: { currency: "USD", grossAmount: 95, netAmount: 95, isFree: false },
      },
    })
  );

  await page.evaluate(() => {
    const legacyUpgrade = {
      originalOrderId: "ord-legacy-80",
      upgradeIntentToken: "intent-legacy.sig",
      packageTitle: "Performance Vertex Max (Upgrade)",
      packagePrice: "$80.00",
      startTimeUTC: "2099-03-04T10:00:00.000Z",
      displayDate: "March 4, 2099",
      displayTime: "10:00 AM",
      localTimeZone: "UTC",
      email: "buyer@example.invalid",
    };
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(legacyUpgrade));
    window.history.replaceState({ usr: { bookingData: legacyUpgrade } }, "", "/payment");
  });

  await page.reload();
  await expect(page.getByRole("button", { name: "Accept updated price", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Updated checkout price" })).toContainText("$80.00 USD");
  await expect(page.getByRole("region", { name: "Updated checkout price" })).toContainText("$95.00 USD");
});

test("late quote after Manual Remove neither restores code nor resets removal authorization across reload", async ({ page, flow }) => {
  let holdPriorQuote = false;
  let releasePriorQuote;
  const priorQuoteGate = new Promise((resolve) => { releasePriorQuote = resolve; });
  let markPriorQuoteEntered;
  const priorQuoteEntered = new Promise((resolve) => { markPriorQuoteEntered = resolve; });
  let failQuote = false;

  await flow.review();
  await flow.payment();

  await page.route("**/api/payment/quote", async (route) => {
    const body = route.request().postDataJSON() || {};
    if (failQuote) {
      return route.fulfill({ status: 500, json: { ok: false, error: "Quote unavailable" } });
    }
    if (body.referralCode === "friend" && body.couponCode === "save20") {
      if (holdPriorQuote) {
        markPriorQuoteEntered();
        await priorQuoteGate;
      }
      return route.fulfill({
        json: {
          ok: true,
          currency: "USD",
          quoteFingerprint: "fp-stacked-72",
          providers: { dodo: { enabled: true, mode: "test", currency: "USD" }, razorpay: { enabled: false, mode: "disabled", currency: "USD" }, paypal: { enabled: false, mode: "disabled", currency: "USD" } },
          quote: {
            currency: "USD",
            grossAmount: 100,
            netAmount: 72,
            isFree: false,
            referralDiscountAmount: 10,
            referralDiscountPercent: 10,
            couponDiscountAmount: 18,
            couponDiscountType: "percent",
            couponDiscountPercent: 20,
          },
        },
      });
    }
    return route.fulfill({
      json: {
        ok: true,
        currency: "USD",
        quoteFingerprint: "fp-after-remove-82",
        providers: { dodo: { enabled: true, mode: "test", currency: "USD" }, razorpay: { enabled: false, mode: "disabled", currency: "USD" }, paypal: { enabled: false, mode: "disabled", currency: "USD" } },
        quote: { currency: "USD", grossAmount: 100, netAmount: 82, isFree: false, referralDiscountAmount: 0, couponDiscountAmount: 18 },
      },
    });
  });

  await page.evaluate(() => {
    const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}");
    const nextB = {
      ...checkout,
      packagePrice: "$100.00",
      referralCode: "friend",
      couponCode: "save20",
      expectedClientTotal: 72,
      expectedClientCurrency: "USD",
      acceptedQuoteTotal: 72,
      acceptedQuoteCurrency: "USD",
    };
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(nextB));
    window.history.replaceState({ usr: { bookingData: nextB } }, "", "/payment");
  });

  await page.reload();
  await expect(page.getByText("$72.00 USD")).toBeVisible();

  holdPriorQuote = true;
  await page.reload();
  await priorQuoteEntered;
  await expect(page.getByRole("button", { name: "Remove referral code", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Remove referral code", exact: true }).click();
  releasePriorQuote();

  await expect(page.getByRole("button", { name: "Accept updated price", exact: true })).toBeVisible();
  const afterFirstRemove = await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}"));
  expect(afterFirstRemove.referralCode || "").toBe("");
  expect(afterFirstRemove.acceptedQuoteTotal).toBe(80);

  failQuote = true;
  await page.reload();
  await expect(page.locator("#payment-referral-code")).toHaveValue("");

  await page.locator("#payment-referral-code").fill("friend");
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove referral code", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Remove referral code", exact: true }).click();
  const afterRepeatRemove = await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}"));
  expect(afterRepeatRemove.acceptedQuoteTotal).toBe(80);
});

test("fixed coupon missing both couponDiscountValue and couponDiscountAmount fails closed on referral removal", async ({ page, flow }) => {
  await flow.review();
  await flow.payment();

  await page.route(/\/api\/ref\/validateReferral/, (route) => {
    const code = (new URL(route.request().url()).searchParams.get("code") || "").toLowerCase();
    return route.fulfill({
      json: code === "friend"
        ? { ok: true, active: true, eligible: true, referral: { code: "friend", currentDiscountPercent: 10 } }
        : { ok: false, error: "Invalid referral code.", reason: "not_found" },
    });
  });
  await page.route(/\/api\/ref\/validateCoupon/, (route) => {
    const code = (new URL(route.request().url()).searchParams.get("code") || "").toLowerCase();
    return route.fulfill({
      json: code === "flat20"
        ? { ok: true, coupon: { code: "flat20", discountType: "fixed", discountAmount: 20, canCombineWithReferral: true } }
        : { ok: false, error: "Invalid coupon code." },
    });
  });
  await page.route("**/api/payment/quote", (route) => {
    const body = route.request().postDataJSON() || {};
    const hasRef = String(body.referralCode || "").toLowerCase() === "friend";
    return route.fulfill({
      json: {
        ok: true,
        currency: "USD",
        quoteFingerprint: hasRef ? "fp-fixed-missing-both" : "fp-fixed-after-remove",
        providers: { dodo: { enabled: true, mode: "test", currency: "USD" }, razorpay: { enabled: false, mode: "disabled", currency: "USD" }, paypal: { enabled: false, mode: "disabled", currency: "USD" } },
        quote: hasRef
          ? { currency: "USD", grossAmount: 100, netAmount: 72, isFree: false, referralCode: "friend", referralDiscountAmount: 8, referralDiscountPercent: 10, couponCode: "flat20", couponDiscountType: "fixed" }
          : { currency: "USD", grossAmount: 100, netAmount: 80, isFree: false, referralDiscountAmount: 0, couponCode: "flat20", couponDiscountType: "fixed", couponDiscountAmount: 20, couponDiscountValue: 20 },
      },
    });
  });

  await page.evaluate(() => {
    const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}");
    const nextB = {
      ...checkout,
      packagePrice: "$100.00",
      referralCode: "friend",
      couponCode: "flat20",
      expectedClientTotal: 72,
      expectedClientCurrency: "USD",
      acceptedQuoteTotal: 72,
      acceptedQuoteCurrency: "USD",
    };
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(nextB));
    window.history.replaceState({ usr: { bookingData: nextB } }, "", "/payment");
  });

  await page.reload();
  await expect(page.getByText("$72.00 USD")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove referral code", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove coupon", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Remove referral code", exact: true }).click();
  await expect(page.getByRole("button", { name: "Accept updated price", exact: true })).toBeVisible();
  const afterRemove = await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}"));
  expect(afterRemove.acceptedQuoteTotal).toBe(72);
});
