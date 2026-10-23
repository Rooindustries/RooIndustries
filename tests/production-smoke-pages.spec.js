const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

const disabledProviders = {
  dodo: { enabled: false, mode: "missing" },
  paypal: { enabled: false, mode: "missing", clientId: "" },
  razorpay: { enabled: false, mode: "missing" },
};
const paidProviders = { ...disabledProviders, dodo: { enabled: true, mode: "test" } };
const paypalSdk = `window.paypal = {
  version: "fixture",
  Buttons() {
    return {
      isEligible: () => true,
      render(container) {
        const button = document.createElement("button");
        button.textContent = "Fixture PayPal";
        container.appendChild(button);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
  },
};`;

for (const width of [1280, 360, 390]) {
  for (const quote of [
    { name: "HTTP failure", status: 503, body: JSON.stringify({ ok: false, error: "Fixture quote unavailable." }), error: "Fixture quote unavailable." },
    { name: "invalid JSON", status: 200, body: "{invalid", error: "Unable to confirm checkout price." },
    { name: "missing fingerprint", status: 200, body: JSON.stringify({ ok: true, providers: paidProviders,
      quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
    }) },
  ]) {
    test(`${width}px initial paid quote ${quote.name} cannot signal readiness`, async ({ page, flow }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route("**/api/payment/quote", route => route.fulfill({
        status: quote.status, contentType: "application/json", body: quote.body,
      }));
      await flow.review();
      await Promise.all([
        page.waitForResponse("**/api/payment/quote").then(response => response.finished()),
        flow.payment(),
      ]);
      if (quote.error) await expect(page.getByText(quote.error, { exact: true })).toBeVisible();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeDisabled();
      await expect(page.locator('[data-roo-flow-ready="payment"]')).toHaveCount(0);
      await testInfo.attach("unconfirmed-paid-quote", { body: JSON.stringify({ width, quote: quote.name }), contentType: "application/json" });
    });
  }
}

for (const width of [1280, 360, 390]) {
  test(`${width}px the smoke readiness signal follows client initialization`, async ({ page, flow }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const serverPages = await Promise.all(["/", "/booking", "/payment"].map(async pathname => {
      const response = await page.request.get(pathname);
      expect(response.ok()).toBe(true);
      return { pathname, html: await response.text() };
    }));
    await page.goto("/");
    const serverSignals = await page.evaluate(pages => pages.map(({ pathname, html }) => ({
      pathname,
      ready: Boolean(new DOMParser().parseFromString(html, "text/html").querySelector("[data-roo-flow-ready]")),
    })), serverPages);
    expect(serverSignals.every(signal => !signal.ready)).toBe(true);
    await expect(page.locator('[data-roo-flow-ready="home"]')).toBeVisible();
    await flow.review();
    await expect(page.locator('[data-roo-flow-ready="booking"]')).toBeVisible();
    await flow.payment();
    await expect(page.locator('[data-roo-flow-ready="payment"]')).toBeVisible();
    const signals = await page.locator("[data-roo-flow-ready]").evaluateAll(elements => elements.map(element => element.dataset.rooFlowReady));
    await testInfo.attach("client-readiness", { body: JSON.stringify({ width, serverSignals, signals }), contentType: "application/json" });
    expect(signals).toContain("payment");
  });
}

for (const width of [1280, 360, 390]) {
  for (const discovery of [
    { name: "failed", status: 503, body: JSON.stringify({ ok: false }) },
    { name: "invalid JSON", status: 200, body: "{invalid" },
    { name: "incomplete", status: 200, body: JSON.stringify({ ok: true, providers: {} }) },
    { name: "non-boolean", status: 200, body: JSON.stringify({ ok: true, providers: {
      dodo: { enabled: "true", mode: "test" },
      paypal: { enabled: false, mode: "missing" },
      razorpay: { enabled: false, mode: "missing" },
    } }) },
    { name: "valid", ready: true, status: 200, body: JSON.stringify({ ok: true, providers: paidProviders }) },
    { name: "disabled", status: 200, body: JSON.stringify({ ok: true, providers: disabledProviders }) },
    { name: "PayPal without client id", status: 200, body: JSON.stringify({ ok: true, providers: {
      ...disabledProviders, paypal: { enabled: true, mode: "sandbox", clientId: "" },
    } }) },
    ...["razorpay", "paypal"].flatMap(provider => [false, true].map(sdkReady => ({
      name: `${provider} with ${sdkReady ? "loaded" : "failed"} SDK`, provider, sdkReady, ready: sdkReady,
      status: 200, body: JSON.stringify({ ok: true, providers: {
        ...disabledProviders, [provider]: { enabled: true, mode: "test", clientId: "fixture-client" },
      } }),
    }))),
  ]) {
    test(`${width}px direct payment readiness follows ${discovery.name} provider discovery`, async ({ page, flow }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      if (discovery.provider) {
        await page.route(discovery.provider === "paypal"
          ? /https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/
          : "https://checkout.razorpay.com/v1/checkout.js", route => discovery.sdkReady
          ? route.fulfill({ contentType: "application/javascript", body: discovery.provider === "paypal"
            ? paypalSdk : "window.Razorpay = function () { return { open() {}, on() {} }; };" })
          : route.abort("failed"));
      }
      await page.route("**/api/payment/providers", route => route.fulfill({
        status: discovery.status, contentType: "application/json", body: discovery.body,
      }));
      await Promise.all([
        page.waitForResponse("**/api/payment/providers").then(response => response.finished()),
        page.goto("/payment"),
      ]);
      await expect(page.getByRole("heading", { name: "Booking Summary", exact: true })).toBeVisible();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const ready = page.locator('[data-roo-flow-ready="payment"]');
      if (discovery.provider === "razorpay") {
        if (discovery.sdkReady) await expect.poll(() => page.evaluate(() => typeof window.Razorpay)).toBe("function");
        else await expect(page.getByText("Payment system failed to load. Please refresh the page and try again.", { exact: true })).toBeVisible();
      }
      if (discovery.provider === "paypal") {
        await expect(page.getByRole("button", { name: discovery.sdkReady ? "Fixture PayPal" : "Retry PayPal", exact: true })).toBeVisible();
      }
      if (discovery.ready) await expect(ready).toBeVisible();
      else await expect(ready).toHaveCount(0);
      await testInfo.attach("provider-readiness", { body: JSON.stringify({
        width, discovery: discovery.name, ready: await ready.count(),
      }), contentType: "application/json" });
    });
  }
}

