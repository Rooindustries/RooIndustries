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
        await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("referral_dismissed"))?.friend)).toBe("applied");
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

const quoteCalls = (flow, since) => flow.state.calls.slice(since).filter(call => call.path === "/api/payment/quote");
const waitQuote = async (flow, code, since) => {
  await expect.poll(() => quoteCalls(flow, since).at(-1)?.body.referralCode).toBe(code);
};
const referralLookups = (flow, since, code) => flow.state.calls.slice(since).filter(call =>
  call.path === "/api/ref/validateReferral" && new URLSearchParams(call.query).get("code").trim().toLowerCase() === code
);
const referralIntent = page => page.evaluate(() => ({
  passive: sessionStorage.getItem("referral_session"),
  journal: sessionStorage.getItem("referral_dismissed"),
}));
const attachJson = (testInfo, name, value) => testInfo.attach(name, {
  body: JSON.stringify(value, null, 2), contentType: "application/json",
});
const reserveAndReview = async (page, flow) => {
  await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await flow.details();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
};
const startFriendPayment = async (page, flow) => {
  await page.goto("/booking?ref=friend");
  await reserveAndReview(page, flow);
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
  const since = flow.state.calls.length;
  await flow.payment();
  await waitQuote(flow, "friend", since);
};
const paymentCode = (page, type = "Referral") => page.getByRole("textbox", { name: `${type} Code (optional)`, exact: true });
const submitPaymentCode = async (page, code, type = "Referral") => {
  const input = paymentCode(page, type);
  await expect(input).toBeEnabled();
  await input.fill(code);
  await input.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
};
const fillSessionQuota = page => page.evaluate(() => {
  let low = 0;
  let high = 8 * 1024 * 1024;
  const key = "roo-referral-quota";
  const text = "x".repeat(high);
  let exception;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    try {
      sessionStorage.setItem(key, text.slice(0, middle));
      low = middle;
    } catch (error) {
      exception = error.name;
      high = middle - 1;
    }
  }
  let extraCharacterError;
  try { sessionStorage.setItem(key, text.slice(0, low + 1)); }
  catch (error) { extraCharacterError = error.name; }
  let characters = 0;
  for (let index = 0; index < sessionStorage.length; index++) {
    const storedKey = sessionStorage.key(index);
    characters += storedKey.length + sessionStorage.getItem(storedKey).length;
  }
  return {
    fillerCharacters: low, bytes: characters * 2, exception, extraCharacterError,
    passive: sessionStorage.getItem("referral_session"), journal: sessionStorage.getItem("referral_dismissed"),
  };
});
const storageError = "Couldn't save this code change. Please try again.";

for (const fromHistory of [false, true]) {
  test(`a fresh creator follow after ${fromHistory ? "history" : "manual replacement"} and a no-ref page captures the same code`, async ({ page, flow }, testInfo) => {
    flow.state.collision = true;
    await page.goto(fromHistory ? "/tourney?ref=friend" : "/?ref=friend");
    await page.waitForFunction(() => Boolean(window.next?.router));
    await expect.poll(() => storedReferral(page)).toBe("friend");
    if (fromHistory) {
      await page.evaluate(() => window.next.router.push("/about?ref=save20"));
      await expect.poll(() => storedReferral(page)).toBe("save20");
      await page.goBack();
      await expect(page).toHaveURL(/\/tourney\?ref=friend$/);
    } else {
      await page.locator(".ri-package-book-button").first().click();
      await reserveAndReview(page, flow);
      await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
      await flow.codeInput("save20");
      await expect(page.getByRole("button", { name: "Remove referral code save20", exact: true })).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      await expect(page).toHaveURL(/\/\?ref=friend$/);
    }
    await page.waitForTimeout(500);
    expect(await storedReferral(page)).toBe("save20");
    await page.evaluate(() => window.next.router.push("/tourney"));
    await expect(page).toHaveURL(/\/tourney$/);
    await page.waitForTimeout(400);
    await page.evaluate(href => window.next.router.push(href), fromHistory ? "/reviews?ref=friend" : "/about?ref=friend");
    await expect(page).toHaveURL(fromHistory ? /\/reviews(\?|$)/ : /\/about(\?|$)/);
    try {
      await expect.poll(() => storedReferral(page)).toBe("friend");
    } finally {
      await attachJson(testInfo, "fresh-follow-intent", await referralIntent(page));
    }
  });
}

