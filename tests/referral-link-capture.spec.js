const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", viewport: { width: 390, height: 844 } });

const storedReferral = page => page.evaluate(() => sessionStorage.getItem("referral_session"));

for (const landing of ["/?ref=friend", "/reviews?ref=friend", "/tourney?ref=friend"]) {
  test(`a creator link to ${landing.split("?")[0]} keeps the code for a booking started elsewhere`, async ({ page, flow }) => {
    await page.goto(landing);
    await expect.poll(() => storedReferral(page)).toBe("friend");
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await flow.review();
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
  });
}

for (const [start, previous, target] of [
  ["/tourney?ref=oldercreator", "oldercreator", "/reviews?ref=friend"],
  ["/tourney", null, "/about?ref=friend"],
]) {
  test(`an in-site move from ${start} to ${target} credits the new creator`, async ({ page, flow }) => {
    await page.goto(start);
    await page.waitForFunction(() => Boolean(window.next?.router));
    await expect.poll(() => storedReferral(page)).toBe(previous);
    await page.evaluate(href => window.next.router.push(href), target);
    await expect(page).toHaveURL(new RegExp(`${target.split("?")[0]}(\\?|$)`));
    await expect.poll(() => storedReferral(page)).toBe("friend");
    await flow.review();
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
  });
}

test("Back over an in-site move keeps the newest code, and a later in-site creator link still credits", async ({ page }) => {
  await page.goto("/tourney?ref=oldercreator");
  await page.waitForFunction(() => Boolean(window.next?.router));
  await expect.poll(() => storedReferral(page)).toBe("oldercreator");
  await page.evaluate(() => window.next.router.push("/reviews?ref=friend"));
  await expect(page).toHaveURL(/\/reviews(\?|$)/);
  await expect.poll(() => storedReferral(page)).toBe("friend");
  await page.goBack();
  await expect(page).toHaveURL(/\/tourney\?ref=oldercreator$/);
  await page.waitForTimeout(1000);
  expect(await storedReferral(page)).toBe("friend");
  await page.evaluate(() => window.next.router.push("/about?ref=latest"));
  await expect(page).toHaveURL(/\/about(\?|$)/);
  await expect.poll(() => storedReferral(page)).toBe("latest");
});

const lastQuote = flow => flow.state.calls.filter(call => call.path === "/api/payment/quote").at(-1);

for (const storageBlocked of [false, true]) {
  test(`a referral removed on payment stays removed after reload and can be manually reapplied${storageBlocked ? " with session storage blocked" : ""}`, async ({ page, flow }, testInfo) => {
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push({ name: error.name, message: error.message, stack: error.stack }));
    try {
      await page.goto("/?ref=friend");
      await expect.poll(() => storedReferral(page)).toBe("friend");
      await page.locator(".ri-package-book-button").first().click();
      await expect(page).toHaveURL(/\/booking$/);
      await page.getByRole("button", { name: /^Earliest available:/ }).click();
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await flow.details();
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
      await flow.payment();
      await expect.poll(() => lastQuote(flow)?.body.referralCode).toBe("friend");

      const referralInput = page.getByRole("textbox", { name: "Referral Code (optional)", exact: true });
      const applyReferral = referralInput.locator("..").getByRole("button", { name: "Apply", exact: true });
      await expect(referralInput).toHaveValue("friend");
      await referralInput.fill("");
      await applyReferral.click();
      await expect.poll(() => storedReferral(page)).toBeNull();
      await expect.poll(() => lastQuote(flow)?.body.referralCode).toBe("");

      if (storageBlocked) {
        const navigationState = await page.evaluate(() => window.history.state);
        await testInfo.attach("payment-navigation-before-storage-denial", {
          body: JSON.stringify(navigationState, null, 2), contentType: "application/json",
        });
        expect(navigationState?.usr?.bookingData?.referralCode).toBe("friend");
        await page.addInitScript(() => {
          Object.defineProperty(window, "sessionStorage", {
            configurable: true,
            get() { throw new DOMException("Storage access denied", "SecurityError"); },
          });
        });
      }

      const callsBeforeReload = flow.state.calls.length;
      await page.reload();
      if (storageBlocked) {
        expect(await page.evaluate(() => {
          try {
            void window.sessionStorage;
            return null;
          } catch (error) {
            return { name: error.name, message: error.message };
          }
        })).toEqual({ name: "SecurityError", message: "Storage access denied" });
      }
      await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
      await expect.poll(() => flow.state.calls.slice(callsBeforeReload).some(call => call.path === "/api/payment/quote")).toBe(true);
      await expect(referralInput).toBeEnabled();
      await expect(referralInput).toHaveValue("");
      if (!storageBlocked) await expect.poll(() => storedReferral(page)).toBeNull();
      await expect.poll(() => lastQuote(flow)?.body.referralCode).toBe("");

      const callsBeforeApply = flow.state.calls.length;
      await referralInput.fill("friend");
      await applyReferral.click();
      await expect.poll(() => flow.state.calls.slice(callsBeforeApply).some(call =>
        call.path === "/api/ref/validateReferral" && new URLSearchParams(call.query).get("code") === "friend"
      )).toBe(true);
      if (!storageBlocked) {
        await expect.poll(() => storedReferral(page)).toBe("friend");
        await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_dismissed"))).toBeNull();
      }
      await expect(referralInput).toHaveValue("friend");
      await expect.poll(() => flow.state.calls.slice(callsBeforeApply).some(call => call.path === "/api/payment/quote")).toBe(true);
      await expect.poll(() => lastQuote(flow)?.body.referralCode).toBe("friend");
      if (storageBlocked) expect(pageErrors).toEqual([]);
    } finally {
      await testInfo.attach("payment-page-errors", {
        body: JSON.stringify(pageErrors, null, 2), contentType: "application/json",
      });
    }
  });
}

