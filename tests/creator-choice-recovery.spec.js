const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ headless: true, javaScriptEnabled: true, timezoneId: "Asia/Kolkata",
  viewport: { width: 390, height: 844 }, reducedMotion: "reduce", actionTimeout: 10000, navigationTimeout: 30000 });
const stored = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state")));
const input = (page, kind) => page.locator(`#payment-${kind}-code`);
const apply = (page, kind) => input(page, kind).locator("..").getByRole("button", { name: "Apply", exact: true });
const ready = async (page, flow, code = "friend") => {
  await page.goto(code ? `/?ref=${code}` : "/packages");
  if (code) await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_session"))).toBe(code);
  await flow.review();
  if (code) await expect(page.getByRole("button", { name: `Remove referral code ${code}`, exact: true })).toBeVisible();
  await flow.payment();
  await expect(input(page, "referral")).toBeEnabled();
};
const quote = flow => flow.state.calls.filter(call => call.path === "/api/payment/quote").at(-1)?.body;

for (const blockedKey of ["booking_draft", "checkout_booking_state", "payment_session_state"]) {
  test(`failed ${blockedKey} saves without code choices do not show a code warning`,
    async ({ page, context, flow }, info) => {
      let saveErrors = 0;
      page.on("console", message => {
        if (message.type() === "error" && message.text() === "Failed to save checkout choices") saveErrors += 1;
      });
      await context.addInitScript(key => {
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (name, value) {
          if (name === key) throw new DOMException("Storage quota", "QuotaExceededError");
          return setItem.call(this, name, value);
        };
      }, blockedKey);
      await ready(page, flow, "");
      await expect.poll(() => quote(flow)).toMatchObject({ referralCode: "", couponCode: "" });
      if (blockedKey === "payment_session_state") {
        await page.getByRole("button", { name: "Pay your way", exact: true }).click();
        await expect(page.getByRole("alert").filter({
          hasText: "Your browser could not save this payment session.",
        })).toBeVisible();
      }
      await expect.poll(() => saveErrors).toBeGreaterThan(0);
      if (blockedKey === "booking_draft") {
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 844 });
          await info.attach(`no-code-save-failure-${width}`, {
            body: await page.screenshot(), contentType: "image/png",
          });
        }
      }
      await expect(page.getByRole("alert").filter({ hasText: "could not save your code choices" })).toHaveCount(0);
    });
}

for (const blockedKey of ["booking_draft", "checkout_booking_state", "referral_session", "all"]) {
  test(`returning to booking keeps a creator replacement when saving ${blockedKey} fails`, async ({ page, context, flow }, info) => {
    let saveErrors = 0;
    page.on("console", message => {
      if (message.type() === "error" && message.text() === "Failed to save checkout choices") saveErrors += 1;
    });
    await context.route("**/api/ref/validateReferral?code=second", route => route.fulfill({
      json: { ok: true, referral: { code: "second", currentDiscountPercent: 5 } },
    }));
    await ready(page, flow);
    await page.evaluate(key => {
      const setItem = Storage.prototype.setItem;
      window.failedCheckoutSaves = 0;
      Storage.prototype.setItem = function (name, value) {
        const choices = ["booking_draft", "checkout_booking_state", "payment_session_state", "referral_session"];
        if (name === key || (key === "all" && choices.includes(name))) {
          window.failedCheckoutSaves += 1;
          throw new DOMException("Storage quota", "QuotaExceededError");
        }
        return setItem.call(this, name, value);
      };
    }, blockedKey);
    await input(page, "referral").fill("second");
    await apply(page, "referral").click();
    await expect(input(page, "referral")).toBeEnabled();
    await expect.poll(() => quote(flow)).toMatchObject({ referralCode: "second" });
    await expect(page.getByRole("alert").filter({ hasText: "could not save your code choices" })).toHaveCount(1);
    await page.getByRole("link", { name: "Back to Booking", exact: true }).click();
    const review = page.getByRole("button", { name: "Review before payment", exact: true });
    await expect(review.or(page.getByRole("heading", { name: "Review your booking", exact: true })).first()).toBeVisible();
    if (await review.isVisible()) await review.click();
    await expect(page.getByRole("button", { name: "Remove referral code second", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: "could not save your code choices" })).toHaveCount(1);
    if (blockedKey === "booking_draft") {
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(page.locator(".ri-booking.transition-opacity")).toHaveCSS("opacity", "1");
        const path = info.outputPath(`draft-save-notice-${width}.png`);
        await page.screenshot({ path });
        await info.attach(`draft-save-notice-${width}`, { path, contentType: "image/png" });
      }
    }
    await flow.payment();
    await expect(input(page, "referral")).toHaveValue("second");
    await expect.poll(() => quote(flow)).toMatchObject({ referralCode: "second" });
    expect(saveErrors).toBeGreaterThan(0);
    expect(saveErrors).toBe(await page.evaluate(() => window.failedCheckoutSaves));
  });
}