test("home history preserves the newer creator through packages remount and a new payment quote", async ({ page, flow }, testInfo) => {
  flow.state.collision = true;
  await page.goto("/?ref=friend");
  await page.waitForFunction(() => Boolean(window.next?.router));
  await expect(page.locator(".ri-package-book-button").first()).toBeVisible();
  await expect.poll(() => storedReferral(page)).toBe("friend");
  await page.evaluate(() => window.next.router.push("/tourney?ref=save20"));
  await expect.poll(() => storedReferral(page)).toBe("save20");
  await page.goBack();
  await expect(page).toHaveURL(/\/\?ref=friend$/);
  await expect(page.locator(".ri-package-book-button").first()).toBeVisible();
  await page.waitForTimeout(700);
  const afterBack = await referralIntent(page);
  await page.locator(".ri-package-book-button").first().click();
  await reserveAndReview(page, flow);
  const since = flow.state.calls.length;
  await flow.payment();
  await expect.poll(() => quoteCalls(flow, since).length).toBeGreaterThan(0);
  await attachJson(testInfo, "home-history-payment", { afterBack, quotes: quoteCalls(flow, since) });
  expect(afterBack.passive).toBe("save20");
  await waitQuote(flow, "save20", since);
});

test("a payment removal also stays removed on Back into the booking draft", async ({ page, flow }, testInfo) => {
  await startFriendPayment(page, flow);
  let since = flow.state.calls.length;
  await submitPaymentCode(page, "");
  await waitQuote(flow, "", since);
  await expect.poll(() => storedReferral(page)).toBeNull();
  const beforeBack = flow.state.calls.length;
  await page.goBack();
  await expect(page).toHaveURL(/\/booking\?ref=friend$/);
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  const afterBack = await referralIntent(page);
  const removeCount = await page.getByRole("button", { name: "Remove referral code friend", exact: true }).count();
  const backCalls = flow.state.calls.slice(beforeBack);
  since = flow.state.calls.length;
  await flow.payment();
  await expect.poll(() => quoteCalls(flow, since).length).toBeGreaterThan(0);
  await attachJson(testInfo, "payment-removal-back", { afterBack, removeCount, backCalls, quotes: quoteCalls(flow, since) });
  expect(removeCount).toBe(0);
  expect(afterBack.passive).toBeNull();
  expect(referralLookups({ state: { calls: backCalls } }, 0, "friend")).toEqual([]);
  await waitQuote(flow, "", since);
});

test("successive payment removals survive reload and explicit normalized reapplication preserves other removals", async ({ page, flow }, testInfo) => {
  flow.state.collision = true;
  await startFriendPayment(page, flow);
  let since = flow.state.calls.length;
  await submitPaymentCode(page, "");
  await waitQuote(flow, "", since);
  const firstRemoval = await referralIntent(page);
  since = flow.state.calls.length;
  await submitPaymentCode(page, " SaVe20 ");
  await waitQuote(flow, "save20", since);
  expect(referralLookups(flow, since, "save20").length).toBeGreaterThan(0);
  const replacement = await referralIntent(page);
  since = flow.state.calls.length;
  await submitPaymentCode(page, "");
  await waitQuote(flow, "", since);
  const secondRemoval = await referralIntent(page);
  expect(await page.evaluate(() => history.state?.usr?.bookingData?.referralCode)).toBe("friend");
  since = flow.state.calls.length;
  await page.reload();
  await expect(paymentCode(page)).toBeEnabled();
  await expect.poll(() => quoteCalls(flow, since).length).toBeGreaterThan(0);
  await attachJson(testInfo, "successive-removals", {
    firstRemoval, replacement, secondRemoval, afterReload: await referralIntent(page), calls: flow.state.calls.slice(since),
  });
  await waitQuote(flow, "", since);
  expect(referralLookups(flow, since, "friend")).toEqual([]);
  await expect(paymentCode(page)).toHaveValue("");
  since = flow.state.calls.length;
  await submitPaymentCode(page, " FrIeNd ");
  await waitQuote(flow, "friend", since);
  expect(referralLookups(flow, since, "friend").length).toBeGreaterThan(0);
  expect(JSON.parse((await referralIntent(page)).journal)).toEqual({ friend: "applied", save20: "removed" });
});

