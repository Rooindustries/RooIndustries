const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({
  headless: true,
  javaScriptEnabled: true,
  timezoneId: "Asia/Kolkata",
  viewport: { width: 390, height: 844 },
  reducedMotion: "reduce",
  video: "retain-on-failure",
  actionTimeout: 10000,
  navigationTimeout: 30000,
});

const storedCode = page => page.evaluate(() => sessionStorage.getItem("referral_session"));
const appliedCode = (page, code) => page.getByRole("button", { name: `Remove referral code ${code}`, exact: true });
const packagesLink = page => page.getByRole("link", { name: "PC optimization packages", exact: true });
const reviewWithCreator = async (page, flow, code = "friend") => {
  await page.goto(`/?ref=${encodeURIComponent(code)}`);
  await expect.poll(() => storedCode(page)).toBe(code);
  await flow.review();
  await expect(appliedCode(page, code)).toBeVisible();
};
const resumeReview = async page => {
  const heading = page.getByRole("heading", { name: "Review your booking", exact: true });
  const button = page.getByRole("button", { name: "Review before payment", exact: true });
  await expect(heading.or(button).first()).toBeVisible();
  if (await button.isVisible()) await button.click();
  await expect(heading).toBeVisible();
};

test.beforeEach(async ({ context, flow }) => {
  await context.route("**/api/ref/validateReferral?*", async route => {
    const code = new URL(route.request().url()).searchParams.get("code")?.trim().toLowerCase();
    if (code !== "second") return route.fallback();
    await route.fulfill({ json: { ok: true, active: true, eligible: true,
      referral: { code, currentDiscountPercent: 5 } } });
  });
});

test("a referral removed at review stays removed on payment links", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await appliedCode(page, "friend").click();
  await flow.payment();
  await page.goto("/payment?ref=friend");
  await expect(page.locator("#payment-referral-code")).toBeEnabled();
  await expect(page.locator("#payment-referral-code")).toHaveValue("");
});

test("adding a coupon does not restore a removed creator", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await page.goto("/payment?ref=friend");
  await page.locator("#payment-referral-code").fill("");
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => storedCode(page)).toBeNull();
  await expect(page.locator("#payment-referral-code")).toBeEnabled();
  await expect(page.locator("#payment-referral-code")).toHaveValue("");
  await page.locator("#payment-coupon-code").fill("save20");
  await page.locator("#payment-coupon-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state"))?.couponCode)).toBe("save20");
  await page.reload();
  await expect(page.locator("#payment-referral-code")).toBeEnabled();
  await expect(page.locator("#payment-referral-code")).toHaveValue("");
});