test("returning to booking keeps coupon removal when draft saves fail", async ({ page, flow }) => {
  await ready(page, flow);
  await input(page, "coupon").fill("save20");
  await apply(page, "coupon").click();
  await expect.poll(async () => (await stored(page))?.couponCode).toBe("save20");
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === "booking_draft") throw new DOMException("Storage quota", "QuotaExceededError");
      return setItem.call(this, name, value);
    };
  });
  await page.getByRole("button", { name: "Remove coupon", exact: true }).click();
  await expect(input(page, "coupon")).toHaveValue("");
  await page.getByRole("link", { name: "Back to Booking", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
  await flow.payment();
  await expect(input(page, "coupon")).toHaveValue("");
  await expect.poll(() => quote(flow)).toMatchObject({ referralCode: "friend", couponCode: "" });
});

test("a creator replacement survives a checkout storage quota failure", async ({ page, context, flow }, info) => {
  await context.route("**/api/ref/validateReferral?code=second", route => route.fulfill({
    json: { ok: true, referral: { code: "second", currentDiscountPercent: 5 } },
  }));
  await ready(page, flow);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "checkout_booking_state") throw new DOMException("Storage quota", "QuotaExceededError");
      return setItem.call(this, key, value);
    };
  });
  await input(page, "referral").fill("second");
  await apply(page, "referral").click();
  await expect(input(page, "referral")).toBeEnabled();
  await expect(input(page, "referral")).toHaveValue("second");
  await expect.poll(() => quote(flow)).toMatchObject({ referralCode: "second" });
  await expect(page.getByRole("alert").filter({ hasText: "could not save your code choices" })).toBeVisible();
  await expect(input(page, "referral")).toHaveValue("second");
  expect((await stored(page)).referralCode).toBe("friend");
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await info.attach(`code-save-failure-${width}`, { body: await page.screenshot(), contentType: "image/png" });
  }
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => flow.state.calls.filter(call => call.path === "/api/payment/start").at(-1)?.body)
    .toMatchObject({ bookingPayload: { referralCode: "second" } });
});

test("a coupon-only save warning clears when storage recovers", async ({ page, flow }) => {
  await ready(page, flow, "");
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    window.restoreCheckoutStorage = () => { Storage.prototype.setItem = setItem; };
    Storage.prototype.setItem = function (key, value) {
      if (key === "checkout_booking_state") throw new DOMException("Storage quota", "QuotaExceededError");
      return setItem.call(this, key, value);
    };
  });
  await input(page, "coupon").fill("save20");
  await apply(page, "coupon").click();
  await expect.poll(() => quote(flow)).toMatchObject({ couponCode: "save20", referralCode: "" });
  const notice = page.getByRole("alert").filter({ hasText: "could not save your code choices" });
  await expect(notice).toBeVisible();
  await page.evaluate(() => window.restoreCheckoutStorage());
  await page.getByRole("button", { name: "Remove coupon", exact: true }).click();
  await expect.poll(() => quote(flow)).toMatchObject({ couponCode: "", referralCode: "" });
  await expect(notice).toHaveCount(0);
});

