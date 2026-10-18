const { test, expect } = require("./fixtures/booking-flow.cjs");
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
