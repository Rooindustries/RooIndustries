const fs = require("node:fs");
const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

test("expiry keeps edits submitted after the saved draft stopped updating", async ({ page, flow }, testInfo) => {
  flow.state.holdMs = 20000;
  await flow.reserve();
  await flow.details("older@example.invalid");
  await expect.poll(() => page.evaluate(() => Object.values(JSON.parse(sessionStorage.getItem("booking_draft")).packages)[0].form.email)).toBe("older@example.invalid");
  await page.evaluate(() => {
    window.__draftRecoverySet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === sessionStorage && key === "booking_draft") throw new DOMException("Fixture draft quota exceeded", "QuotaExceededError");
      return window.__draftRecoverySet.call(this, key, value);
    };
  });
  await page.getByRole("textbox", { name: "Booking email", exact: true }).fill("newer@example.invalid");
  await page.getByRole("textbox", { name: "PC specifications", exact: true }).fill("New PC specifications");
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await flow.payment();
  const submitted = await page.evaluate(() => ({
    checkout: JSON.parse(sessionStorage.getItem("checkout_booking_state")),
    draft: JSON.parse(sessionStorage.getItem("booking_draft")),
    hold: JSON.parse(sessionStorage.getItem("my_slot_hold")),
  }));
  expect(submitted.checkout.email).toBe("newer@example.invalid");
  await expect(page).toHaveURL(/\/booking$/, { timeout: 30000 });
  await page.evaluate(() => { Storage.prototype.setItem = window.__draftRecoverySet; });
  flow.state.holds.clear();
  flow.state.holdMs = 20 * 60 * 1000;
  const slot = page.getByRole("button", { name: "10:00 AM", exact: true });
  if (!await slot.isVisible()) await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await slot.click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  const restored = {
    email: await page.getByRole("textbox", { name: "Booking email", exact: true }).inputValue(),
    specs: await page.getByRole("textbox", { name: "PC specifications", exact: true }).inputValue(),
  };
  fs.mkdirSync(testInfo.outputDir, { recursive: true });
  fs.writeFileSync(testInfo.outputPath("draft-recovery.json"), JSON.stringify({ submitted, restored }, null, 2));
  expect(restored).toEqual({ email: "newer@example.invalid", specs: "New PC specifications" });
});

test("a later draft edit and an intentional empty field outrank old Payment details after reload", async ({ page, flow }, testInfo) => {
  flow.state.holdMs = 20000;
  await flow.review();
  await flow.payment();
  await expect(page).toHaveURL(/\/booking$/, { timeout: 30000 });
  flow.state.holds.clear();
  flow.state.holdMs = 20 * 60 * 1000;
  const slot = page.getByRole("button", { name: "10:00 AM", exact: true });
  if (!await slot.isVisible()) await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await slot.click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await page.getByRole("textbox", { name: "Booking email", exact: true }).fill("latest@example.invalid");
  await page.getByRole("textbox", { name: "PC specifications", exact: true }).fill("");
  await page.reload();
  const restored = {
    email: await page.getByRole("textbox", { name: "Booking email", exact: true }).inputValue(),
    specs: await page.getByRole("textbox", { name: "PC specifications", exact: true }).inputValue(),
  };
  fs.mkdirSync(testInfo.outputDir, { recursive: true });
  fs.writeFileSync(testInfo.outputPath("newer-draft.json"), JSON.stringify(restored, null, 2));
  expect(restored).toEqual({ email: "latest@example.invalid", specs: "" });
});

