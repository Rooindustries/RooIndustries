const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

const makeHoldToken = (nonce) => {
  const payload = Buffer.from(JSON.stringify({ n: nonce })).toString("base64url");
  return `${payload}.sig`;
};

test("currency formatting renders USD, KWD, and EUR across review, payment, and upgrade", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.Razorpay = function() { return { open() {} }; };" })
  );
  await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.paypal = { Buttons: () => ({ isEligible: () => true, render: () => Promise.resolve(), close: () => Promise.resolve() }) };" })
  );
  await page.route("**/api/payment/quote", (route) => {
    const body = route.request().postDataJSON() || {};
    const provider = body.provider || "";
    const cur = provider === "razorpay" ? "KWD" : provider === "paypal" ? "EUR" : "KWD";
    const net = cur === "KWD" ? 80 : 9.99;
    return route.fulfill({
      json: {
        ok: true,
        currency: cur,
        quoteFingerprint: `fp-${cur}`,
        quote: { currency: cur, grossAmount: net, discountAmount: 0, netAmount: net, isFree: false },
        providers: {
          dodo: { enabled: true, mode: "test", currency: "USD" },
          razorpay: { enabled: true, mode: "test", currency: "KWD" },
          paypal: { enabled: true, mode: "sandbox", currency: "EUR", clientId: "sb-eur-client" },
        },
      },
    });
  });

  await flow.review();
  await expect(page.getByText("80.000 KWD")).toBeVisible();
  await flow.payment();
  await expect(page.getByText("80.000 KWD")).toBeVisible();

  await page.route("**/api/ref/getUpgradeInfo**", (route) =>
    route.fulfill({
      json: {
        ok: true,
        currency: "KWD",
        originalPaid: 67.99,
        upgradePrice: 12.01,
        upgradeIntentToken: "intent-kwd.sig",
        booking: { _id: "booking-kwd-1", email: "kwd@example.invalid", packageTitle: "Performance Vertex Overhaul", startTimeUTC: "2099-03-02T10:00:00.000Z" },
        xoc: { title: "Performance Vertex Max", price: 80 },
      },
    })
  );
  await page.goto("/upgrade-xoc");
  await page.getByLabel("Booking email").fill("kwd@example.invalid");
  await page.getByLabel("Enter your Order ID").fill("booking-kwd-1");
  await page.getByRole("button", { name: "Check eligibility", exact: true }).click();
  await expect(page.getByText("12.010 KWD")).toBeVisible();
  await expect(page.getByText("67.990 KWD")).toBeVisible();
});

test("PayPalScriptProvider binds EUR currency for new and legacy EUR sessions", async ({ page, flow }) => {
  const sdkUrls = [];
  await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, (route) => {
    sdkUrls.push(route.request().url());
    return route.fulfill({
      contentType: "application/javascript",
      body: `window.paypal = { Buttons: (cfg) => ({ isEligible: () => true, render: (el) => { const b = document.createElement("button"); b.type = "button"; b.textContent = "Mock PayPal EUR"; b.onclick = () => cfg.createOrder().catch(() => {}); el.innerHTML = ""; el.appendChild(b); return Promise.resolve(); }, close: () => Promise.resolve() }) };`,
    });
  });
  await page.route("**/api/payment/quote", (route) =>
    route.fulfill({
      json: {
        ok: true,
        currency: "EUR",
        quoteFingerprint: "fp-eur",
        quote: { currency: "EUR", grossAmount: 9.99, discountAmount: 0, netAmount: 9.99, isFree: false },
        providers: {
          dodo: { enabled: false, mode: "missing", currency: "USD" },
          razorpay: { enabled: false, mode: "missing", currency: "USD" },
          paypal: { enabled: true, mode: "sandbox", currency: "EUR", clientId: "sb-eur-id" },
        },
      },
    })
  );
  const startCalls = [];
  await page.route("**/api/payment/start", (route) => {
    startCalls.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        provider: "paypal",
        currency: "EUR",
        quoteFingerprint: "fp-eur",
        quote: { currency: "EUR", grossAmount: 9.99, discountAmount: 0, netAmount: 9.99, isFree: false },
        paymentAccessToken: "tok-eur-1",
        providerOrderReady: true,
        providerPayload: { orderId: "pp-eur-order-1", currency: "EUR", amount: 999, clientId: "sb-eur-id" },
        sessionExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      },
    });
  });

  await flow.review();
  await flow.payment();
  await expect(page.getByText("9.99 EUR")).toBeVisible();
  await expect.poll(() => sdkUrls.some((u) => u.includes("currency=EUR"))).toBe(true);
  await page.getByRole("button", { name: "Mock PayPal EUR", exact: true }).click();
  await expect.poll(() => startCalls.length).toBe(1);
});