test("native session quota exhaustion preserves a non-growing removal and refuses stale payment restoration", async ({ page, flow }, testInfo) => {
  await startFriendPayment(page, flow);
  const quota = await fillSessionQuota(page);
  expect(quota.exception).toBe("QuotaExceededError");
  expect(quota.extraCharacterError).toBe("QuotaExceededError");
  expect(quota.passive).toBe("friend");
  let since = flow.state.calls.length;
  await submitPaymentCode(page, "");
  await waitQuote(flow, "", since);
  const afterRemoval = await referralIntent(page);
  expect(await page.evaluate(() => history.state?.usr?.bookingData?.referralCode)).toBe("friend");
  since = flow.state.calls.length;
  await page.reload();
  await expect(paymentCode(page)).toBeEnabled();
  await expect.poll(() => quoteCalls(flow, since).length).toBeGreaterThan(0);
  await attachJson(testInfo, "native-quota-removal", {
    quota, afterRemoval, afterReload: await referralIntent(page), calls: flow.state.calls.slice(since),
    fillerCharactersAfterReload: await page.evaluate(() => sessionStorage.getItem("roo-referral-quota").length),
  });
  await waitQuote(flow, "", since);
  expect(referralLookups(flow, since, "friend")).toEqual([]);
  await expect(paymentCode(page)).toHaveValue("");
  expect(afterRemoval.passive).toBeNull();
  expect(JSON.parse(afterRemoval.journal).friend).toBe("removed");
  expect(afterRemoval.journal.length).toBeLessThanOrEqual(quota.journal.length);
  expect(await page.evaluate(() => sessionStorage.getItem("roo-referral-quota").length)).toBe(quota.fillerCharacters);
});

test("a newer manual referral application overrides an older booking draft dismissal", async ({ page, flow }, testInfo) => {
  await page.goto("/booking?ref=friend");
  await reserveAndReview(page, flow);
  await page.getByRole("button", { name: "Remove referral code friend", exact: true }).click();
  await expect.poll(() => storedReferral(page)).toBeNull();
  let since = flow.state.calls.length;
  await flow.payment();
  await waitQuote(flow, "", since);
  const draft = await page.evaluate(() => {
    const value = JSON.parse(sessionStorage.getItem("booking_draft"));
    return value.packages[value.lastTitle].checkoutCodes;
  });
  expect(draft.dismissedReferralCode).toBe("friend");
  since = flow.state.calls.length;
  await submitPaymentCode(page, "friend");
  await waitQuote(flow, "friend", since);
  expect(referralLookups(flow, since, "friend").length).toBeGreaterThan(0);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  try {
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    await expect.poll(() => storedReferral(page)).toBe("friend");
    since = flow.state.calls.length;
    await flow.payment();
    await waitQuote(flow, "friend", since);
  } finally {
    await attachJson(testInfo, "newer-application-old-draft", { draft, intent: await referralIntent(page), calls: flow.state.calls });
  }
});