for (const width of [1280, 360, 390]) {
  for (const discovery of ["before free quote", "after free quote", "failed"]) {
    test(`${width}px free checkout readiness works with discovery ${discovery}`, async ({ page, flow }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      let releaseDiscovery;
      const discoveryGate = new Promise(resolve => { releaseDiscovery = resolve; });
      let releasePaidQuote;
      const paidQuoteGate = new Promise(resolve => { releasePaidQuote = resolve; });
      let returningToPaid = false;
      await page.route("**/api/payment/providers", async route => {
        if (discovery === "after free quote") await discoveryGate;
        await route.fulfill({ status: discovery === "failed" ? 503 : 200,
          json: discovery === "failed" ? { ok: false } : { ok: true, providers: paidProviders } });
      });
      await page.route("**/api/ref/validateCoupon?code=free100*", route => route.fulfill({
        json: { ok: true, coupon: { code: "free100", discountType: "percent", discountPercent: 100, canCombineWithReferral: true } },
      }));
      await page.route("**/api/payment/quote", async route => {
        const free = route.request().postDataJSON().couponCode === "free100";
        if (!free && returningToPaid) await paidQuoteGate;
        await route.fulfill({ json: {
          ok: true, quoteFingerprint: free ? "fixture-free-quote" : "fixture-paid-quote",
          quote: { grossAmount: 84.99, netAmount: free ? 0 : 84.99, isFree: free },
          providers: free ? { razorpay: disabledProviders.razorpay, paypal: disabledProviders.paypal }
            : returningToPaid ? disabledProviders : paidProviders,
        } });
      });
      try {
        await flow.review();
        if (discovery !== "before free quote") await flow.codeInput("free100");
        await flow.payment();
        const ready = page.locator('[data-roo-flow-ready="payment"]');
        if (discovery === "before free quote") {
          await expect(ready).toBeVisible();
          await page.locator("#payment-coupon-code").fill("free100");
          await page.locator("#payment-coupon-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
        }
        await expect(page.getByRole("button", { name: "Confirm Free Booking", exact: true })).toBeEnabled();
        await expect(ready).toBeVisible();
        if (discovery === "after free quote") {
          const response = page.waitForResponse("**/api/payment/providers");
          releaseDiscovery();
          await (await response).finished();
          await expect(ready).toBeVisible();
        }
        returningToPaid = true;
        const nextQuote = page.waitForRequest(request => request.url().endsWith("/api/payment/quote") && !request.postDataJSON().couponCode);
        await page.getByRole("button", { name: "Remove coupon", exact: true }).click();
        await nextQuote;
        await expect(ready).toHaveCount(0);
        releasePaidQuote();
        await expect(page.getByText("Online payment is unavailable right now.", { exact: false })).toBeVisible();
        await expect(ready).toHaveCount(0);
        await testInfo.attach("free-then-paid-readiness", { body: JSON.stringify({ width, discovery,
          freeQuoteOmitsDodo: true, paidReady: await ready.count(), calls: flow.state.calls,
        }), contentType: "application/json" });
      } finally {
        releaseDiscovery();
        releasePaidQuote();
      }
    });
  }

  test(`${width}px an unconfirmed free quote cannot signal readiness`, async ({ page, flow }) => {
    await page.setViewportSize({ width, height: 900 });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/ref/validateCoupon?code=free100*", route => route.fulfill({
      json: { ok: true, coupon: { code: "free100", discountType: "percent", discountPercent: 100, canCombineWithReferral: true } },
    }));
    await page.route("**/api/payment/quote", async route => {
      if (route.request().postDataJSON().couponCode !== "free100") return route.fallback();
      await gate;
      await route.fulfill({ status: 503, json: { ok: false, error: "Fixture quote unavailable." } });
    });
    try {
      await flow.review();
      await flow.payment();
      const ready = page.locator('[data-roo-flow-ready="payment"]');
      await expect(ready).toBeVisible();
      await page.locator("#payment-coupon-code").fill("free100");
      const quote = page.waitForRequest(request => request.url().endsWith("/api/payment/quote") && request.postDataJSON().couponCode === "free100");
      await page.locator("#payment-coupon-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
      await quote;
      await expect(ready).toHaveCount(0);
      release();
      await expect(page.getByText("Fixture quote unavailable.", { exact: true })).toBeVisible();
      await expect(ready).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Confirm Free Booking", exact: true })).toBeDisabled();
    } finally {
      release();
    }
  });
}