test("removing a payment coupon survives reload and booking review", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await page.locator("#payment-coupon-code").fill("save20");
  await page.locator("#payment-coupon-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("button", { name: "Remove coupon", exact: true }).click();
  await page.reload();
  await expect(page.locator("#payment-coupon-code")).toBeEnabled();
  await expect(page.locator("#payment-coupon-code")).toHaveValue("");
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await page.getByRole("link", { name: "Back to Booking", exact: true }).click();
  await resumeReview(page);
  await expect(appliedCode(page, "friend")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toHaveCount(0);
  await flow.payment();
  await expect(page.locator("#payment-coupon-code")).toHaveValue("");
});

test("an applied creator that becomes invalid is cleared on retry", async ({ page, context, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await page.reload();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await context.route("**/api/ref/validateReferral?code=friend", route => route.fulfill({
    json: { ok: false, reason: "not_found" },
  }));
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator("#payment-referral-code-error")).toBeVisible();
  await expect.poll(() => storedCode(page)).toBeNull();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state")).referralCode)).toBe("");
});

test("an invalidated selected creator does not hand credit to a later link", async ({ page, context, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await context.route("**/api/ref/validateReferral?code=friend", route => route.fulfill({
    json: { ok: false, reason: "not_found" },
  }));
  await page.goto("/payment?ref=second");
  await expect(page.locator("#payment-referral-code-error")).toBeVisible();
  await expect(page.locator("#payment-referral-code")).toHaveValue("");
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state")).referralCode)).toBe("");
  await page.reload();
  await expect(page.locator("#payment-referral-code")).toBeEnabled();
  await expect(page.locator("#payment-referral-code")).toHaveValue("");
});

test("removing the selected creator does not apply an earlier incidental link", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await page.goto("/payment?ref=second");
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await page.locator("#payment-referral-code").fill("");
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await page.reload();
  await expect(page.locator("#payment-referral-code")).toBeEnabled();
  await expect(page.locator("#payment-referral-code")).toHaveValue("");
  await page.goto("/payment?ref=second");
  await expect(page.locator("#payment-referral-code")).toHaveValue("second");
});

test("a restored incompatible coupon keeps its rejection and the applied creator", async ({ page, context, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await context.route("**/api/ref/validateCoupon?*", async route => {
    if (new URL(route.request().url()).searchParams.get("code") !== "save20") return route.fallback();
    await route.fulfill({ json: { ok: true, coupon: {
      code: "save20", discountType: "percent", discountPercent: 20, canCombineWithReferral: false,
    } } });
  });
  await page.evaluate(() => {
    const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state"));
    checkout.couponCode = "save20";
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(checkout));
  });
  await page.reload();
  await expect(page.locator("#payment-coupon-code-error")).toHaveText("This coupon can't be used together with a referral discount.");
  await expect(page.locator("#payment-coupon-code")).toBeEnabled();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await expect.poll(() => flow.state.calls.filter(call => call.path === "/api/payment/quote").at(-1)?.body).toMatchObject({
    referralCode: "friend", couponCode: "",
  });
});

test("an unavailable coupon lookup preserves the applied coupon for retry", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await page.locator("#payment-coupon-code").fill("save20");
  await page.locator("#payment-coupon-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state"))?.couponCode)).toBe("save20");
  flow.state.failures["/api/ref/validateCoupon"] = 503;
  await page.reload();
  await expect(page.locator("#payment-coupon-code-error")).toBeVisible();
  await expect(page.locator("#payment-coupon-code")).toHaveValue("save20");
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state"))?.couponCode)).toBe("save20");
  await expect.poll(() => flow.state.calls.filter(call => call.path === "/api/payment/quote").at(-1)?.body).toMatchObject({
    referralCode: "friend", couponCode: "save20",
  });
  delete flow.state.failures["/api/ref/validateCoupon"];
  await page.locator("#payment-coupon-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator("#payment-coupon-code-error")).toHaveCount(0);
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
});

test("history restoration keeps the restored booking's codes during an outage", async ({ page, context, flow }, testInfo) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await page.locator("#payment-coupon-code").fill("save20");
  await page.locator("#payment-coupon-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state"))?.couponCode)).toBe("save20");
  await expect(page.locator("#payment-coupon-code")).toBeEnabled();
  await context.route("**/api/ref/validateReferral?code=second", route => route.fulfill({ status: 503, json: { ok: false } }));
  await context.route("**/api/ref/validateCoupon?code=save10*", route => route.fulfill({ status: 503, json: { ok: false } }));
  const originalEmail = await page.evaluate(() => {
    const booking = JSON.parse(sessionStorage.getItem("checkout_booking_state"));
    const restored = {
      ...booking,
      email: "restored-visitor@example.invalid",
      referralCode: "second",
      couponCode: "save10",
      checkoutCodes: {
        referral: { code: "second", currentDiscountPercent: 5 },
        coupon: { code: "save10", discountType: "percent", discountPercent: 10, canCombineWithReferral: true },
        dismissedReferralCode: "",
      },
    };
    history.replaceState({ ...history.state, usr: { ...history.state.usr, bookingData: booking } }, "", location.href);
    history.pushState({ ...history.state, usr: { ...history.state.usr, bookingData: restored } }, "", location.href);
    history.back();
    return booking.email;
  });
  await expect.poll(() => page.evaluate(() => history.state?.usr?.bookingData?.email)).toBe(originalEmail);
  const quoteCount = flow.state.calls.filter(call => call.path === "/api/payment/quote").length;
  await page.goForward();
  await expect(page.locator("#payment-referral-code")).toHaveValue("second");
  await expect(page.locator("#payment-coupon-code")).toHaveValue("save10");
  await expect(page.locator("#payment-coupon-code")).toBeEnabled();
  await expect.poll(() => flow.state.calls.filter(call => call.path === "/api/payment/quote").length).toBeGreaterThan(quoteCount);
  await expect.poll(() => flow.state.calls.filter(call => call.path === "/api/payment/quote").at(-1)?.body).toMatchObject({
    referralCode: "second", couponCode: "save10",
  });
  const quote = flow.state.calls.filter(call => call.path === "/api/payment/quote").at(-1)?.body;
  await testInfo.attach("restored-booking-quote", { body: JSON.stringify(quote), contentType: "application/json" });
});

