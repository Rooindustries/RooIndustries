const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ headless: true, javaScriptEnabled: true, timezoneId: "Asia/Kolkata",
  viewport: { width: 390, height: 844 }, reducedMotion: "reduce", actionTimeout: 10000, navigationTimeout: 30000 });
const stored = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state")));
const input = (page, kind) => page.locator(`#payment-${kind}-code`);
const apply = (page, kind) => input(page, kind).locator("..").getByRole("button", { name: "Apply", exact: true });
const ready = async (page, flow, code = "friend") => {
  await page.goto(code ? `/?ref=${code}` : "/packages");
  await flow.review();
  await flow.payment();
  await expect(input(page, "referral")).toBeEnabled();
};
const quote = flow => flow.state.calls.filter(call => call.path === "/api/payment/quote").at(-1)?.body;

for (const action of ["blank", "invalid"]) {
  test(`a repeated ${action} referral action keeps the prior dismissal`, async ({ page, flow }, info) => {
    await ready(page, flow);
    await input(page, "referral").fill("");
    await apply(page, "referral").click();
    await expect.poll(async () => (await stored(page))?.checkoutCodes?.dismissedReferralCode).toBe("friend");
    if (action === "invalid") await input(page, "referral").fill("frend");
    await apply(page, "referral").click();
    if (action === "invalid") await expect(page.locator("#payment-referral-code-error")).toBeVisible();
    expect((await stored(page)).checkoutCodes.dismissedReferralCode).toBe("friend");
    await page.goto("/payment?ref=friend");
    await expect(input(page, "referral")).toBeEnabled();
    await expect(input(page, "referral")).toHaveValue("");
    await expect.poll(() => quote(flow)).toMatchObject({ referralCode: "" });
    await info.attach("dismissed-choice", { body: JSON.stringify(await stored(page)), contentType: "application/json" });
  });
}

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
  await page.evaluate(() => {
    const first = JSON.parse(sessionStorage.getItem("checkout_booking_state"));
    const other = { ...first, email: "other@example.invalid", referralCode: "", couponCode: "",
      checkoutCodes: { referral: null, coupon: null, dismissedReferralCode: "" } };
    const state = history.state;
    history.pushState({ ...state, usr: { ...state.usr, bookingData: other } }, "", location.href);
    history.back();
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
