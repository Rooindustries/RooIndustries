const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

const providers = {
  dodo: { enabled: true, mode: "test" },
  razorpay: { enabled: true, mode: "test" },
  paypal: { enabled: false, mode: "disabled" },
};

test("while one payment method is starting checkout, another can't start a second one", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    await gate;
    await route.fallback();
  });

  await flow.review();
  await flow.payment();
  const razorpay = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
  await expect(razorpay).toBeEnabled();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);
  await expect(razorpay).toBeDisabled();
  await razorpay.click({ force: true });
  await page.waitForTimeout(500);
  expect(starts).toHaveLength(1);

  release();
  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(starts).toHaveLength(1);
});

test("an older start that finishes late does not unlock another method while a newer start runs", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: `fixture-quote-${route.request().postDataJSON()?.couponCode || "none"}`, providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  const releases = [];
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    await new Promise(resolve => releases.push(resolve));
    await route.fallback();
  });

  await flow.review();
  await flow.payment();
  const dodo = page.getByRole("button", { name: /^(Pay your way|Opening checkout\.\.\.)$/ });
  const razorpay = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
  await expect(razorpay).toBeEnabled();
  await dodo.click();
  await expect.poll(() => starts.length).toBe(1);

  const coupon = page.locator("#payment-coupon-code");
  await coupon.fill("save20");
  await coupon.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(2);

  releases[0]();
  await page.waitForTimeout(500);
  await expect(razorpay).toBeDisabled();
  await razorpay.click({ force: true });
  await page.waitForTimeout(500);
  expect(starts).toHaveLength(2);

  releases[1]();
  await expect(page).toHaveURL(/checkout-handoff$/);
});

test("a newer start that fails fast does not unlock another method while an older start is still pending", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: `fixture-quote-${route.request().postDataJSON()?.couponCode || "none"}`, providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  let releaseFirst;
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    if (starts.length === 1) {
      await new Promise(resolve => { releaseFirst = resolve; });
      return route.fallback();
    }
    return route.fulfill({ status: 409, json: { ok: false, code: "quote_fingerprint_mismatch", error: "The price changed." } });
  });

  await flow.review();
  await flow.payment();
  const razorpay = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
  await expect(razorpay).toBeEnabled();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);

  const coupon = page.locator("#payment-coupon-code");
  await coupon.fill("save20");
  await coupon.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(2);
  await expect(page.getByText("The price changed. Review the updated total and click again.", { exact: true })).toBeVisible();

  await expect(razorpay).toBeDisabled();
  await razorpay.click({ force: true });
  await page.waitForTimeout(500);
  expect(starts).toHaveLength(2);

  releaseFirst();
  await expect(razorpay).toBeEnabled();
});

const paypalSdkStub = `
window.paypal = {
  version: "5.0.0",
  Buttons(options) {
    return {
      isEligible: () => true,
      render(container) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Fixture PayPal";
        button.addEventListener("click", async () => {
          const result = await options.onClick({}, { resolve: () => "resolved", reject: () => "rejected" });
          window.__paypalClickResult = result;
          if (result === "resolved") window.__paypalCreateOrder = () => options.createOrder({}, {});
        });
        container.appendChild(button);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
      updateProps: () => Promise.resolve(),
    };
  },
};
`;

test("a PayPal order created after another method started checkout is refused", async ({ page, flow }) => {
  const withPaypal = { ...providers, paypal: { enabled: true, mode: "sandbox", clientId: "fixture-client" } };
  await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, route => route.fulfill({
    contentType: "application/javascript", body: paypalSdkStub,
  }));
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers: withPaypal } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers: withPaypal,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    await gate;
    await route.fallback();
  });

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Fixture PayPal", exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.__paypalCreateOrder)).toBe("function");
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);

  const created = await page.evaluate(() => window.__paypalCreateOrder().then(() => "created", error => String(error?.message || error)));
  expect(created).toContain("Another payment method is still starting");
  expect(starts).toHaveLength(1);

  release();
  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(starts).toHaveLength(1);
});

test("clicking PayPal while another method is starting checkout is refused", async ({ page, flow }) => {
  const withPaypal = { ...providers, paypal: { enabled: true, mode: "sandbox", clientId: "fixture-client" } };
  await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, route => route.fulfill({
    contentType: "application/javascript", body: paypalSdkStub,
  }));
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers: withPaypal } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers: withPaypal,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    await gate;
    await route.fallback();
  });

  await flow.review();
  await flow.payment();
  await expect(page.getByRole("button", { name: "Fixture PayPal", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);

  await page.getByRole("button", { name: "Fixture PayPal", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__paypalClickResult)).toBe("rejected");
  expect(await page.evaluate(() => typeof window.__paypalCreateOrder)).toBe("undefined");
  expect(starts).toEqual(["dodo"]);

  release();
  await expect(page).toHaveURL(/checkout-handoff$/);
  expect(starts).toEqual(["dodo"]);
});

test("while Razorpay is starting checkout, Pay your way can't start a second one", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() { window.__razorpayOpened = (window.__razorpayOpened || 0) + 1; }, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-quote", providers,
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    await gate;
    await route.fallback();
  });

  await flow.review();
  await flow.payment();
  const dodo = page.getByRole("button", { name: "Pay your way", exact: true });
  const razorpay = page.getByRole("button", { name: "Pay with Razorpay", exact: true });
  await expect(dodo).toBeEnabled();
  await expect(razorpay).toBeEnabled();
  await razorpay.click();
  await expect.poll(() => starts.length).toBe(1);
  await expect(dodo).toBeDisabled();
  await dodo.click({ force: true });
  await page.waitForTimeout(500);
  expect(starts).toEqual(["razorpay"]);

  release();
  await page.waitForTimeout(500);
  expect(starts).toEqual(["razorpay"]);
  await expect(page).not.toHaveURL(/checkout-handoff$/);
});

test("a free booking can't be confirmed while a paid checkout is starting", async ({ page, flow }) => {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay = function () { return { open() {}, on() {} }; };",
  }));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/ref/validateCoupon?code=free100*", route => route.fulfill({
    json: { ok: true, coupon: { code: "free100", discountType: "percent", discountPercent: 100, canCombineWithReferral: true } },
  }));
  await page.route("**/api/payment/quote", route => {
    const free = route.request().postDataJSON()?.couponCode === "free100";
    return route.fulfill({ json: {
      ok: true, quoteFingerprint: free ? "fixture-quote-free" : "fixture-quote", providers,
      quote: { grossAmount: 84.99, netAmount: free ? 0 : 84.99, isFree: free },
    } });
  });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const starts = [];
  await page.route("**/api/payment/start", async route => {
    starts.push(route.request().postDataJSON()?.provider || "unknown");
    await gate;
    await route.fallback();
  });

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);

  const coupon = page.locator("#payment-coupon-code");
  await coupon.fill("free100");
  await coupon.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  const confirmFree = page.getByRole("button", { name: "Confirm Free Booking", exact: true });
  await expect(confirmFree).toBeVisible();
  await expect(confirmFree).toBeDisabled();
  await confirmFree.click({ force: true });
  await page.waitForTimeout(500);
  expect(starts).toEqual(["dodo"]);

  release();
  await expect(confirmFree).toBeEnabled();
  await expect(page).toHaveURL(/\/payment$/);
  expect(starts).toEqual(["dodo"]);
  expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
});