test("a checkout whose session cannot be stored stays available for recovery", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "payment_session_state") throw new Error("Fixture storage unavailable");
      return setItem.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Your browser could not save this payment session." })).toBeVisible();
  await expect(page).toHaveURL(/\/payment(?:\?|$)/);
  await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeVisible();
});

for (const replacement of [null, "paypal"]) {
  test(`a late terminal response preserves the refreshed hold after session ${replacement || "removal"}`, async ({ page, context, flow }) => {
    await page.goto("/packages");
    await flow.review();
    await flow.payment();
    await expect(page.locator("#payment-referral-code")).toBeEnabled();
    await page.evaluate(() => {
      const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state"));
      sessionStorage.setItem("payment_session_state", JSON.stringify({
        provider: "dodo", paymentAccessToken: "old-payment-token", providerPayload: { orderId: "cks_old" },
        fingerprint: JSON.stringify({ packageTitle: checkout.packageTitle, originalOrderId: "",
          startTimeUTC: checkout.startTimeUTC, email: checkout.email, referralCode: "", couponCode: "" }),
      }));
    });
    let release;
    let received;
    const requested = new Promise(resolve => { received = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    await context.route("**/api/payment/finalize", async route => {
      received();
      await pending;
      await route.fulfill({ json: { ok: true, status: "abandoned" } });
    });
    await page.goto("/payment?dodo_return=1");
    await requested;
    try {
      await page.evaluate(replacement => {
        const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state"));
        const session = JSON.parse(sessionStorage.getItem("payment_session_state"));
        const hold = JSON.parse(sessionStorage.getItem("my_slot_hold"));
        hold.holdToken = "refreshed-hold-token";
        checkout.slotHoldToken = hold.holdToken;
        sessionStorage.setItem("my_slot_hold", JSON.stringify(hold));
        sessionStorage.setItem("checkout_booking_state", JSON.stringify(checkout));
        if (replacement) sessionStorage.setItem("payment_session_state", JSON.stringify({
          ...session, provider: replacement, paymentAccessToken: "new-payment-token",
        }));
        else sessionStorage.removeItem("payment_session_state");
      }, replacement);
      const response = page.waitForResponse(value => value.url().endsWith("/api/payment/finalize"));
      release();
      await response;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold"))?.holdToken)).toBe("refreshed-hold-token");
      expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state"))?.slotHoldToken)).toBe("refreshed-hold-token");
      expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("payment_session_state"))?.paymentAccessToken || null)).toBe(replacement ? "new-payment-token" : null);
      await expect(page.getByText(/Go back to booking to choose a time/)).toHaveCount(0);
    } finally {
      release();
    }
  });
}

for (const route of ["/BIOSGuide", "/BIOSGuide/", "/BIOSGuide/index.html"]) {
  test(`creator link to ${route} reaches packages and booking`, async ({ page, flow }, testInfo) => {
    await page.goto(`${route}?ref=friend`);
    await expect.poll(() => storedCode(page)).toBe("friend");
    await expect(packagesLink(page)).toHaveCount(1);
    await packagesLink(page).scrollIntoViewIfNeeded();
    await testInfo.attach("guide-packages", { body: await page.screenshot(), contentType: "image/png" });
    await packagesLink(page).click();
    await expect(page).toHaveURL(/\/packages(?:\?|$)/);
    await flow.review();
    await expect(appliedCode(page, "friend")).toBeVisible();
    await flow.payment();
    await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  });
}

test("latest guide link wins before a code is applied", async ({ page, flow }) => {
  await page.goto("/?ref=friend");
  await expect.poll(() => storedCode(page)).toBe("friend");
  await page.goto("/BIOSGuide?ref=second");
  await expect.poll(() => storedCode(page)).toBe("second");
  await packagesLink(page).click();
  await flow.review();
  await expect(appliedCode(page, "second")).toBeVisible();
});

test("a later guide link keeps the code applied to this booking", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await expect(appliedCode(page, "friend")).toBeVisible();
  await page.goto("/BIOSGuide?ref=second");
  await packagesLink(page).click();
  await page.goto("/booking");
  await resumeReview(page);
  await expect(appliedCode(page, "friend")).toBeVisible();
  await flow.payment();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
});

test("a later payment link cannot replace an applied booking code", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await expect(appliedCode(page, "friend")).toBeVisible();
  await flow.payment();
  await page.goto("/payment?ref=second");
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await page.reload();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
});

test("deliberately replacing a payment code survives reload", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await page.locator("#payment-referral-code").fill("second");
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => storedCode(page)).toBe("second");
  await page.reload();
  await expect(page.locator("#payment-referral-code")).toHaveValue("second");
});

