const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");

test.use({
  javaScriptEnabled: true,
  viewport: { width: 390, height: 844 },
  timezoneId: "Asia/Kolkata",
  reducedMotion: "reduce",
  actionTimeout: 10000,
  navigationTimeout: 20000,
  trace: "off",
  video: "off",
});

test.afterEach(async ({ page, flow }, testInfo) => {
  const artifact = testInfo.outputPath("journey.json");
  await fs.writeFile(artifact, JSON.stringify({
    title: testInfo.title,
    status: testInfo.status,
    url: page.url(),
    viewport: page.viewportSize(),
    messages: await page.locator('[role="status"], [role="alert"]').allTextContents(),
    calls: flow.state.calls,
    availability: page.__availabilityLoadingEvidence,
    review: page.__reviewEvidence,
  }, null, 2));
  await testInfo.attach("journey", { path: artifact, contentType: "application/json" });
  const screenshot = testInfo.outputPath("journey.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("journey-screen", { path: screenshot, contentType: "image/png" });
});

test("empty availability offers a refresh and the next open month", async ({ page, flow }) => {
  flow.state.slots = [];
  await page.goto("/booking");
  const empty = page.getByRole("status").filter({ hasText: "There are no open times to book right now." });
  await expect(empty).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true }).last()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next month", exact: true })).toHaveCount(0);
  await expect(empty.getByRole("link", { name: "Contact us", exact: true })).toHaveAttribute("href", "/contact");
  const date = new Date();
  date.setMonth(date.getMonth() + 2, 15);
  flow.state.slots = [{ date: date.toISOString().slice(0, 10), times: ["10:00"] }];
  const count = flow.state.calls.filter(call => call.path === "/api/bookingAvailability").length;
  await empty.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
  expect(flow.state.calls.filter(call => call.path === "/api/bookingAvailability").length).toBeGreaterThan(count);
  await page.getByRole("button", { name: "Next month", exact: true }).click();
  const previous = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  await expect(page.getByText(`No open times in ${previous.toLocaleString("en-US", { month: "long" })}.`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Go to / }).click();
  await expect(page.getByRole("heading", { name: `${date.toLocaleString("en-US", { month: "long" })} ${date.getFullYear()}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true }).last()).toBeDisabled();
  expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(0);
});

test("delayed availability keeps loading separate from an empty calendar", async ({ page, flow }) => {
  page.__availabilityLoadingEvidence = { delays: [] };
  await page.addInitScript(() => {
    window.__watchAvailability = true;
    window.__availabilityEmptyFrames = [];
    const sample = () => {
      if (window.__watchAvailability) {
        const form = document.querySelector(".ri-booking");
        const hasSlots = [...(form?.querySelectorAll("button") || [])]
          .some(button => button.textContent.trim().startsWith("Earliest available:"));
        if (hasSlots) {
          window.__watchAvailability = false;
        } else {
          const text = form?.textContent || "";
          for (const message of ["There are no open times to book right now.", "No open times in "]) {
            if (text.includes(message) && !window.__availabilityEmptyFrames.includes(message)) {
              window.__availabilityEmptyFrames.push(message);
            }
          }
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  let delayed = true;
  await page.route("**/api/bookingAvailability", async route => {
    if (delayed) {
      await page.evaluate(() => {
        window.__availabilityEmptyFrames = [];
        window.__watchAvailability = true;
      });
      const started = Date.now();
      await new Promise(resolve => setTimeout(resolve, 1500));
      page.__availabilityLoadingEvidence.delays.push(Date.now() - started);
    }
    await route.fallback();
  });
  const slots = flow.state.slots;
  const earliest = page.getByRole("button", { name: /^Earliest available:/ });
  await page.goto("/booking");
  await expect(earliest).toBeVisible();
  await expect(page.getByRole("button", { name: /^10:00 AM/ }).first()).toBeVisible();
  page.__availabilityLoadingEvidence.first = await page.evaluate(() => window.__availabilityEmptyFrames);
  expect(page.__availabilityLoadingEvidence.first).toEqual([]);
  delayed = false;
  flow.state.slots = [];
  await page.reload();
  const empty = page.getByRole("status").filter({ hasText: "There are no open times to book right now." });
  await expect(empty).toBeVisible();
  delayed = true;
  flow.state.slots = slots;
  await empty.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(earliest).toBeVisible();
  page.__availabilityLoadingEvidence.refresh = await page.evaluate(() => window.__availabilityEmptyFrames);
  expect(page.__availabilityLoadingEvidence.refresh).toEqual([]);
  expect(page.__availabilityLoadingEvidence.delays.length).toBeGreaterThanOrEqual(2);
  for (const duration of page.__availabilityLoadingEvidence.delays) expect(duration).toBeGreaterThanOrEqual(1400);
  await earliest.click();
  await expect(page.getByRole("button", { name: /^10:00 AM/ }).first()).toBeVisible();
});

test("booking review continues to payment without implying a charge", async ({ page, flow }) => {
  await flow.review();
  await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Pay \$/ })).toHaveCount(0);
  await page.route("**/api/ref/validateCoupon?*", route => route.fulfill({ json: {
    ok: true, coupon: { code: "full", discountType: "percent", discountPercent: 100, canCombineWithReferral: true },
  } }));
  await flow.codeInput("full");
  await expect(page.getByText("$0.00", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled();
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-free-quote", quote: { grossAmount: 84.99, netAmount: 0, isFree: true },
  } }));
  await flow.payment();
  await expect(page.getByRole("button", { name: "Confirm Free Booking", exact: true })).toBeVisible();
});

test("booking FAQ opens separately while keeping the draft and hold", async ({ page, flow }) => {
  await flow.reserve();
  await flow.details();
  const before = await page.evaluate(() => sessionStorage.getItem("my_slot_hold"));
  expect(JSON.parse(before).holdId).toBeTruthy();
  const link = page.getByRole("link", { name: "Read the FAQ (opens in a new tab)", exact: true });
  await expect(link).toHaveAttribute("href", "/#faq");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const popupPromise = page.waitForEvent("popup");
  await link.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/#faq$/);
  await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("visitor@example.invalid");
  expect(await page.evaluate(() => sessionStorage.getItem("my_slot_hold"))).toBe(before);
  expect(flow.state.calls.filter(call => call.path === "/api/releaseHold")).toHaveLength(0);
  await popup.close();
});

test("payment advice recommends only enabled methods and offers contact", async ({ page, flow }) => {
  let providers = {
    dodo: { enabled: false, mode: "disabled" },
    razorpay: { enabled: false, mode: "disabled", disabledReason: "merchant_profile_update" },
    paypal: { enabled: true, mode: "test", clientId: "fixture-paypal-client" },
  };
  await page.route("https://www.paypal.com/sdk/js?*", route => route.abort("failed"));
  await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ json: {
    ok: true, providers, quoteFingerprint: "fixture-quote",
    quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
  } }));
  await flow.review();
  await flow.payment();
  const advice = page.getByRole("status").filter({ hasText: "Razorpay is temporarily unavailable" });
  await expect(advice).toContainText("Please use another payment option.");
  await expect(advice).not.toContainText("Dodo Payments");
  await expect(advice).not.toContainText("PayPal");
  await expect(advice).not.toContainText("above");
  await expect(page.getByRole("button", { name: "Retry PayPal", exact: true })).toBeVisible();
  providers = { ...providers, dodo: { enabled: true, mode: "test" }, paypal: { enabled: false, mode: "disabled" } };
  await page.reload();
  await expect(advice).toContainText("Please use another payment option.");
  await expect(advice).not.toContainText("Dodo Payments");
  await expect(advice).not.toContainText("PayPal");
  providers = { ...providers, paypal: { enabled: false, mode: "disabled" }, dodo: { enabled: false, mode: "disabled" }, razorpay: { enabled: false, mode: "missing" } };
  await page.reload();
  const unavailable = page.getByRole("status").filter({ hasText: "Online payment is unavailable right now." });
  await expect(unavailable).toHaveText("Online payment is unavailable right now. Contact us to finish your booking.");
  await expect(unavailable.getByRole("link", { name: "Contact us", exact: true })).toHaveAttribute("href", "/contact");
  expect(flow.state.calls.filter(call => call.path === "/api/payment/start")).toHaveLength(0);
});

test("a rejected download offers help without losing the entered order", async ({ page }) => {
  const downloads = [];
  const navigations = [];
  page.on("download", download => downloads.push(download.suggestedFilename()));
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  page.__reviewEvidence = { downloads, navigations };
  await page.route("**/api/downloads/validate", route => route.fulfill({ status: 403, json: {
    ok: false, error: "Could not verify this order. Check the Order ID and booking email.",
  } }));
  await page.goto("/downloads/optimizer-pack-v1");
  await page.evaluate(() => { window.__downloadGateMarker = "retained"; });
  await page.getByLabel("Booking email", { exact: true }).fill("visitor@example.invalid");
  await page.getByLabel("Order ID", { exact: true }).fill("booking.example");
  await page.getByRole("button", { name: "Verify and Download", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText("Could not verify this order. Check the Order ID and booking email.");
  await expect(page.getByText("Your order ID is in your booking confirmation email. Can't find it?", { exact: false }))
    .toHaveText("Your order ID is in your booking confirmation email. Can't find it? Contact us");
  await expect(page.getByRole("link", { name: "Contact us", exact: true })).toHaveAttribute("href", "/contact");
  await expect(page.getByLabel("Order ID", { exact: true })).toHaveValue("booking.example");
  await expect(page.getByLabel("Booking email", { exact: true })).toHaveValue("visitor@example.invalid");
  await expect(page.getByText("Verified. Your download is starting.", { exact: true })).toHaveCount(0);
  expect(downloads).toEqual([]);
  expect(navigations.every(url => url.endsWith("/downloads/optimizer-pack-v1"))).toBe(true);
  expect(await page.evaluate(() => window.__downloadGateMarker)).toBe("retained");
  await expect(page).toHaveURL(/\/downloads\/optimizer-pack-v1$/);
  await page.route("**/api/downloads/validate", route => route.abort("failed"));
  await page.getByRole("button", { name: "Verify and Download", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText("Something went wrong while verifying this order. Try again.");
  await expect(page.getByLabel("Order ID", { exact: true })).toHaveValue("booking.example");
  await expect(page.getByLabel("Booking email", { exact: true })).toHaveValue("visitor@example.invalid");
  await expect(page.getByRole("button", { name: "Verify and Download", exact: true })).toBeEnabled();
  expect(downloads).toEqual([]);
  expect(navigations.every(url => url.endsWith("/downloads/optimizer-pack-v1"))).toBe(true);
  expect(await page.evaluate(() => window.__downloadGateMarker)).toBe("retained");
});

test("tools distinguish an empty catalog from a retryable load failure", async ({ page }) => {
  let failed = false;
  let data = [];
  await page.route("**/api/content/tools", route => route.fulfill({
    status: failed ? 503 : 200,
    json: failed ? { ok: false, error: "Synthetic content is unavailable." } : { ok: true, data },
  }));
  await page.goto("/contact");
  await page.locator("footer").getByRole("link", { name: "Tools", exact: true }).click();
  await expect(page.getByText("No tools are listed right now.", { exact: true })).toBeVisible();
  await page.locator("main").getByRole("link", { name: "Read the FAQ", exact: true }).click();
  await expect(page).toHaveURL(/\/#faq$/);
  failed = true;
  await page.locator("footer").getByRole("link", { name: "Tools", exact: true }).click();
  await expect(page.getByText("Couldn't load the tools.", { exact: true })).toBeVisible();
  await expect(page.getByText("No tools are listed right now.", { exact: true })).toHaveCount(0);
  failed = false;
  data = [{ _id: "recovered-tool", title: "Recovered benchmark tool", shortDescription: "A tool available after retry.", category: "Benchmark", downloadMode: "external", downloadUrl: "/favicon-96x96.png" }];
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Recovered benchmark tool", exact: true })).toBeVisible();
  await expect(page.locator("main article")).toHaveCount(1);
  await expect(page.getByText("Couldn't load the tools.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No tools are listed right now.", { exact: true })).toHaveCount(0);
});

test("Escape closes the mobile menu and restores its trigger focus", async ({ page }) => {
  await page.goto("/contact");
  const menu = page.getByRole("button", { name: "Open menu", exact: true });
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.locator("#mobile-site-menu").getByRole("link", { name: "Benefits", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  const proof = page.getByRole("button", { name: "Proof", exact: true });
  await proof.click();
  await expect(proof).toHaveAttribute("aria-expanded", "true");
  await page.locator("#desktop-proof-menu").getByRole("link", { name: "Reviews", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(proof).toHaveAttribute("aria-expanded", "false");
  await expect(proof).toBeFocused();
});

for (const remaining of ["empty", "other slots"]) {
  test(`availability refresh clears a gone selection with ${remaining}`, async ({ page, flow }) => {
    flow.state.slots[0].times = ["10:00"];
    await flow.booking();
    const next = page.getByRole("button", { name: "Next", exact: true }).last();
    await expect(next).toBeEnabled();
    const startTimeUTC = `${flow.state.slots[0].date}T04:30:00.000Z`;
    flow.state.bookedSlots = [{ startTimeUTC, ...(remaining === "other slots" ? { isHold: true, holdId: "another-hold" } : {}) }];
    if (remaining === "other slots") flow.state.slots[0].times.push("11:00");
    const response = page.waitForResponse("**/api/bookingAvailability");
    await page.waitForTimeout(5100);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await response;
    await expect(page.getByRole("status").filter({ hasText: "That time is no longer available. Please pick another." })).toBeVisible();
    await expect(next).toBeDisabled();
    if (remaining === "empty") {
      await expect(page.getByText("There are no open times to book right now.", { exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: /^11:00 AM/ }).first()).toBeEnabled();
    }
    await next.focus();
    await page.keyboard.press("Enter");
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(0);
  });
}

test("failed provider discovery keeps retry guidance instead of an unavailable notice", async ({ page, flow }) => {
  await page.route("**/api/payment/providers", route => route.fulfill({ status: 500, json: { ok: false, error: "Could not check payment methods." } }));
  await page.route("**/api/payment/quote", route => route.fulfill({ status: 500, json: { ok: false, error: "Could not check checkout price." } }));
  await flow.review();
  await flow.payment();
  await expect(page.getByRole("button", { name: "Retry price check", exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Could not check checkout price." })).toBeVisible();
  await expect(page.getByText("Online payment is unavailable right now.", { exact: false })).toHaveCount(0);
  expect(flow.state.calls.filter(call => call.path === "/api/payment/start")).toHaveLength(0);
});

test("reset acknowledgment persists only for the submitted email and errors keep input", async ({ page }) => {
  const requests = [];
  let result = "success";
  let release;
  await page.route("**/api/ref/forgot", async route => {
    requests.push(route.request().postDataJSON());
    if (result === "pending") await new Promise(resolve => { release = resolve; });
    await route.fulfill({ status: result === "error" ? 503 : 200, json: result === "error" ? { ok: false, error: "Reset link could not be sent. Please try again." } : { ok: true } });
  });
  page.__reviewEvidence = { requests };
  await page.goto("/referrals/forgot");
  const email = page.getByLabel("Creator Email", { exact: true });
  const submit = page.getByRole("button", { name: "Send Reset Link", exact: true });
  const message = "If an account matches that email, we've sent a reset link. Check your inbox and spam folder.";
  const status = page.getByRole("status").filter({ hasText: message });
  await email.fill("creator@example.invalid");
  await submit.click();
  await expect(status).toBeInViewport();
  await page.waitForTimeout(3400);
  await expect(status).toBeVisible();
  await expect(email).toHaveValue("creator@example.invalid");
  expect(requests).toHaveLength(1);
  await email.fill("another@example.invalid");
  await expect(status).toHaveCount(0);
  result = "pending";
  await submit.click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await email.fill("changed@example.invalid");
  release();
  await expect(submit).toBeEnabled();
  await expect(status).toHaveCount(0);
  await expect(email).toHaveValue("changed@example.invalid");
  result = "success";
  await submit.click();
  await expect(status).toHaveText(message);
  result = "error";
  await submit.click();
  await expect(page.getByRole("alert").filter({ hasText: "Reset link could not be sent. Please try again." })).toBeVisible();
  await expect(status).toHaveCount(0);
  await expect(email).toHaveValue("changed@example.invalid");
  await expect(submit).toBeEnabled();
  expect(requests).toHaveLength(4);
});
