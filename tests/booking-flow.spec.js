const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", actionTimeout: 10000, navigationTimeout: 20000, trace: "off" });

test.afterEach(async ({ page, flow }, testInfo) => {
  const requests = testInfo.outputPath("requests.json");
  await fs.writeFile(requests, JSON.stringify({ calls: flow.state.calls, aborted: flow.state.aborted }, null, 2));
  await testInfo.attach("requests", { path: requests, contentType: "application/json" });
  const screenshot = testInfo.outputPath("booking-flow.png");
  await page.screenshot({ path: screenshot, fullPage: true, timeout: 10000 });
  await testInfo.attach("booking-flow", { path: screenshot, contentType: "image/png" });
});

const hold = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")));
const failureTypes = [429, 503, "non-json", "unknown", "network", "timeout"];

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    for (const failure of viewport.width === 1440 ? failureTypes : [503]) {
      test(`release ${failure} retains the reservation and details for retry`, async ({ page, flow }) => {
        await flow.reserve();
        await flow.details();
        const original = await hold(page);
        flow.state.failures["/api/releaseHold"] = failure;
        await page.getByRole("button", { name: "Release Slot", exact: true }).click();
        await expect(page.getByRole("alert").filter({ hasText: /could not release|couldn't release|unable to release/i })).toBeVisible({ timeout: 12000 });
        expect(await hold(page)).toEqual(original);
        await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("visitor@example.invalid");
        await page.reload();
        await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("visitor@example.invalid");
        delete flow.state.failures["/api/releaseHold"];
        await page.getByRole("button", { name: "Release Slot", exact: true }).click();
        await expect.poll(() => hold(page)).toBeNull();
        if (failure === 503 && viewport.width === 1440) {
          flow.state.holdMs = 3000;
          await flow.reserve();
          flow.state.failures["/api/releaseHold"] = 503;
          await expect.poll(() => hold(page), { timeout: 7000 }).toBeNull();
        }
      });
    }

    for (const releaseFailure of viewport.width === 1440 ? [503, "timeout"] : [503]) {
      test(`release ${releaseFailure} still replaces a slot using the previous credentials`, async ({ page, flow }) => {
        await flow.reserve();
        await flow.details();
        const original = await hold(page);
        flow.state.failures["/api/releaseHold"] = releaseFailure;
        await page.getByRole("button", { name: "Back", exact: true }).last().click();
        await page.getByRole("button", { name: "11:00 AM", exact: true }).click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("visitor@example.invalid", { timeout: 12000 });
        await expect.poll(async () => (await hold(page))?.startTimeUTC).not.toBe(original.startTimeUTC);
        const calls = flow.state.calls.filter(({ path }) => path === "/api/holdSlot");
        expect(calls).toHaveLength(2);
        expect(calls[1].body).toMatchObject({ previousHoldId: original.holdId, previousHoldToken: original.holdToken });
        expect((await hold(page)).holdId).not.toBe(original.holdId);
        await expect(page.getByRole("alert").filter({ hasText: /could not release/i })).toHaveCount(0);
      });
    }

    for (const status of [400, 409]) {
      test(`release ${status} clears a definitively refused hold`, async ({ page, flow }) => {
        await flow.reserve();
        flow.state.failures["/api/releaseHold"] = status;
        await page.getByRole("button", { name: "Release Slot", exact: true }).click();
        await expect.poll(() => hold(page)).toBeNull();
        await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveCount(0);
      });
    }

    test("same-slot payment pending keeps credentials and returns to details", async ({ page, flow }) => {
      await flow.reserve();
      await flow.details();
      const original = { ...await hold(page), phase: "payment_pending", packageTitle: "Vertex Essentials" };
      await page.evaluate((value) => sessionStorage.setItem("my_slot_hold", JSON.stringify(value)), original);
      flow.state.failures["/api/holdSlot"] = 409;
      await page.reload();
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      const callsBefore = flow.state.calls.filter(({ path }) => path === "/api/holdSlot").length;
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("visitor@example.invalid");
      await expect(page.getByRole("alert").filter({ hasText: /payment session is already in progress/i })).toBeVisible();
      expect(flow.state.calls.filter(({ path }) => path === "/api/holdSlot")).toHaveLength(callsBefore);
      expect(flow.state.calls.filter(({ path }) => path === "/api/releaseHold")).toHaveLength(0);
      expect(await hold(page)).toEqual(original);
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      await expect(page.getByRole("button", { name: "Return to payment", exact: true })).toBeVisible();
    });

    for (const failure of viewport.width === 1440 ? [429, 503, "non-json", "unknown"] : [503]) {
      test(`same-slot refresh ${failure} retains credentials for retry`, async ({ page, flow }) => {
        await flow.reserve();
        await flow.details();
        const original = await hold(page);
        flow.state.failures["/api/holdSlot"] = failure;
        await page.getByRole("button", { name: "Back", exact: true }).last().click();
        await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await expect(page.getByRole("alert").filter({ hasText: /could not reserve.*try again/i })).toBeVisible();
        expect(await hold(page)).toEqual(original);
        delete flow.state.failures["/api/holdSlot"];
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("visitor@example.invalid");
        await expect(page.getByRole("textbox", { name: "PC specifications", exact: true })).toHaveValue("Ryzen 7700 / RTX 4070");
        const calls = flow.state.calls.filter(({ path }) => path === "/api/holdSlot");
        expect(calls).toHaveLength(3);
        expect(calls[2].body).toMatchObject({ startTimeUTC: original.startTimeUTC, previousHoldId: original.holdId, previousHoldToken: original.holdToken });
        expect((await hold(page)).holdToken).not.toBe(original.holdToken);
      });
    }

    test("same-slot refresh 400 clears the refused hold", async ({ page, flow }) => {
      await flow.reserve();
      flow.state.failures["/api/holdSlot"] = 400;
      await page.getByRole("button", { name: "Back", exact: true }).last().click();
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect.poll(() => hold(page)).toBeNull();
      await expect(page.getByRole("alert").filter({ hasText: /slot was just taken/i })).toBeVisible();
    });

    test("confirmed release and replacement 409 clear the stored hold", async ({ page, flow }) => {
      await flow.reserve();
      const original = await hold(page);
      flow.state.failures["/api/holdSlot"] = 409;
      await page.getByRole("button", { name: "Back", exact: true }).last().click();
      await page.getByRole("button", { name: "11:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect(page.getByRole("alert").filter({ hasText: /slot was just taken/i })).toBeVisible();
      expect(await hold(page)).toBeNull();
      const calls = flow.state.calls.filter(({ path }) => path === "/api/holdSlot");
      expect(calls).toHaveLength(2);
      expect(calls[1].body).toMatchObject({ previousHoldId: original.holdId, previousHoldToken: original.holdToken });
      delete flow.state.failures["/api/holdSlot"];
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      expect((await hold(page)).holdToken).not.toBe(original.holdToken);
    });

    for (const holdFailure of viewport.width === 1440 ? [409, 400, 429, 503, "non-json", "unknown", "timeout"] : [409]) {
      test(`release timeout and replacement ${holdFailure} preserve the original slot`, async ({ page, flow }) => {
        await flow.reserve();
        await flow.details();
        const original = await hold(page);
        flow.state.bookedSlots = [{ startTimeUTC: original.startTimeUTC, isHold: true, holdId: original.holdId }];
        flow.state.failures["/api/releaseHold"] = "timeout";
        flow.state.failures["/api/holdSlot"] = holdFailure;
        await page.getByRole("button", { name: "Back", exact: true }).last().click();
        await page.getByRole("button", { name: "11:00 AM", exact: true }).click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await expect(page.getByRole("alert").filter({
          hasText: [400, 409].includes(holdFailure) ? /slot was just taken/i : /could not reserve/i,
        })).toBeVisible({ timeout: 20000 });
        expect(await hold(page)).toEqual(original);
        const calls = flow.state.calls.filter(({ path }) => path === "/api/holdSlot");
        expect(calls).toHaveLength(2);
        expect(calls[1].body).toMatchObject({ previousHoldId: original.holdId, previousHoldToken: original.holdToken });
        delete flow.state.failures["/api/holdSlot"];
        await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("visitor@example.invalid");
        await expect(page.getByRole("textbox", { name: "PC specifications", exact: true })).toHaveValue("Ryzen 7700 / RTX 4070");
        const refreshedCalls = flow.state.calls.filter(({ path }) => path === "/api/holdSlot");
        expect(refreshedCalls).toHaveLength(3);
        expect(refreshedCalls[2].body).toMatchObject({ startTimeUTC: original.startTimeUTC, previousHoldId: original.holdId, previousHoldToken: original.holdToken });
        expect(flow.state.calls.filter(({ path }) => path === "/api/releaseHold")).toHaveLength(1);
        const refreshed = await hold(page);
        expect(refreshed.holdId).toBe(original.holdId);
        expect(refreshed.holdToken).not.toBe(original.holdToken);
        await page.reload();
        await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("visitor@example.invalid");
        expect(await hold(page)).toEqual(refreshed);
        await page.getByRole("button", { name: "Back", exact: true }).last().click();
        await expect(page.getByRole("button", { name: "10:00 AM", exact: true })).toBeEnabled();
      });
    }

    for (const originalState of ["released", "taken"]) {
      test(`release timeout and replacement 409 revalidate the ${originalState} original slot`, async ({ page, flow }) => {
        await flow.reserve();
        await flow.details();
        const original = await hold(page);
        flow.state.failures["/api/releaseHold"] = "timeout";
        flow.state.failures["/api/holdSlot"] = 409;
        if (originalState === "released") {
          flow.state.holds.delete(original.startTimeUTC);
        } else {
          flow.state.holds.set(original.startTimeUTC, { holdId: "another-hold", holdToken: "another-token" });
        }
        await page.getByRole("button", { name: "Back", exact: true }).last().click();
        await page.getByRole("button", { name: "11:00 AM", exact: true }).click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await expect(page.getByRole("alert").filter({ hasText: /slot was just taken/i })).toBeVisible({ timeout: 12000 });
        expect(await hold(page)).toEqual(original);
        delete flow.state.failures["/api/holdSlot"];
        await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await expect.poll(() => flow.state.calls.filter(({ path }) => path === "/api/holdSlot").length).toBe(3);
        const calls = flow.state.calls.filter(({ path }) => path === "/api/holdSlot");
        expect(calls[2].body).toMatchObject({ startTimeUTC: original.startTimeUTC, previousHoldId: original.holdId, previousHoldToken: original.holdToken });
        expect(flow.state.calls.filter(({ path }) => path === "/api/releaseHold")).toHaveLength(1);
        if (originalState === "released") {
          await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("visitor@example.invalid");
          expect((await hold(page)).holdToken).not.toBe(original.holdToken);
        } else {
          await expect(page.getByRole("alert").filter({ hasText: "This slot is currently reserved by someone else." })).toBeVisible();
          expect(await hold(page)).toBeNull();
          await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveCount(0);
        }
      });
    }

    for (const failure of viewport.width === 1440 ? [503, "network", "timeout"] : ["timeout"]) {
      test(`code validation ${failure} is unavailable and allows full-price payment`, async ({ page, flow }) => {
        await flow.review();
        flow.state.failures["/api/ref/validateReferral"] = failure;
        await flow.codeInput("save20");
        await expect(page.getByRole("alert").filter({ hasText: /validation.*unavailable|unable to validate/i })).toBeVisible({ timeout: 20000 });
        await expect(page.getByRole("textbox", { name: "Referral or coupon code", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: /^Pay \$/ })).toBeEnabled();
        await flow.payment();
        await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
        const quote = flow.state.calls.find(({ path }) => path === "/api/payment/quote").body;
        expect(quote.couponCode || "").toBe("");
        expect(quote.referralCode || "").toBe("");
        await page.goto("/booking?ref=friend");
        await expect(page.getByRole("alert").filter({ hasText: /validation.*unavailable|unable to validate/i })).toBeVisible({ timeout: 20000 });
        await expect(page.getByRole("button", { name: /^Pay \$/ })).toBeEnabled();
      });
    }

    test("invalid referral with stalled coupon recovers and keeps referral-first collisions", async ({ page, flow }) => {
      await flow.review();
      flow.state.failures["/api/ref/validateCoupon"] = "timeout";
      await flow.codeInput("unknown");
      await expect(page.getByRole("alert").filter({ hasText: /validation.*unavailable|unable to validate/i })).toBeVisible({ timeout: 20000 });
      delete flow.state.failures["/api/ref/validateCoupon"];
      await flow.codeInput("expired");
      await expect(page.getByRole("alert").filter({ hasText: "This coupon has expired." })).toBeVisible();
      await flow.codeInput("unknown");
      await expect(page.getByRole("alert").filter({ hasText: "Invalid referral or coupon code." })).toBeVisible();
      flow.state.collision = true;
      await flow.codeInput("  FrIeNd  ");
      await expect(page.getByRole("button", { name: /^Pay \$/ })).toBeEnabled();
      await flow.payment();
      await expect.poll(() => flow.state.calls.filter(({ path }) => path === "/api/payment/quote").length).toBeGreaterThan(0);
      const quote = flow.state.calls.filter(({ path }) => path === "/api/payment/quote").at(-1).body;
      expect(quote.referralCode).toBe("friend");
      expect(quote.couponCode || "").toBe("");
      flow.state.failures["/api/ref/validateReferral"] = 503;
      await page.goto("/booking");
      await expect(page.getByRole("alert").filter({ hasText: /validation.*unavailable|unable to validate/i })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Pay \$/ })).toBeEnabled();
    });

    for (const stalled of ["coupon", "referral"]) {
      test(`${stalled === "coupon" ? "valid referral wins over a stalled coupon" : "stalled referral blocks a valid coupon"}`, async ({ page, flow }) => {
        await flow.review();
        flow.state.collision = true;
        flow.state.failures[stalled === "coupon" ? "/api/ref/validateCoupon" : "/api/ref/validateReferral"] = "timeout";
        await flow.codeInput("friend");
        if (stalled === "coupon") {
          await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible({ timeout: 20000 });
          await expect(page.getByRole("button", { name: /^Remove coupon code/ })).toHaveCount(0);
        } else {
          await expect(page.getByRole("alert").filter({ hasText: /validation.*unavailable/i })).toBeVisible({ timeout: 20000 });
          await expect(page.getByRole("button", { name: /^Remove (referral|coupon) code/ })).toHaveCount(0);
          await expect(page.getByRole("textbox", { name: "Referral or coupon code", exact: true })).toBeEnabled();
        }
        await expect(page.getByRole("button", { name: /^Pay \$/ })).toBeEnabled();
        await flow.payment();
        await expect.poll(() => flow.state.calls.filter(({ path }) => path === "/api/payment/quote").length).toBeGreaterThan(0);
        const quote = flow.state.calls.filter(({ path }) => path === "/api/payment/quote").at(-1).body;
        expect(quote.referralCode || "").toBe(stalled === "coupon" ? "friend" : "");
        expect(quote.couponCode || "").toBe("");
      });
    }

    for (const failure of viewport.width === 1440 ? [400, 503, "network"] : [503]) {
      test(`quote ${failure} keeps an actionable error until a successful retry`, async ({ page, flow }) => {
        await flow.review();
        flow.state.failures["/api/payment/quote"] = failure;
        await flow.payment();
        const retry = page.getByRole("button", { name: "Retry price check", exact: true });
        await expect(retry).toBeVisible();
        await page.waitForTimeout(4500);
        await expect(retry).toBeVisible();
        if (typeof failure === "number") {
          await expect(page.getByRole("alert").filter({ hasText: "Fixture request rejected." })).toBeVisible();
        }
        await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeDisabled();
        flow.state.failures["/api/payment/quote"] = "timeout";
        await retry.click();
        await expect(page.getByRole("alert").filter({ hasText: /too long|timed out/i })).toBeVisible({ timeout: 20000 });
        await expect(retry).toBeVisible();
        delete flow.state.failures["/api/payment/quote"];
        await retry.click();
        await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
      });
    }

    test("malformed email stays on details with an associated focused error", async ({ page, flow }) => {
      await flow.reserve();
      await flow.details("not-an-email");
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      const input = page.getByRole("textbox", { name: "Booking email", exact: true });
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(input).toHaveAccessibleDescription(/valid email/i);
      await input.fill("  visitor@example.invalid  ");
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      await flow.payment();
      await expect.poll(() => flow.state.calls.filter(({ path }) => path === "/api/payment/quote").length).toBeGreaterThan(0);
      expect(flow.state.calls.find(({ path }) => path === "/api/payment/quote").body.email).toBe("visitor@example.invalid");
    });

    test("upgrade link failure retries in place without losing inputs", async ({ page, flow }) => {
      flow.state.failures["/api/content/upgrade-link"] = 503;
      await page.goto("/upgrade/max");
      const retry = page.getByRole("button", { name: "Retry", exact: true });
      await expect(retry).toBeVisible();
      await page.locator("input[type=email]").fill("visitor@example.invalid");
      await page.getByPlaceholder("e.g. 1a2b3c4d5e6f7g8h9i", { exact: true }).fill("fixture-order");
      flow.state.failures["/api/content/upgrade-link"] = "timeout";
      await retry.click();
      await expect(page.getByText("Loading upgrade link...", { exact: true })).toBeVisible();
      await expect(retry).toBeVisible({ timeout: 20000 });
      await expect(page.locator("input[type=email]")).toHaveValue("visitor@example.invalid");
      delete flow.state.failures["/api/content/upgrade-link"];
      await retry.click();
      await expect(page.getByText("Fixture upgrade", { exact: true })).toBeVisible();
      await expect(page.locator("input[type=email]")).toHaveValue("visitor@example.invalid");
      await expect(page.getByPlaceholder("e.g. 1a2b3c4d5e6f7g8h9i", { exact: true })).toHaveValue("fixture-order");
      flow.state.failures["/api/content/upgrade-link"] = "timeout";
      await page.reload();
      await expect(page.getByText("Loading upgrade link...", { exact: true })).toBeVisible();
      const aborted = flow.state.aborted.filter((path) => path === "/api/content/upgrade-link").length;
      await page.getByRole("link", { name: "Go to Roo Industries home", exact: true }).click();
      await expect.poll(() => flow.state.aborted.filter((path) => path === "/api/content/upgrade-link").length).toBeGreaterThan(aborted);
    });

    for (const route of ["/upgrade/max", "/upgrade-xoc"]) {
      test(`${route} eligibility timeout recovers without stale input results`, async ({ page, flow }) => {
        await flow.upgrade(route);
        flow.state.failures["/api/ref/getUpgradeInfo"] = "timeout";
        const check = page.getByRole("button", { name: "Check eligibility", exact: true });
        await check.click();
        await expect(check).toBeEnabled({ timeout: 20000 });
        await expect(page.getByText(/went wrong while checking/)).toBeVisible();
        delete flow.state.failures["/api/ref/getUpgradeInfo"];
        await check.click();
        await expect(page.getByRole("heading", { name: "Upgrade Summary", exact: true })).toBeVisible();
        await page.locator("input[type=email]").fill("changed@example.invalid");
        await expect(page.getByRole("button", { name: "Proceed to Payment", exact: true })).toHaveCount(0);
        flow.state.failures["/api/ref/getUpgradeInfo"] = "timeout";
        await check.click();
        await expect(page.getByRole("button", { name: "Checking...", exact: true })).toBeDisabled();
        const aborted = flow.state.aborted.filter((path) => path === "/api/ref/getUpgradeInfo").length;
        await page.getByRole("link", { name: "Go to Roo Industries home", exact: true }).click();
        await expect.poll(() => flow.state.aborted.filter((path) => path === "/api/ref/getUpgradeInfo").length).toBeGreaterThan(aborted);
      });
    }

    test("upgrade labels activate their own inputs", async ({ page, flow }) => {
      await flow.upgrade();
      await page.getByText("Enter your Order ID", { exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Enter your Order ID", exact: true })).toBeFocused();
      await page.getByText("Booking email", { exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeFocused();
    });

    test("checkout timeout gives a manual retry without a second start", async ({ page, flow }) => {
      await flow.review();
      await flow.payment();
      const pay = page.getByRole("button", { name: "Pay your way", exact: true });
      await expect(pay).toBeEnabled();
      flow.state.failures["/api/payment/start"] = "timeout";
      await pay.click();
      await expect(page.getByRole("alert").filter({ hasText: /checkout.*timed out.*try again/i })).toBeVisible({ timeout: 20000 });
      await expect(pay).toBeEnabled();
      expect(flow.state.calls.filter(({ path }) => path === "/api/payment/start")).toHaveLength(1);
      delete flow.state.failures["/api/payment/start"];
      await pay.dblclick();
      await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
      expect(flow.state.calls.filter(({ path }) => path === "/api/payment/start")).toHaveLength(2);
    });
  });
}

test.describe("daylight saving time", () => {
  test.use({ timezoneId: "America/New_York" });
  test("repeated local times keep distinct zone labels through review and reload", async ({ page, flow }, testInfo) => {
    const year = new Date().getFullYear() + 1;
    const first = new Date(Date.UTC(year, 10, 1));
    first.setUTCDate(1 + (7 - first.getUTCDay()) % 7);
    flow.state.slots = [{ date: first.toISOString().slice(0, 10), times: ["11:00", "12:00"] }];
    await flow.booking();
    const edt = page.getByRole("button", { name: "1:30 AM EDT", exact: true });
    const est = page.getByRole("button", { name: "1:30 AM EST", exact: true });
    await expect(edt).toBeVisible();
    await expect(est).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("dst-slots.png"), fullPage: true });
    await est.click();
    await page.getByRole("button", { name: "Next", exact: true }).last().click();
    await expect(page.getByText(/Slot 1:30 AM EST is reserved/)).toBeVisible();
    await flow.details();
    await page.getByRole("button", { name: "Review before payment", exact: true }).click();
    await expect(page.getByText(/1:30 AM EST \(America\/New_York\)/)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/Slot 1:30 AM EST is reserved/)).toBeVisible();
    await flow.payment();
    expect((await hold(page)).startTimeUTC).toBe(`${first.toISOString().slice(0, 10)}T06:30:00.000Z`);
    const booking = await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state")));
    expect(booking.displayTime).toBe("1:30 AM EST");
  });
});