test("mixed-provider retry persists selectedQuoteProvider and ignores late response from earlier reservation", async ({ page, flow }) => {
  const quoteBodies = [];
  let releaseDelayedMismatch;
  const delayedMismatch = new Promise((r) => { releaseDelayedMismatch = r; });
  let startCount = 0;

  await page.route("**/api/payment/quote", async (route) => {
    const body = route.request().postDataJSON() || {};
    quoteBodies.push(body);
    const prov = body.provider || "dodo";
    const isKwd = prov === "razorpay";
    return route.fulfill({
      json: {
        ok: true,
        currency: isKwd ? "KWD" : "USD",
        quoteFingerprint: isKwd ? "fp-kwd-2" : "fp-usd-1",
        quote: { currency: isKwd ? "KWD" : "USD", grossAmount: isKwd ? 80 : 84.99, discountAmount: 0, netAmount: isKwd ? 80 : 84.99, isFree: false },
        providers: {
          dodo: { enabled: true, mode: "test", currency: "USD" },
          razorpay: { enabled: true, mode: "test", currency: "KWD" },
          paypal: { enabled: false, mode: "missing", currency: "USD" },
        },
      },
    });
  });

  await page.route("**/api/payment/start", async (route) => {
    startCount += 1;
    const reqBody = route.request().postDataJSON();
    if (startCount === 1) {
      await delayedMismatch;
      return route.fulfill({
        status: 409,
        json: {
          ok: false,
          code: "quote_fingerprint_mismatch",
          currency: "KWD",
          quoteFingerprint: "fp-kwd-from-A",
          quote: { currency: "KWD", grossAmount: 80, discountAmount: 0, netAmount: 80, isFree: false },
          providers: {
            dodo: { enabled: true, mode: "test", currency: "USD" },
            razorpay: { enabled: true, mode: "test", currency: "KWD" },
            paypal: { enabled: false, mode: "missing", currency: "USD" },
          },
        },
      });
    }
    return route.fulfill({
      status: 409,
      json: {
        ok: false,
        code: "quote_fingerprint_mismatch",
        currency: "KWD",
        quoteFingerprint: `fp-kwd-${reqBody.bookingPayload?.slotHoldId || "x"}`,
        quote: { currency: "KWD", grossAmount: 80, discountAmount: 0, netAmount: 80, isFree: false },
      },
    });
  });

  await page.route("https://checkout.razorpay.com/v1/checkout.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.Razorpay = function() { return { open() {} }; };" })
  );

  await flow.review();
  await flow.payment();
  await expect(page.getByText("$84.99 USD", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Razorpay/i }).click();
  await expect.poll(() => startCount).toBe(1);

  const slotB = {
    packageTitle: "Performance Vertex Overhaul",
    packagePrice: "$84.99",
    startTimeUTC: "2099-03-02T10:00:00.000Z",
    email: "b@example.invalid",
    discord: "userb",
    slotHoldId: "slotHold.B",
    slotHoldToken: makeHoldToken("nonce-B"),
    slotHoldExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
  };
  await page.evaluate((b) => {
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(b));
    sessionStorage.setItem("my_slot_hold", JSON.stringify({ holdId: b.slotHoldId, holdToken: b.slotHoldToken, expiresAt: b.slotHoldExpiresAt, startTimeUTC: b.startTimeUTC, packageTitle: b.packageTitle, phase: "holding" }));
    window.history.pushState({ usr: { bookingData: b } }, "", "/payment");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, slotB);

  await expect.poll(() => quoteBodies.some((b) => b.startTimeUTC === "2099-03-02T10:00:00.000Z")).toBe(true);
  releaseDelayedMismatch();
  await expect(page.getByText("$84.99 USD", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText("$84.99 USD", { exact: true })).toBeVisible();
  const persistedProv = await page.evaluate(() => sessionStorage.getItem("roo_selected_quote_provider"));
  expect(persistedProv).toBeNull();
});