test("an incidental coupon link keeps a deliberate combinable coupon", async ({ page, context, flow }) => {
  await context.route("**/api/ref/validateCoupon?code=later*", route => route.fulfill({
    json: { ok: true, coupon: { code: "later", discountType: "percent",
      discountPercent: 5, canCombineWithReferral: true } },
  }));
  await ready(page, flow, "");
  await input(page, "coupon").fill("save20");
  await apply(page, "coupon").click();
  await expect.poll(async () => (await stored(page))?.couponCode).toBe("save20");
  await page.goto("/payment?ref=later");
  await expect(input(page, "coupon")).toBeEnabled();
  await expect(input(page, "coupon")).toHaveValue("save20");
  await expect.poll(() => quote(flow)).toMatchObject({ couponCode: "save20", referralCode: "" });
  await page.reload();
  await expect(input(page, "coupon")).toHaveValue("save20");
});

test("code edits settle when navigation keeps the same location key", async ({ page, context, flow }) => {
  await ready(page, flow);
  await page.goto("/payment?dodo_return=1");
  await expect(input(page, "coupon")).toBeEnabled();
  await page.evaluate(() => { Math.random = () => 0.12345678; });
  await input(page, "coupon").fill("save20");
  await apply(page, "coupon").click();
  await expect.poll(async () => (await stored(page))?.couponCode).toBe("save20");
  await expect.poll(() => quote(flow)).toMatchObject({ couponCode: "save20" });
  await expect(input(page, "coupon")).toBeEnabled();
  await page.getByRole("button", { name: "Remove coupon", exact: true }).click();
  await expect.poll(async () => (await stored(page))?.couponCode).toBe("");
  await expect.poll(() => quote(flow)).toMatchObject({ couponCode: "", referralCode: "friend" });
  await expect(input(page, "coupon")).toBeEnabled();
  await expect(input(page, "coupon")).toHaveValue("");
  await context.route("**/api/payment/finalize", route => route.fulfill({
    json: { ok: true, status: "booked", bookingId: "same-key-booking" },
  }));
  await page.evaluate(() => {
    const booking = JSON.parse(sessionStorage.getItem("checkout_booking_state"));
    sessionStorage.setItem("payment_session_state", JSON.stringify({ provider: "dodo", providerPayload: {},
      fingerprint: JSON.stringify(booking), paymentAccessToken: "same-key-session" }));
  });
  await input(page, "referral").press("x");
  await expect(page).toHaveURL(/\/payment-success$/);
});

test("a code edit retains the hold refreshed by payment cancellation", async ({ page, context, flow }) => {
  await ready(page, flow);
  await page.evaluate(() => {
    const booking = JSON.parse(sessionStorage.getItem("checkout_booking_state"));
    sessionStorage.setItem("payment_session_state", JSON.stringify({ provider: "paypal", providerPayload: {},
      paymentAccessToken: "before-hold-refresh", fingerprint: JSON.stringify(booking) }));
  });
  await context.route("**/api/payment/cancel", route => route.fulfill({ json: {
    ok: true, cancelled: true, refreshedHold: { slotHoldId: "refreshed-id", slotHoldToken: "refreshed-token",
      slotHoldExpiresAt: new Date(Date.now() + 20 * 60000).toISOString() },
  } }));
  await page.reload();
  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await expect(input(page, "coupon")).toBeEnabled();
  await input(page, "coupon").fill("save20");
  await apply(page, "coupon").click();
  await expect.poll(async () => (await stored(page))).toMatchObject({ couponCode: "save20",
    slotHoldId: "refreshed-id", slotHoldToken: "refreshed-token" });
  await page.reload();
  await expect(input(page, "coupon")).toBeEnabled();
  expect((await stored(page)).slotHoldToken).toBe("refreshed-token");
});