test("a deliberate review replacement beats later creator links", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.codeInput("second");
  await expect(appliedCode(page, "second")).toBeVisible();
  await page.goto("/booking?ref=friend");
  await resumeReview(page);
  await expect(appliedCode(page, "second")).toBeVisible();
  await flow.payment();
  await page.goto("/payment?ref=friend");
  await expect(page.locator("#payment-referral-code")).toHaveValue("second");
});

test("guide links explicitly carry credit into an independently opened tab", async ({ page, context }) => {
  await page.goto("/BIOSGuide?ref=friend");
  await expect.poll(() => storedCode(page)).toBe("friend");
  const target = await packagesLink(page).getAttribute("href");
  expect(new URL(target, page.url()).searchParams.get("ref")).toBe("friend");
  const second = await context.newPage();
  await second.goto(target);
  await expect.poll(() => storedCode(second)).toBe("friend");
  expect(await storedCode(page)).toBe("friend");
  await second.close();
});

test("an unrelated tab does not inherit a guide visitor's code", async ({ page, context }) => {
  await page.goto("/BIOSGuide?ref=friend");
  await expect.poll(() => storedCode(page)).toBe("friend");
  const other = await context.newPage();
  await other.goto("/packages");
  expect(await storedCode(other)).toBeNull();
  expect(await storedCode(page)).toBe("friend");
  await other.close();
});

test("the guide home link keeps the creator through booking", async ({ page, flow }) => {
  await page.goto("/BIOSGuide?ref=friend");
  const home = page.getByRole("link", { name: "Visit RooIndustries.com", exact: true });
  await expect(home).not.toHaveAttribute("target", "_blank");
  await home.click();
  await expect(page).toHaveURL(/\/\?ref=friend$/);
  await flow.review();
  await expect(appliedCode(page, "friend")).toBeVisible();
});

test("a guide creator link still reaches packages when storage is blocked", async ({ page }) => {
  await page.addInitScript(() => {
    if (!location.pathname.startsWith("/BIOSGuide")) return;
    Storage.prototype.setItem = () => { throw new DOMException("Storage blocked", "SecurityError"); };
  });
  await page.goto("/BIOSGuide?ref=friend");
  await packagesLink(page).click();
  await expect(page).toHaveURL(/\/packages\?ref=friend$/);
  await expect.poll(() => storedCode(page)).toBe("friend");
});

for (const query of ["", "?ref=", "?ref=%20%20"]) {
  test(`guide without a nonempty code preserves storage: ${query || "no query"}`, async ({ page }) => {
    await page.goto("/?ref=friend");
    await expect.poll(() => storedCode(page)).toBe("friend");
    await page.goto(`/BIOSGuide${query}`);
    expect(await storedCode(page)).toBe("friend");
  });
}

test("a removed payment code stays removed at review and after reload", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await page.locator("#payment-referral-code").fill("");
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => storedCode(page)).toBeNull();
  await page.reload();
  await expect(page.locator("#payment-referral-code")).toBeEnabled();
  await expect(page.locator("#payment-referral-code")).toHaveValue("");
  await page.goto("/booking");
  await resumeReview(page);
  await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled();
  await expect(appliedCode(page, "friend")).toHaveCount(0);
});

test("Back and Forward keep a deliberate replacement over an older payment entry", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await page.goto("/BIOSGuide?ref=friend");
  await page.goto("/payment");
  await page.locator("#payment-referral-code").fill("second");
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => storedCode(page)).toBe("second");
  await page.goBack();
  await expect(packagesLink(page)).toBeVisible();
  await page.goBack();
  await expect(page.locator("#payment-referral-code")).toHaveValue("second");
  await page.reload();
  await expect(page.locator("#payment-referral-code")).toHaveValue("second");
  await page.goForward();
  await expect(packagesLink(page)).toBeVisible();
  await page.goForward();
  await expect(page.locator("#payment-referral-code")).toHaveValue("second");
});

test("guide packages link fits phones and desktop", async ({ page }, testInfo) => {
  await page.goto("/BIOSGuide?ref=friend");
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await packagesLink(page).scrollIntoViewIfNeeded();
    await expect(packagesLink(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await testInfo.attach(`guide-${width}`, { body: await page.screenshot(), contentType: "image/png" });
  }
});

test("an invalid later creator link does not evict an applied code", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await expect(appliedCode(page, "friend")).toBeVisible();
  await flow.payment();
  await page.goto("/payment?ref=unknown");
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
});

