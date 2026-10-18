const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce", actionTimeout: 10000 });

const storedState = page => page.evaluate(() => ({
  selection: JSON.parse(sessionStorage.getItem("booking_modal_state")),
  hold: JSON.parse(sessionStorage.getItem("my_slot_hold")),
}));

const record = async (page, info, name, requests) => {
  await page.screenshot({ path: info.outputPath(`${name}.png`), animations: "disabled" });
  const state = await storedState(page);
  const path = info.outputPath(`${name}.json`);
  await fs.writeFile(path, JSON.stringify({ ...state, requests }, null, 2));
  await info.attach(name, { path, contentType: "application/json" });
  return state;
};

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    for (const status of [200, 409]) {
      test(status === 200 ? "a slot can't be changed while it is being reserved" : "a reservation conflict while pending doesn't clear a newer choice", async ({ page, flow }, info) => {
        await flow.booking();
        const first = page.getByRole("button", { name: "10:00 AM", exact: true });
        const second = page.getByRole("button", { name: "11:00 AM", exact: true });
        const dayNumber = Number(flow.state.slots[0].date.slice(-2));
        const day = page.locator(".booking-calendar-grid button").filter({ hasText: new RegExp(`^${dayNumber}$`) });
        const earliest = page.getByRole("button", { name: /^Earliest available:/ });
        const plan = page.getByRole("button", { name: "View My Plan", exact: true });
        const controls = [first, second, day, earliest, plan,
          page.getByRole("button", { name: "Previous month", exact: true }),
          page.getByRole("button", { name: "Next month", exact: true })];
        for (const control of controls) await expect(control).toBeEnabled();
        await first.click();
        const expectedStart = new Date(`${flow.state.slots[0].date}T10:00:00+05:30`).toISOString();
        const requests = [];
        let respond;
        let completed;
        const response = new Promise(resolve => { respond = resolve; });
        await page.route("**/api/holdSlot", async route => {
          requests.push(route.request().postDataJSON());
          await response;
          if (status === 200) await route.fallback();
          else await route.fulfill({ status, json: { ok: false, message: "This slot is already booked." } });
        });
        try {
          await page.getByRole("button", { name: "Next", exact: true }).last().click();
          await expect.poll(() => requests.length).toBe(1);
          completed = page.waitForResponse("**/api/holdSlot", { timeout: 10000 }).then(response => response.finished()).catch(() => {});
          await second.click({ force: true });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const pending = await record(page, info, "slot-reservation-pending", requests);
          expect(pending.selection.selectedSlot.localLabel).toBe("10:00 AM");
          expect(pending.selection.selectedSlot.utcStart).toBe(expectedStart);
          for (const control of controls) await expect(control).toBeDisabled({ timeout: 1000 });
          expect(requests).toHaveLength(1);
          expect(requests[0].startTimeUTC).toBe(expectedStart);
          respond();

          if (status === 200) {
            await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
            await expect(page.getByRole("dialog").getByText("10:00 AM", { exact: true })).toBeVisible();
            expect((await storedState(page)).hold.startTimeUTC).toBe(expectedStart);
            await record(page, info, "slot-reservation-details", requests);
            await page.getByRole("button", { name: "Back", exact: true }).last().click();
            await expect(second).toBeVisible();
            await expect.poll(() => storedState(page).then(state => state.selection.selectedSlot?.utcStart)).toBe(expectedStart);
          } else {
            await expect(page.getByRole("alert").filter({ hasText: "This slot is already booked." })).toBeVisible();
            await expect.poll(() => storedState(page).then(state => state.selection.selectedSlot)).toBeNull();
            expect((await storedState(page)).hold).toBeNull();
            await expect(page.getByRole("button", { name: "Next", exact: true }).last()).toHaveAttribute("aria-disabled", "true");
            await expect(second).toBeEnabled();
            await second.click();
            await expect.poll(() => storedState(page).then(state => state.selection.selectedSlot?.localLabel)).toBe("11:00 AM");
          }
          for (const control of controls) await expect(control).toBeEnabled();
          expect(requests).toHaveLength(1);
          await record(page, info, "slot-reservation-outcome", requests);
        } finally {
          respond();
          await completed;
          await page.unrouteAll({ behavior: "wait" });
        }
      });
    }
  });
}