test("a removed code stays out of the payment quote when the booking address changes", async ({ page, flow }) => {
  await page.goto("/booking?ref=friend");
  await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await flow.details();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await page.getByRole("button", { name: "Remove referral code friend", exact: true }).click();
  await expect.poll(() => storedReferral(page)).toBeNull();
  await page.evaluate(() => window.next.router.replace("/booking?ref=friend&utm_source=review"));
  await expect(page).toHaveURL(/utm_source=review/);
  await page.waitForTimeout(500);
  expect(await storedReferral(page)).toBeNull();
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toHaveCount(0);
  await flow.payment();
  await expect.poll(() => lastQuote(flow)).toBeTruthy();
  await page.waitForTimeout(500);
  expect(lastQuote(flow).body.referralCode || "").toBe("");
});

test("a code removed in booking stays removed after closing back to the creator link and paying", async ({ page, flow }) => {
  await page.goto("/?ref=friend");
  await expect.poll(() => storedReferral(page)).toBe("friend");
  await page.locator(".ri-package-book-button").first().click();
  await expect(page).toHaveURL(/\/booking$/);
  await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await flow.details();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await page.getByRole("button", { name: "Remove referral code friend", exact: true }).click();
  await expect.poll(() => storedReferral(page)).toBeNull();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/\/\?ref=friend$/);
  await page.waitForTimeout(500);
  expect(await storedReferral(page)).toBeNull();
  await page.locator(".ri-package-book-button").first().click();
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toHaveCount(0);
  await flow.payment();
  await expect.poll(() => lastQuote(flow)).toBeTruthy();
  await page.waitForTimeout(500);
  expect(lastQuote(flow).body.referralCode || "").toBe("");
});

test("a creator link opened again after its code was removed stays removed", async ({ page, flow }) => {
  await page.goto("/reviews?ref=friend");
  await expect.poll(() => storedReferral(page)).toBe("friend");
  await flow.review();
  await page.getByRole("button", { name: "Remove referral code friend", exact: true }).click();
  await expect.poll(() => storedReferral(page)).toBeNull();
  await page.goto("/reviews?ref=friend");
  await page.waitForFunction(() => Boolean(window.next?.router));
  await page.waitForTimeout(500);
  expect(await storedReferral(page)).toBeNull();
  await page.goto("/booking");
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toHaveCount(0);
});

test("a removed creator code preserves a different creator on booking reopen and payment", async ({ page, flow }) => {
  await page.goto("/?ref=friend");
  await expect.poll(() => storedReferral(page)).toBe("friend");
  await page.locator(".ri-package-book-button").first().click();
  await expect(page).toHaveURL(/\/booking$/);
  await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await flow.details();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await page.getByRole("button", { name: "Remove referral code friend", exact: true }).click();
  await expect.poll(() => storedReferral(page)).toBeNull();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/\/\?ref=friend$/);
  flow.state.collision = true;
  await page.evaluate(() => window.next.router.push("/reviews?ref=save20"));
  await expect(page).toHaveURL(/\/reviews(\?|$)/);
  await expect.poll(() => storedReferral(page)).toBe("save20");
  await page.goto("/booking");
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove referral code save20", exact: true })).toBeVisible();
  await expect.poll(() => storedReferral(page)).toBe("save20");
  await flow.payment();
  await expect.poll(() => lastQuote(flow)?.body.referralCode).toBe("save20");
});

test("a second tab starts without the first tab's creator code", async ({ page }) => {
  await page.goto("/reviews?ref=friend");
  await expect.poll(() => storedReferral(page)).toBe("friend");
  const second = await page.context().newPage();
  await second.goto("/packages");
  await expect(second.locator(".ri-package-card").first()).toBeVisible();
  expect(await storedReferral(second)).toBeNull();
  await second.close();
});

test("a referral removed in the booking dialog stays removed", async ({ page, flow }) => {
  await page.goto("/booking?ref=friend");
  await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await flow.details();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await page.getByRole("button", { name: "Remove referral code friend", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toHaveCount(0);
  await expect.poll(() => storedReferral(page)).toBeNull();
});

test("a code applied in booking survives closing back to another creator's link", async ({ page, flow }) => {
  await page.goto("/?ref=oldercreator");
  await expect.poll(() => storedReferral(page)).toBe("oldercreator");
  await page.locator(".ri-package-book-button").first().click();
  await expect(page).toHaveURL(/\/booking$/);
  await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await flow.details();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Referral or coupon code", exact: true })).toBeVisible();
  await flow.codeInput("friend");
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
  await expect.poll(() => storedReferral(page)).toBe("friend");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/\/\?ref=oldercreator$/);
  await page.waitForTimeout(500);
  expect(await storedReferral(page)).toBe("friend");
});