for (const screen of ["payment", "booking"]) {
  test(`a journal write failure refuses ${screen} removal visibly and a retry persists it`, async ({ page, flow }, testInfo) => {
    if (screen === "payment") await startFriendPayment(page, flow);
    else {
      await page.goto("/booking?ref=friend");
      await reserveAndReview(page, flow);
      await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    }
    const before = await referralIntent(page);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.restoreReferralSetter = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function(key, value) {
        if (key === "referral_dismissed") throw new DOMException("Journal write denied", "QuotaExceededError");
        return original.call(this, key, value);
      };
    });
    let since = flow.state.calls.length;
    if (screen === "payment") await submitPaymentCode(page, "");
    else await page.getByRole("button", { name: "Remove referral code friend", exact: true }).click();
    try {
      await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
      expect(await referralIntent(page)).toEqual(before);
      if (screen === "payment") {
        expect(lastQuote(flow).body.referralCode).toBe("friend");
        expect(quoteCalls(flow, since).every(call => call.body.referralCode === "friend")).toBe(true);
      } else await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    } finally {
      await attachJson(testInfo, "failed-removal-intent", { before, after: await referralIntent(page), calls: flow.state.calls.slice(since) });
    }
    await page.evaluate(() => window.restoreReferralSetter());
    since = flow.state.calls.length;
    if (screen === "payment") {
      await submitPaymentCode(page, "");
      await waitQuote(flow, "", since);
    } else {
      await page.getByRole("button", { name: "Remove referral code friend", exact: true }).click();
      await flow.payment();
      await waitQuote(flow, "", since);
    }
    since = flow.state.calls.length;
    await page.reload();
    await expect(paymentCode(page)).toBeEnabled();
    await waitQuote(flow, "", since);
    expect(JSON.parse((await referralIntent(page)).journal).friend).toBe("removed");
  });
}

for (const origin of ["payment coupon", "booking draft coupon", "booking query alias"]) {
  test(`automatic ${origin} resolution cannot revive a removed referral but explicit application works`, async ({ page, flow }, testInfo) => {
    if (origin === "payment coupon") {
      await startFriendPayment(page, flow);
      const since = flow.state.calls.length;
      await submitPaymentCode(page, "");
      await waitQuote(flow, "", since);
      await page.evaluate(() => {
        const state = history.state;
        history.replaceState({ ...state, usr: { ...state.usr, bookingData: { ...state.usr.bookingData, couponCode: "friend" } } }, "");
      });
    } else {
      await page.goto("/booking?ref=friend");
      await reserveAndReview(page, flow);
      await page.getByRole("button", { name: "Remove referral code friend", exact: true }).click();
      await expect.poll(() => storedReferral(page)).toBeNull();
      if (origin === "booking draft coupon") {
        await page.evaluate(() => {
          const draft = JSON.parse(sessionStorage.getItem("booking_draft"));
          draft.packages[draft.lastTitle].checkoutCodes.coupon = { code: "friend", discountType: "percent", discountPercent: 20, canCombineWithReferral: true };
          sessionStorage.setItem("booking_draft", JSON.stringify(draft));
        });
      } else {
        await page.route("**/api/ref/validateReferral?code=alias", async route => {
          flow.state.calls.push({ path: "/api/ref/validateReferral", query: "?code=alias", body: null });
          await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, active: true, eligible: true, referral: { code: "friend", currentDiscountPercent: 10 } }) });
        });
      }
    }
    const beforeAutomatic = flow.state.calls.length;
    if (origin === "booking query alias") {
      await page.goto("/booking?ref=alias");
      await expect(page).toHaveURL(/ref=alias/);
    } else await page.reload();
    if (origin === "payment coupon") {
      await expect(paymentCode(page)).toBeEnabled();
      await waitQuote(flow, "", beforeAutomatic);
      await expect(paymentCode(page)).toHaveValue("");
      const since = flow.state.calls.length;
      await submitPaymentCode(page, "friend", "Coupon");
      await waitQuote(flow, "friend", since);
      expect(referralLookups(flow, since, "friend").length).toBeGreaterThan(0);
    } else {
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
      await expect.poll(() => referralLookups(flow, beforeAutomatic, origin === "booking query alias" ? "alias" : "friend").length).toBeGreaterThan(0);
      await page.waitForTimeout(500);
      await attachJson(testInfo, "automatic-booking-result", { intent: await referralIntent(page), calls: flow.state.calls.slice(beforeAutomatic) });
      await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toHaveCount(0);
      expect(await storedReferral(page)).not.toBe("friend");
      const since = flow.state.calls.length;
      await flow.codeInput("friend");
      await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
      expect(referralLookups(flow, since, "friend").length).toBeGreaterThan(0);
      const beforePayment = flow.state.calls.length;
      await flow.payment();
      await waitQuote(flow, "friend", beforePayment);
    }
    expect(JSON.parse((await referralIntent(page)).journal).friend).toBe("applied");
  });
}