test("saving a newer session retires an unsaved session for the same booking", async ({ page }) => {
  const { readFile } = require("node:fs/promises");
  await page.route("**/public/checkout-state.js", async route => route.fulfill({
    contentType: "text/javascript", body: await readFile(require.resolve("../public/checkout-state.js"), "utf8"),
  }));
  await page.route("**/__test/session-module/*", async route => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    if (!["paymentSessionStorage.js", "browserStorage"].includes(name)) return route.abort();
    const source = await readFile(require.resolve(`../src/lib/${name.replace(/\.js$/, "")}.js`), "utf8");
    return route.fulfill({ contentType: "text/javascript", body: source });
  });
  await page.goto("/packages");
  const result = await page.evaluate(async () => {
    const storage = await import("/__test/session-module/paymentSessionStorage.js");
    const unsaved = new Map();
    const fingerprint = JSON.stringify({ packageTitle: "Performance Vertex Overhaul",
      startTimeUTC: "2099-01-05T10:00:00.000Z", email: "visitor@example.invalid" });
    const oldSession = { provider: "dodo", providerPayload: {}, fingerprint, paymentAccessToken: "retired-session" };
    const other = { ...oldSession, paymentAccessToken: "other-session",
      fingerprint: JSON.stringify({ packageTitle: "Other package", email: "other@example.invalid" }) };
    sessionStorage.setItem("payment_session_state", JSON.stringify(other));
    let latest;
    let otherKept;
    const setItem = Storage.prototype.setItem;
    try {
      Storage.prototype.setItem = () => { throw new DOMException("Storage quota", "QuotaExceededError"); };
      if (!storage.writeStoredPaymentSession(oldSession, unsaved)) unsaved.set(oldSession.paymentAccessToken, oldSession);
      const newer = { ...oldSession, paymentAccessToken: "newer-unsaved-session" };
      storage.writeStoredPaymentSession(newer, unsaved);
      latest = storage.readCheckoutPaymentSession(fingerprint, unsaved)?.paymentAccessToken;
      storage.clearStoredPaymentSession(newer);
      unsaved.delete(newer.paymentAccessToken);
      otherKept = JSON.parse(sessionStorage.getItem("payment_session_state"))?.paymentAccessToken;
    } finally {
      Storage.prototype.setItem = setItem;
    }
    const nextSession = { ...oldSession, paymentAccessToken: "current-session" };
    const saved = storage.writeStoredPaymentSession(nextSession, unsaved);
    storage.clearStoredPaymentSession(nextSession);
    return { saved, latest, otherKept, recovered: storage.readCheckoutPaymentSession(fingerprint, unsaved) };
  });
  expect(result.saved).toBe(true);
  expect(result.latest).toBe("newer-unsaved-session");
  expect(result.otherKept).toBe("other-session");
  expect(result.recovered).toBeNull();
});

test("booking review leaves another booking's payment untouched", async ({ page, context, flow }) => {
  await ready(page, flow);
  const session = await page.evaluate(() => {
    const booking = JSON.parse(sessionStorage.getItem("checkout_booking_state"));
    const hold = JSON.parse(sessionStorage.getItem("my_slot_hold"));
    sessionStorage.setItem("my_slot_hold", JSON.stringify({ ...hold, phase: "payment_pending" }));
    const other = { provider: "dodo", paymentAccessToken: "other-booking-token", providerPayload: {},
      fingerprint: JSON.stringify({ ...booking, startTimeUTC: "2099-12-25T04:30:00.000Z" }) };
    sessionStorage.setItem("payment_session_state", JSON.stringify(other));
    return other;
  });
  const cancellations = [];
  await context.route("**/api/payment/cancel", route => {
    cancellations.push(route.request().headers().authorization);
    return route.fulfill({ json: { ok: true, cancelled: true } });
  });
  await page.goto("/booking");
  await page.getByRole("button", { name: "Release payment", exact: true }).click();
  await expect(page.getByText("Return to payment once so the active session can be checked.", { exact: true })).toBeVisible();
  expect(cancellations).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("payment_session_state")))).toEqual(session);
});