for (const scenario of [
  { width: 1280 },
  { width: 360, withoutHold: true },
  { width: 390, withoutDraft: true },
]) {
  test(`${scenario.width}px clearing every detail survives a history return and reload`, async ({ page, flow }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    const chooseSlot = async () => {
      const slot = page.getByRole("button", { name: "10:00 AM", exact: true });
      if (!await slot.isVisible()) await page.getByRole("button", { name: /^Earliest available:/ }).click();
      await slot.click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
    };
    const showDetails = async () => {
      const email = page.getByRole("textbox", { name: "Booking email", exact: true });
      const edit = page.getByRole("button", { name: "Edit details", exact: true });
      const earliest = page.getByRole("button", { name: /^Earliest available:/ });
      const slot = page.getByRole("button", { name: "10:00 AM", exact: true });
      await expect.poll(async () => await email.isVisible() || await edit.isVisible() || await earliest.isVisible() || await slot.isVisible()).toBe(true);
      if (await email.isVisible()) return;
      if (await edit.isVisible()) await edit.click();
      else await chooseSlot();
    };
    await page.goto("/");
    const homeEntries = await page.evaluate(() => history.length);
    await page.locator(".ri-package-book-button").first().click();
    await expect(page).toHaveURL(/\/booking$/);
    await chooseSlot();
    await flow.details();
    await page.getByRole("button", { name: "Review before payment", exact: true }).click();
    await flow.payment();
    const submitted = await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state")));
    await page.getByRole("link", { name: "Back to Booking", exact: true }).click();
    await expect(page).toHaveURL(/\/booking$/);
    await showDetails();
    const fields = ["notes", "mainGame", "specs", "discord", "email"];
    for (const field of fields) {
      if (scenario.withoutDraft && field === "email") {
        await page.evaluate(() => sessionStorage.removeItem("booking_draft"));
      }
      await page.locator(`[name="${field}"]`).fill("");
    }
    const cleared = await page.evaluate(() => JSON.parse(sessionStorage.getItem("booking_draft")));
    if (scenario.withoutHold) {
      flow.state.holds.clear();
      await page.evaluate(() => {
        sessionStorage.removeItem("my_slot_hold");
        sessionStorage.removeItem("booking_hold_expired");
      });
    }
    const bookingEntry = await page.evaluate(() => window.history.state);
    const hops = await page.evaluate(initial => history.length - initial, homeEntries);
    await page.evaluate(delta => history.go(-delta), hops);
    await expect(page).toHaveURL(/\/$/);
    await page.evaluate(delta => history.go(delta), hops);
    await expect(page).toHaveURL(/\/booking$/);
    await showDetails();
    const returned = Object.fromEntries(await Promise.all(fields.map(async field => [field, await page.locator(`[name="${field}"]`).inputValue()])));
    await page.reload();
    await showDetails();
    const restored = Object.fromEntries(await Promise.all(fields.map(async field => [field, await page.locator(`[name="${field}"]`).inputValue()])));
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(testInfo.outputPath("cleared-details.json"), JSON.stringify({ submitted, bookingEntry, cleared, returned, restored }, null, 2));
    expect(returned).toEqual(Object.fromEntries(fields.map(field => [field, ""])));
    expect(restored).toEqual(Object.fromEntries(fields.map(field => [field, ""])));
    const draft = Object.values(cleared.packages).find(value => value.selectedPackage?.title === submitted.packageTitle);
    expect(draft.formRevision).toBeGreaterThan(submitted.formRevision);
    expect(draft.form).toBeUndefined();
  });
}

for (const scenario of [
  { width: 1280, step: 3 },
  { width: 360, step: 2 },
  { width: 390, step: 1 },
]) {
  test(`${scenario.width}px an explicit successful release clears only its package details`, async ({ page, flow }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await flow.review();
    if (scenario.step < 3) await page.getByRole("button", { name: "Edit details", exact: true }).click();
    if (scenario.step === 1) await page.getByRole("button", { name: "Back", exact: true }).last().click();
    const before = await page.evaluate(() => {
      const draft = JSON.parse(sessionStorage.getItem("booking_draft"));
      draft.packages["Other package"] = { selectedPackage: { title: "Other package" }, form: { email: "other@example.invalid" } };
      sessionStorage.setItem("booking_draft", JSON.stringify(draft));
      return draft;
    });
    await page.getByRole("button", { name: "Release Slot", exact: true }).click();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("my_slot_hold"))).toBeNull();
    const after = await page.evaluate(() => ({
      draft: JSON.parse(sessionStorage.getItem("booking_draft")),
      marker: sessionStorage.getItem("booking_hold_expired"),
    }));
    const key = before.lastTitle;
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(testInfo.outputPath("manual-release.json"), JSON.stringify({ before, after }, null, 2));
    expect(after.draft.packages[key].form).toBeUndefined();
    expect(after.draft.packages[key].formRevision).toBeGreaterThan(before.packages[key].formRevision);
    expect(after.draft.packages["Other package"]).toEqual(before.packages["Other package"]);
    expect(after.marker).toBeNull();
    const slot = page.getByRole("button", { name: "10:00 AM", exact: true });
    if (!await slot.isVisible()) await page.getByRole("button", { name: /^Earliest available:/ }).click();
    await slot.click();
    await page.getByRole("button", { name: "Next", exact: true }).last().click();
    for (const field of ["discord", "email", "specs", "mainGame", "notes"]) {
      await expect(page.locator(`[name="${field}"]`)).toHaveValue("");
    }
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("");
  });
}

test("details edited while a manual release waits remain available for the next reservation", async ({ page, flow }, testInfo) => {
  await flow.reserve();
  await flow.details();
  let finishRelease;
  const finished = new Promise(resolve => { finishRelease = resolve; });
  await page.route("**/api/releaseHold", async route => {
    await finished;
    flow.state.holds.clear();
    await route.fulfill({ json: { ok: true } });
  });
  const requested = page.waitForRequest("**/api/releaseHold");
  await page.getByRole("button", { name: "Release Slot", exact: true }).click();
  await requested;
  await page.getByRole("textbox", { name: "Booking email", exact: true }).fill("edited@example.invalid");
  finishRelease();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("my_slot_hold"))).toBeNull();
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem("booking_draft")));
  fs.mkdirSync(testInfo.outputDir, { recursive: true });
  fs.writeFileSync(testInfo.outputPath("edited-during-release.json"), JSON.stringify(draft, null, 2));
  expect(draft.packages[draft.lastTitle].form.email).toBe("edited@example.invalid");
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("edited@example.invalid");
});
