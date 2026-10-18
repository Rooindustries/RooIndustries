const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce" });

const validation = "**/api/ref/validateReferral?*";
const draft = page => page.evaluate(() => {
  const stored = JSON.parse(sessionStorage.getItem("booking_draft"));
  return stored?.packages?.[stored.lastTitle] || null;
});
const record = async (page, info, name, values) => {
  await fs.mkdir(info.outputDir, { recursive: true });
  const path = info.outputPath(`${name}.json`);
  await fs.writeFile(path, JSON.stringify(values, null, 2));
  await info.attach(name, { path, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath(`${name}.png`), animations: "disabled" });
};
const holdValidation = async page => {
  let release;
  let requested;
  const calls = [];
  const gate = new Promise(resolve => { release = resolve; });
  const request = new Promise(resolve => { requested = resolve; });
  const response = page.waitForResponse(validation);
  response.catch(() => {});
  await page.route(validation, async route => {
    calls.push(route.request().url());
    requested();
    await gate;
    await route.fallback();
  });
  return {
    request,
    release,
    response,
    calls,
    finish: async () => {
      release();
      if (calls.length) await response.then(result => result.finished()).catch(() => {});
      await page.unrouteAll({ behavior: "wait" });
    },
  };
};

test("review controls wait for a manual code check", async ({ page, flow }, info) => {
  await flow.review();
  await flow.codeInput("save20");
  const coupon = page.getByRole("button", { name: "Remove coupon code save20", exact: true });
  await expect(coupon).toBeVisible();
  const controls = [
    page.getByRole("button", { name: "Edit details", exact: true }),
    page.getByRole("button", { name: "Edit", exact: true }),
    page.getByRole("button", { name: "Back", exact: true }).last(),
    coupon,
  ];
  const held = await holdValidation(page);
  try {
    await flow.codeInput("friend");
    await held.request;
    for (const control of controls) await expect(control).toBeDisabled({ timeout: 1000 });
    await expect(page.getByRole("button", { name: "Checking code...", exact: true })).toBeVisible();
    await record(page, info, "manual-code-check-pending", { draft: await draft(page) });
    held.release();
    await (await held.response).finished();
    const referral = page.getByRole("button", { name: "Remove referral code friend", exact: true });
    await expect(referral).toBeVisible();
    await expect(coupon).toBeVisible();
    for (const control of [...controls, referral]) await expect(control).toBeEnabled();
    const applied = await draft(page);
    expect(applied.form.email).toBe("visitor@example.invalid");
    expect(applied.checkoutCodes.referral.code).toBe("friend");
    expect(applied.checkoutCodes.coupon.code).toBe("save20");
    await controls[0].click();
    await page.getByRole("textbox", { name: "Booking email", exact: true }).fill("updated@example.invalid");
    await page.getByRole("button", { name: "Review before payment", exact: true }).click();
    const updated = await draft(page);
    expect(updated.form.email).toBe("updated@example.invalid");
    expect(updated.checkoutCodes.referral.code).toBe("friend");
    expect(updated.checkoutCodes.coupon.code).toBe("save20");
    await expect(referral).toBeVisible();
    await expect(coupon).toBeVisible();
    await record(page, info, "manual-code-check-finished", { applied, updated });
  } finally {
    await held.finish();
  }
});

test("closing the dialog during a code check leaves the reopened booking alone", async ({ page, flow }, info) => {
  await flow.review();
  const held = await holdValidation(page);
  try {
    await flow.codeInput("friend");
    await held.request;
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Continue booking", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    held.release();
    await (await held.response).finished();
    await page.waitForTimeout(300);
    const state = {
      draft: await draft(page),
      referralSession: await page.evaluate(() => sessionStorage.getItem("referral_session")),
    };
    await record(page, info, "reopened-booking-after-old-code-reply", state);
    expect(state.referralSession).toBeNull();
    expect(state.draft.checkoutCodes?.referral || null).toBeNull();
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toHaveCount(0);
  } finally {
    await held.finish();
  }
});

test("the automatic referral check holds the review step until it finishes", async ({ page, flow }, info) => {
  const held = await holdValidation(page);
  try {
    await page.goto("/booking?ref=friend");
    await page.getByRole("button", { name: /^Earliest available:/ }).click();
    await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).last().click();
    await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
    await flow.details();
    await page.getByRole("button", { name: "Review before payment", exact: true }).click();
    await held.request;
    await expect(page.getByRole("button", { name: "Edit details", exact: true })).toBeDisabled({ timeout: 1000 });
    await expect(page.getByRole("button", { name: "Back", exact: true }).last()).toBeDisabled({ timeout: 1000 });
    await expect(page.getByRole("button", { name: "Checking code...", exact: true })).toBeVisible();
    held.release();
    await (await held.response).finished();
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled();
    await record(page, info, "automatic-code-check-finished", { draft: await draft(page) });
  } finally {
    await held.finish();
  }
});

test("releasing the slot during the automatic referral check doesn't leave the review stuck", async ({ page, flow }, info) => {
  const held = await holdValidation(page);
  try {
    await page.goto("/booking?ref=friend");
    await page.getByRole("button", { name: /^Earliest available:/ }).click();
    await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).last().click();
    await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
    await flow.details();
    await page.getByRole("button", { name: "Review before payment", exact: true }).click();
    await held.request;
    await page.getByRole("dialog").getByRole("button", { name: "Release Slot", exact: true }).click();
    await expect(page.getByRole("button", { name: "10:00 AM", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).last().click();
    await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
    await flow.details();
    await page.getByRole("button", { name: "Review before payment", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Checking code...", exact: true })).toBeVisible();
    held.release();
    await (await held.response).finished();
    await page.waitForTimeout(300);
    await record(page, info, "release-during-automatic-check", { requestCount: held.calls.length, draft: await draft(page) });
    await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled({ timeout: 1000 });
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Checking code...", exact: true })).toHaveCount(0);
    expect(held.calls).toHaveLength(2);
    await record(page, info, "automatic-code-check-retried", { requestCount: held.calls.length, draft: await draft(page) });
  } finally {
    await held.finish();
  }
});

test("a manual code reply from a released slot leaves the replacement booking alone", async ({ page, flow }, info) => {
  await flow.review();
  const originalHold = await page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")));
  const held = await holdValidation(page);
  try {
    await flow.codeInput("friend");
    await held.request;
    await page.getByRole("dialog").getByRole("button", { name: "Release Slot", exact: true }).click();
    await expect(page.getByRole("button", { name: "10:00 AM", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).last().click();
    await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
    await flow.details("updated@example.invalid");
    await page.getByRole("button", { name: "Review before payment", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    const replacementHold = await page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")));
    expect(replacementHold.holdId).not.toBe(originalHold.holdId);
    expect((await draft(page)).form.email).toBe("updated@example.invalid");
    await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled({ timeout: 1000 });
    await expect(page.getByRole("button", { name: "Edit details", exact: true })).toBeEnabled();
    held.release();
    await (await held.response).finished();
    await page.waitForTimeout(300);
    const state = {
      originalHoldId: originalHold.holdId,
      replacementHoldId: replacementHold.holdId,
      draft: await draft(page),
      referralSession: await page.evaluate(() => sessionStorage.getItem("referral_session")),
    };
    await record(page, info, "manual-code-check-replaced-slot", state);
    expect(state.draft.form.email).toBe("updated@example.invalid");
    expect(state.draft.checkoutCodes?.referral || null).toBeNull();
    expect(state.referralSession).toBeNull();
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled();
  } finally {
    await held.finish();
  }
});
