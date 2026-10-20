const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", viewport: { width: 390, height: 844 } });

const message = "Please fill out all required fields.";

test("a missing required detail is marked, focused and cleared once filled", async ({ page, flow }) => {
  await flow.reserve();
  await page.getByRole("textbox", { name: "Discord username", exact: true }).fill("fixture_visitor");
  await page.getByRole("textbox", { name: "Booking email", exact: true }).fill("visitor@example.invalid");
  await page.getByRole("textbox", { name: "Main game or application", exact: true }).fill("CS2");
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();

  await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
  const specs = page.getByRole("textbox", { name: "PC specifications", exact: true });
  await expect(specs).toBeFocused();
  await expect(specs).toHaveAttribute("aria-invalid", "true");
  await expect(specs).toHaveAccessibleDescription(message);
  for (const name of ["Discord username", "Booking email", "Main game or application"]) {
    await expect(page.getByRole("textbox", { name, exact: true })).not.toHaveAttribute("aria-invalid", "true");
  }

  await specs.fill("Ryzen 7700 / RTX 4070");
  await expect(specs).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
});

test("every empty required detail is marked and the first one is focused", async ({ page, flow }) => {
  await flow.reserve();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Discord username", exact: true })).toBeFocused();
  for (const name of ["Discord username", "Booking email", "PC specifications", "Main game or application"]) {
    await expect(page.getByRole("textbox", { name, exact: true })).toHaveAttribute("aria-invalid", "true");
  }
  await expect(page.getByRole("textbox", { name: "Extra booking requirements (optional)", exact: true })).not.toHaveAttribute("aria-invalid", "true");
});

test("continuing from a restored review with a blank detail returns to that field", async ({ page, flow }) => {
  await flow.review();
  await page.evaluate(() => {
    const draft = JSON.parse(sessionStorage.getItem("booking_draft"));
    for (const entry of Object.values(draft.packages)) if (entry?.form) entry.form.specs = "";
    sessionStorage.setItem("booking_draft", JSON.stringify(draft));
  });
  await page.reload();
  await page.getByRole("button", { name: "Continue to payment", exact: true }).click();
  const specs = page.getByRole("textbox", { name: "PC specifications", exact: true });
  await expect(specs).toBeFocused();
  await expect(specs).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
});

test("going back and reserving again does not keep stale marks", async ({ page, flow }) => {
  await flow.reserve();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  const discord = page.getByRole("textbox", { name: "Discord username", exact: true });
  await expect(discord).toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await expect(discord).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
  await expect(discord).not.toHaveAttribute("aria-invalid", "true");
  await expect(discord).not.toHaveAttribute("aria-describedby", "booking-details-error");
});