test("invalid stored lock (quoteFingerprintValid: false) blocks browser resume", async ({ page, flow }) => {
  await flow.review();
  await flow.payment();

  await page.evaluate(() => {
    const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}");
    const fp = JSON.stringify({
      packageTitle: checkout.packageTitle || "",
      originalOrderId: checkout.originalOrderId || "",
      startTimeUTC: checkout.startTimeUTC || "",
      email: checkout.email || "",
      referralCode: checkout.referralCode || "",
      couponCode: checkout.couponCode || "",
    });
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo",
      fingerprint: fp,
      paymentAccessToken: "tok-invalid-fp",
      providerPayload: { orderId: "ord-inv", checkoutUrl: `${location.origin}/__test/checkout-handoff`, dodoReturnTag: "tag-inv" },
      result: { refreshedHold: { slotHoldId: checkout.slotHoldId, slotHoldToken: checkout.slotHoldToken } },
    }));
  });
  await page.route("**/api/payment/status", (route) =>
    route.fulfill({
      json: { ok: true, status: "started", provider: "dodo", quoteFingerprint: "", quoteFingerprintValid: false, providerOrderReady: true },
    })
  );

  await page.reload();
  await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
  await expect(page.getByText("This payment session cannot be resumed. Check its status instead.")).toBeVisible();
  await expect(page).toHaveURL(/\/payment$/);
});

test("booking step 3 handles lineage-owned release rejection and successful release rotation", async ({ page, flow }) => {
  await flow.review();
  await flow.payment();
  const nextToken = makeHoldToken("rotated-booking-release");
  let rejectFirst = true;
  await page.route("**/api/payment/cancel", (route) => {
    if (rejectFirst) {
      rejectFirst = false;
      return route.fulfill({ status: 409, json: { ok: false, error: "Payment cancellation was rejected." } });
    }
    return route.fulfill({
      json: {
        ok: true,
        cancelled: true,
        status: "abandoned",
        providerPaymentState: "cancelled",
        terminalOutcomeComplete: true,
        refreshedHold: {
          slotHoldId: "slotHold.released",
          slotHoldToken: nextToken,
          slotHoldExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
          phase: "holding",
        },
      },
    });
  });

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
      paymentAccessToken: "tok-booking-release",
      providerPayload: { orderId: "ord-rel", checkoutUrl: `${location.origin}/__test/checkout-handoff`, dodoReturnTag: "tag-rel" },
      result: { refreshedHold: { slotHoldId: hold.holdId, slotHoldToken: hold.holdToken, slotHoldExpiresAt: hold.expiresAt } },
    }));
  });

  await page.goto("/booking");
  await expect(page).toHaveURL(/\/booking/);
  const releaseBtn = page.getByRole("button", { name: /^Release payment$/i });
  await expect(releaseBtn).toBeVisible();
  await expect(page.getByRole("button", { name: /^Return to payment$/i })).toBeVisible();

  await releaseBtn.click();
  await expect(page.getByText("Payment cancellation was rejected.")).toBeVisible();
  await expect(releaseBtn).toBeEnabled();

  await releaseBtn.click();
  await expect(page.getByText(/Payment method released/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Continue to payment$/i })).toBeVisible();
  const after = await page.evaluate(() => ({
    session: sessionStorage.getItem("payment_session_state"),
    hold: JSON.parse(sessionStorage.getItem("my_slot_hold") || "null"),
  }));
  expect(after.session).toBeNull();
  expect(after.hold?.holdToken).toBe(nextToken);
  expect(after.hold?.phase).toBe("holding");
});

test("tagged Dodo expired-hold return finalizes without redirect and tagged cancel restores payment methods", async ({ page, flow }) => {
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
    const expired = "2000-01-01T00:00:00.000Z";
    sessionStorage.setItem("checkout_booking_state", JSON.stringify({ ...checkout, slotHoldExpiresAt: expired }));
    sessionStorage.setItem("my_slot_hold", JSON.stringify({ ...hold, expiresAt: expired, phase: "payment_pending" }));
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo",
      fingerprint: fp,
      paymentAccessToken: "tok-dodo-exp-return",
      providerPayload: { orderId: "ord-exp-ret", checkoutUrl: `${location.origin}/__test/checkout-handoff`, dodoReturnTag: "tag-exp-ret" },
      result: { refreshedHold: { slotHoldId: hold.holdId, slotHoldToken: hold.holdToken, slotHoldExpiresAt: expired } },
    }));
  });

  await page.route("**/api/payment/finalize", (route) =>
    route.fulfill({
      json: {
        ok: true,
        status: "booked",
        bookingId: "booking-dodo-exp-ret",
        emailDispatchToken: "disp-exp-ret",
      },
    })
  );

  await page.goto("/payment?dodo_return=1&dodo_session=tag-exp-ret");
  await expect(page).toHaveURL(/\/payment-success/);
});