const resumeQuoteTest = test.extend({
  launchOptions: async ({ launchOptions }, use) => {
    await use({ ...launchOptions, channel: "chromium", ignoreDefaultArgs: ["--disable-back-forward-cache"] });
  },
  resume: async ({ page, browser, flow, baseURL }, use, testInfo) => {
    const evidence = { setupComplete: false, calls: [], requests: [], snapshots: {}, pageErrors: [], readiness: [] };
    const pendingAssets = new Set();
    const config = { failure: false, gate: null,
      status: { httpStatus: 200, body: { ok: true, status: "started" } },
      cancel: { httpStatus: 409, body: { ok: false, error: "Fixture cancellation refused." } },
    };
    const enabledProviders = { dodo: { enabled: true, mode: "test" }, razorpay: { enabled: true, mode: "test" }, paypal: { enabled: true, mode: "sandbox", clientId: "fixture-client" } };
    const attach = async (name, value) => testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: "application/json" });
    await page.addInitScript(() => {
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
      window.__resumeObservation = { nonce, pageshows: [] };
      window.__resumeSdk = [];
      addEventListener("pageshow", event => window.__resumeObservation.pageshows.push({ persisted: event.persisted, url: location.href, at: performance.now() }));
    });
    page.on("pageerror", error => evidence.pageErrors.push({ name: error.name, message: error.message }));
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.origin === baseURL && ["script", "stylesheet", "image", "font"].includes(request.resourceType())) pendingAssets.add(request);
      if (url.pathname.startsWith("/api/")) evidence.requests.push({ at: Date.now(), path: url.pathname, body: request.postDataJSON(), authorization: request.headers().authorization || "" });
    });
    page.on("requestfinished", request => pendingAssets.delete(request));
    page.on("requestfailed", request => pendingAssets.delete(request));
    const snapshot = () => page.evaluate(() => {
      const raw = Object.fromEntries(["payment_session_state", "my_slot_hold", "booking_draft", "referral_dismissed", "referral_capture", "referral_session"].map(key => [key, sessionStorage.getItem(key)]));
      const panel = document.querySelector(".booking-payment");
      const summary = [...document.querySelectorAll("h3")].find(element => element.textContent === "Booking Summary")?.parentElement;
      return { at: Date.now(), url: location.href, raw, session: JSON.parse(raw.payment_session_state || "null"), hold: JSON.parse(raw.my_slot_hold || "null"), draft: JSON.parse(raw.booking_draft || "null"), observation: window.__resumeObservation, sdk: window.__resumeSdk,
        navigation: performance.getEntriesByType("navigation").map(entry => entry.type), ui: { summary: summary?.innerText || "", body: document.body.innerText, opacity: panel ? getComputedStyle(panel).opacity : null, children: panel ? [...panel.children].map(child => getComputedStyle(child).opacity) : [], buttons: [...document.querySelectorAll("button")].map(button => ({ text: button.textContent, disabled: button.disabled })) } };
    });
    const capture = async name => {
      const value = await snapshot();
      evidence.snapshots[name] = value;
      await attach(`resume-${name}`, value);
      if (await page.getByRole("heading", { name: "Booking Summary", exact: true }).count()) await testInfo.attach(`resume-${name}-paint`, { body: await page.screenshot(), contentType: "image/png" });
      return value;
    };
    await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({ contentType: "application/javascript", body: `
      window.Razorpay = function(options) {
        this.open = () => window.__resumeSdk.push({ kind: "razorpay-open", orderId: options.order_id, key: options.key, amount: options.amount, currency: options.currency });
        this.on = () => {};
      };
    ` }));
    await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, route => route.fulfill({ contentType: "application/javascript", body: `
      window.paypal = { version: "5.0.0", Buttons(options) {
        let button;
        return { isEligible: () => true, updateProps: () => Promise.resolve(), close: async () => button?.remove(),
          async render(container) {
            button = document.createElement("button");
            button.type = "button"; button.textContent = "Resume fixture PayPal"; button.disabled = true;
            container.appendChild(button);
            options.onInit({}, {
              enable: async () => { button.disabled = false; window.__resumeSdk.push({ kind: "paypal-enable" }); },
              disable: async () => { button.disabled = true; window.__resumeSdk.push({ kind: "paypal-disable" }); },
            });
            button.addEventListener("click", async () => {
              try {
                const result = await options.onClick({}, { resolve: () => "resolved", reject: () => "rejected" });
                window.__resumeSdk.push({ kind: "paypal-click", result });
                if (result === "resolved") window.__resumeSdk.push({ kind: "paypal-order", orderId: await options.createOrder({}, {}) });
              } catch (error) { window.__resumeSdk.push({ kind: "paypal-error", message: error.message }); options.onError?.(error); }
            });
          },
        };
      } };
    ` }));
    for (const path of ["/api/payment/providers", "/api/payment/quote", "/api/payment/start", "/api/payment/status", "/api/payment/cancel"]) {
      await page.route(`**${path}`, async route => {
        const request = route.request();
        const call = { at: Date.now(), path, body: request.postDataJSON(), authorization: request.headers().authorization || "" };
        evidence.calls.push(call);
        let response, status = 200;
        if (path === "/api/payment/providers") response = { ok: true, providers: enabledProviders };
        if (path === "/api/payment/quote") {
          const gate = config.gate;
          if (gate) { call.gated = true; gate.entered.push(call); await gate.promise; }
          if (config.failure) { status = 503; response = { ok: false, error: "Fixture fresh quote unavailable." }; }
          else response = { ok: true, providers: enabledProviders, quoteFingerprint: `resume-price-${call.body.referralCode || "none"}`, quote: { grossAmount: 54.95, netAmount: call.body.referralCode === "friend" ? 49.45 : 54.95, isFree: false } };
        }
        if (path === "/api/payment/start") {
          const hold = flow.state.holds.get(call.body.bookingPayload.startTimeUTC);
          expect(hold).toBeTruthy();
          expect(call.body.bookingPayload.referralCode).toBe("");
          expect(call.body.quoteFingerprint).toBe("resume-price-none");
          const provider = call.body.provider;
          const providerPayload = provider === "dodo" ? { checkoutUrl: `${baseURL}/__test/checkout-handoff` }
            : provider === "razorpay" ? { orderId: "resume-razorpay-order", key: "fixture-razorpay-key", amount: 5495, currency: "USD" }
              : { orderId: "resume-paypal-order" };
          response = { ok: true, status: "started", paymentAccessToken: `resume-${provider}-token`, providerPayload,
            quote: { grossAmount: 54.95, netAmount: 54.95, isFree: false }, quoteFingerprint: "resume-price-none",
            sessionExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
            refreshedHold: { slotHoldId: hold.holdId, slotHoldToken: hold.holdToken, slotHoldExpiresAt: hold.expiresAt, phase: "payment_pending" } };
        }
        if (path === "/api/payment/status") { status = config.status.httpStatus; response = config.status.body; }
        if (path === "/api/payment/cancel") {
          status = config.cancel.httpStatus; response = { ...config.cancel.body };
          if (response.ok && response.cancelled) {
            const hold = [...flow.state.holds.values()][0];
            expect(hold).toBeTruthy();
            response.refreshedHold = { slotHoldId: hold.holdId, slotHoldToken: hold.holdToken, slotHoldExpiresAt: hold.expiresAt, phase: "holding" };
          }
        }
        call.response = response; call.status = status;
        await route.fulfill({ status, json: response });
        call.fulfilledAt = Date.now();
      });
    }
    const button = provider => page.getByRole("button", { name: provider === "dodo" ? /^(Pay your way|Resume checkout)$/ : provider === "razorpay" ? "Pay with Razorpay" : "Resume fixture PayPal", exact: true });
    const paint = async () => {
      const panel = page.locator(".booking-payment");
      await expect(panel).toHaveCSS("opacity", "1", { timeout: 5000 });
      for (const child of await panel.locator(":scope > div").all()) await expect(child).toHaveCSS("opacity", "1", { timeout: 5000 });
      await page.getByRole("heading", { name: "Booking Summary", exact: true }).scrollIntoViewIfNeeded();
    };
    const ready = async () => {
      await expect.poll(() => pendingAssets.size, { timeout: 10000 }).toBe(0);
      evidence.readiness.push({ at: Date.now(), url: page.url(), pending: [...pendingAssets].map(request => request.url()) });
    };
    const payment = async () => {
      await flow.review(); await flow.payment(); await paint(); await ready();
      await page.goto("/payment?internalPayments=1");
      for (const provider of ["dodo", "razorpay", "paypal"]) await expect(button(provider)).toBeEnabled();
      await paint(); await ready();
      await expect.poll(() => evidence.calls.filter(call => call.path === "/api/payment/quote").every(call => call.fulfilledAt)).toBe(true);
    };
    const open = async provider => {
      await payment();
      await button(provider).click();
      if (provider === "dodo") {
        await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
        await capture("handoff");
        await page.goBack({ waitUntil: "commit" });
      } else {
        await expect.poll(() => page.evaluate(provider => window.__resumeSdk.filter(call => call.kind === (provider === "razorpay" ? "razorpay-open" : "paypal-order")).length, provider)).toBe(1);
      }
      await expect(button(provider)).toBeEnabled(); await paint(); await ready();
      const baseline = await capture("baseline");
      expect(baseline.session.provider).toBe(provider);
      expect(baseline.session.result.quote.netAmount).toBe(54.95);
      expect(JSON.parse(baseline.session.fingerprint).referralCode).toBe("");
      expect(evidence.calls.filter(call => call.path === "/api/payment/start")).toHaveLength(1);
      return baseline;
    };
    const gateQuote = () => {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      config.gate = { promise, entered: [], release: () => { config.failure = true; release(); } };
    };
    const failQuote = async () => {
      const observed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/payment/quote" && response.status() === 503);
      config.gate.release();
      const response = await observed;
      await response.finished();
      await expect(page.getByRole("alert").filter({ hasText: "Fixture fresh quote unavailable." })).toBeVisible();
    };
    const newerLink = async baseline => {
      gateQuote(); await ready();
      await page.goto("/about?ref=friend");
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_session"))).toContain("friend");
      const other = await capture("public"); await ready();
      await page.goBack({ waitUntil: "commit" });
      await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
      await expect.poll(() => config.gate.entered.length).toBeGreaterThan(0);
      expect(config.gate.entered[0].body.referralCode).toBe("friend");
      await paint();
      const restored = await capture("pending-quote");
      expect(restored.raw.payment_session_state).toBe(baseline.raw.payment_session_state);
      expect(restored.hold).toEqual(baseline.hold);
      expect(restored.draft).toEqual(baseline.draft);
      if (baseline.session?.provider === "dodo") {
        expect(other.observation.nonce).not.toBe(baseline.observation.nonce);
        expect(restored.observation.nonce).toBe(baseline.observation.nonce);
        expect(restored.observation.pageshows.slice(baseline.observation.pageshows.length).some(event => event.persisted)).toBe(true);
      }
      evidence.setupComplete = true;
      await attach("resume-setup-controls", evidence);
      return restored;
    };
    const unchanged = (actual, baseline) => {
      expect(actual.raw.payment_session_state).toBe(baseline.raw.payment_session_state);
      expect(actual.hold).toEqual(baseline.hold); expect(actual.draft).toEqual(baseline.draft);
    };
    const again = async (provider, baseline) => {
      const soft = expect.configure({ soft: true });
      const before = await snapshot();
      const priorOpens = before.sdk.filter(call => call.kind === (provider === "razorpay" ? "razorpay-open" : "paypal-order")).length;
      if (await button(provider).isEnabled()) await button(provider).click();
      else evidence.resumeBlockedByDisabledButton = provider;
      await soft.poll(() => evidence.calls.filter(call => call.path === "/api/payment/status").length, { timeout: 2000 }).toBe(1);
      const statuses = evidence.calls.filter(call => call.path === "/api/payment/status");
      soft(statuses.map(call => ({ authorization: call.authorization, body: call.body }))).toEqual([{ authorization: `Bearer ${baseline.session.paymentAccessToken}`, body: {} }]);
      if (statuses.length) {
        if (provider === "dodo") await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
        else await soft.poll(() => page.evaluate(provider => window.__resumeSdk.filter(call => call.kind === (provider === "razorpay" ? "razorpay-open" : "paypal-order")).length, provider), { timeout: 2000 }).toBe(priorOpens + 1);
      }
      const resumed = await capture("resumed"); unchanged(resumed, baseline);
      if (provider !== "dodo" && statuses.length) soft(resumed.sdk.filter(call => call.kind === (provider === "razorpay" ? "razorpay-open" : "paypal-order")).at(-1).orderId).toBe(baseline.session.providerPayload.orderId);
      await soft(page.getByText("Final amount is zero or negative. Please contact support.", { exact: true })).not.toBeVisible({ timeout: 2000 });
    };
    const cdp = await browser.newBrowserCDPSession(); evidence.engine = await cdp.send("Browser.getVersion"); await cdp.detach();
    try { await use({ evidence, config, button, capture, snapshot, paint, ready, payment, open, newerLink, failQuote, unchanged, again }); }
    finally {
      config.gate?.release();
      try { evidence.final = await snapshot(); } catch (error) { evidence.final = { unavailable: true, message: error.message }; }
      evidence.flowCalls = flow.state.calls; evidence.aborted = flow.state.aborted; evidence.holds = [...flow.state.holds.entries()];
      evidence.errors = testInfo.errors.map(error => error.message);
      await attach("resume-evidence", evidence);
      await testInfo.attach("resume-final-page", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(evidence.pageErrors).toEqual([]); expect(evidence.aborted).toEqual([]);
      expect(evidence.requests.filter(call => /\/api\/payment\/(capture|confirm|finalize)(\/|$)/.test(call.path) || call.path === "/api/releaseHold")).toEqual([]);
      expect(evidence.requests.filter(call => call.path === "/api/payment/cancel")).toHaveLength(evidence.expectedCancels || 0);
      if (evidence.expectedSessionRemoved) expect(evidence.final.session).toBeNull();
      expect(evidence.requests.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
      expect(evidence.requests.filter(call => call.path === "/api/payment/start")).toHaveLength(evidence.noStart ? 0 : 1);
    }
  },
});

resumeQuoteTest.use({ viewport: { width: 390, height: 844 }, video: "off" });