test("an incidental creator keeps a deliberate incompatible coupon until explicit replacement", async ({ page, context, flow }, info) => {
  await context.route("**/api/ref/validateCoupon?*", route => {
    if (new URL(route.request().url()).searchParams.get("code") !== "solo30") return route.fallback();
    return route.fulfill({ json: { ok: true, coupon: { code: "solo30", discountType: "percent",
      discountPercent: 30, canCombineWithReferral: false } } });
  });
  await ready(page, flow, "");
  await input(page, "coupon").fill("solo30");
  await apply(page, "coupon").click();
  await expect.poll(async () => (await stored(page))?.couponCode).toBe("solo30");
  await page.goto("/payment?ref=friend");
  await expect(input(page, "coupon")).toBeEnabled();
  await expect(input(page, "coupon")).toHaveValue("solo30");
  await expect(input(page, "referral")).toHaveValue("");
  await page.reload();
  await expect(input(page, "coupon")).toBeEnabled();
  await expect.poll(() => quote(flow)).toMatchObject({ couponCode: "solo30", referralCode: "" });
  await info.attach("passive-link-quote", { body: JSON.stringify(quote(flow)), contentType: "application/json" });
  await input(page, "referral").fill("friend");
  await apply(page, "referral").click();
  await expect.poll(async () => (await stored(page))).toMatchObject({ referralCode: "friend", couponCode: "" });
});

for (const candidate of ["svae20", "save20"]) {
  test(`a rejected ${candidate === "save20" ? "selected" : "different"} coupon preserves the correct choice`, async ({ page, context, flow }, info) => {
    await ready(page, flow);
    await input(page, "coupon").fill("save20");
    await apply(page, "coupon").click();
    await expect.poll(async () => (await stored(page))?.couponCode).toBe("save20");
    await context.route(`**/api/ref/validateCoupon?code=${candidate}*`, route => route.fulfill({
      status: 400, json: { ok: false, error: "Invalid coupon", reason: "not_found" },
    }));
    await input(page, "coupon").fill(candidate);
    await apply(page, "coupon").click();
    await expect(page.locator("#payment-coupon-code-error")).toBeVisible();
    const expected = candidate === "save20" ? "" : "save20";
    expect((await stored(page)).couponCode).toBe(expected);
    await page.reload();
    await expect(input(page, "coupon")).toBeEnabled();
    await expect(input(page, "coupon")).toHaveValue(expected);
    await expect.poll(() => quote(flow)).toMatchObject({ couponCode: expected, referralCode: "friend" });
    await info.attach("rejected-candidate-quote", { body: JSON.stringify(quote(flow)), contentType: "application/json" });
  });
}

for (const legacy of [false, true]) {
  test(`Dodo confirmation survives an invalidated coupon with query size ${legacy ? "absent" : "present"}`, async ({ page, context, flow }, info) => {
    if (legacy) await page.addInitScript(() => { delete URLSearchParams.prototype.size; });
    await ready(page, flow);
    await input(page, "coupon").fill("save20");
    await apply(page, "coupon").click();
    await expect.poll(async () => (await stored(page))?.couponCode).toBe("save20");
    await page.evaluate(() => {
      const booking = JSON.parse(sessionStorage.getItem("checkout_booking_state"));
      sessionStorage.setItem("payment_session_state", JSON.stringify({ provider: "dodo", paymentAccessToken: "fixture-payment",
        providerPayload: { checkoutUrl: "/__test/checkout-handoff" }, fingerprint: JSON.stringify({
          packageTitle: booking.packageTitle, originalOrderId: "", startTimeUTC: booking.startTimeUTC,
          email: booking.email, referralCode: "friend", couponCode: "save20",
        }) }));
    });
    await context.route("**/api/ref/validateCoupon?*", route => route.fulfill({ status: 400,
      json: { ok: false, error: "This coupon has reached its maximum number of uses." } }));
    const finalizes = [];
    await context.route("**/api/payment/finalize", async route => {
      finalizes.push(route.request().headers().authorization);
      await route.fulfill({ json: { ok: true, status: "booked", bookingId: "fixture-booking",
        booking: { packageTitle: "Performance Vertex Overhaul" } } });
    });
    await page.goto("/payment?dodo_return=1");
    await expect(page).toHaveURL(/\/payment-success$/);
    expect(finalizes.length).toBeGreaterThan(0);
    expect(finalizes.every(value => value === "Bearer fixture-payment")).toBe(true);
    expect(await page.evaluate(() => sessionStorage.getItem("payment_session_state"))).toBeNull();
    await info.attach("confirmed-return", { body: JSON.stringify({ legacy, finalizes, url: page.url() }), contentType: "application/json" });
  });
}

