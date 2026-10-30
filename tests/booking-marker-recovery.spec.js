const fs = require("node:fs");
const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

for (const width of [1280, 360, 390]) {
  test(`${width}px: a denied expiry marker does not erase the saved draft on reload`, async ({ page, flow }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (this === sessionStorage && key === "booking_hold_expired") {
          throw new DOMException("Fixture expiry marker denied", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
    });
    flow.state.holdMs = 20000;
    await flow.reserve();
    await flow.details();
    await expect(page.getByRole("alert").filter({ hasText: "The reservation expired. Please choose a slot again." })).toBeVisible({ timeout: 30000 });
    const before = await page.evaluate(() => ({
      marker: sessionStorage.getItem("booking_hold_expired"),
      hold: sessionStorage.getItem("my_slot_hold"),
      draft: JSON.parse(sessionStorage.getItem("booking_draft")),
    }));
    expect(before.marker).toBeNull();
    expect(before.hold).toBeNull();
    expect(Object.values(before.draft.packages)[0].form.email).toBe("visitor@example.invalid");
    await page.reload();
    await expect(page.getByRole("dialog")).toBeVisible();
    flow.state.holds.clear();
    flow.state.holdMs = 20 * 60 * 1000;
    await page.getByRole("button", { name: /^Earliest available:/ }).click();
    await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).last().click();
    const restored = {
      email: await page.getByRole("textbox", { name: "Booking email", exact: true }).inputValue(),
      discord: await page.getByRole("textbox", { name: "Discord username", exact: true }).inputValue(),
      specs: await page.getByRole("textbox", { name: "PC specifications", exact: true }).inputValue(),
    };
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(testInfo.outputPath("marker-recovery.json"), JSON.stringify({ before, restored }, null, 2));
    expect(restored).toEqual({ email: "visitor@example.invalid", discord: "fixture_visitor", specs: "Ryzen 7700 / RTX 4070" });
  });
}