test("PayPal session reload locks Razorpay and redirects if status reports booked", async ({ page, flow }) => {
  await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "window.paypal = { Buttons: (opts) => { window.__ppOpts = opts; return { isEligible: () => true, render: () => Promise.resolve(), close: () => Promise.resolve() }; } };",
    })
  );
  await page.route("https://checkout.razorpay.com/v1/checkout.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.Razorpay = function() { return { open() {} }; };" })
  );
  const ppProviders = {
    dodo: { enabled: true, mode: "test", currency: "USD" },
    razorpay: { enabled: true, mode: "test", currency: "USD" },
    paypal: { enabled: true, mode: "sandbox", currency: "USD", clientId: "sb-usd-client" },
  };
  await page.route("**/api/payment/providers", (route) =>
    route.fulfill({ json: { ok: true, providers: ppProviders } })
  );
  await page.route("**/api/payment/quote", (route) =>
    route.fulfill({
      json: {
        ok: true,
        currency: "USD",
        quoteFingerprint: "fp-pp-usd",
        quote: { currency: "USD", grossAmount: 84.99, discountAmount: 0, netAmount: 84.99, isFree: false },
        providers: ppProviders,
      },
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
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "paypal",
      fingerprint: fp,
      paymentAccessToken: "tok-pp-resume",
      providerPayload: { orderId: "pp-order-resume", currency: "USD", amount: 8499 },
      result: { refreshedHold: { slotHoldId: hold.holdId, slotHoldToken: hold.holdToken, slotHoldExpiresAt: hold.expiresAt } },
    }));
  });

  await page.route("**/api/payment/status", (route) =>
    route.fulfill({ json: { ok: true, status: "booked", bookingId: "booking-pp-resume", emailDispatchToken: "disp-pp" } })
  );

  await page.reload();
  await expect(page.getByRole("button", { name: /Pay with Razorpay/i })).toBeDisabled();
  await expect(page.getByText(/Pricing and provider selection are locked/i)).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__ppOpts?.createOrder));
  await page.evaluate(() => window.__ppOpts.createOrder().catch(() => {}));
  await expect(page).toHaveURL(/\/payment-success/);
});

test("stalled payment status requests abort and stop within the poll deadline", async ({ page, flow }) => {
  await page.addInitScript(() => {
    const origSetTimeout = window.setTimeout;
    const realNow = Date.now.bind(Date);
    let offset = 0;
    Date.now = () => realNow() + offset;
    window.setTimeout = (fn, ms, ...args) => {
      if (window.location.search.includes("dodo_session=tag-stall") && typeof ms === "number" && ms >= 100 && ms <= 15000) {
        return origSetTimeout(() => { offset += ms; fn(...args); }, ms >= 5000 ? 25 : 10);
      }
      return origSetTimeout(fn, ms, ...args);
    };
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
      provider: "dodo",
      fingerprint: fp,
      paymentAccessToken: "tok-stall-poll",
      providerPayload: { orderId: "ord-stall", checkoutUrl: `${location.origin}/__test/checkout-handoff`, dodoReturnTag: "tag-stall" },
      result: { refreshedHold: { slotHoldId: hold.holdId, slotHoldToken: hold.holdToken, slotHoldExpiresAt: hold.expiresAt } },
    }));
  });

  let statusAttempts = 0;
  await page.route("**/api/payment/finalize", (route) =>
    route.fulfill({ status: 202, json: { ok: true, status: "needs_recovery" } })
  );
  await page.route("**/api/payment/status", async () => {
    statusAttempts += 1;
    await new Promise(() => {});
  });

  await page.goto("/payment?dodo_return=1&dodo_session=tag-stall");
  await expect(page.getByText(/Timed out waiting for payment confirmation/i)).toBeVisible({ timeout: 10000 });
  expect(statusAttempts).toBeGreaterThanOrEqual(2);
  expect(statusAttempts).toBeLessThanOrEqual(10);
});