test("code persistence preserves unrelated query markers without query size", async ({ page, flow }) => {
  await page.addInitScript(() => { delete URLSearchParams.prototype.size; });
  await ready(page, flow);
  await page.goto("/payment?ref=friend&dodo_cancel=1&source=creator");
  await expect(input(page, "referral")).toBeEnabled();
  await input(page, "referral").fill("");
  await apply(page, "referral").click();
  await expect(page).toHaveURL(url => !url.searchParams.has("ref") && url.searchParams.get("dodo_cancel") === "1" && url.searchParams.get("source") === "creator");
});

test("unsaved sessions stay recoverable for their own restored booking", async ({ page, context, flow }, info) => {
  await ready(page, flow);
  await page.evaluate(async () => {
    const first = JSON.parse(sessionStorage.getItem("checkout_booking_state"));
    const other = { ...first, email: "other@example.invalid", referralCode: "", couponCode: "",
      checkoutCodes: { referral: null, coupon: null, dismissedReferralCode: "" } };
    const state = history.state;
    await new Promise(resolve => {
      const replaceState = history.replaceState;
      history.replaceState = function (...args) {
        const result = replaceState.apply(this, args);
        if (args[0]?.usr?.bookingData?.email === first.email) {
          history.replaceState = replaceState;
          resolve();
        }
        return result;
      };
      history.pushState({ ...state, usr: { ...state.usr, bookingData: other } }, "", location.href);
      history.back();
    });
  });
  await expect.poll(() => page.evaluate(() => history.state?.usr?.bookingData?.email)).toBe("visitor@example.invalid");
  await expect.poll(async () => (await stored(page))?.email).toBe("visitor@example.invalid");
  await expect(input(page, "referral")).toBeEnabled();
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "payment_session_state") throw new DOMException("Storage quota", "QuotaExceededError");
      return setItem.call(this, key, value);
    };
  });
  let starts = 0;
  await context.route("**/api/payment/start", route => route.fulfill({ json: {
    ok: true, paymentAccessToken: `fixture-payment-${++starts}`, status: "started",
    providerPayload: { checkoutUrl: "/__test/checkout-handoff" },
  } }));
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Your browser could not save this payment session." })).toBeVisible();
  expect(starts).toBe(1);
  await page.goForward();
  await expect.poll(() => page.evaluate(() => history.state?.usr?.bookingData?.email)).toBe("other@example.invalid");
  await expect.poll(async () => (await stored(page))?.email).toBe("other@example.invalid");
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => starts).toBe(2);
  await page.goBack();
  await expect.poll(async () => (await stored(page))?.email).toBe("visitor@example.invalid");
  await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeEnabled();
  const tokens = [];
  await context.route("**/api/payment/finalize", route => {
    tokens.push(route.request().headers().authorization);
    return route.fulfill({ json: { ok: true, status: "booked", bookingId: "fixture-recovered" } });
  });
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page).toHaveURL(/\/payment-success$/);
  expect(tokens).toEqual(["Bearer fixture-payment-1"]);
  expect(starts).toBe(2);
  await info.attach("unsaved-session-recovery", { body: JSON.stringify({ starts, tokens }), contentType: "application/json" });
});