for (const [provider, title] of [["dodo", "Dodo"], ["razorpay", "Razorpay"], ["paypal", "PayPal"]]) {
  resumeQuoteTest(`a reserved ${title} checkout resumes while its new quote is pending or unavailable`, async ({ page, resume }) => {
    const baseline = await resume.open(provider);
    await resume.newerLink(baseline);
    const soft = expect.configure({ soft: true });
    await soft(resume.button(provider)).toBeEnabled({ timeout: 2000 });
    for (const other of ["dodo", "razorpay", "paypal"].filter(value => value !== provider)) await expect(resume.button(other)).toBeDisabled();
    await expect(page.getByRole("heading", { name: "Booking Summary", exact: true }).locator("..").getByText("$54.95 USD", { exact: true })).toBeVisible();
    await resume.failQuote();
    const failed = await resume.capture("failed-quote"); resume.unchanged(failed, baseline);
    await soft(resume.button(provider)).toBeEnabled({ timeout: 2000 });
    for (const other of ["dodo", "razorpay", "paypal"].filter(value => value !== provider)) await expect(resume.button(other)).toBeDisabled();
    await resume.again(provider, baseline);
  });
}

resumeQuoteTest("a reserved Razorpay checkout with no saved price resumes without claiming a zero amount", async ({ page, resume }) => {
  const baseline = await resume.open("razorpay");
  const legacyRaw = await page.evaluate(() => {
    const value = JSON.parse(sessionStorage.getItem("payment_session_state")); delete value.result.quote;
    const raw = JSON.stringify(value); sessionStorage.setItem("payment_session_state", raw); return raw;
  });
  const expected = JSON.parse(baseline.raw.payment_session_state); delete expected.result.quote;
  expect(JSON.parse(legacyRaw)).toEqual(expected);
  const legacy = { ...baseline, raw: { ...baseline.raw, payment_session_state: legacyRaw }, session: JSON.parse(legacyRaw) };
  resume.evidence.constructedLegacy = legacy;
  await resume.ready(); await page.reload();
  await expect(resume.button("razorpay")).toBeEnabled(); await resume.paint(); await resume.ready();
  const restored = await resume.capture("legacy-reload"); resume.unchanged(restored, legacy);
  resume.evidence.setupComplete = true;
  const summary = page.getByRole("heading", { name: "Booking Summary", exact: true }).locator("..");
  await expect(summary.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(summary.getByText("Session price unavailable. Try again or change payment method.", { exact: true })).toBeVisible();
  await expect(summary.getByText(/\$\d+\.\d{2}/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm Free Booking", exact: true })).not.toBeVisible();
  const soft = expect.configure({ soft: true });
  await soft(page.getByText(/^(Cards & crypto|Cards, crypto & Klarna)$/)).toHaveCount(0, { timeout: 2000 });
  await resume.again("razorpay", legacy);
});

resumeQuoteTest("a new checkout still waits for its confirmed price", async ({ page, resume }) => {
  resume.evidence.noStart = true;
  await resume.payment(); const baseline = await resume.capture("fresh-baseline"); expect(baseline.session).toBeNull();
  await resume.newerLink(baseline);
  for (const provider of ["dodo", "razorpay", "paypal"]) await expect(resume.button(provider)).toBeDisabled();
  await resume.failQuote();
  const failed = await resume.capture("fresh-quote-failed"); resume.unchanged(failed, baseline);
  for (const provider of ["dodo", "razorpay", "paypal"]) await expect(resume.button(provider)).toBeDisabled();
  resume.config.gate = null; resume.config.failure = false;
  await page.getByRole("button", { name: "Retry price check", exact: true }).click();
  for (const provider of ["dodo", "razorpay", "paypal"]) await expect(resume.button(provider)).toBeEnabled();
  await resume.paint(); const recovered = await resume.capture("fresh-price-recovered"); resume.unchanged(recovered, baseline);
});

const sameRecoveryReservation = (actual, baseline) => {
  for (const key of ["holdId", "holdToken", "expiresAt", "startTimeUTC", "packageTitle"]) expect(actual.hold[key]).toBe(baseline.hold[key]);
  expect(actual.draft).toEqual(baseline.draft);
};

const providerOpenCount = (snapshot, provider) => snapshot.sdk.filter(call => call.kind === (provider === "razorpay" ? "razorpay-open" : "paypal-order")).length;

const clickReservedStatus = async (page, resume, provider, { captureBody = true } = {}) => {
  const observed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/payment/status");
  await expect(resume.button(provider)).toBeEnabled();
  await resume.button(provider).click();
  const response = await observed; await response.finished();
  resume.evidence.observedStatuses ||= [];
  const statusEvidence = { at: Date.now(), status: response.status(), bodyCaptured: captureBody };
  if (captureBody) statusEvidence.body = await response.json();
  resume.evidence.observedStatuses.push(statusEvidence);
};

const recoverPriceAfterClose = async (page, resume, baseline) => {
  const soft = expect.configure({ soft: true });
  await resume.paint();
  await expect.poll(() => resume.evidence.calls.filter(call => call.path === "/api/payment/quote").every(call => call.fulfilledAt)).toBe(true);
  const retry = page.getByRole("button", { name: "Retry price check", exact: true });
  const before = await resume.capture("retry-before-close");
  expect(before.session).toBeNull(); sameRecoveryReservation(before, baseline);
  for (const provider of ["dodo", "razorpay", "paypal"]) await expect(resume.button(provider)).toBeDisabled();
  resume.evidence.retryBeforeClose = { at: Date.now(), count: await retry.count() };
  await soft(retry).toHaveCount(1, { timeout: 2000 });
  await soft(retry).toBeVisible({ timeout: 2000 });
  const close = page.locator(".booking-payment").getByRole("button", { name: "Close", exact: true });
  resume.evidence.bannerBeforeClose = await close.locator("..").innerText();
  await close.click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await resume.capture("retry-after-close");
  expect(after.session).toBeNull(); sameRecoveryReservation(after, baseline);
  resume.evidence.retryAfterClose = { at: Date.now(), count: await retry.count() };
  await soft(retry).toHaveCount(1, { timeout: 2000 });
  await soft(retry).toBeVisible({ timeout: 2000 });
  if (await retry.count() === 1) {
    resume.config.gate = null; resume.config.failure = false;
    const boundary = resume.evidence.calls.length;
    await retry.click();
    await expect.poll(() => resume.evidence.calls.slice(boundary).some(call => call.path === "/api/payment/quote" && call.status === 200 && call.fulfilledAt && call.body.referralCode === "friend")).toBe(true);
    for (const provider of ["dodo", "razorpay", "paypal"]) await expect(resume.button(provider)).toBeEnabled();
    await resume.paint();
    await expect(page.getByRole("heading", { name: "Booking Summary", exact: true }).locator("..").getByText("$49.45 USD", { exact: true })).toBeVisible();
    const recovered = await resume.capture("price-recovered");
    expect(recovered.session).toBeNull(); sameRecoveryReservation(recovered, baseline);
  } else resume.evidence.manualPriceRecoveryBlocked = true;
};

for (const [provider, title] of [["razorpay", "Razorpay"], ["paypal", "PayPal"]]) {
  resumeQuoteTest(`price retry survives a terminal ${title} resume after a failed fresh quote`, async ({ page, resume }) => {
    const baseline = await resume.open(provider);
    await resume.newerLink(baseline); await resume.failQuote();
    const before = await resume.capture("before-terminal-status");
    resume.config.status = { httpStatus: 200, body: { ok: true, status: "failed", recoveryReason: "Fixture checkout is no longer payable." } };
    await clickReservedStatus(page, resume, provider);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
    resume.evidence.expectedSessionRemoved = true;
    const cleared = await resume.capture("terminal-cleared");
    expect(providerOpenCount(cleared, provider)).toBe(providerOpenCount(before, provider));
    sameRecoveryReservation(cleared, baseline);
    const status = resume.evidence.calls.filter(call => call.path === "/api/payment/status");
    expect(status).toHaveLength(1); expect(status[0].authorization).toBe(`Bearer ${baseline.session.paymentAccessToken}`); expect(status[0].body).toEqual({});
    await recoverPriceAfterClose(page, resume, baseline);
  });
}

for (const [provider, title] of [["dodo", "Dodo"], ["razorpay", "Razorpay"], ["paypal", "PayPal"]]) {
  resumeQuoteTest(`price retry survives releasing ${title} after a failed fresh quote`, async ({ page, resume }) => {
    const baseline = await resume.open(provider);
    await resume.newerLink(baseline); await resume.failQuote();
    resume.config.cancel = { httpStatus: 200, body: { ok: true, cancelled: true } };
    resume.evidence.expectedCancels = 1;
    const observed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/payment/cancel");
    await page.getByRole("button", { name: "Change payment method", exact: true }).click();
    const response = await observed; await response.finished(); expect(response.status()).toBe(200);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
    resume.evidence.expectedSessionRemoved = true;
    const released = await resume.capture("method-released");
    expect(released.hold.phase).toBe("holding"); sameRecoveryReservation(released, baseline);
    const cancel = resume.evidence.calls.filter(call => call.path === "/api/payment/cancel");
    expect(cancel).toHaveLength(1); expect(cancel[0].authorization).toBe(`Bearer ${baseline.session.paymentAccessToken}`); expect(cancel[0].body).toEqual({});
    await recoverPriceAfterClose(page, resume, baseline);
  });
}

const statusRefusals = [
  { provider: "dodo", title: "a Dodo resume preserves its session when status reports an expired token", httpStatus: 401, body: { ok: false, code: "payment_access_token_expired", error: "Payment session expired." } },
  { provider: "razorpay", title: "a Razorpay resume preserves its session when status rejects its identity", httpStatus: 403, body: { ok: false, code: "payment_access_token_mismatch", error: "Payment session does not match the current record." } },
  { provider: "paypal", title: "a PayPal resume preserves its session when status cannot find its record", httpStatus: 404, body: { ok: false, code: "payment_record_not_found", error: "Payment session not found." } },
  { provider: "razorpay", title: "a Razorpay resume preserves its session when status is unavailable", httpStatus: 503, body: { ok: false, error: "Payment status is temporarily unavailable." } },
  { provider: "razorpay", title: "a Razorpay resume refuses a contradictory successful status response", httpStatus: 200, body: { ok: false, status: "started", error: "Fixture contradictory status response." } },
];

for (const fault of statusRefusals) {
  resumeQuoteTest(fault.title, async ({ page, resume }) => {
    const baseline = await resume.open(fault.provider);
    resume.config.status = { httpStatus: fault.httpStatus, body: fault.body };
    await clickReservedStatus(page, resume, fault.provider);
    expect(resume.evidence.observedStatuses[0]).toMatchObject({ status: fault.httpStatus, body: fault.body });
    resume.evidence.setupComplete = true;
    const soft = expect.configure({ soft: true });
    const message = fault.provider === "paypal" ? "This payment method could not process your payment. Please try again." : fault.body.error;
    await soft(page.getByRole("alert").filter({ hasText: message })).toBeVisible({ timeout: 2000 });
    await soft(page).toHaveURL(/\/payment(?:\?|$)/, { timeout: 2000 });
    const refused = await resume.capture("status-refused"); resume.unchanged(refused, baseline);
    if (fault.provider !== "dodo") soft(providerOpenCount(refused, fault.provider)).toBe(providerOpenCount(baseline, fault.provider));
    if (fault.provider === "paypal") soft(refused.sdk.filter(call => call.kind === "paypal-error")).toHaveLength(1);
    if (new URL(page.url()).pathname === "/payment") {
      resume.config.status = { httpStatus: 200, body: { ok: true, status: "started" } };
      await clickReservedStatus(page, resume, fault.provider, { captureBody: fault.provider !== "dodo" });
      expect(resume.evidence.observedStatuses.at(-1).status).toBe(200);
      if (fault.provider === "dodo") await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
      else await expect.poll(() => page.evaluate(provider => window.__resumeSdk.filter(call => call.kind === (provider === "razorpay" ? "razorpay-open" : "paypal-order")).length, fault.provider)).toBe(providerOpenCount(refused, fault.provider) + 1);
      const recovered = await resume.capture("verified-status-recovered"); resume.unchanged(recovered, baseline);
      if (fault.provider !== "dodo") expect(recovered.sdk.filter(call => call.kind === (fault.provider === "razorpay" ? "razorpay-open" : "paypal-order")).at(-1).orderId).toBe(baseline.session.providerPayload.orderId);
      const statuses = resume.evidence.calls.filter(call => call.path === "/api/payment/status");
      expect(statuses).toHaveLength(2); expect(statuses.map(call => ({ authorization: call.authorization, body: call.body }))).toEqual([0, 1].map(() => ({ authorization: `Bearer ${baseline.session.paymentAccessToken}`, body: {} })));
    } else resume.evidence.manualStatusRecoveryNotReached = true;
  });
}

for (const [provider, title] of [["dodo", "Dodo"], ["razorpay", "Razorpay"], ["paypal", "PayPal"]]) {
  resumeQuoteTest(`a reserved ${title} checkout retains malformed details without opening an empty order`, async ({ page, resume }) => {
    const baseline = await resume.open(provider);
    const malformedRaw = await page.evaluate(() => {
      const value = JSON.parse(sessionStorage.getItem("payment_session_state")); value.providerPayload = {};
      const raw = JSON.stringify(value); sessionStorage.setItem("payment_session_state", raw); return raw;
    });
    const expected = JSON.parse(baseline.raw.payment_session_state); expected.providerPayload = {};
    expect(JSON.parse(malformedRaw)).toEqual(expected);
    const malformed = { ...baseline, raw: { ...baseline.raw, payment_session_state: malformedRaw }, session: JSON.parse(malformedRaw) };
    resume.evidence.constructedMalformed = malformed;
    await resume.ready(); await page.reload();
    await expect(resume.button(provider)).toBeEnabled(); await resume.paint(); await resume.ready();
    const before = await resume.capture("malformed-reloaded"); resume.unchanged(before, malformed);
    await clickReservedStatus(page, resume, provider);
    expect(resume.evidence.observedStatuses[0]).toMatchObject({ status: 200, body: { ok: true, status: "started" } });
    resume.evidence.setupComplete = true;
    const soft = expect.configure({ soft: true });
    await soft(page.locator(".booking-payment").getByRole("alert")).toBeVisible({ timeout: 2000 });
    await soft(page).toHaveURL(/\/payment(?:\?|$)/, { timeout: 2000 });
    const refused = await resume.capture("malformed-refused"); resume.unchanged(refused, malformed);
    if (provider !== "dodo") soft(providerOpenCount(refused, provider)).toBe(providerOpenCount(before, provider));
    if (provider === "paypal") soft(refused.sdk.filter(call => call.kind === "paypal-error")).toHaveLength(1);
    const statuses = resume.evidence.calls.filter(call => call.path === "/api/payment/status");
    expect(statuses).toHaveLength(1); expect(statuses[0].authorization).toBe(`Bearer ${baseline.session.paymentAccessToken}`); expect(statuses[0].body).toEqual({});
  });
}

resumeQuoteTest("price retry preserves terminal recovery guidance until dismissal", async ({ page, resume }) => {
  const baseline = await resume.open("razorpay");
  await resume.newerLink(baseline); await resume.failQuote();
  const reason = "Fixture checkout is no longer payable.";
  resume.config.status = { httpStatus: 200, body: { ok: true, status: "failed", recoveryReason: reason } };
  await clickReservedStatus(page, resume, "razorpay");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
  resume.evidence.expectedSessionRemoved = true;
  const guidance = page.locator(".booking-payment").getByRole("alert").filter({ hasText: reason });
  await expect(guidance).toBeVisible();
  await resume.paint();
  const before = await resume.capture("guidance-before-retry");
  sameRecoveryReservation(before, baseline);
  expect(providerOpenCount(before, "razorpay")).toBe(providerOpenCount(baseline, "razorpay"));
  resume.evidence.guidanceBeforeRetry = await guidance.allTextContents();
  const status = resume.evidence.calls.filter(call => call.path === "/api/payment/status");
  expect(status).toHaveLength(1); expect(status[0].authorization).toBe(`Bearer ${baseline.session.paymentAccessToken}`); expect(status[0].body).toEqual({});
  const retry = page.getByRole("button", { name: "Retry price check", exact: true });
  await expect(retry).toHaveCount(1); await expect(retry).toBeVisible();
  resume.config.gate = null; resume.config.failure = false;
  const boundary = resume.evidence.calls.length;
  resume.evidence.quoteRetryBoundary = boundary;
  await retry.click();
  await expect.poll(() => resume.evidence.calls.slice(boundary).some(call => call.path === "/api/payment/quote" && call.status === 200 && call.fulfilledAt && call.body.referralCode === "friend")).toBe(true);
  for (const provider of ["dodo", "razorpay", "paypal"]) await expect(resume.button(provider)).toBeEnabled();
  await resume.paint();
  const summary = page.getByRole("heading", { name: "Booking Summary", exact: true }).locator("..");
  await expect(summary.getByText("$49.45 USD", { exact: true })).toBeVisible();
  const after = await resume.capture("guidance-after-retry");
  expect(after.session).toBeNull(); sameRecoveryReservation(after, baseline);
  expect(providerOpenCount(after, "razorpay")).toBe(providerOpenCount(baseline, "razorpay"));
  resume.evidence.guidanceAfterRetry = await guidance.allTextContents();
  await expect(guidance).toBeVisible({ timeout: 2000 });
  await guidance.getByRole("button", { name: "Close", exact: true }).click();
  await expect(guidance).toHaveCount(0);
  await expect(summary.getByText("$49.45 USD", { exact: true })).toBeVisible();
  for (const provider of ["dodo", "razorpay", "paypal"]) await expect(resume.button(provider)).toBeEnabled();
  const dismissed = await resume.capture("guidance-user-dismissed");
  expect(dismissed.session).toBeNull(); sameRecoveryReservation(dismissed, baseline);
});

resumeQuoteTest("a reserved checkout keeps manual review guidance without a future price retry", async ({ page, resume }) => {
  const baseline = await resume.open("dodo");
  await resume.newerLink(baseline); await resume.failQuote();
  const reason = "This payment requires manual review. Please contact Roo Industries.";
  resume.config.status = { httpStatus: 200, body: { ok: true, status: "needs_recovery", manualReviewRequired: true, recoveryReason: reason } };
  await clickReservedStatus(page, resume, "dodo");
  expect(resume.evidence.observedStatuses.at(-1)).toMatchObject({ status: 200, body: resume.config.status.body });
  const guidance = page.locator(".booking-payment").getByRole("status").filter({ hasText: reason });
  await expect(guidance).toBeVisible();
  await expect(page).toHaveURL(/\/payment(?:\?|$)/);
  await expect(resume.button("dodo")).toBeEnabled();
  for (const provider of ["razorpay", "paypal"]) await expect(resume.button(provider)).toBeDisabled();
  await expect(page.locator("#payment-referral-code")).toBeDisabled();
  await expect(page.locator("#payment-coupon-code")).toBeDisabled();
  await resume.paint();
  const summary = page.getByRole("heading", { name: "Booking Summary", exact: true }).locator("..");
  await expect(summary.getByText("$54.95 USD", { exact: true })).toBeVisible();
  await expect(summary.getByText("Price confirmed for this session.", { exact: true })).toBeVisible();
  const before = await resume.capture("manual-guidance-before-retry"); resume.unchanged(before, baseline);
  resume.evidence.guidanceBeforeRetry = await guidance.allTextContents();
  const retry = page.getByRole("button", { name: "Retry price check", exact: true });
  resume.evidence.manualReviewRetryCount = await retry.count();
  const soft = expect.configure({ soft: true });
  await soft(retry).toHaveCount(0, { timeout: 2000 });
  if (await retry.count()) {
    resume.evidence.manualReviewRetryBranch = "actual existing fallback clicked";
    resume.config.gate = null; resume.config.failure = false;
    const boundary = resume.evidence.calls.length;
    resume.evidence.quoteRetryBoundary = boundary;
    await retry.click();
    await expect.poll(() => resume.evidence.calls.slice(boundary).some(call => call.path === "/api/payment/quote" && call.status === 200 && call.fulfilledAt && call.body.referralCode === "friend")).toBe(true);
  } else resume.evidence.manualReviewRetryBranch = "fallback absent; no click";
  await resume.paint();
  const after = await resume.capture("manual-guidance-after-retry"); resume.unchanged(after, baseline);
  resume.evidence.guidanceAfterRetry = await guidance.allTextContents();
  await soft(guidance).toBeVisible({ timeout: 2000 });
  await expect(page).toHaveURL(/\/payment(?:\?|$)/);
  await expect(summary.getByText("$54.95 USD", { exact: true })).toBeVisible();
  for (const provider of ["razorpay", "paypal"]) await expect(resume.button(provider)).toBeDisabled();
  await expect(page.locator("#payment-referral-code")).toBeDisabled();
  await expect(page.locator("#payment-coupon-code")).toBeDisabled();
  const status = resume.evidence.calls.filter(call => call.path === "/api/payment/status");
  expect(status).toHaveLength(1); expect(status[0].authorization).toBe(`Bearer ${baseline.session.paymentAccessToken}`); expect(status[0].body).toEqual({});
});

const claimedStartTest = test.extend({
  claimed: async ({ page, browser, flow, baseURL }, use, testInfo) => {
    const evidence = { synthetic: true, setupComplete: false, phase: "setup", calls: [], requests: [],
      snapshots: {}, pageErrors: [], aborted: [], handoffs: [], boundaries: {}, validationResponses: [] };
    const enabled = { ...providers, paypal: { enabled: true, mode: "sandbox", clientId: "fixture-client" } };
    const config = { provider: "dodo", upgrade: false, emptyPayload: false, fault: "",
      status: { httpStatus: 200, body: { ok: true, status: "started" } }, holdStatus: false,
      expectedStarts: 1, refuseReplacementStart: false };
    let release, releaseStatus;
    const gate = new Promise(resolve => { release = resolve; });
    const statusGate = new Promise(resolve => { releaseStatus = resolve; });
    const attach = (name, value) => testInfo.attach(`claimed-${name}`, {
      body: JSON.stringify(value, null, 2), contentType: "application/json",
    });
    await page.addInitScript(() => {
      window.__claimedSdk = [];
      window.__claimedStorageFailures = [];
    });
    page.on("pageerror", error => evidence.pageErrors.push({ name: error.name, message: error.message }));
    page.on("requestfailed", request => evidence.aborted.push({ url: request.url(), method: request.method(),
      duringSetup: !evidence.setupComplete, failure: request.failure() }));
    page.on("response", async response => {
      const url = new URL(response.url());
      if (/^\/api\/ref\/validate(Referral|Coupon)$/.test(url.pathname)) {
        evidence.validationResponses.push({ at: Date.now(), url: url.href, status: response.status(), data: await response.json() });
      }
    });
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/")) evidence.requests.push({ at: Date.now(), path: url.pathname,
        query: url.search, body: request.postDataJSON(), authorization: request.headers().authorization || "" });
      if (url.pathname === "/__test/checkout-handoff") evidence.handoffs.push({ at: Date.now(), url: url.href });
    });
    await page.route("https://checkout.razorpay.com/v1/checkout.js", route => route.fulfill({
      contentType: "application/javascript", body: `window.Razorpay = function(options) {
        this.open = () => window.__claimedSdk.push({ kind: "razorpay-open", orderId: options.order_id });
        this.on = () => {};
      };`,
    }));
    await page.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, route => route.fulfill({
      contentType: "application/javascript", body: `window.paypal = { version: "5.0.0", Buttons(options) {
        window.__claimedPayPalOptions = options;
        let button;
        return { isEligible: () => true, updateProps: () => Promise.resolve(), close: async () => button?.remove(),
          async render(container) {
            button = document.createElement("button"); button.type = "button";
            button.textContent = "Claimed fixture PayPal"; button.disabled = true; container.appendChild(button);
            options.onInit({}, { enable: async () => { button.disabled = false; }, disable: async () => { button.disabled = true; } });
            button.addEventListener("click", async () => {
              try {
                const result = await options.onClick({}, { resolve: () => "resolved", reject: () => "rejected" });
                window.__claimedSdk.push({ at: Date.now(), kind: "paypal-click", result });
                if (result === "resolved") window.__claimedSdk.push({ at: Date.now(), kind: "paypal-order", orderId: await options.createOrder({}, {}) });
              } catch (error) {
                window.__claimedSdk.push({ at: Date.now(), kind: "paypal-error", message: error.message });
                options.onError?.(error);
                window.__claimedSdk.push({ at: Date.now(), kind: "paypal-error-handled" });
              }
            });
          },
        };
      } };`,
    }));
    for (const path of ["providers", "quote", "start", "status", "cancel"]) {
      await page.route(`**/api/payment/${path}`, async route => {
        const request = route.request();
        const call = { at: Date.now(), path: `/api/payment/${path}`, body: request.postDataJSON(),
          authorization: request.headers().authorization || "" };
        evidence.calls.push(call);
        if (path === "start" && config.refuseReplacementStart && evidence.calls.filter(call => call.path === "/api/payment/start").length > 1) {
          call.status = 503; call.data = { ok: false, error: "Fixture replacement start unavailable." };
          call.releasedAt = Date.now();
          await route.fulfill({ status: call.status, json: call.data });
          call.fulfilledAt = Date.now();
          return;
        }
        let data, status = 200;
        if (path === "providers") data = { ok: true, providers: enabled };
        if (path === "quote") {
          const gross = call.body.originalOrderId ? 45 : 54.95;
          const net = call.body.couponCode === "save20" ? (call.body.originalOrderId ? 36 : 43.96) : gross;
          data = { ok: true, providers: enabled, quoteFingerprint: `claimed-${call.body.originalOrderId ? "upgrade" : "hold"}-${call.body.couponCode || "none"}`,
            quote: { grossAmount: gross, netAmount: net, isFree: false } };
        }
        if (path === "start") {
          const payload = call.body.bookingPayload;
          const provider = call.body.provider;
          const hold = [...flow.state.holds.values()][0];
          data = { ok: true, provider, status: "started", paymentAccessToken: `claimed-${provider}-token`,
            quote: { grossAmount: config.upgrade ? 45 : 54.95, netAmount: config.upgrade ? 45 : 54.95, isFree: false },
            quoteFingerprint: call.body.quoteFingerprint, sessionExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
            providerPayload: config.emptyPayload ? {} : provider === "dodo" ? { checkoutUrl: `${baseURL}/__test/checkout-handoff` }
              : provider === "razorpay" ? { orderId: "claimed-razorpay-order", key: "fixture-key", amount: 5495, currency: "USD" }
                : { orderId: "claimed-paypal-order" },
            ...(!config.upgrade ? { refreshedHold: { slotHoldId: hold?.holdId, slotHoldToken: hold?.holdToken,
              slotHoldExpiresAt: hold?.expiresAt, phase: "payment_pending" } } : {}),
          };
          expect(payload.couponCode).toBe("");
          call.data = data;
          evidence.first = call;
          call.claimedAt = Date.now();
          await gate;
          if (config.fault === "provider") data.provider = "razorpay";
          if (config.fault === "quote") data.quoteFingerprint = "different-quote";
          if (config.fault === "returned-hold") data.refreshedHold.slotHoldId = "different-hold";
          call.releasedAt = Date.now();
        }
        if (path === "status") {
          data = config.status.body; status = config.status.httpStatus;
          if (config.holdStatus) await statusGate;
          call.releasedAt = Date.now();
        }
        if (path === "cancel") {
          const hold = [...flow.state.holds.values()][0];
          data = { ok: true, cancelled: true, ...(!config.upgrade ? { refreshedHold: {
            slotHoldId: hold.holdId, slotHoldToken: `${hold.holdToken}-rotated`, slotHoldExpiresAt: hold.expiresAt, phase: "holding",
          } } : {}) };
        }
        call.data = data; call.status = status;
        await route.fulfill({ status, json: data });
        call.fulfilledAt = Date.now();
      });
    }
    const snapshot = () => page.evaluate(() => {
      const raw = Object.fromEntries(Object.keys(sessionStorage).sort().map(key => [key, sessionStorage.getItem(key)]));
      const draft = JSON.parse(raw.booking_draft || "null");
      const summary = [...document.querySelectorAll("h3")].find(element => /^(Booking|Upgrade) Summary$/.test(element.textContent))?.parentElement;
      return { at: Date.now(), url: location.href, raw, session: JSON.parse(raw.payment_session_state || "null"),
        hold: JSON.parse(raw.my_slot_hold || "null"), checkout: JSON.parse(raw.checkout_booking_state || "null"), draft,
        form: draft?.packages?.[draft.lastTitle]?.form, sdk: window.__claimedSdk,
        storageFailures: window.__claimedStorageFailures, summary: summary?.innerText || "",
        couponInput: document.querySelector("#payment-coupon-code")?.value ?? null,
        body: document.body.innerText };
    });
    const paint = async () => {
      const panel = page.locator(".booking-payment");
      if (!await panel.count()) return;
      await expect(panel).toHaveCSS("opacity", "1");
      for (const child of await panel.locator(":scope > div").all()) await expect(child).toHaveCSS("opacity", "1");
      await page.getByRole("heading", { name: config.upgrade ? "Upgrade Summary" : "Booking Summary", exact: true }).scrollIntoViewIfNeeded();
    };
    const capture = async name => {
      await paint();
      const value = await snapshot(); evidence.snapshots[name] = value;
      await attach(name, value);
      await testInfo.attach(`claimed-${name}-paint`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      const input = page.locator("#payment-coupon-code");
      if (await input.count()) {
        await input.scrollIntoViewIfNeeded();
        await expect(input).toBeVisible();
        await testInfo.attach(`claimed-${name}-input-paint`, { body: await page.screenshot(), contentType: "image/png" });
      }
      return value;
    };
    const button = () => page.getByRole("button", { name: config.provider === "dodo" ? "Pay your way"
      : config.provider === "razorpay" ? "Pay with Razorpay" : "Claimed fixture PayPal", exact: true });
    const setup = async options => {
      Object.assign(config, options);
      if (config.upgrade) {
        await flow.upgrade();
        await page.getByRole("button", { name: "Check eligibility", exact: true }).click();
        await page.getByRole("button", { name: "Proceed to Payment", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Complete Upgrade Payment", exact: true })).toBeVisible();
      } else { await flow.review(); await flow.payment(); }
      await page.goto("/payment?internalPayments=1");
      await expect(button()).toBeEnabled();
      await expect.poll(() => evidence.calls.some(call => call.path === "/api/payment/quote" && call.fulfilledAt && call.body.couponCode === "")).toBe(true);
      evidence.initial = await capture("initial");
      expect(evidence.initial.session).toBeNull();
      if (config.upgrade) {
        expect(evidence.initial.checkout).toMatchObject({ originalOrderId: "fixture-order", upgradeIntentToken: "fixture-intent",
          email: "visitor@example.invalid", discord: "visitor", specs: "RTX 4070", mainGame: "CS2" });
        expect(flow.state.holdCount).toBe(0);
      } else {
        expect(evidence.initial.hold.holdId).toBeTruthy();
        expect(evidence.initial.form).toMatchObject({ email: "visitor@example.invalid", discord: "fixture_visitor",
          specs: "Ryzen 7700 / RTX 4070", mainGame: "CS2" });
        expect(flow.state.holdCount).toBe(1);
      }
      await button().click();
      await expect.poll(() => !!evidence.first?.claimedAt).toBe(true);
      expect(evidence.first.body.bookingPayload).toMatchObject(config.upgrade
        ? { originalOrderId: "fixture-order", upgradeIntentToken: "fixture-intent" }
        : { slotHoldId: evidence.initial.hold.holdId, slotHoldToken: evidence.initial.hold.holdToken });
      const boundary = evidence.requests.length;
      evidence.boundaries.apply = { at: Date.now(), requestIndex: boundary };
      const input = page.locator("#payment-coupon-code");
      await input.fill("save20");
      await input.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
      await expect.poll(() => flow.state.calls.some(call => call.path === "/api/ref/validateCoupon" && call.query.includes("save20"))).toBe(true);
      await expect.poll(() => evidence.calls.some(call => call.path === "/api/payment/quote" && call.fulfilledAt && call.body.couponCode === "save20")).toBe(true);
      await expect(page.getByRole("heading", { name: config.upgrade ? "Upgrade Summary" : "Booking Summary", exact: true }).locator("..").getByText(config.upgrade ? "$36.00 USD" : "$43.96 USD", { exact: true })).toBeVisible();
      evidence.before = await capture("before-response");
      expect(evidence.before.session).toBeNull();
      expect(evidence.before.couponInput).toBe("save20");
      expect(evidence.requests.slice(boundary).some(call => call.path === "/api/ref/validateCoupon" && call.query.includes("save20"))).toBe(true);
      evidence.setupComplete = true; evidence.phase = "product";
      await attach("setup", evidence);
    };
    const deliver = async () => {
      evidence.beforeDelivery = await capture("immediately-before-response");
      evidence.boundaries.delivery = { at: Date.now(), requestIndex: evidence.requests.length };
      const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/payment/start");
      release(); await (await response).finished();
      await expect.poll(() => !!evidence.first.fulfilledAt).toBe(true);
      await page.waitForTimeout(250);
      const q1 = evidence.calls.find(call => call.path === "/api/payment/quote" && call.body.couponCode === "save20" && call.fulfilledAt);
      evidence.chronologyValid = evidence.first.claimedAt <= evidence.boundaries.apply.at &&
        q1.fulfilledAt <= evidence.boundaries.delivery.at && evidence.boundaries.delivery.at <= evidence.first.releasedAt;
      expect(evidence.chronologyValid).toBe(true);
    };
    const recover = async ({ reload = false, quota = false } = {}) => {
      const soft = expect.configure({ soft: true, timeout: 2000 });
      await deliver();
      if (config.provider === "paypal") {
        await expect.poll(() => page.evaluate(() => window.__claimedSdk.some(call => call.kind === "paypal-error-handled"))).toBe(true);
      }
      const change = page.getByRole("button", { name: "Change payment method", exact: true });
      await soft(change).toBeVisible();
      let saved = await capture("adopted");
      if (quota) {
        soft(saved.session).toBeNull();
        soft(saved.storageFailures.some(call => call.name === "QuotaExceededError" && JSON.parse(call.value).paymentAccessToken === evidence.first.data.paymentAccessToken)).toBe(true);
        await soft(page.getByText("Your browser could not save this payment session. Keep this page open and change payment method before trying again.", { exact: true })).toBeVisible();
        await page.waitForTimeout(2200);
        await soft(page.getByText("Your browser could not save this payment session. Keep this page open and change payment method before trying again.", { exact: true })).toBeVisible();
      } else {
        soft(saved.session?.paymentAccessToken).toBe(evidence.first.data.paymentAccessToken);
        soft(saved.session?.recoveryFingerprint && JSON.parse(saved.session.recoveryFingerprint).couponCode).toBe("save20");
        soft(saved.session?.fingerprint && JSON.parse(saved.session.fingerprint).couponCode).toBe("");
        if (reload && saved.session) {
          const raw = saved.raw.payment_session_state;
          await page.reload();
          await soft(change).toBeVisible(); saved = await capture("reloaded");
          soft(saved.raw.payment_session_state).toBe(raw);
        }
      }
      if (config.provider === "paypal") {
        const guidance = quota
          ? "Your browser could not save this payment session. Keep this page open and change payment method before trying again."
          : "Your earlier checkout is still reserved. Change payment method to use the updated codes.";
        const assertGuidance = async () => {
          await soft(page.getByText(guidance, { exact: true })).toBeVisible();
          await soft(page.getByText("This payment method could not process your payment. Please try again.", { exact: true })).toHaveCount(0);
          await soft(change).toBeVisible();
        };
        await assertGuidance();
        for (const callback of ["onCancel", "onError"]) {
          evidence.boundaries[callback] = { at: Date.now(), requestIndex: evidence.requests.length };
          await page.evaluate(callback => {
            window.__claimedSdk.push({ at: Date.now(), kind: "constructed-callback", callback });
            if (callback === "onError") window.__claimedPayPalOptions.onError(new Error("Repeated obsolete SDK error"));
            else window.__claimedPayPalOptions.onCancel({});
            window.__claimedSdk.push({ at: Date.now(), kind: "constructed-callback-handled", callback });
          }, callback);
          await assertGuidance();
          const notified = await capture(`after-obsolete-${callback}`);
          soft(notified.raw).toEqual(saved.raw);
          soft(notified.sdk.filter(call => ["paypal-order", "razorpay-open"].includes(call.kind))).toEqual([]);
          soft(evidence.calls.filter(call => /\/(status|cancel)$/.test(call.path))).toEqual([]);
        }
        await page.waitForTimeout(2200);
        await assertGuidance();
        await capture("obsolete-callback-guidance-persistent");
      }
      soft(saved.summary).toContain(config.upgrade ? "$45.00 USD" : "$54.95 USD");
      soft(saved.couponInput).toBe("save20");
      if (config.upgrade) { soft(saved.hold).toBeNull(); soft(saved.checkout.originalOrderId).toBe("fixture-order"); }
      else { soft(saved.hold.holdId).toBe(evidence.initial.hold.holdId); soft(saved.hold.holdToken).toBe(evidence.initial.hold.holdToken); soft(saved.form).toEqual(evidence.initial.form); }
      soft(saved.sdk.filter(call => ["razorpay-open", "paypal-order"].includes(call.kind))).toEqual([]);
      soft(evidence.handoffs).toEqual([]);
      if (!await change.isVisible()) { evidence.recoveryNotReached = true; return; }
      evidence.boundaries.cancel = { at: Date.now(), requestIndex: evidence.requests.length, flowIndex: flow.state.calls.length };
      await change.click();
      await soft.poll(() => evidence.calls.filter(call => call.path === "/api/payment/cancel" && call.fulfilledAt).length).toBe(1);
      const cancel = evidence.calls.find(call => call.path === "/api/payment/cancel");
      soft(cancel).toMatchObject({ authorization: `Bearer ${evidence.first.data.paymentAccessToken}`, body: {}, status: 200, data: { ok: true, cancelled: true } });
      await soft.poll(() => evidence.requests.slice(evidence.boundaries.cancel.requestIndex).some(call => call.path === "/api/ref/validateCoupon" && call.query.includes("save20"))).toBe(true);
      await soft.poll(() => evidence.calls.some(call => call.path === "/api/payment/quote" && call.at >= evidence.boundaries.cancel.at && call.body.couponCode === "save20" && call.fulfilledAt)).toBe(true);
      const cancelled = await capture("cancelled");
      soft(cancelled.session).toBeNull(); soft(cancelled.couponInput).toBe("save20");
      soft(cancelled.summary).toContain(config.upgrade ? "$36.00 USD" : "$43.96 USD");
      if (config.upgrade) {
        soft(cancelled.hold).toBeNull();
        soft(cancelled.checkout).toMatchObject({ originalOrderId: "fixture-order", upgradeIntentToken: "fixture-intent",
          email: "visitor@example.invalid", discord: "visitor", specs: "RTX 4070", mainGame: "CS2", couponCode: "save20" });
      } else {
        soft(cancelled.hold.holdId).toBe(evidence.initial.hold.holdId);
        soft(cancelled.hold.holdToken).toBe(`${evidence.initial.hold.holdToken}-rotated`);
        soft(cancelled.form).toEqual(evidence.initial.form);
        soft(cancelled.checkout).toMatchObject({ ...evidence.first.body.bookingPayload, couponCode: "save20",
          slotHoldToken: `${evidence.initial.hold.holdToken}-rotated`, slotHoldExpiresAt: evidence.initial.hold.expiresAt });
      }
      soft(cancelled.raw.booking_draft).toBe(evidence.before.raw.booking_draft);
      for (const key of ["referral_dismissed", "referral_capture", "referral_session", "referral_choices"]) soft(cancelled.raw[key]).toBe(evidence.initial.raw[key]);
    };
    const cdp = await browser.newBrowserCDPSession(); evidence.engine = await cdp.send("Browser.getVersion"); await cdp.detach();
    try { await use({ evidence, config, setup, deliver, recover, capture, snapshot, releaseStatus }); }
    finally {
      release(); releaseStatus();
      if (!page.isClosed()) {
        try {
          await page.evaluate(() => { if (window.__claimedNativeSetter) Storage.prototype.setItem = window.__claimedNativeSetter; });
          evidence.final = await capture("final");
        } catch (error) { evidence.finalCaptureError = error.message; }
      }
      evidence.flowCalls = flow.state.calls;
      evidence.flowAborted = flow.state.aborted;
      evidence.errors = testInfo.errors.map(error => error.message);
      evidence.classification = evidence.setupComplete ? (evidence.errors.length ? "product failure" : "passed") : "setup failure";
      await attach("evidence", evidence);
      expect(evidence.pageErrors).toEqual([]);
      expect(evidence.aborted.filter(request => !(config.upgrade && request.duringSetup &&
        request.method === "GET" && new URL(request.url).pathname === "/api/content/upgrade-link" &&
        request.failure?.errorText === "net::ERR_ABORTED"))).toEqual([]);
      expect(evidence.handoffs).toEqual([]);
      expect(evidence.requests.filter(call => /\/api\/payment\/(capture|confirm|finalize)(\/|$)/.test(call.path) || call.path === "/api/releaseHold")).toEqual([]);
      expect(evidence.requests.filter(call => call.path === "/api/holdSlot")).toHaveLength(config.upgrade ? 0 : 1);
      expect(evidence.requests.filter(call => call.path === "/api/payment/start")).toHaveLength(config.expectedStarts);
      expect(evidence.final?.sdk?.filter(call => ["razorpay-open", "paypal-order"].includes(call.kind)) || []).toEqual([]);
    }
  },
});

claimedStartTest.use({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", actionTimeout: 10000, navigationTimeout: 20000, video: "off" });

for (const [provider, title] of [["razorpay", "Razorpay"], ["paypal", "PayPal"]]) {
  claimedStartTest(`a delayed claimed ${title} start keeps recovery without opening the old order`, async ({ claimed }) => {
    await claimed.setup({ provider }); await claimed.recover();
  });
}

claimedStartTest("a delayed claimed Dodo start survives reload with its original price and updated coupon", async ({ claimed }) => {
  await claimed.setup({ provider: "dodo" }); await claimed.recover({ reload: true });
});

for (const [provider, title] of [["dodo", "Dodo"], ["paypal", "PayPal"]]) {
  claimedStartTest(`a delayed claimed ${title} start keeps in-memory cancellation when session storage is full`, async ({ page, claimed }) => {
    await claimed.setup({ provider });
    await page.evaluate(() => {
      window.__claimedNativeSetter = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (this === sessionStorage && key === "payment_session_state") {
          const error = new DOMException("Fixture session storage full", "QuotaExceededError");
          window.__claimedStorageFailures.push({ at: Date.now(), key, value, name: error.name }); throw error;
        }
        return window.__claimedNativeSetter.call(this, key, value);
      };
    });
    try { await claimed.recover({ quota: true }); }
    finally { await page.evaluate(() => { Storage.prototype.setItem = window.__claimedNativeSetter; }); }
  });
}

claimedStartTest("a delayed claimed PayPal start shows a current error after a new accepted attempt", async ({ page, claimed }) => {
  await claimed.setup({ provider: "paypal" });
  await claimed.deliver();
  await expect.poll(() => page.evaluate(() => window.__claimedSdk.some(call => call.kind === "paypal-error-handled"))).toBe(true);
  const adopted = await claimed.capture("retry-adopted");
  expect(adopted.session.paymentAccessToken).toBe(claimed.evidence.first.data.paymentAccessToken);
  expect(adopted.form).toEqual(claimed.evidence.initial.form);
  expect(adopted.hold).toMatchObject({ holdId: claimed.evidence.initial.hold.holdId,
    holdToken: claimed.evidence.initial.hold.holdToken, expiresAt: claimed.evidence.initial.hold.expiresAt, phase: "payment_pending" });
  expect(adopted.summary).toContain("$54.95 USD");
  expect(adopted.couponInput).toBe("save20");
  await page.locator(".booking-payment").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByText("This payment method could not process your payment. Please try again.", { exact: true })).toHaveCount(0);
  claimed.config.status = { httpStatus: 503, body: { ok: false, error: "Fixture current PayPal status unavailable." } };
  claimed.config.holdStatus = true;
  claimed.evidence.boundaries.currentError = { at: Date.now(), sdkIndex: adopted.sdk.length, requestIndex: claimed.evidence.requests.length };
  await page.getByRole("button", { name: "Claimed fixture PayPal", exact: true }).click();
  await expect.poll(() => claimed.evidence.calls.filter(call => call.path === "/api/payment/status").length).toBe(1);
  const status = claimed.evidence.calls.find(call => call.path === "/api/payment/status");
  expect(status).toMatchObject({ authorization: `Bearer ${adopted.session.paymentAccessToken}`, body: {} });
  const pending = await claimed.capture("current-status-pending");
  expect(pending.sdk.slice(claimed.evidence.boundaries.currentError.sdkIndex).filter(call => call.kind === "paypal-error")).toEqual([]);
  const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/payment/status");
  claimed.releaseStatus();
  const refused = await response;
  await refused.finished();
  expect(refused.status()).toBe(503);
  expect(await refused.json()).toEqual(claimed.config.status.body);
  await expect.poll(() => page.evaluate(boundary => window.__claimedSdk.slice(boundary).some(call => call.kind === "paypal-error-handled"), claimed.evidence.boundaries.currentError.sdkIndex)).toBe(true);
  await expect(page.getByText("This payment method could not process your payment. Please try again.", { exact: true })).toBeVisible();
  const failed = await claimed.capture("current-error");
  expect(failed.raw).toEqual(adopted.raw);
  expect(failed.sdk.slice(claimed.evidence.boundaries.currentError.sdkIndex).filter(call => call.kind === "paypal-click")).toEqual([
    { at: expect.any(Number), kind: "paypal-click", result: "resolved" },
  ]);
  const errors = failed.sdk.slice(claimed.evidence.boundaries.currentError.sdkIndex).filter(call => call.kind === "paypal-error");
  expect(errors).toEqual([{ at: expect.any(Number), kind: "paypal-error", message: claimed.config.status.body.error }]);
  expect(errors[0].at).toBeGreaterThanOrEqual(status.releasedAt);
  expect(status).toMatchObject({ status: 503, data: claimed.config.status.body, fulfilledAt: expect.any(Number) });
  expect(claimed.evidence.calls.filter(call => call.path === "/api/payment/cancel")).toEqual([]);
});

for (const [title, upgrade, status, recoveryReason] of [
  ["a reserved PayPal upgrade keeps its manual-review guidance after the SDK rejects checkout", true, "needs_recovery", "Your payment was received. Roo Industries will contact you about your upgrade."],
  ["a reserved PayPal checkout keeps its refunded status guidance after the SDK rejects checkout", false, "refunded", "This payment has been refunded."],
  ["a reserved PayPal checkout keeps its failed status guidance after the SDK rejects checkout", false, "failed", "Payment could not be completed."],
  ["a reserved PayPal checkout keeps its abandoned status guidance after the SDK rejects checkout", false, "abandoned", "This payment session was released and is no longer payable."],
]) {
  claimedStartTest(title, async ({ page, claimed }) => {
    const soft = expect.configure({ soft: true, timeout: 2000 });
    await claimed.setup({ provider: "paypal", ...(upgrade ? { upgrade: true } : {}) });
    await claimed.deliver();
    await expect.poll(() => page.evaluate(() => window.__claimedSdk.some(call => call.kind === "paypal-error-handled"))).toBe(true);
    const adopted = await claimed.capture("terminal-adopted");
    expect(adopted.session).toMatchObject({ provider: "paypal", paymentAccessToken: "claimed-paypal-token",
      providerPayload: { orderId: "claimed-paypal-order" } });
    expect(adopted.session.paymentAccessToken).toBe(claimed.evidence.first.data.paymentAccessToken);
    expect(adopted.session.providerPayload).toEqual(claimed.evidence.first.data.providerPayload);
    expect(adopted.session.result).toEqual(claimed.evidence.first.data);
    expect(adopted.session.result.quote).toEqual({ grossAmount: upgrade ? 45 : 54.95, netAmount: upgrade ? 45 : 54.95, isFree: false });
    expect(JSON.parse(adopted.session.fingerprint)).toMatchObject({ couponCode: "", originalOrderId: upgrade ? "fixture-order" : "" });
    expect(JSON.parse(adopted.session.recoveryFingerprint)).toEqual({ ...JSON.parse(adopted.session.fingerprint), couponCode: "save20" });
    expect(adopted.checkout).toEqual(claimed.evidence.beforeDelivery.checkout);
    expect(adopted.draft).toEqual(claimed.evidence.beforeDelivery.draft);
    expect(adopted.form).toEqual(claimed.evidence.initial.form);
    expect(adopted.summary).toContain(upgrade ? "$45.00 USD" : "$54.95 USD");
    expect(adopted.couponInput).toBe("save20");
    if (upgrade) {
      expect(adopted.hold).toBeNull();
      expect(adopted.checkout).toMatchObject({ originalOrderId: "fixture-order", upgradeIntentToken: "fixture-intent",
        email: "visitor@example.invalid", discord: "visitor", specs: "RTX 4070", mainGame: "CS2" });
    } else {
      expect(adopted.hold).toEqual({ holdId: claimed.evidence.initial.hold.holdId,
        holdToken: claimed.evidence.initial.hold.holdToken, expiresAt: claimed.evidence.initial.hold.expiresAt,
        startTimeUTC: claimed.evidence.initial.hold.startTimeUTC, packageTitle: claimed.evidence.initial.hold.packageTitle,
        phase: "payment_pending" });
    }
    expect(claimed.evidence.requests.filter(call => call.path === "/api/holdSlot")).toHaveLength(upgrade ? 0 : 1);
    expect(adopted.sdk.filter(call => ["paypal-order", "razorpay-open"].includes(call.kind))).toEqual([]);
    await page.locator(".booking-payment").getByRole("button", { name: "Close", exact: true }).click();
    claimed.config.status = { httpStatus: 200, body: { ok: true, provider: "paypal", status, recoveryReason,
      ...(upgrade ? { manualReviewRequired: true } : {}) } };
    claimed.config.holdStatus = true;
    const boundary = { at: Date.now(), sdkIndex: adopted.sdk.length, requestIndex: claimed.evidence.requests.length };
    claimed.evidence.boundaries.terminal = boundary;
    await page.getByRole("button", { name: "Claimed fixture PayPal", exact: true }).click();
    await expect.poll(() => claimed.evidence.calls.filter(call => call.path === "/api/payment/status").length).toBe(1);
    const statusCall = claimed.evidence.calls.find(call => call.path === "/api/payment/status");
    expect(statusCall).toMatchObject({ authorization: `Bearer ${adopted.session.paymentAccessToken}`, body: {} });
    const pending = await claimed.capture("terminal-status-pending");
    expect(pending.sdk.slice(boundary.sdkIndex).filter(call => call.kind === "paypal-error")).toEqual([]);
    const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/payment/status");
    claimed.releaseStatus();
    const terminal = await response;
    await terminal.finished();
    expect(terminal.status()).toBe(200);
    expect(await terminal.json()).toEqual(claimed.config.status.body);
    claimed.evidence.boundaries.statusFinished = { at: Date.now(), status: terminal.status(), body: await terminal.json() };
    await expect.poll(() => page.evaluate(index => window.__claimedSdk.slice(index).some(call => call.kind === "paypal-error-handled"), boundary.sdkIndex)).toBe(true);
    const after = await claimed.capture("terminal-error-handled");
    const sdk = after.sdk.slice(boundary.sdkIndex);
    expect(sdk.filter(call => call.kind === "paypal-click")).toEqual([{ at: expect.any(Number), kind: "paypal-click", result: "resolved" }]);
    const errors = sdk.filter(call => call.kind === "paypal-error");
    expect(errors).toHaveLength(1);
    expect(errors[0].at).toBeGreaterThanOrEqual(statusCall.releasedAt);
    expect(sdk.filter(call => call.kind === "paypal-error-handled")).toEqual([{ at: expect.any(Number), kind: "paypal-error-handled" }]);
    expect(sdk.find(call => call.kind === "paypal-error-handled").at).toBeGreaterThanOrEqual(errors[0].at);
    await soft(page.getByText(recoveryReason, { exact: true })).toBeVisible();
    await soft(page.getByText("This payment method could not process your payment. Please try again.", { exact: true })).toHaveCount(0);
    if (upgrade) {
      expect(after.raw).toEqual(adopted.raw);
      expect(after.session).toEqual(adopted.session);
      expect(after.summary).toContain("$45.00 USD");
      await expect(page.getByRole("button", { name: "Change payment method", exact: true })).toBeVisible();
    } else {
      expect(after.session).toBeNull();
      const { payment_session_state, ...otherRaw } = adopted.raw;
      expect(after.raw).toEqual(otherRaw);
      await expect(page.getByRole("button", { name: "Change payment method", exact: true })).toHaveCount(0);
      expect(after.summary).not.toContain("This checkout is reserved with PayPal.");
      const summary = page.getByRole("heading", { name: "Booking Summary", exact: true }).locator("..");
      await soft(summary.getByText("$43.96 USD", { exact: true })).toBeVisible();
      await soft(summary.getByText("save20 · −$10.99", { exact: true })).toBeVisible();
    }
    expect(after.hold).toEqual(adopted.hold);
    expect(after.checkout).toEqual(adopted.checkout);
    expect(after.draft).toEqual(adopted.draft);
    expect(after.form).toEqual(adopted.form);
    expect(after.couponInput).toBe("save20");
    expect(after.sdk.filter(call => ["paypal-order", "razorpay-open"].includes(call.kind))).toEqual([]);
    expect(statusCall).toMatchObject({ status: 200, data: claimed.config.status.body, fulfilledAt: expect.any(Number) });
    expect(claimed.evidence.requests.slice(boundary.requestIndex).filter(call => call.path === "/api/payment/status")).toEqual([
      { at: expect.any(Number), path: "/api/payment/status", query: "", body: {}, authorization: `Bearer ${adopted.session.paymentAccessToken}` },
    ]);
    expect(claimed.evidence.calls.filter(call => call.path === "/api/payment/start")).toHaveLength(1);
    expect(claimed.evidence.calls.filter(call => call.path === "/api/payment/status")).toHaveLength(1);
    expect(claimed.evidence.calls.filter(call => call.path === "/api/payment/cancel")).toEqual([]);
    expect(claimed.evidence.requests.filter(call => /\/api\/payment\/(cancel|capture|confirm|finalize)(\/|$)/.test(call.path) || call.path === "/api/releaseHold")).toEqual([]);
    expect(claimed.evidence.pageErrors).toEqual([]);
    expect(claimed.evidence.aborted).toEqual([]);
    expect(claimed.evidence.handoffs).toEqual([]);
    if (!upgrade && status === "failed") {
      const first = JSON.stringify(claimed.evidence.first);
      claimed.config.expectedStarts = 2;
      claimed.config.refuseReplacementStart = true;
      const replacementBoundary = { at: Date.now(), sdkIndex: after.sdk.length, requestIndex: claimed.evidence.requests.length };
      claimed.evidence.boundaries.replacement = replacementBoundary;
      const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/payment/start");
      await page.getByRole("button", { name: "Claimed fixture PayPal", exact: true }).click();
      const refused = await response;
      await refused.finished();
      expect(refused.status()).toBe(503);
      expect(await refused.json()).toEqual({ ok: false, error: "Fixture replacement start unavailable." });
      claimed.evidence.boundaries.replacementFinished = { at: Date.now(), status: refused.status(), body: await refused.json() };
      await expect.poll(() => page.evaluate(index => window.__claimedSdk.slice(index).some(call => call.kind === "paypal-error-handled"), replacementBoundary.sdkIndex)).toBe(true);
      const replacement = await claimed.capture("replacement-error-handled");
      const start = claimed.evidence.calls.filter(call => call.path === "/api/payment/start")[1];
      expect(claimed.evidence.calls.filter(call => call.path === "/api/payment/start")).toHaveLength(2);
      expect(start).toMatchObject({ status: 503, data: { ok: false, error: "Fixture replacement start unavailable." },
        releasedAt: expect.any(Number), fulfilledAt: expect.any(Number), authorization: "" });
      soft(start.body).toEqual({ provider: "paypal", quoteFingerprint: "claimed-hold-save20",
        bookingPayload: { ...claimed.evidence.first.body.bookingPayload, couponCode: "save20" } });
      expect(JSON.stringify(start.body)).not.toContain(adopted.session.paymentAccessToken);
      expect(claimed.evidence.requests.slice(replacementBoundary.requestIndex).filter(call => call.path === "/api/payment/start")).toEqual([
        { at: expect.any(Number), path: "/api/payment/start", query: "", body: start.body, authorization: "" },
      ]);
      expect(JSON.stringify(claimed.evidence.first)).toBe(first);
      expect(replacement.raw).toEqual(after.raw);
      expect(replacement.session).toBeNull();
      expect(replacement.hold).toEqual(after.hold);
      expect(replacement.checkout).toEqual(after.checkout);
      expect(replacement.draft).toEqual(after.draft);
      expect(replacement.form).toEqual(after.form);
      expect(replacement.couponInput).toBe("save20");
      const sdk = replacement.sdk.slice(replacementBoundary.sdkIndex);
      expect(sdk.filter(call => call.kind === "paypal-click")).toEqual([{ at: expect.any(Number), kind: "paypal-click", result: "resolved" }]);
      expect(sdk.filter(call => call.kind === "paypal-error")).toEqual([
        { at: expect.any(Number), kind: "paypal-error", message: "Fixture replacement start unavailable." },
      ]);
      expect(sdk.filter(call => call.kind === "paypal-error-handled")).toEqual([{ at: expect.any(Number), kind: "paypal-error-handled" }]);
      expect(sdk.find(call => call.kind === "paypal-error").at).toBeGreaterThanOrEqual(start.releasedAt);
      expect(sdk.find(call => call.kind === "paypal-error-handled").at).toBeGreaterThanOrEqual(sdk.find(call => call.kind === "paypal-error").at);
      await expect(page.getByText("This payment method could not process your payment. Please try again.", { exact: true })).toBeVisible();
      expect(replacement.sdk.filter(call => ["paypal-order", "razorpay-open"].includes(call.kind))).toEqual([]);
      expect(claimed.evidence.calls.filter(call => call.path === "/api/payment/status")).toHaveLength(1);
      expect(claimed.evidence.calls.filter(call => call.path === "/api/payment/cancel")).toEqual([]);
      expect(claimed.evidence.requests.filter(call => /\/api\/payment\/(cancel|capture|confirm|finalize)(\/|$)/.test(call.path) || call.path === "/api/releaseHold")).toEqual([]);
      expect(claimed.evidence.pageErrors).toEqual([]);
      expect(claimed.evidence.aborted).toEqual([]);
      expect(claimed.evidence.handoffs).toEqual([]);
    }
  });
}

claimedStartTest("a delayed claimed Dodo start retains empty provider details for authentic cancellation", async ({ claimed }) => {
  await claimed.setup({ provider: "dodo", emptyPayload: true }); await claimed.recover();
});

claimedStartTest("a delayed claimed Dodo upgrade keeps its exact intent through cancellation and coupon validation", async ({ claimed }) => {
  await claimed.setup({ provider: "dodo", upgrade: true }); await claimed.recover();
});

for (const [fault, title] of [
  ["stored-hold", "refuses a replaced stored hold ID"],
  ["stored-token", "refuses a new stored hold token generation"],
  ["replacement", "preserves a replacement payment session"],
  ["close", "does not write after the actual Payment Close"],
  ["provider", "refuses a different returned provider"],
  ["quote", "refuses a different returned quote fingerprint"],
  ["returned-hold", "refuses a different returned hold ID"],
  ["email", "preserves a new stored checkout email"],
  ["intent", "preserves a new stored upgrade intent"],
]) {
  claimedStartTest(`a delayed claimed Dodo start ${title}`, async ({ page, claimed }) => {
    await claimed.setup({ provider: "dodo", upgrade: fault === "intent", fault });
    claimed.evidence.setupComplete = false; claimed.evidence.phase = "refusal setup";
    if (["stored-hold", "stored-token", "replacement", "email", "intent"].includes(fault)) {
      claimed.evidence.constructedMutation = await page.evaluate(({ fault, first }) => {
        const key = fault.startsWith("stored-") ? "my_slot_hold" : fault === "replacement" ? "payment_session_state" : "checkout_booking_state";
        const data = JSON.parse(sessionStorage.getItem(key) || "null");
        let value = data;
        if (fault === "stored-hold") value.holdId = "new-owner-hold";
        if (fault === "stored-token") value.holdToken = "new-generation-token";
        if (fault === "email") value.email = "replacement@example.invalid";
        if (fault === "intent") value.upgradeIntentToken = "replacement-intent";
        if (fault === "replacement") value = { provider: "dodo", fingerprint: JSON.stringify({ ...first.body.bookingPayload }),
          paymentAccessToken: "replacement-payment-token", providerPayload: { checkoutUrl: `${location.origin}/__test/checkout-handoff` },
          result: { quote: first.data.quote }, sessionExpiresAt: first.data.sessionExpiresAt };
        const raw = JSON.stringify(value); sessionStorage.setItem(key, raw); return { at: Date.now(), key, before: data, raw };
      }, { fault, first: claimed.evidence.first });
    }
    if (fault === "close") {
      await page.locator("#booking-modal-close").click();
      await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toHaveCount(0);
    }
    claimed.evidence.setupComplete = true; claimed.evidence.phase = "product";
    await claimed.deliver();
    const after = await claimed.capture("refused");
    expect(after.raw).toEqual(claimed.evidence.beforeDelivery.raw);
    expect(after.url).toBe(claimed.evidence.beforeDelivery.url);
    expect(after.sdk.filter(call => ["razorpay-open", "paypal-order"].includes(call.kind))).toEqual([]);
    expect(claimed.evidence.calls.filter(call => call.path === "/api/payment/cancel")).toEqual([]);
    await expect(page.getByRole("button", { name: "Change payment method", exact: true })).toHaveCount(0);
  });
}

test("removing a coupon while a payment start is in flight keeps the started payment recoverable", async ({ page, flow }) => {
  let pending;
  let body;
  await page.route("**/api/payment/start", route => { pending = route; body = route.request().postDataJSON(); });
  await flow.review();
  await flow.codeInput("save20");
  await expect(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toBeVisible();
  await flow.payment();
  await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("button", { name: "Remove coupon", exact: true }).click();
  await expect(page.locator("#payment-coupon-code")).toHaveValue("");
  const expires = new Date(Date.now() + 20 * 60000).toISOString();
  const response = page.waitForResponse("**/api/payment/start");
  await pending.fulfill({ json: {
    ok: true, provider: "dodo", status: "started", paymentAccessToken: "fixture-started-payment",
    quoteFingerprint: body.quoteFingerprint,
    providerPayload: { checkoutUrl: new URL("/__test/checkout-handoff", page.url()).href },
    sessionExpiresAt: expires,
    quote: { grossAmount: 54.95, netAmount: 43.96, isFree: false, couponDiscountAmount: 10.99 },
    refreshedHold: { slotHoldId: body.bookingPayload.slotHoldId, slotHoldToken: body.bookingPayload.slotHoldToken, slotHoldExpiresAt: expires, phase: "payment_pending" },
  } });
  await response;
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("payment_session_state"))).not.toBeNull();
  expect(JSON.parse(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).paymentAccessToken).toBe("fixture-started-payment");
  await expect(page.getByText("Your earlier checkout is still reserved. Change payment method to use the updated codes.")).toBeVisible();
  expect(body.bookingPayload.couponCode).toBe("save20");
});
