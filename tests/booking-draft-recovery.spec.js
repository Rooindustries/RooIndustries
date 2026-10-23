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
