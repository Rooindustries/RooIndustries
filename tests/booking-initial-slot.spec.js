const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, reducedMotion: "reduce", trace: process.env.CI ? "retain-on-failure" : "off" });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-11T12:00:00Z"));
});

const zones = [
  { timezoneId: "UTC", firstDay: "Monday, January 5", nextDay: "Tuesday, January 6", firstTime: "4:30 AM", secondTime: "5:30 AM" },
  { timezoneId: "America/Los_Angeles", firstDay: "Sunday, January 4", nextDay: "Monday, January 5", firstTime: "8:30 PM", secondTime: "9:30 PM" },
  { timezoneId: "Asia/Kolkata", firstDay: "Monday, January 5", nextDay: "Tuesday, January 6", firstTime: "10:00 AM", secondTime: "11:00 AM" },
];

const expectInitialDay = async (page, day, firstTime, secondTime) => {
  await expect(page.getByText(`Availability for ${day}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: firstTime, exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: secondTime, exact: true })).toBeEnabled();
  const hint = page.getByRole("button", { name: /^Earliest available:/ });
  await expect(hint).toContainText(firstTime);
  const initialHeading = await page.getByText(/^Availability for /).textContent();
  await hint.click();
  await expect(page.getByText(/^Availability for /)).toHaveText(initialHeading);
};

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const zone of zones) {
    test.describe(`${viewport.width}px ${zone.timezoneId}`, () => {
      test.use({ viewport, timezoneId: zone.timezoneId });

      test("initial day matches the earliest enabled slot", async ({ page, flow }) => {
        flow.state.slots = [{ date: "2099-01-05", times: ["10:00", "11:00"] }];
        await page.goto("/booking");
        await expectInitialDay(page, zone.firstDay, zone.firstTime, zone.secondTime);
      });

      test("initial day skips a fully booked day", async ({ page, flow }) => {
        flow.state.slots = [
          { date: "2099-01-05", times: ["10:00", "11:00"] },
          { date: "2099-01-06", times: ["10:00", "11:00"] },
        ];
        flow.state.bookedSlots = [
          { startTimeUTC: "2099-01-05T04:30:00.000Z" },
          { startTimeUTC: "2099-01-05T05:30:00.000Z" },
        ];
        await page.goto("/booking");
        await expectInitialDay(page, zone.nextDay, zone.firstTime, zone.secondTime);
      });
    });
  }

  test.describe(`${viewport.width}px DST`, () => {
    test.use({ viewport, timezoneId: "America/Los_Angeles" });

    test("initial day crosses spring-forward without selecting an empty preceding day", async ({ page, flow }) => {
      flow.state.slots = [{ date: "2027-03-14", times: ["15:00", "16:00"] }];
      await page.goto("/booking");
      await expectInitialDay(page, "Sunday, March 14", "1:30 AM", "3:30 AM");
    });

    test("initial day preserves both fall-back hours", async ({ page, flow }) => {
      flow.state.slots = [{ date: "2027-11-07", times: ["14:00", "15:00"] }];
      await page.goto("/booking");
      await expectInitialDay(page, "Sunday, November 7", "1:30 AM PDT", "1:30 AM PST");
    });
  });
}
