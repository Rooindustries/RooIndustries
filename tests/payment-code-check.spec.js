const { test, expect, overhaulPrice } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });

const fields = page => {
  const referral = page.getByRole("textbox", { name: "Referral Code (optional)", exact: true });
  const coupon = page.getByRole("textbox", { name: "Coupon Code (optional)", exact: true });
  const apply = input => input.locator("..").getByRole("button", { name: /^(Apply|Checking\.\.\.)$/ });
  return { referral, coupon, referralApply: apply(referral), couponApply: apply(coupon) };
};

const holdCheck = async (page, endpoint) => {
  const pattern = "**/api/ref/" + endpoint + "?*";
  let release;
  let requested;
  const calls = [];
  const gate = new Promise(resolve => { release = resolve; });
  const request = new Promise(resolve => { requested = resolve; });
  const response = page.waitForResponse(pattern);
  response.catch(() => {});
  await page.route(pattern, async route => {
    calls.push(route.request().url());
    requested();
    await gate;
    await route.fallback();
  });
  return {
    release, request, response, calls,
    finish: async () => {
      release();
      if (calls.length) await response.then(result => result.finished()).catch(() => {});
      await page.unrouteAll({ behavior: "wait" });
    },
  };
};

const record = async (page, info, name, values) => {
  await fs.mkdir(info.outputDir, { recursive: true });
  const path = info.outputPath(name + ".json");
  await fs.writeFile(path, JSON.stringify(values, null, 2));
  await info.attach(name, { path, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath(name + ".png"), animations: "disabled" });
};

const lastQuote = flow => flow.state.calls.filter(call => call.path === "/api/payment/quote").at(-1)?.body;

for (const viewport of [null, { width: 390, height: 844 }]) {
  test("a coupon check locks both code fields until it answers" + (viewport ? " on mobile" : ""), async ({ page, flow }, info) => {
    if (viewport) await page.setViewportSize(viewport);
    await flow.review();
    await flow.payment();
    const ui = fields(page);
    await expect(ui.coupon).toBeEnabled();
    const held = await holdCheck(page, "validateCoupon");
    try {
      await ui.coupon.fill("save20");
      await ui.couponApply.click();
      await held.request;
      for (const control of Object.values(ui)) await expect(control).toBeDisabled({ timeout: 1000 });
      await expect(ui.couponApply).toHaveText("Checking...");
      await record(page, info, "coupon-check-pending", { checkedCode: "save20", heldRequests: held.calls.length });
      held.release();
      await (await held.response).finished();
      const status = page.getByRole("status").filter({ hasText: "Coupon applied" });
      await expect(status).toBeVisible();
      await expect(ui.coupon).toHaveValue("save20");
      await expect(ui.referral).toHaveValue("");
      for (const control of Object.values(ui)) await expect(control).toBeEnabled();
      await expect.poll(() => lastQuote(flow)).toMatchObject({ referralCode: "", couponCode: "save20" });
      await record(page, info, "coupon-check-finished", {
        coupon: await ui.coupon.inputValue(), referral: await ui.referral.inputValue(),
        banner: await status.innerText(), quote: lastQuote(flow),
      });
    } finally {
      await held.finish();
    }
  });
}

test("a referral check keeps the applied coupon untouched", async ({ page, flow }, info) => {
  await flow.review();
  await flow.payment();
  const ui = fields(page);
  await expect(ui.coupon).toBeEnabled();
  await ui.coupon.fill("save20");
  await ui.couponApply.click();
  const remove = page.getByRole("button", { name: "Remove coupon", exact: true });
  await expect(remove).toBeVisible();
  const held = await holdCheck(page, "validateReferral");
  try {
    await ui.referral.fill("friend");
    await ui.referralApply.click();
    await held.request;
    for (const control of [...Object.values(ui), remove]) await expect(control).toBeDisabled({ timeout: 1000 });
    await record(page, info, "referral-check-pending", { coupon: await ui.coupon.inputValue(), referral: await ui.referral.inputValue() });
    held.release();
    await (await held.response).finished();
    await expect(ui.referral).toHaveValue("friend");
    await expect(ui.coupon).toHaveValue("save20");
    for (const control of [...Object.values(ui), remove]) await expect(control).toBeEnabled();
    await expect(page.locator("dt").filter({ hasText: /^Referral$/ }).locator("..").locator("dd")).toContainText("friend");
    await expect(page.locator("dt").filter({ hasText: /^Coupon$/ }).locator("..").locator("dd")).toContainText("save20");
    await expect.poll(() => lastQuote(flow)).toMatchObject({ referralCode: "friend", couponCode: "save20" });
    await record(page, info, "referral-check-finished", {
      coupon: await ui.coupon.inputValue(), referral: await ui.referral.inputValue(), quote: lastQuote(flow),
    });
  } finally {
    await held.finish();
  }
});

test("a code error stays with the code that was checked", async ({ page, flow }, info) => {
  await flow.review();
  await flow.payment();
  const ui = fields(page);
  await expect(ui.coupon).toBeEnabled();
  const held = await holdCheck(page, "validateCoupon");
  try {
    await ui.coupon.fill("expired");
    await ui.couponApply.click();
    await held.request;
    await expect(ui.coupon).toBeDisabled({ timeout: 1000 });
    held.release();
    await (await held.response).finished();
    const alert = page.getByRole("alert").filter({ hasText: "This coupon has expired." });
    await expect(alert).toBeVisible();
    await expect(ui.coupon).toHaveValue("expired");
    await expect(ui.coupon).toBeEnabled();
    await record(page, info, "checked-code-error", { coupon: await ui.coupon.inputValue(), error: await alert.innerText() });
    await ui.coupon.fill("save20");
    await expect(alert).toHaveCount(0);
    await record(page, info, "checked-code-edited", { coupon: await ui.coupon.inputValue(), alerts: await alert.count() });
  } finally {
    await held.finish();
  }
});

