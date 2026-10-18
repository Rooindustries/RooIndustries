const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce", actionTimeout: 10000 });

const savedMessage = "We couldn't release this slot. Your reservation and details are still saved. Please try again.";
const paymentMessage = "This hold belongs to an active payment session.";
const savedReservation = page => page.evaluate(() => ({
  hold: JSON.parse(sessionStorage.getItem("my_slot_hold")),
  draft: JSON.parse(sessionStorage.getItem("booking_draft")),
}));
const banner = page => page.locator(".reservation-banner-surface");
const releaseButton = page => banner(page).getByRole("button", { name: "Release", exact: true });

const closeBooking = async page => {
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(banner(page)).toBeVisible();
};

const expectReadable = async (page, message) => {
  const alert = banner(page).getByRole("alert").filter({ hasText: message });
  await expect(alert).toBeVisible();
  await expect.poll(() => alert.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const parent = element.closest(".reservation-banner-surface").getBoundingClientRect();
    const scroller = element.closest(".booking-dialog-body");
    const viewport = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    const button = element.closest(".reservation-banner-surface").querySelector("button").getBoundingClientRect();
    return rect.top >= Math.max(parent.top, viewport.top) && rect.bottom <= Math.min(parent.bottom, viewport.bottom) &&
      rect.left >= 0 && rect.right <= innerWidth &&
      !(rect.left < button.right && rect.right > button.left && rect.top < button.bottom && rect.bottom > button.top);
  })).toBe(true);
};

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("release keeps the reservation and details when the server can't release it", async ({ page, flow }, info) => {
      await flow.reserve();
      await flow.details();
      await closeBooking(page);
      const original = await savedReservation(page);
      expect(original.draft.packages[original.draft.lastTitle].form.email).toBe("visitor@example.invalid");

      for (const failure of [500, "network", 409, 429]) {
        await page.route("**/api/releaseHold", route => failure === "network"
          ? route.abort("failed")
          : route.fulfill({ status: failure, json: { ok: false, message: failure === 409 ? paymentMessage : "Failed to release hold" } }));
        await releaseButton(page).click();
        expect(await savedReservation(page)).toEqual(original);
        const message = failure === 409 ? paymentMessage : savedMessage;
        await expectReadable(page, message);
        await page.waitForTimeout(5000);
        await expectReadable(page, message);
        expect(await savedReservation(page)).toEqual(original);
        await page.screenshot({ path: info.outputPath(`reservation-release-${failure}.png`) });
        await page.unroute("**/api/releaseHold");
      }
    });

    for (const status of [200, 400, 403, 404]) {
      test(status === 200 ? "release clears the reservation once the server confirms" : `release ${status} clears a definitively refused reservation`, async ({ page, flow }) => {
        await flow.reserve();
        await flow.details();
        await closeBooking(page);
        let respond;
        const response = new Promise(resolve => { respond = resolve; });
        const calls = [];
        await page.route("**/api/releaseHold", async route => {
          calls.push(route.request().postDataJSON());
          await response;
          await route.fulfill({ status, json: { ok: status === 200 } });
        });
        try {
          const original = await savedReservation(page);
          await releaseButton(page).click();
          await expect(banner(page).getByRole("button", { name: "Releasing...", exact: true })).toBeDisabled();
          expect(await savedReservation(page)).toEqual(original);
          expect(calls).toEqual([{ holdId: original.hold.holdId, holdToken: original.hold.holdToken }]);
          respond();
          await expect.poll(() => savedReservation(page)).toEqual({ hold: null, draft: null });
          await expect(banner(page)).toHaveCount(0);
          await expect(page).toHaveURL(url => url.pathname === "/");
        } finally {
          respond();
          await page.unroute("**/api/releaseHold");
        }
      });
    }

    test("a delayed release result leaves a refreshed reservation untouched", async ({ page, flow }) => {
      await flow.reserve();
      await flow.details();
      await closeBooking(page);
      for (const status of [200, 409]) {
        let respond;
        const response = new Promise(resolve => { respond = resolve; });
        await page.route("**/api/releaseHold", async route => {
          await response;
          await route.fulfill({ status, json: { ok: status === 200, message: paymentMessage } });
        });
        try {
          const original = await savedReservation(page);
          await releaseButton(page).click();
          await expect(banner(page).getByRole("button", { name: "Releasing...", exact: true })).toBeDisabled();
          const refreshed = { ...original.hold, holdToken: `${original.hold.holdToken}-refreshed` };
          await page.evaluate(hold => window.dispatchEvent(new CustomEvent("hold-state", { detail: hold })), refreshed);
          respond();
          await expect(releaseButton(page)).toBeEnabled();
          expect(await savedReservation(page)).toEqual({ ...original, hold: refreshed });
          await expect(banner(page).getByRole("alert")).toHaveCount(0);
        } finally {
          respond();
          await page.unroute("**/api/releaseHold");
        }
      }
    });

    test("continue booking is unavailable while a release is pending", async ({ page, flow }) => {
      await flow.reserve();
      await flow.details();
      await closeBooking(page);
      const original = await savedReservation(page);
      let respond;
      const response = new Promise(resolve => { respond = resolve; });
      await page.route("**/api/releaseHold", async route => {
        await response;
        await route.fulfill({ status: 200, json: { ok: true } });
      });
      try {
        await releaseButton(page).click();
        const continueButton = banner(page).getByRole("button", { name: "Continue booking", exact: true });
        await expect(continueButton).toBeDisabled({ timeout: 2000 });
        await continueButton.click({ force: true });
        await expect(page).toHaveURL(url => url.pathname === "/");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(await savedReservation(page)).toEqual(original);
        respond();
        await expect.poll(() => savedReservation(page)).toEqual({ hold: null, draft: null });
        await expect(banner(page)).toHaveCount(0);
      } finally {
        respond();
        await page.unrouteAll({ behavior: "wait" });
      }
    });

    test("a release that finishes after the customer resumed booking keeps their new details", async ({ page, flow }) => {
      await flow.reserve();
      await flow.details();
      await closeBooking(page);
      let respond;
      const response = new Promise(resolve => { respond = resolve; });
      await page.route("**/api/releaseHold", async route => {
        await response;
        await route.fulfill({ status: 200, json: { ok: true } });
      });
      try {
        await releaseButton(page).click();
        await expect(banner(page).getByRole("button", { name: "Releasing...", exact: true })).toBeDisabled();
        await page.locator('a[href="/booking"]').first().click();
        await expect(page).toHaveURL(url => url.pathname === "/booking");
        const email = page.getByRole("textbox", { name: "Booking email", exact: true });
        await expect(email).toBeVisible();
        await email.fill("updated@example.invalid");
        await expect.poll(async () => {
          const { draft } = await savedReservation(page);
          return draft?.packages?.[draft.lastTitle]?.form?.email;
        }).toBe("updated@example.invalid");
        respond();
        await expect.poll(async () => (await savedReservation(page)).hold).toBeNull();
        await page.waitForTimeout(1000);
        await expect(page).toHaveURL(url => url.pathname === "/booking");
        const { draft } = await savedReservation(page);
        expect(draft.packages[draft.lastTitle].form.email).toBe("updated@example.invalid");
      } finally {
        respond();
        await page.unrouteAll({ behavior: "wait" });
      }
    });

    test("a stalled release gives up and keeps the reservation", async ({ page, flow }, info) => {
      await page.clock.install();
      await flow.reserve();
      await flow.details();
      await closeBooking(page);
      await page.clock.pauseAt(new Date(Date.now() + 10000));
      const original = await savedReservation(page);
      flow.state.failures["/api/releaseHold"] = "timeout";
      await releaseButton(page).click();
      await expect.poll(() => flow.state.calls.filter(call => call.path === "/api/releaseHold").length).toBe(1);
      await page.clock.runFor(8100);
      await expectReadable(page, savedMessage);
      await expect(releaseButton(page)).toBeEnabled();
      await expect(banner(page).getByRole("button", { name: "Continue booking", exact: true })).toBeEnabled();
      expect(await savedReservation(page)).toEqual(original);
      await expect.poll(() => flow.state.aborted).toContain("/api/releaseHold");
      await page.screenshot({ path: info.outputPath("reservation-release-timeout.png"), animations: "disabled" });
      delete flow.state.failures["/api/releaseHold"];
      await releaseButton(page).click();
      await expect.poll(() => savedReservation(page)).toEqual({ hold: null, draft: null });
      await expect(banner(page)).toHaveCount(0);
      expect(flow.state.calls.filter(call => call.path === "/api/releaseHold")).toHaveLength(2);
    });

    test("the inline payment reservation keeps its release error readable", async ({ page, flow }, info) => {
      await flow.review();
      await flow.payment();
      const original = await savedReservation(page);
      await page.route("**/api/releaseHold", route => route.fulfill({ status: 500, json: { ok: false, message: "Failed to release hold" } }));
      await releaseButton(page).click();
      await expectReadable(page, savedMessage);
      await page.waitForTimeout(5000);
      await expectReadable(page, savedMessage);
      expect(await savedReservation(page)).toEqual(original);
      await page.screenshot({ path: info.outputPath("reservation-release-inline.png") });
    });
  });
}
