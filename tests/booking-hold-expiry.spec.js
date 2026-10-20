const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

const expiredMessage = "The reservation expired. Please choose a slot again.";
const holdLifetime = 21 * 60 * 1000;

const storedHold = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold") || "null"));
const draftEmail = page => page.evaluate(() => {
  const draft = JSON.parse(sessionStorage.getItem("booking_draft") || "null");
  return Object.values(draft?.packages || {}).map(entry => entry?.form?.email).find(Boolean) || null;
});

test("expiry on the details step keeps the booking open with the typed details", async ({ page, flow }) => {
  await page.clock.install();
  await flow.reserve();
  await flow.details();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
  await page.clock.fastForward(holdLifetime);
  await expect(page.getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible();
  await expect(page).toHaveURL(/\/booking$/);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "10:00 AM", exact: true })).toBeVisible();
  expect(await storedHold(page)).toBeNull();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
});

test("expiry on the payment page returns to slot selection with the reason", async ({ page, flow }) => {
  await page.clock.install();
  await flow.review();
  await flow.payment();
  await page.clock.fastForward(holdLifetime);
  await expect(page).toHaveURL(/\/booking$/);
  await expect(page.getByRole("alert").filter({ hasText: expiredMessage })).toBeVisible();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await storedHold(page)).toBeNull();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
});

test("same-tab payment expiry on the booking step stays in the booking flow", async ({ page, flow }) => {
  await page.clock.install();
  await flow.reserve();
  await flow.details();
  const original = { ...await storedHold(page), phase: "payment_pending" };
  await page.evaluate(value => sessionStorage.setItem("my_slot_hold", JSON.stringify(value)), original);
  await page.reload();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.clock.fastForward(holdLifetime);
  await page.clock.runFor(2000);
  await expect(page).toHaveURL(/\/booking$/);
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await storedHold(page)).toMatchObject({ holdId: original.holdId, phase: "payment_pending" });
});

test("expiry away from the booking flow clears the reservation without moving the visitor", async ({ page, flow }) => {
  await page.clock.install();
  await flow.reserve();
  await flow.details();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const continueBooking = page.getByRole("button", { name: "Continue booking", exact: true });
  await expect(continueBooking).toBeVisible();
  const url = page.url();
  await page.clock.fastForward(holdLifetime);
  await expect(continueBooking).toHaveCount(0);
  expect(page.url()).toBe(url);
  expect(await storedHold(page)).toBeNull();
  expect(await draftEmail(page)).toBe("visitor@example.invalid");
});