for (const raw of ["{broken", "null", "[]", '{"friend":"unexpected"}']) {
  test(`invalid referral intent ${raw} refuses automatic and manual replacement without erasing evidence`, async ({ page, flow }, testInfo) => {
    await page.goto("/tourney");
    await page.evaluate(raw => sessionStorage.setItem("referral_dismissed", raw), raw);
    await page.goto("/booking?ref=friend");
    await reserveAndReview(page, flow);
    const since = flow.state.calls.length;
    await flow.payment();
    await expect.poll(() => quoteCalls(flow, since).length).toBeGreaterThan(0);
    await attachJson(testInfo, "invalid-intent-automatic", { raw, intent: await referralIntent(page), quotes: quoteCalls(flow, since) });
    await waitQuote(flow, "", since);
    expect((await referralIntent(page)).journal).toBe(raw);
    const beforeManual = flow.state.calls.length;
    await submitPaymentCode(page, "friend");
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    expect(referralLookups(flow, beforeManual, "friend").length).toBeGreaterThan(0);
    expect((await referralIntent(page)).journal).toBe(raw);
    expect(lastQuote(flow).body.referralCode).toBe("");
    expect(quoteCalls(flow, beforeManual)).toEqual([]);
  });
}

test("a new automatic referral cannot enroll in a full readable session store", async ({ page, flow }, testInfo) => {
  await startFriendPayment(page, flow);
  let since = flow.state.calls.length;
  await submitPaymentCode(page, "");
  await waitQuote(flow, "", since);
  const quota = await fillSessionQuota(page);
  expect(quota.extraCharacterError).toBe("QuotaExceededError");
  await page.evaluate(() => {
    const state = history.state;
    history.replaceState({ ...state, usr: { ...state.usr, bookingData: { ...state.usr.bookingData, referralCode: "save20" } } }, "");
  });
  flow.state.collision = true;
  since = flow.state.calls.length;
  await page.reload();
  await expect(paymentCode(page)).toBeEnabled();
  await expect.poll(() => quoteCalls(flow, since).length).toBeGreaterThan(0);
  await attachJson(testInfo, "full-store-enrollment", { quota, intent: await referralIntent(page), calls: flow.state.calls.slice(since) });
  await waitQuote(flow, "", since);
  expect(referralLookups(flow, since, "save20")).toEqual([]);
  await expect(paymentCode(page)).toHaveValue("");
  expect(JSON.parse((await referralIntent(page)).journal)).toEqual({ friend: "removed" });
});

for (const screen of ["payment referral", "payment coupon", "booking"]) {
  test(`a manual referral change from ${screen} refuses quota failure and preserves the prior choice`, async ({ page, flow }, testInfo) => {
    flow.state.collision = true;
    if (screen.startsWith("payment")) await startFriendPayment(page, flow);
    else {
      await page.goto("/booking?ref=friend");
      await reserveAndReview(page, flow);
      await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    }
    const quota = await fillSessionQuota(page);
    expect(quota.extraCharacterError).toBe("QuotaExceededError");
    const since = flow.state.calls.length;
    if (screen.startsWith("payment")) await submitPaymentCode(page, "save20", screen === "payment coupon" ? "Coupon" : "Referral");
    else await flow.codeInput("save20");
    try {
      await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
      expect(referralLookups(flow, since, "save20").length).toBeGreaterThan(0);
      expect((await referralIntent(page)).journal).toBe(quota.journal);
      expect(await storedReferral(page)).toBe("friend");
      if (screen.startsWith("payment")) {
        expect(lastQuote(flow).body.referralCode).toBe("friend");
        expect(quoteCalls(flow, since)).toEqual([]);
      } else await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    } finally {
      await attachJson(testInfo, "manual-application-quota", { screen, quota, intent: await referralIntent(page), calls: flow.state.calls.slice(since) });
    }
  });
}