test("Enter in a code field checks it the way Apply does", async ({ page, flow }) => {
  await flow.review();
  await flow.payment();
  const ui = fields(page);
  await expect(ui.coupon).toBeEnabled();
  const couponCheck = page.waitForResponse("**/api/ref/validateCoupon?*");
  await ui.coupon.fill("save20");
  await ui.coupon.press("Enter");
  await (await couponCheck).finished();
  await expect(page.getByRole("status").filter({ hasText: "Coupon applied" })).toBeVisible();
  const referralCheck = page.waitForResponse("**/api/ref/validateReferral?*");
  await ui.referral.fill("friend");
  await ui.referral.press("Enter");
  await (await referralCheck).finished();
  await expect.poll(() => lastQuote(flow)).toMatchObject({ referralCode: "friend", couponCode: "save20" });
  const checks = [];
  page.on("request", request => { if (/\/api\/ref\/validate/.test(request.url())) checks.push(request.url()); });
  await page.getByRole("button", { name: "Remove coupon", exact: true }).click();
  await expect(ui.coupon).toHaveValue("");
  expect(checks).toEqual([]);
  await expect(page).toHaveURL(/\/payment/);
});

const quoteProviders = {
  dodo: { enabled: true, mode: "test" },
  razorpay: { enabled: false, mode: "test", disabledReason: "fixture" },
  paypal: { enabled: false, mode: "test", clientId: "" },
};

const serverQuote = (page, quoteFor) => page.route("**/api/payment/quote", async route => {
  const quote = await quoteFor(route.request().postDataJSON() || {});
  await route.fulfill({ json: { ok: true, quoteFingerprint: "fixture-quoted-discounts", quote, providers: quoteProviders } });
});

const usd = value => `$${value.toFixed(2)}`;
const listPrice = usd(overhaulPrice);
const couponTotal = usd(overhaulPrice - 5.5);

const quotedDiscounts = body => {
  const coupon = body.couponCode === "save20" ? 5.5 : 0;
  const referral = body.referralCode === "friend" ? 3.25 : 0;
  const netAmount = Math.round((overhaulPrice - coupon - referral) * 100) / 100;
  return { grossAmount: overhaulPrice, netAmount, isFree: false,
    couponDiscountAmount: coupon, referralDiscountAmount: referral, referralDiscountPercent: referral ? 10 : 0 };
};

const line = (page, label) => page.locator("dt").filter({ hasText: new RegExp(`^(${label})$`) }).locator("..").locator("dd");

test("the payment page shows the discounts the server quoted", async ({ page, flow }) => {
  await serverQuote(page, quotedDiscounts);
  await flow.review();
  await flow.payment();
  const ui = fields(page);
  await ui.coupon.fill("save20");
  await ui.couponApply.click();
  await expect(line(page, "Coupon")).toHaveText("save20 · −$5.50");
  await expect(line(page, "Total|Subtotal")).toHaveText(`${listPrice}${couponTotal} USD`);
  await ui.referral.fill("friend");
  await ui.referralApply.click();
  await expect(line(page, "Referral")).toHaveText("friend · −$3.25");
  await expect(line(page, "Total|Subtotal")).toHaveText(`${listPrice}${usd(overhaulPrice - 5.5 - 3.25)} USD`);
});

test("the review step shows the discounts the server quoted", async ({ page, flow }) => {
  await serverQuote(page, quotedDiscounts);
  await flow.reserve();
  await flow.details();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await flow.codeInput("save20");
  await expect(line(page, "Coupon")).toContainText("save20 · −$5.50");
  await expect(line(page, "Total|Subtotal")).toContainText(couponTotal);
});

test("removing a coupon never shows the old quoted total", async ({ page, flow }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await serverQuote(page, async body => {
    if (!body.couponCode && release.armed) await held;
    return quotedDiscounts(body);
  });
  await flow.review();
  await flow.payment();
  const ui = fields(page);
  await ui.coupon.fill("save20");
  await ui.couponApply.click();
  await expect(line(page, "Total|Subtotal")).toHaveText(`${listPrice}${couponTotal} USD`);
  release.armed = true;
  await page.getByRole("button", { name: "Remove coupon", exact: true }).click();
  await expect(line(page, "Coupon")).toHaveCount(0);
  await expect(line(page, "Total|Subtotal")).toHaveText(`${listPrice} USD`);
  release();
  await expect(page.getByText("Price confirmed for this session.", { exact: true })).toBeVisible();
  await expect(line(page, "Total|Subtotal")).toHaveText(`${listPrice} USD`);
});

test("a quote without line amounts never shows browser-estimated discounts", async ({ page, flow }) => {
  await serverQuote(page, body => body.couponCode === "save20"
    ? { grossAmount: overhaulPrice, netAmount: 0, isFree: true }
    : quotedDiscounts(body));
  await flow.review();
  await flow.payment();
  const ui = fields(page);
  await ui.coupon.fill("save20");
  await ui.couponApply.click();
  await expect(line(page, "Total|Subtotal")).toHaveText("$0.00 USD");
  await expect(page.getByText(`−${usd(overhaulPrice * 0.2)}`)).toHaveCount(0);
  await expect(line(page, "Coupon")).toHaveCount(0);
});
