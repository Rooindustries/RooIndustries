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
    await use({ ...launchOptions, ignoreDefaultArgs: ["--disable-back-forward-cache"] });
  },
  resume: async ({ page, browser, flow, baseURL }, use, testInfo) => {
    const evidence = { setupComplete: false, calls: [], requests: [], snapshots: {}, pageErrors: [], readiness: [] };
    const pendingAssets = new Set();
    const config = { failure: false, gate: null };
    const enabledProviders = { dodo: { enabled: true, mode: "test" }, razorpay: { enabled: true, mode: "test" }, paypal: { enabled: true, mode: "sandbox", clientId: "fixture-client" } };
    const attach = async (name, value) => testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: "application/json" });
    await page.addInitScript(() => {
      window.__resumeObservation = { nonce: crypto.randomUUID(), pageshows: [] };
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
              } catch (error) { window.__resumeSdk.push({ kind: "paypal-error", message: error.message }); }
            });
          },
        };
      } };
    ` }));
    for (const path of ["/api/payment/providers", "/api/payment/quote", "/api/payment/start", "/api/payment/status"]) {
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
        if (path === "/api/payment/status") response = { ok: true, status: "started" };
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
      expect(evidence.requests.filter(call => /\/api\/payment\/(cancel|capture|confirm|finalize)(\/|$)/.test(call.path) || call.path === "/api/releaseHold")).toEqual([]);
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
  await expect(summary.getByText("Session price unavailable. Check payment status or change payment method.", { exact: true })).toBeVisible();
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