test("an invalid manual replacement cannot apply the incidental creator link", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await page.goto("/payment?ref=second");
  await page.locator("#payment-referral-code").fill("unknown");
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator("#payment-referral-code-error")).toBeVisible();
  await expect.poll(() => storedCode(page)).toBe("friend");
  await page.reload();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
});

test("unavailable validation retains the chosen code for retry", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await expect(appliedCode(page, "friend")).toBeVisible();
  await flow.payment();
  flow.state.failures["/api/ref/validateReferral"] = 503;
  await page.goto("/payment?ref=second");
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await expect(page.locator("#payment-referral-code-error")).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state")).referralCode)).toBe("friend");
  delete flow.state.failures["/api/ref/validateReferral"];
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator("#payment-referral-code-error")).toHaveCount(0);
  await expect.poll(() => storedCode(page)).toBe("friend");
});

test("a creator deliberately entered in the coupon field replaces the applied creator", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await page.locator("#payment-coupon-code").fill("second");
  await page.locator("#payment-coupon-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator("#payment-referral-code")).toHaveValue("second");
  await page.reload();
  await expect(page.locator("#payment-referral-code")).toHaveValue("second");
});

test("applying only a coupon leaves the next creator link available", async ({ page, flow }) => {
  await page.goto("/packages");
  await flow.review();
  await flow.payment();
  await page.locator("#payment-coupon-code").fill("save20");
  await page.locator("#payment-coupon-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state"))?.couponCode)).toBe("save20");
  await page.goto("/payment?ref=second");
  await expect(page.locator("#payment-referral-code")).toHaveValue("second");
  await expect(page.locator("#payment-coupon-code")).toHaveValue("save20");
});

test("an older payment view does not change a different visitor's booking draft", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await page.evaluate(() => {
    const draft = JSON.parse(sessionStorage.getItem("booking_draft"));
    draft.packages["Performance Vertex Overhaul"].form.email = "next-visitor@example.invalid";
    sessionStorage.setItem("booking_draft", JSON.stringify(draft));
  });
  await page.locator("#payment-referral-code").fill("second");
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => storedCode(page)).toBe("second");
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("booking_draft"))
    .packages["Performance Vertex Overhaul"].checkoutCodes.referral.code)).toBe("friend");
});

test("an older payment view does not change a later slot's draft for the same visitor", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await page.evaluate(() => {
    const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state"));
    const draft = JSON.parse(sessionStorage.getItem("booking_draft"));
    draft.packages[checkout.packageTitle].startTimeUTC = new Date(new Date(checkout.startTimeUTC).getTime() + 3600000).toISOString();
    sessionStorage.setItem("booking_draft", JSON.stringify(draft));
  });
  await page.locator("#payment-referral-code").fill("second");
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => storedCode(page)).toBe("second");
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("booking_draft"))
    .packages["Performance Vertex Overhaul"].checkoutCodes.referral.code)).toBe("friend");
});

test("a legacy draft still saves a replacement for its current held slot", async ({ page, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await page.evaluate(() => {
    const draft = JSON.parse(sessionStorage.getItem("booking_draft"));
    delete draft.packages["Performance Vertex Overhaul"].startTimeUTC;
    sessionStorage.setItem("booking_draft", JSON.stringify(draft));
  });
  await page.locator("#payment-referral-code").fill("second");
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => storedCode(page)).toBe("second");
  await page.getByRole("link", { name: "Back to Booking", exact: true }).click();
  await resumeReview(page);
  await expect(appliedCode(page, "second")).toBeVisible();
});

test("a delayed code response cannot reopen or rewrite a closed checkout", async ({ page, context, flow }) => {
  await reviewWithCreator(page, flow);
  await flow.payment();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  let release;
  let received;
  const requested = new Promise(resolve => { received = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  await context.route("**/api/ref/validateReferral?*", async route => {
    if (new URL(route.request().url()).searchParams.get("code") !== "second") return route.fallback();
    received();
    await pending;
    await route.fulfill({ json: { ok: true, active: true, eligible: true,
      referral: { code: "second", currentDiscountPercent: 5 } } });
  });
  await page.locator("#payment-referral-code").fill("second");
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await requested;
  try {
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toHaveCount(0);
    const response = page.waitForResponse(value => value.url().includes("validateReferral?code=second"));
    release();
    await response;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await storedCode(page)).toBe("friend");
    expect(new URL(page.url()).pathname).not.toBe("/payment");
  } finally {
    release();
  }
});
