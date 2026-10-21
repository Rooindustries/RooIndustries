const { test: bookingTest, expect } = require("./fixtures/booking-flow.cjs");

const test = bookingTest.extend({
  referralCpu: [async ({ page }, use, testInfo) => {
    if (testInfo.title !== "a fresh direct booking query captures a different creator after removal" &&
      testInfo.title !== "quick Continue on a fresh direct creator link never quotes the prior creator") return use();
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    await testInfo.attach("referral-cpu-throttling", {
      body: JSON.stringify({ rate: 6, browserName: "chromium" }), contentType: "application/json",
    });
    try {
      await use();
    } finally {
      await session.detach();
    }
  }, { auto: true }],
});

test.use({ video: "off" });
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
        await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("referral_dismissed"))?.codes?.friend)).toBe("applied");
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
  expect(JSON.parse((await referralIntent(page)).journal).codes).toEqual({ friend: "applied", save20: "removed" });
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
  expect(JSON.parse(afterRemoval.journal).codes.friend).toBe("removed");
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
    expect(JSON.parse((await referralIntent(page)).journal).codes.friend).toBe("removed");
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
    expect(JSON.parse((await referralIntent(page)).journal).codes.friend).toBe("applied");
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
  expect(JSON.parse((await referralIntent(page)).journal).codes).toEqual({ friend: "removed" });
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

const checkoutScope = (title = "Performance Vertex Overhaul", order = "") => JSON.stringify([title, order]);
const envelope = async page => JSON.parse((await referralIntent(page)).journal);

for (const destination of ["reload", "Back"]) {
  test(`manual replacement survives ${destination} with the old code still available`, async ({ page, flow }, testInfo) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    let since = flow.state.calls.length;
    await submitPaymentCode(page, "save20");
    await waitQuote(flow, "save20", since);
    const before = await referralIntent(page);
    since = flow.state.calls.length;
    if (destination === "reload") {
      await page.reload();
      await expect(paymentCode(page)).toBeEnabled();
      await expect.poll(() => quoteCalls(flow, since).length).toBeGreaterThan(0);
    } else {
      await page.goBack();
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled();
      await page.waitForTimeout(500);
    }
    const afterReturn = await referralIntent(page);
    const returnCalls = flow.state.calls.slice(since);
    if (destination === "Back") {
      since = flow.state.calls.length;
      await flow.payment();
      await expect.poll(() => quoteCalls(flow, since).length).toBeGreaterThan(0);
    }
    await attachJson(testInfo, `manual-replacement-${destination.toLowerCase()}`, { before, afterReturn, returnCalls, quotes: quoteCalls(flow, since) });
    await waitQuote(flow, "save20", since);
    await expect(paymentCode(page)).toHaveValue("save20");
    expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
  });
}

test("a refused older booking draft cannot erase a different newly followed creator", async ({ page, flow }, testInfo) => {
  flow.state.collision = true;
  await startFriendPayment(page, flow);
  let since = flow.state.calls.length;
  await submitPaymentCode(page, "");
  await waitQuote(flow, "", since);
  const afterRemoval = await referralIntent(page);
  await page.goto("/reviews?ref=save20");
  await expect.poll(() => storedReferral(page)).toBe("save20");
  const afterFollow = await referralIntent(page);
  const beforeReopen = flow.state.calls.length;
  await page.goto("/booking");
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled();
  await page.waitForTimeout(600);
  const afterReopen = await referralIntent(page);
  since = flow.state.calls.length;
  await flow.payment();
  await expect.poll(() => quoteCalls(flow, since).length).toBeGreaterThan(0);
  await attachJson(testInfo, "removed-draft-new-creator", { afterRemoval, afterFollow, afterReopen, reopenCalls: flow.state.calls.slice(beforeReopen, since), quotes: quoteCalls(flow, since) });
  expect(afterReopen.passive).toBe("save20");
  expect(referralLookups(flow, beforeReopen, "save20").length).toBeGreaterThan(0);
  await waitQuote(flow, "save20", since);
});

for (const inputType of ["Referral", "Coupon"]) {
  test(`a departed payment ${inputType} validation cannot undo a newer booking removal`, async ({ page, flow }, testInfo) => {
    flow.state.collision = true;
    await page.goto("/reviews?ref=friend");
    await expect.poll(() => storedReferral(page)).toBe("friend");
    await flow.review();
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    let since = flow.state.calls.length;
    await flow.payment();
    await waitQuote(flow, "friend", since);
    let intercepted = false;
    let releaseResponse;
    let completedResponse = false;
    const responseGate = new Promise(resolve => { releaseResponse = resolve; });
    await page.route("**/api/ref/validateReferral?code=save20", async route => {
      if (intercepted) return route.fallback();
      intercepted = true;
      flow.state.calls.push({ path: "/api/ref/validateReferral", query: "?code=save20", body: null, delayed: true });
      await responseGate;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, active: true, eligible: true, referral: { code: "save20", currentDiscountPercent: 10 } }) });
      completedResponse = true;
    });
    try {
      await submitPaymentCode(page, "save20", inputType);
      await expect.poll(() => intercepted).toBe(true);
      const started = Date.now();
      await page.goBack();
      await expect(page).toHaveURL(/\/booking$/);
      await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
      await flow.codeInput("save20");
      await expect(page.getByRole("button", { name: "Remove referral code save20", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Remove referral code save20", exact: true }).click();
      const beforeRelease = await referralIntent(page);
      expect(Date.now() - started).toBeLessThan(7500);
      releaseResponse();
      await expect.poll(() => completedResponse).toBe(true);
      await page.waitForTimeout(500);
      const afterRelease = await referralIntent(page);
      since = flow.state.calls.length;
      await flow.payment();
      await expect.poll(() => quoteCalls(flow, since).length).toBeGreaterThan(0);
      await attachJson(testInfo, "departed-payment-response", { inputType, beforeRelease, afterRelease, quotes: quoteCalls(flow, since), calls: flow.state.calls });
      expect(afterRelease).toEqual(beforeRelease);
      await waitQuote(flow, "", since);
    } finally {
      releaseResponse();
    }
  });
}

for (const destination of ["reload", "Back"]) {
  test(`removing a replacement keeps its older available ancestor out after ${destination}`, async ({ page, flow }, testInfo) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    let since = flow.state.calls.length;
    await submitPaymentCode(page, "save20");
    await waitQuote(flow, "save20", since);
    since = flow.state.calls.length;
    await submitPaymentCode(page, "");
    await waitQuote(flow, "", since);
    const before = await referralIntent(page);
    since = flow.state.calls.length;
    if (destination === "reload") {
      await page.reload();
      await expect(paymentCode(page)).toBeEnabled();
    } else {
      await page.goBack();
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled();
      since = flow.state.calls.length;
      await flow.payment();
    }
    await waitQuote(flow, "", since);
    expect(referralLookups(flow, since, "friend")).toEqual([]);
    await attachJson(testInfo, "replacement-removal-return", { before, afterReturn: await referralIntent(page), quotes: quoteCalls(flow, since) });
    since = flow.state.calls.length;
    await submitPaymentCode(page, "friend");
    await waitQuote(flow, "friend", since);
    expect((await envelope(page)).codes).toEqual({ friend: "applied", save20: "removed" });
  });
}

for (const inputType of ["Referral", "Coupon"]) {
  test(`partial native quota failure never acknowledges a lost manual ${inputType} choice`, async ({ page, flow }, testInfo) => {
    await page.route("**/api/ref/validateReferral?code=longcreator", async route => {
      flow.state.calls.push({ path: "/api/ref/validateReferral", query: "?code=longcreator", body: null });
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, active: true, eligible: true, referral: { code: "longcreator", currentDiscountPercent: 10 } }) });
    });
    await page.goto("/reviews?ref=longcreator");
    await expect.poll(() => storedReferral(page)).toBe("longcreator");
    await startFriendPayment(page, flow);
    const quota = await fillSessionQuota(page);
    expect(quota.extraCharacterError).toBe("QuotaExceededError");
    expect(JSON.parse(quota.journal).codes.longcreator).toBe("available");
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.referralWrites = [];
      Storage.prototype.setItem = function(key, value) {
        if (key !== "referral_dismissed" && key !== "referral_session") return original.call(this, key, value);
        try {
          const result = original.call(this, key, value);
          window.referralWrites.push({ key, value, result: "success" });
          return result;
        } catch (error) {
          window.referralWrites.push({ key, value, error: error.name });
          throw error;
        }
      };
    });
    const since = flow.state.calls.length;
    await submitPaymentCode(page, "longcreator", inputType);
    await expect(paymentCode(page, inputType)).toBeEnabled();
    await page.waitForTimeout(400);
    const displayed = await paymentCode(page).inputValue();
    const after = await referralIntent(page);
    const writes = await page.evaluate(() => window.referralWrites);
    const errors = await page.getByRole("alert").allTextContents();
    const beforeReload = flow.state.calls.length;
    const manualQuotes = quoteCalls(flow, since);
    await page.reload();
    await expect(paymentCode(page)).toBeEnabled();
    await expect.poll(() => quoteCalls(flow, beforeReload).length).toBeGreaterThan(0);
    const stored = await envelope(page);
    const committed = stored.choices[checkoutScope()];
    await attachJson(testInfo, "partial-manual-quota", { inputType, quota, displayed, after, writes, errors, manualQuotes, afterReload: await referralIntent(page), reloadQuotes: quoteCalls(flow, beforeReload), fillerCharactersAfterReload: await page.evaluate(() => sessionStorage.getItem("roo-referral-quota").length) });
    if (committed === "longcreator") {
      expect(displayed).toBe("longcreator");
      await waitQuote(flow, "longcreator", beforeReload);
      await expect(paymentCode(page)).toHaveValue("longcreator");
    } else {
      expect(errors.join(" ")).toContain(storageError);
      expect(after).toEqual({ passive: quota.passive, journal: quota.journal });
      expect(committed).toBe("friend");
      expect(manualQuotes).toEqual([]);
      await waitQuote(flow, "friend", beforeReload);
      await expect(paymentCode(page)).toHaveValue("friend");
    }
  });
}

for (const resetBlocked of [false, true]) {
  test(`a fresh booking resets the previous checkout choice${resetBlocked ? " and refuses a failed reset" : " for a new creator"}`, async ({ page, flow }, testInfo) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    let since = flow.state.calls.length;
    await submitPaymentCode(page, "save20");
    await waitQuote(flow, "save20", since);
    await page.getByRole("dialog").getByRole("button", { name: "Release", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(flow.state.calls.some(call => call.path === "/api/releaseHold")).toBe(true);
    await page.goto("/reviews?ref=friend");
    await expect.poll(() => storedReferral(page)).toBe("friend");
    if (resetBlocked) {
      await page.addInitScript(scope => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (key === "referral_dismissed" && !Object.hasOwn(JSON.parse(value).choices, scope)) {
            throw new DOMException("Choice reset denied", "QuotaExceededError");
          }
          return original.call(this, key, value);
        };
      }, checkoutScope());
    }
    since = flow.state.calls.length;
    await page.goto("/booking");
    await reserveAndReview(page, flow);
    if (resetBlocked) {
      await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
      expect(referralLookups(flow, since, "save20")).toEqual([]);
      expect(referralLookups(flow, since, "friend")).toEqual([]);
      expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
      await flow.codeInput("friend");
    }
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    const beforePayment = flow.state.calls.length;
    await flow.payment();
    await waitQuote(flow, "friend", beforePayment);
    await attachJson(testInfo, "fresh-booking-choice", { resetBlocked, intent: await referralIntent(page), calls: flow.state.calls.slice(since) });
    expect((await envelope(page)).choices[checkoutScope()]).toBe("friend");
  });
}

test("package and original order scopes isolate upgrade choices and retain a same-order retry", async ({ page, flow }, testInfo) => {
  flow.state.collision = true;
  await startFriendPayment(page, flow);
  let since = flow.state.calls.length;
  await submitPaymentCode(page, "save20");
  await waitQuote(flow, "save20", since);
  await page.goto("/reviews?ref=friend");
  await expect.poll(() => storedReferral(page)).toBe("friend");
  let order = "fixture-order";
  await page.route("**/api/ref/getUpgradeInfo", async route => {
    flow.state.calls.push({ path: "/api/ref/getUpgradeInfo", body: route.request().postDataJSON(), query: "" });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      ok: true, booking: { _id: order, packageTitle: "Performance Vertex Overhaul", startTimeUTC: `${flow.state.slots[0].date}T04:30:00.000Z`, email: "visitor@example.invalid", discord: "visitor", specs: "RTX 4070", mainGame: "CS2", localTimeZone: "Asia/Kolkata" },
      xoc: { title: "Performance Vertex Max", price: 99.95 }, targetPackage: { title: "Performance Vertex Max", price: 99.95 }, originalPaid: 54.95, upgradePrice: 45, upgradeIntentToken: "fixture-intent",
    }) });
  });
  const upgradePayment = async () => {
    await flow.upgrade();
    await page.getByRole("button", { name: "Check eligibility", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Upgrade Summary", exact: true })).toBeVisible();
    const before = flow.state.calls.length;
    await page.getByRole("button", { name: "Proceed to Payment", exact: true }).click();
    await expect(paymentCode(page)).toBeEnabled();
    await expect.poll(() => quoteCalls(flow, before).length).toBeGreaterThan(0);
    return before;
  };
  since = await upgradePayment();
  await waitQuote(flow, "friend", since);
  since = flow.state.calls.length;
  await submitPaymentCode(page, "save20");
  await waitQuote(flow, "save20", since);
  await page.goto("/reviews?ref=friend");
  since = await upgradePayment();
  await waitQuote(flow, "save20", since);
  order = "fixture-second-order";
  since = await upgradePayment();
  await waitQuote(flow, "friend", since);
  await attachJson(testInfo, "scoped-upgrade-choices", { intent: await referralIntent(page), quotes: flow.state.calls.filter(call => call.path === "/api/payment/quote") });
  expect((await envelope(page)).choices).toMatchObject({
    [checkoutScope()]: "save20",
    [checkoutScope("Performance Vertex Max (Upgrade)", "fixture-order")]: "save20",
    [checkoutScope("Performance Vertex Max (Upgrade)", "fixture-second-order")]: "friend",
  });
});

for (const change of ["view", "token"]) {
  test(`a delayed manual payment result loses ownership after a ${change} change`, async ({ page, flow }, testInfo) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    let release;
    let intercepted = false;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/ref/validateReferral?code=save20", async route => {
      intercepted = true;
      flow.state.calls.push({ path: "/api/ref/validateReferral", query: "?code=save20", delayed: true });
      await gate;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, active: true, eligible: true, referral: { code: "save20", currentDiscountPercent: 10 } }) });
    });
    try {
      await submitPaymentCode(page, "save20");
      await expect.poll(() => intercepted).toBe(true);
      const before = await referralIntent(page);
      if (change === "view") {
        await page.evaluate(() => window.next.router.replace("/payment?ownership=changed"));
        await expect(page).toHaveURL(/ownership=changed/);
      } else {
        await page.evaluate(() => sessionStorage.setItem("payment_session_state", JSON.stringify({ paymentAccessToken: "new-owner-token", provider: "dodo", fingerprint: "{}", providerPayload: { checkoutUrl: "/__test/checkout-handoff" } })));
      }
      release();
      await expect(paymentCode(page)).toBeEnabled();
      await page.waitForTimeout(400);
      await attachJson(testInfo, "manual-payment-ownership", { change, before, after: await referralIntent(page), calls: flow.state.calls });
      expect(await referralIntent(page)).toEqual(before);
      expect(lastQuote(flow).body.referralCode).toBe("friend");
      await expect(paymentCode(page, "Coupon")).toBeEnabled();
    } finally {
      release();
    }
  });
}

for (const inputType of ["Referral", "Coupon"]) {
  test(`an authoritative ${inputType} choice survives a failed compatibility mirror write`, async ({ page, flow }, testInfo) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === "referral_session") throw new DOMException("Mirror denied", "QuotaExceededError");
        return original.call(this, key, value);
      };
    });
    let since = flow.state.calls.length;
    await submitPaymentCode(page, "save20", inputType);
    await waitQuote(flow, "save20", since);
    expect(await storedReferral(page)).toBe("friend");
    expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
    const before = await referralIntent(page);
    since = flow.state.calls.length;
    await page.reload();
    await expect(paymentCode(page)).toBeEnabled();
    await waitQuote(flow, "save20", since);
    await expect(paymentCode(page)).toHaveValue("save20");
    await attachJson(testInfo, "mirror-failure-reload", { before, after: await referralIntent(page), calls: flow.state.calls.slice(since) });
  });
}

test("an invalid manual replacement preserves the validated checkout choice", async ({ page, flow }, testInfo) => {
  await startFriendPayment(page, flow);
  const before = await referralIntent(page);
  const since = flow.state.calls.length;
  await submitPaymentCode(page, "invalid");
  await expect(page.getByRole("alert").filter({ hasText: "Invalid or inactive referral code." })).toBeVisible();
  expect(await referralIntent(page)).toEqual(before);
  expect(quoteCalls(flow, since)).toEqual([]);
  expect(lastQuote(flow).body.referralCode).toBe("friend");
  const reload = flow.state.calls.length;
  await page.reload();
  await waitQuote(flow, "friend", reload);
  await expect(paymentCode(page)).toHaveValue("friend");
  await attachJson(testInfo, "invalid-manual-preservation", { before, after: await referralIntent(page), calls: flow.state.calls.slice(since) });
});

const navigationTiming = page => page.evaluate(() => ({
  type: performance.getEntriesByType("navigation")[0]?.type || "",
  pageShows: window.referralPageShows || [],
}));

for (const navigation of ["direct", "in-app"]) {
  test(`a fresh ${navigation} booking query captures a different creator after removal`, async ({ page, flow }, testInfo) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    let since = flow.state.calls.length;
    await submitPaymentCode(page, "");
    await waitQuote(flow, "", since);
    const afterRemoval = await referralIntent(page);
    expect((await envelope(page)).codes.friend).toBe("removed");
    expect((await envelope(page)).choices[checkoutScope()]).toBe("friend");
    since = flow.state.calls.length;
    if (navigation === "direct") await page.goto("/booking?ref=save20");
    else {
      await page.goto("/tourney");
      await page.waitForFunction(() => Boolean(window.next?.router));
      await page.evaluate(() => window.next.router.push("/booking?ref=save20"));
    }
    await expect(page).toHaveURL(/\/booking\?ref=save20$/);
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove referral code save20", exact: true })).toBeVisible();
    expect(referralLookups(flow, since, "save20").length).toBeGreaterThan(0);
    expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
    expect(await storedReferral(page)).toBe("save20");
    const beforePayment = flow.state.calls.length;
    await flow.payment();
    await waitQuote(flow, "save20", beforePayment);
    await attachJson(testInfo, "fresh-booking-query-provenance", { navigation, timing: await navigationTiming(page), afterRemoval, after: await referralIntent(page), calls: flow.state.calls.slice(since) });
  });
}

test("Back and hard reload of the old booking query cannot revive an available ancestor", async ({ page, flow }, testInfo) => {
  flow.state.collision = true;
  await startFriendPayment(page, flow);
  let since = flow.state.calls.length;
  await submitPaymentCode(page, "save20");
  await waitQuote(flow, "save20", since);
  since = flow.state.calls.length;
  await submitPaymentCode(page, "");
  await waitQuote(flow, "", since);
  const afterRemoval = await referralIntent(page);
  since = flow.state.calls.length;
  await page.goBack();
  await expect(page).toHaveURL(/\/booking\?ref=friend$/);
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled();
  const afterBack = await referralIntent(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled();
  const timing = await navigationTiming(page);
  expect(timing.type).toBe("reload");
  expect(referralLookups(flow, since, "friend")).toEqual([]);
  expect(await referralIntent(page)).toEqual(afterRemoval);
  expect(afterBack).toEqual(afterRemoval);
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toHaveCount(0);
  const beforePayment = flow.state.calls.length;
  await flow.payment();
  await waitQuote(flow, "", beforePayment);
  expect((await envelope(page)).codes).toEqual({ friend: "available", save20: "removed" });
  expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
  await attachJson(testInfo, "restored-booking-query-provenance", { afterRemoval, afterBack, after: await referralIntent(page), timing, calls: flow.state.calls.slice(since) });
});

test("reloading the old public query preserves removal until a later fresh same-code follow", async ({ page, flow }, testInfo) => {
  flow.state.collision = true;
  await page.goto("/?ref=friend");
  await expect.poll(() => storedReferral(page)).toBe("friend");
  await page.locator(".ri-package-book-button").first().click();
  await reserveAndReview(page, flow);
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
  let since = flow.state.calls.length;
  await flow.payment();
  await waitQuote(flow, "friend", since);
  since = flow.state.calls.length;
  await submitPaymentCode(page, "save20");
  await waitQuote(flow, "save20", since);
  since = flow.state.calls.length;
  await submitPaymentCode(page, "");
  await waitQuote(flow, "", since);
  const afterRemoval = await referralIntent(page);
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/\/\?ref=friend$/);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.next?.router));
  const timing = await navigationTiming(page);
  expect(timing.type).toBe("reload");
  expect(await referralIntent(page)).toEqual(afterRemoval);
  await page.evaluate(() => window.next.router.push("/tourney"));
  await expect(page).toHaveURL(/\/tourney$/);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.next.router.push("/reviews?ref=friend"));
  await expect.poll(() => storedReferral(page)).toBe("friend");
  const afterFollow = await referralIntent(page);
  since = flow.state.calls.length;
  await page.goto("/booking");
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
  expect(referralLookups(flow, since, "friend").length).toBeGreaterThan(0);
  const beforePayment = flow.state.calls.length;
  await flow.payment();
  await waitQuote(flow, "friend", beforePayment);
  expect((await envelope(page)).codes.save20).toBe("removed");
  await attachJson(testInfo, "public-query-reload-and-fresh-follow", { afterRemoval, timing, afterFollow, after: await referralIntent(page), calls: flow.state.calls.slice(since) });
});

test("fresh blank booking capture clears passive but restored blank preserves a later creator and the current choice", async ({ page, flow }, testInfo) => {
  flow.state.collision = true;
  await page.goto("/reviews?ref=save20");
  await expect.poll(() => storedReferral(page)).toBe("save20");
  await page.goto("/booking?ref=");
  await page.waitForFunction(() => Boolean(window.next?.router));
  await expect.poll(() => storedReferral(page)).toBeNull();
  const afterFreshBlank = await referralIntent(page);
  const since = flow.state.calls.length;
  await reserveAndReview(page, flow);
  expect(referralLookups(flow, since, "save20")).toEqual([]);
  await flow.codeInput("friend");
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
  await page.evaluate(() => window.next.router.push("/tourney"));
  await expect(page).toHaveURL(/\/tourney$/);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.next.router.push("/reviews?ref=save20"));
  await expect.poll(() => storedReferral(page)).toBe("save20");
  const afterFollow = await referralIntent(page);
  await page.goBack();
  await expect(page).toHaveURL(/\/tourney$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/booking\?ref=$/);
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
  expect(await storedReferral(page)).toBe("save20");
  const afterBack = await referralIntent(page);
  await page.reload();
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
  expect(await storedReferral(page)).toBe("save20");
  const timing = await navigationTiming(page);
  expect(timing.type).toBe("reload");
  expect((await envelope(page)).choices[checkoutScope()]).toBe("friend");
  const beforePayment = flow.state.calls.length;
  await flow.payment();
  await waitQuote(flow, "friend", beforePayment);
  expect(await storedReferral(page)).toBe("save20");
  await attachJson(testInfo, "blank-booking-query-provenance", { afterFreshBlank, afterFollow, afterBack, after: await referralIntent(page), timing, calls: flow.state.calls.slice(since) });
});

test("real cross-document Back preserves the newer passive creator", async ({ page, flow }, testInfo) => {
  flow.state.collision = true;
  await page.addInitScript(() => {
    window.referralPageShows = [];
    window.addEventListener("pageshow", event => {
      window.referralPageShows.push({ persisted: event.persisted, type: performance.getEntriesByType("navigation")[0]?.type || "" });
    });
  });
  await page.goto("/tourney?ref=friend");
  await expect.poll(() => storedReferral(page)).toBe("friend");
  await page.goto("/about?ref=save20");
  await expect.poll(() => storedReferral(page)).toBe("save20");
  const beforeBack = await referralIntent(page);
  await page.goBack();
  await expect(page).toHaveURL(/\/tourney\?ref=friend$/);
  await page.waitForFunction(() => Boolean(window.next?.router));
  const timing = await navigationTiming(page);
  expect(timing.type === "back_forward" || timing.pageShows.some(event => event.persisted)).toBe(true);
  expect(await referralIntent(page)).toEqual(beforeBack);
  const since = flow.state.calls.length;
  await flow.review();
  await expect(page.getByRole("button", { name: "Remove referral code save20", exact: true })).toBeVisible();
  expect(referralLookups(flow, since, "save20").length).toBeGreaterThan(0);
  const beforePayment = flow.state.calls.length;
  await flow.payment();
  await waitQuote(flow, "save20", beforePayment);
  await attachJson(testInfo, "real-cross-document-provenance", { beforeBack, timing, after: await referralIntent(page), calls: flow.state.calls.slice(since) });
});

test("injected missing initial navigation timing refuses capture and leaves explicit manual application available", async ({ page, flow }, testInfo) => {
  await page.addInitScript(() => {
    const original = performance.getEntriesByType.bind(performance);
    performance.getEntriesByType = type => type === "navigation" ? [] : original(type);
  });
  await page.goto("/reviews?ref=friend");
  await page.waitForFunction(() => Boolean(window.next?.router));
  await page.waitForTimeout(300);
  expect(await storedReferral(page)).toBeNull();
  const timing = await navigationTiming(page);
  expect(timing.type).toBe("");
  const since = flow.state.calls.length;
  await flow.review();
  expect(referralLookups(flow, since, "friend")).toEqual([]);
  await flow.codeInput("friend");
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
  expect(referralLookups(flow, since, "friend").length).toBeGreaterThan(0);
  const beforePayment = flow.state.calls.length;
  await flow.payment();
  await waitQuote(flow, "friend", beforePayment);
  await attachJson(testInfo, "injected-missing-navigation-timing", { injected: true, timing, after: await referralIntent(page), calls: flow.state.calls.slice(since) });
});

test("native same-path history distinguishes an absent referral from explicit blank", async ({ page, flow }, testInfo) => {
  flow.state.collision = true;
  await page.goto("/reviews?ref=save20");
  await expect.poll(() => storedReferral(page)).toBe("save20");
  await page.goto("/booking");
  await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
  await page.waitForFunction(() => Boolean(window.next?.router));
  const address = () => page.evaluate(() => {
    const params = new URLSearchParams(window.location.search);
    return { url: window.location.href, pathname: window.location.pathname, hasRef: params.has("ref"), ref: params.get("ref") };
  });
  const beforeAddress = await address();
  const beforeIntent = await referralIntent(page);
  const beforeEnvelope = await envelope(page);
  expect(beforeAddress).toMatchObject({ pathname: "/booking", hasRef: false, ref: null });
  expect(beforeEnvelope.passiveCode).toBe("save20");
  const since = flow.state.calls.length;
  let blankAddress = null;
  try {
    await page.evaluate(() => {
      const { __NA, _N, ...appState } = window.history.state || {};
      window.referralNativeHistoryInput = {
        beforeNextFlag: Boolean(window.history.state?.__NA),
        beforePagesFlag: Boolean(window.history.state?._N),
        passedNextFlag: Boolean(appState.__NA),
        passedPagesFlag: Boolean(appState._N),
      };
      window.history.pushState(appState, "", "/booking?ref=");
    });
    await expect(page).toHaveURL(/\/booking\?ref=$/);
    blankAddress = await address();
    expect(blankAddress).toMatchObject({ pathname: "/booking", hasRef: true, ref: "" });
    await expect.poll(() => storedReferral(page)).toBeNull();
    const cleared = await envelope(page);
    expect(cleared.passiveCode).toBe("");
    expect(cleared.codes).toEqual(beforeEnvelope.codes);
    expect(cleared.choices).toEqual(beforeEnvelope.choices);
    await reserveAndReview(page, flow);
    await expect(page.getByRole("button", { name: "Remove referral code save20", exact: true })).toHaveCount(0);
    expect(referralLookups(flow, since, "save20")).toEqual([]);
    const beforePayment = flow.state.calls.length;
    await flow.payment();
    await waitQuote(flow, "", beforePayment);
  } finally {
    const nativeHistory = await page.evaluate(() => ({
      input: window.referralNativeHistoryInput || null,
      finalNextFlag: Boolean(window.history.state?.__NA),
      finalPagesFlag: Boolean(window.history.state?._N),
    }));
    await attachJson(testInfo, "native-ref-presence-identity", { beforeAddress, blankAddress, beforeIntent, afterAddress: await address(), afterIntent: await referralIntent(page), nativeHistory, timing: await navigationTiming(page), calls: flow.state.calls.slice(since) });
  }
});

for (const variant of ["accepts a freshly followed passive referral", "recovers from an unavailable passive referral", "restores without a creator follow"]) {
  test(`coupon-only retained draft ${variant}`, async ({ page, flow }, testInfo) => {
    const followsCreator = variant !== "restores without a creator follow";
    const unavailable = variant === "recovers from an unavailable passive referral";
    const responses = [];
    page.on("response", async response => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith("/api/ref/validate")) return;
      responses.push({ path: url.pathname, query: url.search, status: response.status(), data: await response.json() });
    });
    const snapshot = () => page.evaluate(() => ({
      url: location.href,
      passive: sessionStorage.getItem("referral_session"),
      journal: sessionStorage.getItem("referral_dismissed"),
      draft: JSON.parse(sessionStorage.getItem("booking_draft")),
      hold: JSON.parse(sessionStorage.getItem("my_slot_hold")),
      disabledButtons: [...document.querySelectorAll("button:disabled")].map(button => button.textContent),
      text: document.body.innerText,
    }));
    let before;
    let afterFollow;
    let afterRestore;
    let beforeTransition;
    let beforeRetry;
    let beforePayment;
    let automaticLookupCount;
    try {
      await page.goto("/tourney");
      await flow.review();
      await flow.codeInput("save20");
      await expect(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toBeVisible();
      await expect.poll(async () => (await snapshot()).draft?.packages["Performance Vertex Overhaul"]?.checkoutCodes?.coupon?.code).toBe("save20");
      before = await snapshot();
      const original = before.draft.packages[before.draft.lastTitle];
      expect(before.passive).toBeNull();
      expect(before.journal).toBeNull();
      expect(original.checkoutCodes.referral).toBeNull();
      expect(original.form).toEqual({ discord: "fixture_visitor", email: "visitor@example.invalid", specs: "Ryzen 7700 / RTX 4070", mainGame: "CS2", notes: "" });
      expect(before.hold.phase).toBe("active");
      expect(Date.parse(before.hold.expiresAt)).toBeGreaterThan(Date.now());
      expect(quoteCalls(flow, 0)).toHaveLength(0);
      beforeTransition = flow.state.calls.length;
      if (unavailable) {
        await page.route("**/api/ref/validateReferral?code=friend", async route => {
          flow.state.calls.push({ path: "/api/ref/validateReferral", query: "?code=friend", body: null });
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, reason: "unavailable" }) });
        });
      }
      if (followsCreator) {
        await page.goto("/reviews?ref=friend");
        await expect.poll(() => storedReferral(page)).toBe("friend");
        afterFollow = await snapshot();
        expect(JSON.parse(afterFollow.journal)).toEqual({ passiveCode: "friend", codes: { friend: "available" }, choices: {} });
      }
      await page.goto("/booking");
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
      if (followsCreator) await expect.poll(() => referralLookups(flow, beforeTransition, "friend").length).toBeGreaterThan(0);
      await expect(page.getByRole("button", { name: "Checking code...", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toHaveCount(followsCreator && !unavailable ? 1 : 0);
      for (const value of Object.values(original.form).filter(Boolean)) await expect(page.getByRole("dialog").getByText(value, { exact: true })).toBeVisible();
      afterRestore = await snapshot();
      expect(afterRestore.hold).toEqual(before.hold);
      expect(afterRestore.draft.packages[before.draft.lastTitle].form).toEqual(original.form);
      expect(flow.state.calls.slice(beforeTransition).filter(call => call.path === "/api/holdSlot")).toHaveLength(0);
      await expect.poll(() => responses.filter(response => new URLSearchParams(response.query).get("code") === "save20").length).toBe(4);
      expect(responses.filter(response => new URLSearchParams(response.query).get("code") === "save20").every(response => response.status === 200)).toBe(true);
      if (unavailable) {
        await expect(page.getByText("Code validation is temporarily unavailable. Try again or continue without this code.", { exact: true })).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Referral or coupon code", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
        automaticLookupCount = referralLookups(flow, beforeTransition, "friend").length;
        expect(automaticLookupCount).toBe(1);
        await page.waitForTimeout(700);
        expect(referralLookups(flow, beforeTransition, "friend")).toHaveLength(automaticLookupCount);
        expect(responses.filter(response => new URLSearchParams(response.query).get("code") === "friend").map(response => [response.path, response.status]).sort()).toEqual([["/api/ref/validateCoupon", 200], ["/api/ref/validateReferral", 503]]);
        await page.unroute("**/api/ref/validateReferral?code=friend");
        beforeRetry = flow.state.calls.length;
        await flow.codeInput("friend");
        await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toBeVisible();
        expect(referralLookups(flow, beforeRetry, "friend")).toHaveLength(1);
      } else if (followsCreator) {
        await expect.poll(() => responses.filter(response => new URLSearchParams(response.query).get("code") === "friend").length).toBe(2);
        expect(responses.filter(response => new URLSearchParams(response.query).get("code") === "friend").every(response => response.status === 200)).toBe(true);
      } else {
        expect(await storedReferral(page)).toBeNull();
        expect(referralLookups(flow, beforeTransition, "friend")).toHaveLength(0);
      }
      beforePayment = flow.state.calls.length;
      expect(quoteCalls(flow, 0)).toHaveLength(0);
      await flow.payment();
      await expect.poll(() => quoteCalls(flow, beforePayment).at(-1)?.body).toMatchObject({ referralCode: followsCreator ? "friend" : "", couponCode: "save20" });
    } finally {
      await attachJson(testInfo, "coupon-only-retained-draft", {
        variant, before, afterFollow, afterRestore, final: await snapshot(),
        beforeTransition, beforeRetry, beforePayment, automaticLookupCount,
        newQuotes: beforePayment === undefined ? [] : quoteCalls(flow, beforePayment),
        responses, calls: flow.state.calls,
      });
    }
  });
}

const retainedCheckout = page => page.evaluate(() => ({
  intent: {
    passive: sessionStorage.getItem("referral_session"),
    journal: sessionStorage.getItem("referral_dismissed"),
  },
  draft: JSON.parse(sessionStorage.getItem("booking_draft")),
  hold: JSON.parse(sessionStorage.getItem("my_slot_hold")),
  captureFailures: window.referralCaptureFailures || [],
  guard: sessionStorage.getItem("referral_capture"),
  url: location.href,
}));

for (const entry of ["direct booking", "public Book click"]) {
  test(`a failed fresh creator capture on ${entry} continues without attribution and recovers manually`, async ({ page, flow }, testInfo) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    const before = await retainedCheckout(page);
    expect(JSON.parse(before.intent.journal).codes.friend).toBe("available");
    expect(JSON.parse(before.intent.journal).choices[checkoutScope()]).toBe("friend");
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      window.referralCaptureFailures = [];
      window.restoreReferralSetter = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function(key, value) {
        if (key === "referral_dismissed" && JSON.parse(value).passiveCode === "save20" &&
          JSON.parse(value).codes.save20 === "available") {
          window.referralCaptureFailures.push({ key, value, previous: this.getItem(key), name: "QuotaExceededError" });
          throw new DOMException("Fresh creator journal denied", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
    });
    const since = flow.state.calls.length;
    let afterFailure;
    let paymentEmpty;
    let beforePayment;
    let beforeRecovery;
    try {
      if (entry === "direct booking") await page.goto("/booking?ref=save20");
      else {
        await page.goto("/?ref=save20");
        await expect.poll(() => page.evaluate(() => window.referralCaptureFailures.length)).toBeGreaterThan(0);
        await page.locator(".ri-package-book-button").first().click();
      }
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.referralCaptureFailures.length)).toBe(1);
      await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Referral or coupon code", exact: true })).toHaveValue("save20");
      await expect(page.getByRole("button", { name: /^Remove referral code / })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Checking code...", exact: true })).toHaveCount(0);
      afterFailure = await retainedCheckout(page);
      expect(afterFailure.intent).toEqual(before.intent);
      expect(afterFailure.hold).toEqual(before.hold);
      expect(afterFailure.draft.packages[before.draft.lastTitle].form).toEqual(before.draft.packages[before.draft.lastTitle].form);
      expect(afterFailure.draft.packages[before.draft.lastTitle].checkoutCodes).toEqual(before.draft.packages[before.draft.lastTitle].checkoutCodes);
      expect(afterFailure.draft.packages[before.draft.lastTitle].selectedPackage.title).toBe(before.draft.packages[before.draft.lastTitle].selectedPackage.title);
      for (const value of Object.values(before.draft.packages[before.draft.lastTitle].form).filter(Boolean)) {
        await expect(page.getByRole("dialog").getByText(value, { exact: true })).toBeVisible();
      }
      expect(referralLookups(flow, since, "friend")).toEqual([]);
      expect(referralLookups(flow, since, "save20")).toEqual([]);
      expect(quoteCalls(flow, since)).toEqual([]);
      beforePayment = flow.state.calls.length;
      await flow.payment();
      await expect(paymentCode(page)).toBeEnabled();
      await expect(paymentCode(page)).toHaveValue("save20");
      await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
      await waitQuote(flow, "", beforePayment);
      paymentEmpty = await retainedCheckout(page);
      expect(paymentEmpty.intent).toEqual(before.intent);
      expect(paymentEmpty.hold).toEqual(before.hold);
      expect(paymentEmpty.draft.packages[before.draft.lastTitle].form).toEqual(before.draft.packages[before.draft.lastTitle].form);
      expect(paymentEmpty.draft.packages[before.draft.lastTitle].checkoutCodes).toEqual(before.draft.packages[before.draft.lastTitle].checkoutCodes);
      expect(paymentEmpty.draft.packages[before.draft.lastTitle].selectedPackage.title).toBe(before.draft.packages[before.draft.lastTitle].selectedPackage.title);
      expect(quoteCalls(flow, since).every(call => call.body.referralCode === "")).toBe(true);
      expect(referralLookups(flow, since, "friend")).toEqual([]);
      expect(referralLookups(flow, since, "save20")).toEqual([]);
      const beforeReload = flow.state.calls.length;
      await page.reload();
      await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
      await expect(paymentCode(page)).toBeEnabled();
      const afterReload = await retainedCheckout(page);
      const reloadCalls = flow.state.calls.slice(beforeReload);
      await attachJson(testInfo, "failed-capture-payment-reload", {
        beforeReload, beforeReloadState: paymentEmpty, afterReload, reloadCalls,
        timing: await navigationTiming(page), referralInput: await paymentCode(page).inputValue(),
        storageErrorVisible: await page.getByRole("alert").filter({ hasText: storageError }).isVisible(),
      });
      await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
      await expect(paymentCode(page)).toHaveValue("save20");
      await waitQuote(flow, "", beforeReload);
      expect(referralLookups(flow, beforeReload, "friend")).toEqual([]);
      expect(afterReload.intent).toEqual(before.intent);
      await page.evaluate(() => window.restoreReferralSetter());
      beforeRecovery = flow.state.calls.length;
      await submitPaymentCode(page, "save20");
      await waitQuote(flow, "save20", beforeRecovery);
      expect(referralLookups(flow, beforeRecovery, "save20")).toHaveLength(1);
      expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
      expect((await envelope(page)).codes.save20).toBe("applied");
      expect(await storedReferral(page)).toBe("save20");
      expect(quoteCalls(flow, beforeRecovery).every(call => call.body.referralCode === "save20")).toBe(true);
      expect(quoteCalls(flow, since).every(call => ["", "save20"].includes(call.body.referralCode))).toBe(true);
      expect(referralLookups(flow, since, "friend")).toEqual([]);
      expect(await page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
      const beforeAcknowledgedReload = flow.state.calls.length;
      await page.reload();
      await expect(paymentCode(page)).toBeEnabled();
      await expect(paymentCode(page)).toHaveValue("save20");
      await expect(page.getByRole("alert").filter({ hasText: storageError })).toHaveCount(0);
      await waitQuote(flow, "save20", beforeAcknowledgedReload);
      expect(referralLookups(flow, beforeAcknowledgedReload, "friend")).toEqual([]);
      await attachJson(testInfo, "acknowledged-capture-reload", {
        beforeAcknowledgedReload, after: await retainedCheckout(page), calls: flow.state.calls.slice(beforeAcknowledgedReload),
      });
    } finally {
      await attachJson(testInfo, "failed-fresh-capture-recovery", {
        entry, before, afterFailure, paymentEmpty, final: await retainedCheckout(page), beforePayment, beforeRecovery,
        calls: flow.state.calls.slice(since), newQuotes: beforePayment === undefined ? [] : quoteCalls(flow, beforePayment),
        recoveredQuotes: beforeRecovery === undefined ? [] : quoteCalls(flow, beforeRecovery),
      });
    }
  });
}

const friendValidationPhases = async (page, flow, phase) => {
  for (const type of ["Referral", "Coupon"]) {
    await page.route(`**/api/ref/validate${type}?*`, async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("code") !== "friend" || phase.current === "valid") return route.fallback();
      flow.state.calls.push({ path: url.pathname, query: url.search, body: null, phase: phase.current });
      await route.fulfill({
        status: type === "Referral" && phase.current === "unavailable" ? 503 : 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, reason: type === "Referral" && phase.current === "unavailable" ? "unavailable" : "not_found" }),
      });
    });
  }
};

const unavailableMessage = "Code validation is temporarily unavailable. Try again or continue without this code.";
const invalidReferralMessage = "Invalid or inactive referral code.";

test("an unavailable Payment arrival keeps the referral input retryable and an invalid retry clears its passive code", async ({ page, flow }, testInfo) => {
  await startFriendPayment(page, flow);
  const phase = { current: "unavailable" };
  await friendValidationPhases(page, flow, phase);
  const since = flow.state.calls.length;
  let unavailable;
  let retry;
  try {
    await page.reload();
    await expect(paymentCode(page)).toBeEnabled();
    await expect(page.getByRole("alert").filter({ hasText: unavailableMessage })).toBeVisible();
    await expect(paymentCode(page)).toHaveValue("friend");
    await waitQuote(flow, "", since);
    expect(await storedReferral(page)).toBe("friend");
    await expect(page.locator("dt").filter({ hasText: /^Referral$/ })).toHaveCount(0);
    unavailable = { intent: await referralIntent(page), quotes: quoteCalls(flow, since) };
    phase.current = "invalid";
    retry = flow.state.calls.length;
    await submitPaymentCode(page, "friend");
    await expect(page.getByRole("alert").filter({ hasText: invalidReferralMessage })).toBeVisible();
    expect(await storedReferral(page)).toBeNull();
    expect((await envelope(page)).codes.friend).toBe("available");
    expect(quoteCalls(flow, retry)).toEqual([]);
  } finally {
    await attachJson(testInfo, "payment-arrival-unavailable-retry", {
      unavailable, retry, after: await referralIntent(page), calls: flow.state.calls.slice(since),
    });
  }
});

for (const blockedClear of [false, true]) {
  test(`a same-code invalid Payment retry removes its applied discount${blockedClear ? " despite a failed journal clear" : " and passive attribution"}`, async ({ page, flow }, testInfo) => {
    await startFriendPayment(page, flow);
    const before = await referralIntent(page);
    const phase = { current: "unavailable" };
    await friendValidationPhases(page, flow, phase);
    const since = flow.state.calls.length;
    let unavailable;
    let retry;
    try {
      await submitPaymentCode(page, "friend");
      await expect(paymentCode(page)).toBeEnabled();
      await expect(page.getByRole("alert").filter({ hasText: unavailableMessage })).toBeVisible();
      await expect(paymentCode(page)).toHaveValue("friend");
      await expect(page.locator("dt").filter({ hasText: /^Referral$/ })).toHaveCount(1);
      expect(await referralIntent(page)).toEqual(before);
      expect(quoteCalls(flow, since)).toEqual([]);
      expect(lastQuote(flow).body.referralCode).toBe("friend");
      unavailable = { intent: await referralIntent(page), quotes: quoteCalls(flow, since) };
      if (blockedClear) {
        await page.evaluate(() => {
          const original = Storage.prototype.setItem;
          window.referralClearFailures = [];
          Storage.prototype.setItem = function(key, value) {
            if (key === "referral_dismissed" && JSON.parse(value).passiveCode === "") {
              window.referralClearFailures.push({ key, value, previous: this.getItem(key), name: "QuotaExceededError" });
              throw new DOMException("Invalid referral clear denied", "QuotaExceededError");
            }
            return original.call(this, key, value);
          };
        });
      }
      phase.current = "invalid";
      retry = flow.state.calls.length;
      await submitPaymentCode(page, "friend");
      await expect(page.getByRole("alert").filter({ hasText: blockedClear ? storageError : invalidReferralMessage })).toBeVisible();
      await waitQuote(flow, "", retry);
      await expect(page.locator("dt").filter({ hasText: /^Referral$/ })).toHaveCount(0);
      if (blockedClear) {
        expect(await referralIntent(page)).toEqual(before);
        expect(await page.evaluate(() => window.referralClearFailures.length)).toBe(1);
      } else {
        expect(await storedReferral(page)).toBeNull();
        expect((await envelope(page)).codes.friend).toBe("available");
      }
    } finally {
      await attachJson(testInfo, "payment-same-code-invalid-retry", {
        blockedClear, before, unavailable, retry, after: await referralIntent(page),
        clearFailures: await page.evaluate(() => window.referralClearFailures || []),
        calls: flow.state.calls.slice(since), newQuotes: retry === undefined ? [] : quoteCalls(flow, retry),
      });
    }
  });
}

test("quick Continue on a fresh direct creator link never quotes the prior creator", async ({ page, flow }, testInfo) => {
  flow.state.collision = true;
  await startFriendPayment(page, flow);
  let since = flow.state.calls.length;
  await submitPaymentCode(page, "");
  await waitQuote(flow, "", since);
  const before = await retainedCheckout(page);
  since = flow.state.calls.length;
  try {
    await page.goto("/booking?ref=save20");
    await page.getByRole("button", { name: "Continue to payment", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
    await expect(paymentCode(page)).toBeEnabled();
    await waitQuote(flow, "save20", since);
    expect(quoteCalls(flow, since).every(call => call.body.referralCode === "save20")).toBe(true);
    expect(referralLookups(flow, since, "friend")).toEqual([]);
    expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
  } finally {
    await attachJson(testInfo, "quick-continue-fresh-creator", {
      before, after: await retainedCheckout(page), calls: flow.state.calls.slice(since), newQuotes: quoteCalls(flow, since),
    });
  }
});

const expectRetainedCaptureData = (after, before) => {
  expect(after.intent).toEqual(before.intent);
  expect(after.hold).toEqual(before.hold);
  expect(after.draft.packages[before.draft.lastTitle].form).toEqual(before.draft.packages[before.draft.lastTitle].form);
  expect(after.draft.packages[before.draft.lastTitle].checkoutCodes).toEqual(before.draft.packages[before.draft.lastTitle].checkoutCodes);
};

const recoverDurableReferral = async (page, flow, code) => {
  const beforeManual = flow.state.calls.length;
  await submitPaymentCode(page, code);
  await waitQuote(flow, code, beforeManual);
  expect(referralLookups(flow, beforeManual, code)).toHaveLength(1);
  expect(await page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
  const afterManual = await retainedCheckout(page);
  const beforeReload = flow.state.calls.length;
  await page.reload();
  await expect(paymentCode(page)).toBeEnabled();
  await expect(paymentCode(page)).toHaveValue(code);
  await expect(page.getByRole("alert").filter({ hasText: storageError })).toHaveCount(0);
  await waitQuote(flow, code, beforeReload);
  return { beforeManual, afterManual, beforeReload, afterReload: await retainedCheckout(page), calls: flow.state.calls.slice(beforeManual) };
};

test("durable capture treats a missing legacy guard as unconfirmed until explicit reapplication", async ({ page, flow }, testInfo) => {
  await startFriendPayment(page, flow);
  const before = await retainedCheckout(page);
  await page.evaluate(() => sessionStorage.removeItem("referral_capture"));
  const since = flow.state.calls.length;
  let unconfirmed;
  let recovery;
  try {
    await page.reload();
    await expect(paymentCode(page)).toBeEnabled();
    unconfirmed = await retainedCheckout(page);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    await waitQuote(flow, "", since);
    expect(referralLookups(flow, since, "friend")).toEqual([]);
    expectRetainedCaptureData(unconfirmed, before);
    recovery = await recoverDurableReferral(page, flow, "friend");
  } finally {
    await attachJson(testInfo, "legacy-unconfirmed-capture", {
      before, unconfirmed, recovery, final: await retainedCheckout(page), since, calls: flow.state.calls.slice(since),
    });
  }
});

for (const failure of ["guard allocation", "native full store"]) {
  test(`durable capture refuses a fresh creator after ${failure} across Payment reload`, async ({ page, flow }, testInfo) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    const before = await retainedCheckout(page);
    const quota = failure === "native full store" ? await fillSessionQuota(page) : null;
    if (quota) {
      expect(quota.exception).toBe("QuotaExceededError");
      expect(quota.extraCharacterError).toBe("QuotaExceededError");
    }
    await page.addInitScript(blockGuard => {
      const setter = Storage.prototype.setItem;
      const remover = Storage.prototype.removeItem;
      window.captureStorageOperations = [];
      window.restoreCaptureStorage = () => {
        Storage.prototype.setItem = setter;
        Storage.prototype.removeItem = remover;
      };
      Storage.prototype.setItem = function(key, value) {
        const observed = ["referral_capture", "referral_dismissed", "referral_session"].includes(key);
        try {
          if (blockGuard && key === "referral_capture") throw new DOMException("Capture guard denied", "QuotaExceededError");
          const result = setter.call(this, key, value);
          if (observed) window.captureStorageOperations.push({ operation: "set", key, value, result: "success" });
          return result;
        } catch (error) {
          if (observed) window.captureStorageOperations.push({ operation: "set", key, value, error: error.name });
          throw error;
        }
      };
      Storage.prototype.removeItem = function(key) {
        const result = remover.call(this, key);
        if (key === "referral_capture") window.captureStorageOperations.push({ operation: "remove", key, result: "success" });
        return result;
      };
    }, failure === "guard allocation");
    const since = flow.state.calls.length;
    let afterCapture;
    let captureOperations;
    let beforePayment;
    let beforeReload;
    let afterReload;
    let recovery;
    try {
      await page.goto("/booking?ref=save20");
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
      afterCapture = await retainedCheckout(page);
      captureOperations = await page.evaluate(() => window.captureStorageOperations);
      expectRetainedCaptureData(afterCapture, before);
      expect(captureOperations.some(operation => operation.error === "QuotaExceededError")).toBe(true);
      expect(captureOperations.filter(operation => operation.key === "referral_dismissed")).toEqual([]);
      if (failure === "guard allocation") {
        expect(afterCapture.guard).toBeNull();
        expect(captureOperations.some(operation => operation.operation === "remove" && operation.key === "referral_capture")).toBe(true);
      } else expect(["", null]).toContain(afterCapture.guard);
      beforePayment = flow.state.calls.length;
      await flow.payment();
      await expect(paymentCode(page)).toBeEnabled();
      await waitQuote(flow, "", beforePayment);
      beforeReload = flow.state.calls.length;
      await page.reload();
      await expect(paymentCode(page)).toBeEnabled();
      afterReload = await retainedCheckout(page);
      await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
      await waitQuote(flow, "", beforeReload);
      expect(referralLookups(flow, since, "friend")).toEqual([]);
      expect(quoteCalls(flow, since).every(call => call.body.referralCode === "")).toBe(true);
      expectRetainedCaptureData(afterReload, before);
      await page.evaluate(() => {
        window.restoreCaptureStorage();
        sessionStorage.removeItem("roo-referral-quota");
      });
      recovery = await recoverDurableReferral(page, flow, "save20");
    } finally {
      await attachJson(testInfo, "failed-capture-guard-allocation", {
        failure, before, quota, afterCapture, captureOperations, beforePayment, beforeReload, afterReload, recovery,
        final: await retainedCheckout(page), finalOperations: await page.evaluate(() => window.captureStorageOperations || []),
        since, calls: flow.state.calls.slice(since),
      });
    }
  });
}

test("durable capture refusal survives a real opener session clone without changing the original", async ({ page, flow }, testInfo) => {
  flow.state.collision = true;
  await startFriendPayment(page, flow);
  const before = await retainedCheckout(page);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "referral_dismissed" && JSON.parse(value).passiveCode === "save20") {
        throw new DOMException("Fresh creator journal denied", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });
  const since = flow.state.calls.length;
  let original;
  let clone;
  let popup;
  let beforePopup;
  let hasOpener;
  try {
    await page.goto("/booking?ref=save20");
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    const beforePayment = flow.state.calls.length;
    await flow.payment();
    await expect(paymentCode(page)).toBeEnabled();
    await waitQuote(flow, "", beforePayment);
    original = await retainedCheckout(page);
    beforePopup = flow.state.calls.length;
    [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.evaluate(() => { window.open("/payment", "_blank"); }),
    ]);
    await expect(popup.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
    await expect(paymentCode(popup)).toBeEnabled();
    hasOpener = await popup.evaluate(() => window.opener !== null);
    clone = await retainedCheckout(popup);
    expect(hasOpener).toBe(true);
    await expect(popup.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    await expect(paymentCode(popup)).toHaveValue("save20");
    await waitQuote(flow, "", beforePopup);
    expect(referralLookups(flow, beforePopup, "friend")).toEqual([]);
    expect(JSON.parse(clone.guard)).toEqual({ code: "save20" });
    expect(clone.guard).toBe(original.guard);
    expectRetainedCaptureData(clone, before);
    expect(await retainedCheckout(page)).toEqual(original);
  } finally {
    await attachJson(testInfo, "cloned-capture-refusal", {
      before, original, clone, hasOpener, beforePopup, since, calls: flow.state.calls.slice(since),
      finalOriginal: await retainedCheckout(page),
    });
    if (popup) await popup.close();
  }
});

test.describe("referral restoration from the browser cache", () => {
  const cachedTest = test.extend({
    launchOptions: async ({ launchOptions }, use) => {
      await use({ ...launchOptions, ignoreDefaultArgs: ["--disable-back-forward-cache"] });
    },
    bfcache: [async ({ page, browser, flow }, use, testInfo) => {
      const evidence = { timeline: [], notRestored: [], pageErrors: [], documents: [] };
      page.on("console", message => {
        if (message.text().startsWith("roo475-bfcache:")) {
          evidence.timeline.push({ observedAt: new Date().toISOString(), ...JSON.parse(message.text().slice(15)) });
        }
      });
      page.on("pageerror", error => evidence.pageErrors.push({ name: error.name, message: error.message }));
      page.on("response", async response => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          evidence.documents.push({ url: response.url(), status: response.status(), headers: await response.allHeaders() });
        }
      });
      const session = await page.context().newCDPSession(page);
      await session.send("Page.enable");
      session.on("Page.backForwardCacheNotUsed", event => evidence.notRestored.push(event));
      const browserSession = await browser.newBrowserCDPSession();
      evidence.engine = await browserSession.send("Browser.getVersion");
      evidence.commandLine = await browserSession.send("Browser.getBrowserCommandLine");
      await browserSession.detach();
      expect(evidence.commandLine.arguments).not.toContain("--disable-back-forward-cache");
      await page.addInitScript(() => {
        const nonce = crypto.randomUUID();
        const observation = window.referralBfcache = { nonce, pageshows: [], pagehides: [] };
        const record = (kind, event) => {
          const entry = { persisted: event.persisted, url: location.href, time: performance.now() };
          observation[kind].push(entry);
          console.debug("roo475-bfcache:" + JSON.stringify({ kind, nonce, ...entry }));
        };
        window.addEventListener("pageshow", event => record("pageshows", event));
        window.addEventListener("pagehide", event => record("pagehides", event));
      });
      try {
        await use(evidence);
      } finally {
        evidence.final = await snapshot(page);
        evidence.calls = flow.state.calls;
        evidence.newQuotes = quoteCalls(flow, evidence.backBoundary ?? 0);
        await attachJson(testInfo, "cached-referral-runtime", evidence);
        await session.detach();
        expect(evidence.pageErrors).toEqual([]);
        expect(flow.state.calls.filter(call => /\/api\/payment\/(start|capture|confirm|finalize)(\/|$)/.test(call.path))).toEqual([]);
      }
    }, { auto: true }],
  });

  const snapshot = async page => ({
    retained: await page.evaluate(() => {
      const read = key => (window.referralOriginalGetter || Storage.prototype.getItem).call(sessionStorage, key);
      return {
        intent: { passive: read("referral_session"), journal: read("referral_dismissed") },
        guard: read("referral_capture"),
        draft: JSON.parse(read("booking_draft")),
        hold: JSON.parse(read("my_slot_hold")),
        captureFailures: window.referralCaptureFailures || [],
        url: location.href,
      };
    }),
    observation: await page.evaluate(() => ({
      ...window.referralBfcache,
      query: location.search,
      navigation: performance.getEntriesByType("navigation").map(entry => ({
        type: entry.type,
        notRestoredReasons: entry.notRestoredReasons?.toJSON?.() ?? entry.notRestoredReasons ?? null,
      })),
    })),
    paymentInput: await paymentCode(page).count() ? await paymentCode(page).inputValue() : null,
    bookingInput: await page.getByRole("textbox", { name: "Referral or coupon code", exact: true }).count()
      ? await page.getByRole("textbox", { name: "Referral or coupon code", exact: true }).inputValue() : null,
    storageErrorVisible: await page.getByRole("alert").filter({ hasText: storageError }).isVisible(),
    referralGrants: await page.locator("dt").filter({ hasText: /^Referral$/ }).allTextContents(),
    referralBadges: await page.getByRole("button", { name: /^Remove referral code / }).allTextContents(),
    alerts: await page.getByRole("alert").allTextContents(),
    body: await page.locator("body").innerText(),
  });

  const denyFreshBJournal = page => page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    window.referralCaptureFailures = [];
    window.restoreReferralSetter = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key, value) {
      if (key === "referral_dismissed" && JSON.parse(value).passiveCode === "save20" &&
        JSON.parse(value).codes.save20 === "available") {
        window.referralCaptureFailures.push({ key, value, previous: this.getItem(key), name: "QuotaExceededError" });
        throw new DOMException("Fresh creator journal denied", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });

  const observeBack = async (page, flow, evidence, testInfo) => {
    evidence.backBoundary = flow.state.calls.length;
    evidence.backAt = new Date().toISOString();
    await page.goBack({ waitUntil: "commit" });
    await expect.poll(() => page.evaluate(() => window.referralBfcache?.pageshows.some(event => event.persisted))).toBe(true);
    evidence.afterBack = await snapshot(page);
    await attachJson(testInfo, "cached-referral-before-product-assertions", {
      before: evidence.before, otherDocument: evidence.otherDocument, afterBack: evidence.afterBack,
      calls: flow.state.calls, backBoundary: evidence.backBoundary, notRestored: evidence.notRestored,
    });
    expect(evidence.afterBack.observation.pageshows.some(event => event.persisted === true)).toBe(true);
    expect(evidence.afterBack.observation.nonce).toBe(evidence.before.observation.nonce);
    expect(evidence.otherDocument.observation.nonce).not.toBe(evidence.before.observation.nonce);
  };

  const expectFormAndHold = (after, before) => {
    expect(after.hold).toEqual(before.hold);
    expect(after.draft.packages[before.draft.lastTitle].form).toEqual(before.draft.packages[before.draft.lastTitle].form);
    expect(after.draft.packages[before.draft.lastTitle].selectedPackage).toEqual(before.draft.packages[before.draft.lastTitle].selectedPackage);
  };

  const acknowledgeBInBooking = async (page, flow, evidence) => {
    await page.goto("/booking");
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    await page.evaluate(() => window.restoreReferralSetter());
    const since = flow.state.calls.length;
    await flow.codeInput("save20");
    await expect(page.getByRole("button", { name: "Remove referral code save20", exact: true })).toBeVisible();
    expect(referralLookups(flow, since, "save20")).toHaveLength(1);
    const journal = await envelope(page);
    expect(journal.codes.save20).toBe("applied");
    expect(journal.choices[checkoutScope()]).toBe("save20");
    expect(await storedReferral(page)).toBe("save20");
    expect(await page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
    evidence.otherDocument = await snapshot(page);
    expectFormAndHold(evidence.otherDocument.retained, evidence.before.retained);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
  };

  cachedTest("cached referral Payment rejects a newly pending capture", async ({ page, flow, bfcache }, testInfo) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    await expect(paymentCode(page)).toBeEnabled();
    bfcache.before = await snapshot(page);
    bfcache.oldQuotes = quoteCalls(flow, 0);
    await denyFreshBJournal(page);
    const since = flow.state.calls.length;
    await page.goto("/reviews?ref=save20");
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe(JSON.stringify({ code: "save20" }));
    bfcache.otherDocument = await snapshot(page);
    expect(bfcache.otherDocument.retained.intent).toEqual(bfcache.before.retained.intent);
    expect(bfcache.otherDocument.retained.captureFailures).toHaveLength(1);
    expect(quoteCalls(flow, since)).toEqual([]);
    await observeBack(page, flow, bfcache, testInfo);
    await expect(page.locator("dt").filter({ hasText: /^Referral$/ })).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    await expect(paymentCode(page)).toHaveValue("save20");
    await waitQuote(flow, "", bfcache.backBoundary);
    expect(quoteCalls(flow, bfcache.backBoundary).every(call => call.body.referralCode === "")).toBe(true);
    expect(referralLookups(flow, bfcache.backBoundary, "friend")).toEqual([]);
    expectRetainedCaptureData(await retainedCheckout(page), bfcache.before.retained);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
  });

  cachedTest("cached referral Payment observes later manual acknowledgement", async ({ page, flow, bfcache }, testInfo) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    const acknowledgedA = await retainedCheckout(page);
    await denyFreshBJournal(page);
    await page.goto("/booking?ref=save20");
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    const beforePayment = flow.state.calls.length;
    await flow.payment();
    await expect(paymentCode(page)).toHaveValue("save20");
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    await waitQuote(flow, "", beforePayment);
    bfcache.before = await snapshot(page);
    expectRetainedCaptureData(bfcache.before.retained, acknowledgedA);
    await acknowledgeBInBooking(page, flow, bfcache);
    await observeBack(page, flow, bfcache, testInfo);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toHaveCount(0);
    await expect(paymentCode(page)).toHaveValue("save20");
    await expect(page.locator("dt").filter({ hasText: /^Referral$/ })).toHaveCount(1);
    await waitQuote(flow, "save20", bfcache.backBoundary);
    expect(quoteCalls(flow, bfcache.backBoundary).every(call => call.body.referralCode === "save20")).toBe(true);
    expect(referralLookups(flow, bfcache.backBoundary, "friend")).toEqual([]);
    expectFormAndHold(await retainedCheckout(page), bfcache.before.retained);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
  });

  cachedTest("cached referral Payment preserves unchanged acknowledged intent", async ({ page, flow, bfcache }, testInfo) => {
    await startFriendPayment(page, flow);
    await expect(paymentCode(page)).toBeEnabled();
    bfcache.before = await snapshot(page);
    bfcache.oldQuotes = quoteCalls(flow, 0);
    await page.goto("/about");
    bfcache.otherDocument = await snapshot(page);
    expect(bfcache.otherDocument.retained.intent).toEqual(bfcache.before.retained.intent);
    await observeBack(page, flow, bfcache, testInfo);
    await expect(paymentCode(page)).toHaveValue("friend");
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toHaveCount(0);
    await expect(page.locator("dt").filter({ hasText: /^Referral$/ })).toHaveCount(1);
    expectRetainedCaptureData(await retainedCheckout(page), bfcache.before.retained);
    expect(quoteCalls(flow, bfcache.backBoundary)).toEqual([]);
  });

  cachedTest("cached referral Booking rejects a newly pending capture", async ({ page, flow, bfcache }, testInfo) => {
    flow.state.collision = true;
    await page.goto("/booking?ref=friend");
    await reserveAndReview(page, flow);
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    bfcache.before = await snapshot(page);
    await denyFreshBJournal(page);
    const since = flow.state.calls.length;
    await page.goto("/reviews?ref=save20");
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe(JSON.stringify({ code: "save20" }));
    bfcache.otherDocument = await snapshot(page);
    expect(bfcache.otherDocument.retained.intent).toEqual(bfcache.before.retained.intent);
    expect(bfcache.otherDocument.retained.captureFailures).toHaveLength(1);
    expect(quoteCalls(flow, since)).toEqual([]);
    await observeBack(page, flow, bfcache, testInfo);
    await expect(page.getByRole("button", { name: /^Remove referral code / })).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Referral or coupon code", exact: true })).toHaveValue("save20");
    expectRetainedCaptureData(await retainedCheckout(page), bfcache.before.retained);
    expectFormAndHold(await retainedCheckout(page), bfcache.before.retained);
    await flow.payment();
    await waitQuote(flow, "", bfcache.backBoundary);
    expect(quoteCalls(flow, bfcache.backBoundary).every(call => call.body.referralCode === "")).toBe(true);
    expect(referralLookups(flow, bfcache.backBoundary, "friend")).toEqual([]);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
  });

  cachedTest("cached referral Booking observes later manual acknowledgement", async ({ page, flow, bfcache }, testInfo) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    await denyFreshBJournal(page);
    await page.goto("/booking?ref=save20");
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Referral or coupon code", exact: true })).toHaveValue("save20");
    bfcache.before = await snapshot(page);
    await acknowledgeBInBooking(page, flow, bfcache);
    await observeBack(page, flow, bfcache, testInfo);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove referral code save20", exact: true })).toBeVisible();
    expectFormAndHold(await retainedCheckout(page), bfcache.before.retained);
    await flow.payment();
    await waitQuote(flow, "save20", bfcache.backBoundary);
    expect(quoteCalls(flow, bfcache.backBoundary).every(call => call.body.referralCode === "save20")).toBe(true);
    expect(referralLookups(flow, bfcache.backBoundary, "friend")).toEqual([]);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
  });

  cachedTest("cached referral Payment refuses unreadable restored storage", async ({ page, flow, bfcache }, testInfo) => {
    await startFriendPayment(page, flow);
    await expect(paymentCode(page)).toBeEnabled();
    bfcache.before = await snapshot(page);
    await page.evaluate(() => {
      const original = Storage.prototype.getItem;
      window.referralOriginalGetter = original;
      window.restoreReferralGetter = () => { Storage.prototype.getItem = original; };
      Storage.prototype.getItem = function(key) {
        if (["referral_capture", "referral_dismissed", "referral_session"].includes(key)) {
          throw new DOMException("Referral storage read denied", "SecurityError");
        }
        return original.call(this, key);
      };
    });
    await page.goto("/about");
    bfcache.otherDocument = await snapshot(page);
    await observeBack(page, flow, bfcache, testInfo);
    expect(await page.evaluate(() => {
      try { sessionStorage.getItem("referral_capture"); return null; }
      catch (error) { return error.name; }
    })).toBe("SecurityError");
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    await expect(paymentCode(page)).toHaveValue("");
    await expect(page.locator("dt").filter({ hasText: /^Referral$/ })).toHaveCount(0);
    await waitQuote(flow, "", bfcache.backBoundary);
    expect(referralLookups(flow, bfcache.backBoundary, "friend")).toEqual([]);
    bfcache.afterRefusal = await snapshot(page);
    expectRetainedCaptureData(bfcache.afterRefusal.retained, bfcache.before.retained);
    expect(bfcache.afterRefusal.retained.guard).toBe(bfcache.before.retained.guard);
    await page.evaluate(() => window.restoreReferralGetter());
    bfcache.manualBoundary = flow.state.calls.length;
    await submitPaymentCode(page, "friend");
    await waitQuote(flow, "friend", bfcache.manualBoundary);
    expect(referralLookups(flow, bfcache.manualBoundary, "friend")).toHaveLength(1);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toHaveCount(0);
    await expect(page.locator("dt").filter({ hasText: /^Referral$/ })).toHaveCount(1);
    expect(await page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
    expectFormAndHold(await retainedCheckout(page), bfcache.before.retained);
  });

  for (const restoreBeforeReserve of [false, true]) {
    cachedTest(`cached referral Booking stays usable when referral storage is blocked ${restoreBeforeReserve ? "before" : "after"} reservation`, async ({ page, flow, bfcache }, testInfo) => {
      await page.addInitScript(() => {
        const originalGet = Storage.prototype.getItem;
        const originalSet = Storage.prototype.setItem;
        window.referralOriginalGetter = originalGet;
        const blocked = key => ["referral_capture", "referral_dismissed", "referral_session"].includes(key);
        Storage.prototype.getItem = function(key) {
          if (blocked(key)) throw new DOMException("Referral storage denied", "SecurityError");
          return originalGet.call(this, key);
        };
        Storage.prototype.setItem = function(key, value) {
          if (blocked(key)) throw new DOMException("Referral storage denied", "SecurityError");
          return originalSet.call(this, key, value);
        };
      });
      await page.goto("/booking");
      if (!restoreBeforeReserve) {
        await reserveAndReview(page, flow);
        await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
        await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled();
        await expect(page.getByRole("textbox", { name: "Referral or coupon code", exact: true })).toBeEnabled();
      }
      bfcache.before = await snapshot(page);
      await page.goto("/about");
      bfcache.otherDocument = await snapshot(page);
      await observeBack(page, flow, bfcache, testInfo);
      if (restoreBeforeReserve) await reserveAndReview(page, flow);
      bfcache.afterReview = await snapshot(page);
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
      await expect(page.getByRole("button", { name: "Checking code...", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled();
      const input = page.getByRole("textbox", { name: "Referral or coupon code", exact: true });
      await expect(input).toBeEnabled();
      await input.fill("friend");
      await expect(input).toHaveValue("friend");
      if (!restoreBeforeReserve) expectFormAndHold(bfcache.afterReview.retained, bfcache.before.retained);
      bfcache.continueBoundary = flow.state.calls.length;
      await flow.payment();
      await waitQuote(flow, "", bfcache.continueBoundary);
      expect(quoteCalls(flow, bfcache.continueBoundary).every(call => call.body.referralCode === "")).toBe(true);
      expect(referralLookups(flow, bfcache.backBoundary, "friend")).toEqual([]);
      expectFormAndHold((await snapshot(page)).retained, bfcache.afterReview.retained);
      expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
    });
  }

  for (const variant of ["normal", "newer choice", "journal denial"]) {
    cachedTest(`an unavailable automatic referral stays removed after empty Payment Apply with ${variant}`, async ({ page, flow, bfcache }, testInfo) => {
      flow.state.collision = true;
      await startFriendPayment(page, flow);
      const phase = { current: "unavailable" };
      await friendValidationPhases(page, flow, phase);
      bfcache.arrivalBoundary = flow.state.calls.length;
      await page.reload();
      await expect(paymentCode(page)).toBeEnabled();
      await expect(page.getByRole("alert").filter({ hasText: unavailableMessage })).toBeVisible();
      await expect(paymentCode(page)).toHaveValue("friend");
      await expect(page.locator("dt").filter({ hasText: /^Referral$/ })).toHaveCount(0);
      await waitQuote(flow, "", bfcache.arrivalBoundary);
      bfcache.before = await snapshot(page);
      if (variant === "newer choice") {
        await page.evaluate(scope => {
          const journal = JSON.parse(sessionStorage.getItem("referral_dismissed"));
          journal.passiveCode = "save20";
          journal.codes.save20 = "applied";
          journal.choices[scope] = "save20";
          sessionStorage.setItem("referral_dismissed", JSON.stringify(journal));
          sessionStorage.setItem("referral_session", "save20");
        }, checkoutScope());
      }
      if (variant === "journal denial") {
        await page.evaluate(() => {
          const original = Storage.prototype.setItem;
          window.restoreRemovalSetter = () => { Storage.prototype.setItem = original; };
          window.referralRemovalFailures = [];
          Storage.prototype.setItem = function(key, value) {
            if (key === "referral_dismissed" && JSON.parse(value).codes.friend === "removed") {
              window.referralRemovalFailures.push({ key, value, previous: this.getItem(key) });
              throw new DOMException("Removal journal denied", "QuotaExceededError");
            }
            return original.call(this, key, value);
          };
        });
      }
      bfcache.beforeEmpty = await snapshot(page);
      bfcache.emptyBoundary = flow.state.calls.length;
      await submitPaymentCode(page, "");
      if (variant === "journal denial") {
        await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
        expect(await referralIntent(page)).toEqual(bfcache.beforeEmpty.retained.intent);
        expect(await page.evaluate(() => window.referralRemovalFailures.length)).toBe(1);
        bfcache.deniedRemoval = await snapshot(page);
        await page.evaluate(() => window.restoreRemovalSetter());
        await submitPaymentCode(page, "");
      }
      expect((await envelope(page)).codes.friend).toBe("removed");
      expect(await storedReferral(page)).toBe(variant === "newer choice" ? "save20" : null);
      if (variant === "newer choice") {
        expect((await envelope(page)).codes.save20).toBe("applied");
        expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
      }
      expect(await page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
      bfcache.afterEmpty = await snapshot(page);
      phase.current = "valid";
      bfcache.reloadBoundary = flow.state.calls.length;
      await page.reload();
      await waitQuote(flow, variant === "newer choice" ? "save20" : "", bfcache.reloadBoundary);
      await expect(paymentCode(page)).toHaveValue(variant === "newer choice" ? "save20" : "");
      expect(referralLookups(flow, bfcache.reloadBoundary, "friend")).toEqual([]);
      expect((await envelope(page)).codes.friend).toBe("removed");
      await expect(page.locator("dt").filter({ hasText: /^Referral$/ })).toHaveCount(variant === "newer choice" ? 1 : 0);
      expectFormAndHold(await retainedCheckout(page), bfcache.before.retained);
      await attachJson(testInfo, "unavailable-empty-payment-removal", {
        variant, before: bfcache.before, beforeEmpty: bfcache.beforeEmpty, afterEmpty: bfcache.afterEmpty,
        final: await snapshot(page), calls: flow.state.calls.slice(bfcache.emptyBoundary),
      });
    });
  }

  cachedTest("empty Payment Apply preserves a failed capture until explicit manual acknowledgement", async ({ page, flow, bfcache }) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    await denyFreshBJournal(page);
    await page.goto("/booking?ref=save20");
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    const beforePayment = flow.state.calls.length;
    await flow.payment();
    await waitQuote(flow, "", beforePayment);
    await expect(paymentCode(page)).toHaveValue("save20");
    bfcache.before = await snapshot(page);
    await submitPaymentCode(page, "");
    bfcache.afterEmpty = await snapshot(page);
    expect(bfcache.afterEmpty.retained.intent).toEqual(bfcache.before.retained.intent);
    expect(bfcache.afterEmpty.retained.guard).toBe(JSON.stringify({ code: "save20" }));
    bfcache.reloadBoundary = flow.state.calls.length;
    await page.reload();
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    await expect(paymentCode(page)).toHaveValue("save20");
    await waitQuote(flow, "", bfcache.reloadBoundary);
    expect(referralLookups(flow, bfcache.reloadBoundary, "friend")).toEqual([]);
    expect(referralLookups(flow, bfcache.reloadBoundary, "save20")).toEqual([]);
    expect((await snapshot(page)).retained.intent).toEqual(bfcache.before.retained.intent);
    expectFormAndHold(await retainedCheckout(page), bfcache.before.retained);
  });

  for (const inputType of ["Referral", "Coupon"]) {
    cachedTest(`an obsolete manual ${inputType} response cannot replace a newer acknowledged referral after cached restore`, async ({ page, flow, bfcache }, testInfo) => {
      flow.state.collision = true;
      await startFriendPayment(page, flow);
      await expect(paymentCode(page)).toBeEnabled();
      bfcache.beforeManual = await snapshot(page);
      bfcache.manualNetwork = [];
      page.on("requestfinished", request => {
        const url = new URL(request.url());
        if (url.pathname.startsWith("/api/ref/validate")) {
          bfcache.manualNetwork.push({ kind: "requestfinished", url: request.url(), observedAt: new Date().toISOString() });
        }
      });
      await page.evaluate(scope => {
        const originalFetch = window.fetch;
        const originalSet = Storage.prototype.setItem;
        let release;
        let selected = false;
        const gate = new Promise(resolve => { release = resolve; });
        const audit = window.referralManualContinuation = { events: [], released: false, resumed: false };
        const record = (kind, details = {}) => audit.events.push({ kind, time: performance.now(), at: Date.now(), ...details });
        window.fetch = async function(input, options) {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          const hold = !selected && url.pathname === "/api/ref/validateReferral" && url.searchParams.get("code") === "friend";
          if (hold) selected = true;
          const response = await originalFetch.call(this, input, options);
          if (hold) {
            const originalJson = response.json.bind(response);
            response.json = async () => {
              const data = await originalJson();
              record("network-json-complete", { url: url.href, ok: response.ok });
              await gate;
              audit.resumed = true;
              record("json-continuation-resumed");
              return data;
            };
          }
          return response;
        };
        Storage.prototype.setItem = function(key, value) {
          if (key === "referral_dismissed") {
            const journal = JSON.parse(value);
            record("journal-write", { code: journal.choices[scope], passiveCode: journal.passiveCode });
          }
          return originalSet.call(this, key, value);
        };
        window.addEventListener("pageshow", event => {
          if (!event.persisted) return;
          record("pageshow-release", { persisted: event.persisted, nonce: window.referralBfcache.nonce });
          audit.released = true;
          release();
        });
      }, checkoutScope());
      const finished = page.waitForEvent("requestfinished", request => {
        const url = new URL(request.url());
        return url.pathname === "/api/ref/validateReferral" && url.searchParams.get("code") === "friend";
      });
      await submitPaymentCode(page, "friend", inputType);
      await finished;
      await expect.poll(() => page.evaluate(() => window.referralManualContinuation.events.some(event => event.kind === "network-json-complete"))).toBe(true);
      expect(await page.evaluate(() => window.referralManualContinuation.resumed)).toBe(false);
      bfcache.before = await snapshot(page);
      bfcache.beforeContinuation = await page.evaluate(() => window.referralManualContinuation);
      await page.goto("/booking");
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
      await flow.codeInput("save20");
      await expect(page.getByRole("button", { name: "Remove referral code save20", exact: true })).toBeVisible();
      expect((await envelope(page)).codes.save20).toBe("applied");
      expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
      expect(await page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
      bfcache.otherDocument = await snapshot(page);
      await observeBack(page, flow, bfcache, testInfo);
      await expect.poll(() => page.evaluate(() => window.referralManualContinuation.resumed)).toBe(true);
      bfcache.afterContinuation = await page.evaluate(() => window.referralManualContinuation);
      await attachJson(testInfo, "obsolete-manual-response-ordering", {
        inputType, before: bfcache.beforeContinuation, after: bfcache.afterContinuation,
        network: bfcache.manualNetwork, afterBack: await snapshot(page), calls: flow.state.calls,
      });
      const events = bfcache.afterContinuation.events;
      expect(events.findIndex(event => event.kind === "network-json-complete")).toBeLessThan(events.findIndex(event => event.kind === "pageshow-release"));
      expect(events.findIndex(event => event.kind === "pageshow-release")).toBeLessThan(events.findIndex(event => event.kind === "json-continuation-resumed"));
      expect(events.filter(event => event.kind === "journal-write" && event.code === "friend")).toEqual([]);
      expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
      expect(await storedReferral(page)).toBe("save20");
      await waitQuote(flow, "save20", bfcache.backBoundary);
      expect(quoteCalls(flow, bfcache.backBoundary).every(call => call.body.referralCode === "save20")).toBe(true);
      await expect(paymentCode(page)).toHaveValue("save20");
      expect(referralLookups(flow, bfcache.backBoundary, "friend")).toEqual([]);
      expectFormAndHold(await retainedCheckout(page), bfcache.beforeManual.retained);
      expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
    });
  }

  const scopePackages = { X: "Performance Vertex Overhaul", Y: "Performance Vertex Max" };
  const scopeForm = label => ({
    discord: `${label}_scope_visitor`, email: `${label}-visitor@example.invalid`,
    specs: `${label.toUpperCase()} Ryzen 9800X3D / RTX 5080`, mainGame: label === "y" ? "Valorant" : "CS2",
  });
  const fillScopeForm = async (page, label) => {
    const form = scopeForm(label);
    for (const [name, value] of [["Discord username", form.discord], ["Booking email", form.email],
      ["PC specifications", form.specs], ["Main game or application", form.mainGame]]) {
      await page.getByRole("textbox", { name, exact: true }).fill(value);
    }
  };
  const expectScopeForm = async (page, label) => {
    const form = scopeForm(label);
    for (const [name, value] of [["Discord username", form.discord], ["Booking email", form.email],
      ["PC specifications", form.specs], ["Main game or application", form.mainGame]]) {
      await expect(page.getByRole("textbox", { name, exact: true })).toHaveValue(value);
    }
  };
  const bookScopePackage = async (page, label, route = "/") => {
    await page.goto(route);
    await page.locator(".ri-package-book-button").nth(label === "X" ? 0 : 1).click();
    await expect(page).toHaveURL(/\/booking$/);
  };
  const reserveScopeSlot = async (page, label) => {
    await page.getByRole("button", { name: /^Earliest available:/ }).click();
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).last().click();
    await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
  };
  const reviewScope = async page => {
    await page.getByRole("button", { name: "Review before payment", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  };
  const scopeInput = page => page.getByRole("textbox", { name: "Referral or coupon code", exact: true });
  const expectScopeControls = async page => {
    await expect(page.getByRole("button", { name: "Continue to payment", exact: true })).toBeEnabled();
    await expect(page.getByText("Checking code...", { exact: true })).toHaveCount(0);
    if (!await scopeInput(page).isVisible()) {
      await page.getByRole("button", { name: "Have a referral or coupon code?", exact: true }).click();
    }
    await expect(scopeInput(page)).toBeEnabled();
    await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  };
  const preparePriorYScope = async (page, flow, evidence) => {
    await bookScopePackage(page, "Y", "/?ref=friend");
    await reserveScopeSlot(page, "10:00 AM");
    await fillScopeForm(page, "y");
    await reviewScope(page);
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    await flow.codeInput("friend");
    await expectScopeControls(page);
    evidence.priorY = await snapshot(page);
    expect(evidence.priorY.retained.draft.packages[scopePackages.Y].form).toMatchObject(scopeForm("y"));
    expect(evidence.priorY.retained.draft.packages[scopePackages.Y].checkoutCodes.referral.code).toBe("friend");
    expect((await envelope(page)).choices[checkoutScope(scopePackages.Y)]).toBe("friend");
    await bookScopePackage(page, "X");
    await reserveScopeSlot(page, "11:00 AM");
    expect(flow.state.holds.has(evidence.priorY.retained.hold.startTimeUTC)).toBe(false);
    await fillScopeForm(page, "x");
    await reviewScope(page);
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    evidence.priorX = await snapshot(page);
    expect(evidence.priorX.retained.draft.packages[scopePackages.X].form).toMatchObject(scopeForm("x"));
    expect(evidence.priorX.retained.draft.packages[scopePackages.Y].form).toEqual(evidence.priorY.retained.draft.packages[scopePackages.Y].form);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(2);
    expect(flow.state.holds.size).toBe(1);
  };
  const expectScopeSwap = async (page, flow, evidence) => {
    const current = await snapshot(page);
    const holds = flow.state.calls.filter(call => call.path === "/api/holdSlot");
    evidence.holdRequests = holds;
    evidence.activeHolds = [...flow.state.holds.entries()];
    evidence.afterSwap = current;
    expect(holds).toHaveLength(3);
    expect(holds[1].body).toMatchObject({ packageTitle: scopePackages.X,
      previousHoldId: evidence.priorY.retained.hold.holdId, previousHoldToken: evidence.priorY.retained.hold.holdToken });
    expect(holds[2].body).toMatchObject({ packageTitle: scopePackages.Y,
      previousHoldId: evidence.priorX.retained.hold.holdId, previousHoldToken: evidence.priorX.retained.hold.holdToken });
    expect(flow.state.holds.size).toBe(1);
    expect(flow.state.holds.has(evidence.priorX.retained.hold.startTimeUTC)).toBe(false);
    expect([...flow.state.holds.values()][0].holdId).toBe(current.retained.hold.holdId);
    expect(current.retained.hold.packageTitle).toBe(scopePackages.Y);
    expect(current.retained.hold.startTimeUTC).toBe(evidence.priorY.retained.hold.startTimeUTC);
    expect(current.retained.draft.packages[scopePackages.Y].form).toEqual(evidence.priorY.retained.draft.packages[scopePackages.Y].form);
    await expectScopeForm(page, "y");
  };
  const denyScopeDeletion = (page, scope) => page.addInitScript(scope => {
    const original = Storage.prototype.setItem;
    window.referralResetFailures = [];
    window.restoreReferralSetter = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key, value) {
      if (key === "referral_dismissed") {
        const previous = this.getItem(key);
        if (Object.hasOwn(JSON.parse(previous || "{}").choices || {}, scope) && !Object.hasOwn(JSON.parse(value).choices, scope)) {
          window.referralResetFailures.push({ key, value, previous, name: "QuotaExceededError", at: Date.now() });
          throw new DOMException("Scoped choice deletion denied", "QuotaExceededError");
        }
      }
      return original.call(this, key, value);
    };
  }, scope);

  for (const [failure, route, desktop] of [["network", "/", true], [503, "/packages", false], [429, "/", false]]) {
    cachedTest(`hold-scope recovery: prior Y candidates settle after ${failure} release on ${route}`, async ({ page, flow, bfcache }, testInfo) => {
      if (desktop) await page.setViewportSize({ width: 1280, height: 900 });
      await preparePriorYScope(page, flow, bfcache);
      flow.state.failures["/api/releaseHold"] = failure;
      bfcache.failure = failure;
      await bookScopePackage(page, "Y", route);
      await reserveScopeSlot(page, "10:00 AM");
      await expectScopeSwap(page, flow, bfcache);
      await reviewScope(page);
      bfcache.review = await snapshot(page);
      await attachJson(testInfo, "scope-swap-before-product-assertions", bfcache);
      await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
      await expectScopeControls(page);
      const beforePayment = flow.state.calls.length;
      await flow.payment();
      await waitQuote(flow, "friend", beforePayment);
      expect(quoteCalls(flow, beforePayment).every(call => call.body.packageTitle === scopePackages.Y && call.body.referralCode === "friend")).toBe(true);
      expect((await snapshot(page)).retained.draft.packages[scopePackages.Y].form).toEqual(bfcache.priorY.retained.draft.packages[scopePackages.Y].form);
      expect((await envelope(page)).choices[checkoutScope(scopePackages.Y)]).toBe("friend");
      expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(3);
      bfcache.beforePayment = beforePayment;
      bfcache.newPaymentQuotes = quoteCalls(flow, beforePayment);
    });
  }

  cachedTest("hold-scope recovery: first-time Y applies passive referral without draft candidates", async ({ page, flow, bfcache }, testInfo) => {
    await bookScopePackage(page, "X", "/?ref=friend");
    await reserveScopeSlot(page, "10:00 AM");
    await fillScopeForm(page, "x");
    bfcache.priorX = await snapshot(page);
    expect(bfcache.priorX.retained.draft.packages[scopePackages.X].checkoutCodes).toBeUndefined();
    flow.state.failures["/api/releaseHold"] = "network";
    await bookScopePackage(page, "Y");
    await reserveScopeSlot(page, "11:00 AM");
    await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue("");
    await expect(page.getByRole("textbox", { name: "Discord username", exact: true })).toHaveValue("");
    await fillScopeForm(page, "y");
    bfcache.freshY = await snapshot(page);
    await reviewScope(page);
    bfcache.review = await snapshot(page);
    await attachJson(testInfo, "fresh-scope-before-product-assertions", bfcache);
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    await expectScopeControls(page);
    expect(quoteCalls(flow, 0)).toEqual([]);
    const beforePayment = flow.state.calls.length;
    await flow.payment();
    await waitQuote(flow, "friend", beforePayment);
    expect(quoteCalls(flow, beforePayment).every(call => call.body.packageTitle === scopePackages.Y && call.body.referralCode === "friend")).toBe(true);
    expect((await envelope(page)).choices[checkoutScope(scopePackages.Y)]).toBe("friend");
    const after = await snapshot(page);
    expect(after.retained.draft.packages[scopePackages.Y].form).toEqual(bfcache.freshY.retained.draft.packages[scopePackages.Y].form);
    expect(after.retained.hold).toEqual(bfcache.freshY.retained.hold);
    expect(flow.state.holds.size).toBe(1);
    expect(flow.state.holds.has(bfcache.priorX.retained.hold.startTimeUTC)).toBe(false);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(2);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")[1].body).toMatchObject({
      previousHoldId: bfcache.priorX.retained.hold.holdId, previousHoldToken: bfcache.priorX.retained.hold.holdToken });
    bfcache.beforePayment = beforePayment;
    bfcache.newPaymentQuotes = quoteCalls(flow, beforePayment);
  });

  cachedTest("hold-scope recovery: a same-scope restored hold retains its manual choice and removal", async ({ page, flow, bfcache }) => {
    flow.state.collision = true;
    await bookScopePackage(page, "X", "/?ref=friend");
    await reserveAndReview(page, flow);
    await page.getByRole("button", { name: "Remove referral code friend", exact: true }).click();
    await flow.codeInput("save20");
    await expect(page.getByRole("button", { name: "Remove referral code save20", exact: true })).toBeVisible();
    bfcache.before = await snapshot(page);
    await bookScopePackage(page, "X");
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove referral code save20", exact: true })).toBeVisible();
    await expectScopeControls(page);
    const restored = await snapshot(page);
    expectFormAndHold(restored.retained, bfcache.before.retained);
    expect(restored.retained.intent).toEqual(bfcache.before.retained.intent);
    expect((await envelope(page)).codes.friend).toBe("removed");
    expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
    const beforePayment = flow.state.calls.length;
    await flow.payment();
    await waitQuote(flow, "save20", beforePayment);
    expect(referralLookups(flow, beforePayment, "friend")).toEqual([]);
    expect(flow.state.holds.size).toBe(1);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
    bfcache.beforePayment = beforePayment;
    bfcache.newPaymentQuotes = quoteCalls(flow, beforePayment);
  });

  cachedTest("hold-scope recovery: denied Y reset preserves prior draft and refuses Payment until manual recovery", async ({ page, flow, bfcache }, testInfo) => {
    await preparePriorYScope(page, flow, bfcache);
    await denyScopeDeletion(page, checkoutScope(scopePackages.Y));
    flow.state.failures["/api/releaseHold"] = 503;
    const since = flow.state.calls.length;
    await bookScopePackage(page, "Y");
    await reserveScopeSlot(page, "10:00 AM");
    await expectScopeSwap(page, flow, bfcache);
    await reviewScope(page);
    bfcache.review = await snapshot(page);
    bfcache.resetFailures = await page.evaluate(() => window.referralResetFailures);
    await attachJson(testInfo, "denied-scope-reset-before-product-assertions", bfcache);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    await expectScopeControls(page);
    expect(bfcache.resetFailures.length).toBeGreaterThan(0);
    expect((await envelope(page)).choices[checkoutScope(scopePackages.Y)]).toBe("friend");
    expect(bfcache.review.retained.guard).not.toBe("ready");
    expect(bfcache.review.retained.draft.packages[scopePackages.Y].checkoutCodes).toEqual(bfcache.priorY.retained.draft.packages[scopePackages.Y].checkoutCodes);
    const beforePayment = flow.state.calls.length;
    await flow.payment();
    await waitQuote(flow, "", beforePayment);
    expect(referralLookups(flow, since, "friend")).toEqual([]);
    expect(quoteCalls(flow, beforePayment).every(call => call.body.referralCode === "" && call.body.packageTitle === scopePackages.Y)).toBe(true);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    const paymentState = (await snapshot(page)).retained;
    const priorDraft = bfcache.afterSwap.retained.draft.packages[scopePackages.Y];
    const paymentDraft = paymentState.draft.packages[scopePackages.Y];
    expect(paymentState.hold).toEqual(bfcache.afterSwap.retained.hold);
    expect(paymentState.intent).toEqual(bfcache.review.retained.intent);
    expect(paymentDraft.form).toEqual(priorDraft.form);
    expect(paymentDraft.checkoutCodes).toEqual(priorDraft.checkoutCodes);
    expect(paymentDraft.selectedPackage).toMatchObject(priorDraft.selectedPackage);
    await page.evaluate(() => window.restoreReferralSetter());
    const recovery = flow.state.calls.length;
    await submitPaymentCode(page, "friend");
    await waitQuote(flow, "friend", recovery);
    expect(await page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
    const reloadBoundary = flow.state.calls.length;
    await page.reload();
    await expect(paymentCode(page)).toHaveValue("friend");
    await waitQuote(flow, "friend", reloadBoundary);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toHaveCount(0);
    expect(flow.state.holds.size).toBe(1);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(3);
    bfcache.beforePayment = beforePayment;
    bfcache.recoveryBoundary = recovery;
    bfcache.reloadBoundary = reloadBoundary;
    bfcache.newPaymentQuotes = quoteCalls(flow, beforePayment);
  });

  cachedTest("hold-scope recovery: failed fresh reset refuses retained choice through Payment reload before recovery", async ({ page, flow, bfcache }, testInfo) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    const replacement = flow.state.calls.length;
    await submitPaymentCode(page, "save20");
    await waitQuote(flow, "save20", replacement);
    await page.getByRole("dialog").getByRole("button", { name: "Release", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto("/reviews?ref=friend");
    await expect.poll(() => storedReferral(page)).toBe("friend");
    bfcache.oldIntent = await referralIntent(page);
    await denyScopeDeletion(page, checkoutScope());
    const since = flow.state.calls.length;
    await page.goto("/booking");
    await reserveAndReview(page, flow);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    await expectScopeControls(page);
    bfcache.before = await snapshot(page);
    bfcache.resetFailures = await page.evaluate(() => window.referralResetFailures);
    expect(bfcache.before.retained.intent).toEqual(bfcache.oldIntent);
    expect(bfcache.resetFailures.length).toBeGreaterThan(0);
    const beforePayment = flow.state.calls.length;
    await flow.payment();
    await expect(paymentCode(page)).toBeEnabled();
    bfcache.afterPayment = await snapshot(page);
    await attachJson(testInfo, "failed-reset-payment-before-product-assertions", bfcache);
    await waitQuote(flow, "", beforePayment);
    expect(referralLookups(flow, since, "friend")).toEqual([]);
    expect(referralLookups(flow, since, "save20")).toEqual([]);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    expect(bfcache.afterPayment.retained.intent).toEqual(bfcache.oldIntent);
    const reloadBoundary = flow.state.calls.length;
    await page.reload();
    await expect(paymentCode(page)).toBeEnabled();
    await waitQuote(flow, "", reloadBoundary);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    expect(referralLookups(flow, since, "friend")).toEqual([]);
    expect(referralLookups(flow, since, "save20")).toEqual([]);
    expectFormAndHold((await snapshot(page)).retained, bfcache.before.retained);
    expect((await snapshot(page)).retained.intent).toEqual(bfcache.oldIntent);
    await page.evaluate(() => window.restoreReferralSetter());
    const recovery = flow.state.calls.length;
    await submitPaymentCode(page, "friend");
    await waitQuote(flow, "friend", recovery);
    expect(await page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
    const acknowledgedReload = flow.state.calls.length;
    await page.reload();
    await expect(paymentCode(page)).toHaveValue("friend");
    await waitQuote(flow, "friend", acknowledgedReload);
    expect((await envelope(page)).choices[checkoutScope()]).toBe("friend");
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toHaveCount(0);
    bfcache.beforePayment = beforePayment;
    bfcache.reloadBoundary = reloadBoundary;
    bfcache.recoveryBoundary = recovery;
    bfcache.acknowledgedReload = acknowledgedReload;
    bfcache.newPaymentQuotes = quoteCalls(flow, beforePayment);
  });

  cachedTest("hold-scope recovery: unready cached Booking invalidates its completed obsolete manual continuation", async ({ page, flow, bfcache }, testInfo) => {
    flow.state.collision = true;
    await page.addInitScript(() => {
      if (location.hash !== "#referral-storage-denied") return;
      const getter = Storage.prototype.getItem;
      const setter = Storage.prototype.setItem;
      const remover = Storage.prototype.removeItem;
      const keys = ["referral_capture", "referral_dismissed", "referral_session"];
      window.referralOriginalGetter = getter;
      window.referralBlockedOperations = [];
      Storage.prototype.getItem = function(key) {
        if (keys.includes(key)) throw new DOMException("First document referral read denied", "SecurityError");
        return getter.call(this, key);
      };
      Storage.prototype.setItem = function(key, value) {
        if (keys.includes(key)) {
          window.referralBlockedOperations.push({ key, value, at: Date.now() });
          throw new DOMException("First document referral write denied", "SecurityError");
        }
        return setter.call(this, key, value);
      };
      Storage.prototype.removeItem = function(key) {
        if (keys.includes(key)) throw new DOMException("First document referral removal denied", "SecurityError");
        return remover.call(this, key);
      };
    });
    await page.goto("/booking#referral-storage-denied");
    await reserveAndReview(page, flow);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    await expectScopeControls(page);
    bfcache.beforeManual = await snapshot(page);
    bfcache.manualNetwork = [];
    page.on("requestfinished", request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/ref/validate")) bfcache.manualNetwork.push({ url: request.url(), at: Date.now() });
    });
    await page.evaluate(() => {
      const originalFetch = window.fetch;
      const originalSet = Storage.prototype.setItem;
      let release;
      let selected = false;
      const gate = new Promise(resolve => { release = resolve; });
      const audit = window.referralManualContinuation = { events: [], released: false, resumed: false };
      const record = (kind, details = {}) => audit.events.push({ kind, at: Date.now(), time: performance.now(), ...details });
      window.fetch = async function(input, options) {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const hold = !selected && url.pathname === "/api/ref/validateReferral" && url.searchParams.get("code") === "friend";
        if (hold) selected = true;
        const response = await originalFetch.call(this, input, options);
        if (hold) {
          const originalJson = response.json.bind(response);
          response.json = async () => {
            const data = await originalJson();
            record("network-json-complete", { url: url.href, ok: response.ok });
            await gate;
            audit.resumed = true;
            record("json-continuation-resumed");
            return data;
          };
        }
        return response;
      };
      Storage.prototype.setItem = function(key, value) {
        if (key === "booking_draft") {
          const draft = JSON.parse(value);
          record("draft-write", { code: draft.packages[draft.lastTitle]?.checkoutCodes?.referral?.code || "", value });
        }
        return originalSet.call(this, key, value);
      };
      window.addEventListener("pageshow", event => {
        if (!event.persisted) return;
        record("pageshow-release", { persisted: event.persisted, nonce: window.referralBfcache.nonce });
        audit.released = true;
        release();
      });
    });
    const finished = page.waitForEvent("requestfinished", request => {
      const url = new URL(request.url());
      return url.pathname === "/api/ref/validateReferral" && url.searchParams.get("code") === "friend";
    });
    await flow.codeInput("friend");
    await finished;
    await expect.poll(() => page.evaluate(() => window.referralManualContinuation.events.some(event => event.kind === "network-json-complete"))).toBe(true);
    expect(await page.evaluate(() => window.referralManualContinuation.resumed)).toBe(false);
    bfcache.before = await snapshot(page);
    bfcache.beforeContinuation = await page.evaluate(() => window.referralManualContinuation);
    await page.goto("/booking?scope_recovery=acknowledge");
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    await flow.codeInput("save20");
    await expect(page.getByRole("button", { name: "Remove referral code save20", exact: true })).toBeVisible();
    expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
    expect(await page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
    bfcache.otherDocument = await snapshot(page);
    expect(bfcache.otherDocument.observation.nonce).not.toBe(bfcache.before.observation.nonce);
    await observeBack(page, flow, bfcache, testInfo);
    await expect.poll(() => page.evaluate(() => window.referralManualContinuation.resumed)).toBe(true);
    await expectScopeControls(page);
    bfcache.afterContinuation = await page.evaluate(() => window.referralManualContinuation);
    bfcache.afterRestore = await snapshot(page);
    await attachJson(testInfo, "unready-booking-obsolete-manual-ordering", bfcache);
    const events = bfcache.afterContinuation.events;
    expect(events.findIndex(event => event.kind === "network-json-complete")).toBeLessThan(events.findIndex(event => event.kind === "pageshow-release"));
    expect(events.findIndex(event => event.kind === "pageshow-release")).toBeLessThan(events.findIndex(event => event.kind === "json-continuation-resumed"));
    expect(events.filter(event => event.kind === "draft-write" && event.code === "friend")).toEqual([]);
    expect(bfcache.afterRestore.retained.intent).toEqual(bfcache.otherDocument.retained.intent);
    expectFormAndHold(bfcache.afterRestore.retained, bfcache.beforeManual.retained);
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toHaveCount(0);
    expect(quoteCalls(flow, 0)).toEqual([]);
    expect(referralLookups(flow, bfcache.backBoundary, "friend")).toEqual([]);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
    expect(flow.state.holds.size).toBe(1);
  });

  const withPendingOldCleanup = async (page, flow, evidence, testInfo, assertions) => {
    let releaseGate;
    let finishHandler;
    let entered = false;
    let released;
    let handler;
    const gate = new Promise(resolve => { releaseGate = resolve; });
    const finished = new Promise(resolve => { finishHandler = resolve; });
    evidence.cleanup = { timeline: [], setupComplete: false };
    const audit = evidence.cleanup;
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (["/api/holdSlot", "/api/releaseHold"].includes(path)) {
        audit.timeline.push({ kind: "request", path, body: request.postDataJSON(), at: Date.now() });
      }
    });
    page.on("response", response => {
      const path = new URL(response.url()).pathname;
      if (["/api/holdSlot", "/api/releaseHold"].includes(path)) {
        audit.timeline.push({ kind: "response", path, body: response.request().postDataJSON(), status: response.status(), at: Date.now() });
      }
    });
    try {
      await flow.reserve();
      await flow.details();
      audit.before = await slotSwapSnapshot(page);
      const oldHold = audit.before.hold;
      const isOld = request => {
        const body = request.postDataJSON();
        return new URL(request.url()).pathname === "/api/releaseHold" &&
          body.holdId === oldHold.holdId && body.holdToken === oldHold.holdToken;
      };
      handler = async route => {
        if (!isOld(route.request())) return route.fallback();
        entered = true;
        audit.oldRequest = route.request().postDataJSON();
        audit.timeline.push({ kind: "old-cleanup-gated", at: Date.now() });
        try {
          await gate;
          audit.timeline.push({ kind: "old-cleanup-fallback", at: Date.now() });
          await route.fallback();
        } finally {
          finishHandler();
        }
      };
      await page.route("**/api/releaseHold", handler);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByRole("button", { name: "11:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect.poll(() => entered).toBe(true);
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      await expect.poll(async () => (await slotSwapSnapshot(page)).hold?.holdId).not.toBe(oldHold.holdId);
      audit.accepted = await slotSwapSnapshot(page);
      const newHold = audit.accepted.hold;
      expect(newHold).toBeTruthy();
      expect(newHold.startTimeUTC).not.toBe(oldHold.startTimeUTC);
      expect(newHold.holdId).not.toBe(oldHold.holdId);
      expect(newHold.holdToken).not.toBe(oldHold.holdToken);
      expect(flow.state.holds.size).toBe(1);
      expect(flow.state.holds.get(newHold.startTimeUTC)).toMatchObject({ holdId: newHold.holdId, holdToken: newHold.holdToken });
      expect(flow.state.holds.has(oldHold.startTimeUTC)).toBe(false);
      const holds = flow.state.calls.filter(call => call.path === "/api/holdSlot");
      expect(holds).toHaveLength(2);
      expect(holds[1].body).toMatchObject({ startTimeUTC: newHold.startTimeUTC,
        previousHoldId: oldHold.holdId, previousHoldToken: oldHold.holdToken });
      expect(audit.timeline.filter(event => event.kind === "response" && event.path === "/api/holdSlot").at(-1).status).toBe(200);
      expect(audit.oldRequest).toEqual({ holdId: oldHold.holdId, holdToken: oldHold.holdToken });
      expect(flow.state.calls.filter(call => call.path === "/api/releaseHold")).toEqual([]);
      expect(audit.accepted.fields).toEqual(audit.before.fields);
      expect(audit.accepted.draft.packages[newHold.packageTitle].form).toEqual(audit.before.draft.packages[oldHold.packageTitle].form);
      await expect(page.getByRole("button", { name: "Release Slot", exact: true })).toBeEnabled();
      expect(evidence.pageErrors).toEqual([]);
      expect(flow.state.calls.filter(call => call.path.startsWith("/api/payment/"))).toEqual([]);
      audit.setupComplete = true;
      await attachJson(testInfo, "old-cleanup-valid-new-hold-before-product-assertions", {
        ...audit, calls: flow.state.calls, activeHolds: [...flow.state.holds.entries()],
      });
      const releaseOld = () => {
        if (!released) {
          released = (async () => {
            const response = page.waitForResponse(response => isOld(response.request()));
            releaseGate();
            const result = await response;
            audit.oldResponse = { status: result.status(), body: await result.json(), at: Date.now() };
            await finished;
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          })();
        }
        return released;
      };
      try {
        await assertions({ audit, oldHold, newHold, releaseOld });
      } finally {
        if (entered) await releaseOld();
      }
    } finally {
      releaseGate();
      if (entered) await finished;
      if (handler) await page.unroute("**/api/releaseHold", handler);
      audit.final = await slotSwapSnapshot(page);
      audit.calls = flow.state.calls;
      audit.activeHolds = [...flow.state.holds.entries()];
      await attachJson(testInfo, "old-cleanup-complete-diagnosis", audit);
    }
  };

  cachedTest("lifecycle diagnosis: old cleanup cannot block releasing the accepted new hold", async ({ page, flow, bfcache }, testInfo) => {
    await withPendingOldCleanup(page, flow, bfcache, testInfo, async ({ audit, newHold, releaseOld }) => {
      audit.releaseClick = { at: Date.now(), hold: newHold };
      await page.getByRole("button", { name: "Release Slot", exact: true }).click();
      const newReleases = () => flow.state.calls.filter(call => call.path === "/api/releaseHold" &&
        call.body.holdId === newHold.holdId && call.body.holdToken === newHold.holdToken);
      await expect.configure({ soft: true }).poll(() => newReleases().length, { timeout: 2000 }).toBe(1);
      if (newReleases().length) {
        await expect.poll(async () => (await slotSwapSnapshot(page)).hold, { timeout: 3000 }).toBeNull();
      }
      audit.afterClick = await slotSwapSnapshot(page);
      audit.newReleaseRequests = newReleases();
      audit.activeWhileOldPending = [...flow.state.holds.entries()];
      await attachJson(testInfo, "new-hold-release-while-old-cleanup-pending", audit);
      expect.soft(audit.afterClick.hold).toBeNull();
      expect.soft(flow.state.holds.size).toBe(0);
      await releaseOld();
      audit.afterOldCleanup = await slotSwapSnapshot(page);
      expect.soft(audit.afterOldCleanup.hold).toBeNull();
      expect.soft(flow.state.holds.size).toBe(0);
      expect.soft(newReleases()).toHaveLength(1);
    });
  });

  cachedTest("lifecycle diagnosis: old cleanup cannot erase new-form validation", async ({ page, flow, bfcache }, testInfo) => {
    await withPendingOldCleanup(page, flow, bfcache, testInfo, async ({ audit, newHold, releaseOld }) => {
      const alert = page.getByRole("alert").filter({ hasText: "Please enter a valid email address." });
      await page.getByRole("textbox", { name: "Booking email", exact: true }).fill("not-an-email");
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      await expect(alert).toHaveText("Please enter a valid email address.");
      audit.beforeOldResponse = await slotSwapSnapshot(page);
      audit.validationAlert = await alert.innerText();
      await releaseOld();
      audit.afterOldResponse = await slotSwapSnapshot(page);
      audit.afterAlerts = await page.getByRole("alert").allTextContents();
      await attachJson(testInfo, "new-form-validation-around-obsolete-cleanup-response", audit);
      expect(audit.afterOldResponse.hold).toEqual(newHold);
      expect(audit.afterOldResponse.fields.email).toBe("not-an-email");
      expect(audit.afterOldResponse.draft.packages[newHold.packageTitle].form.email).toBe("not-an-email");
      expect(flow.state.holds.size).toBe(1);
      await expect(alert).toHaveText("Please enter a valid email address.", { timeout: 3000 });
    });
  });

  cachedTest("lifecycle diagnosis: cached unready Y retains its own manual referral and coupon", async ({ page, flow, bfcache }, testInfo) => {
    await bookScopePackage(page, "Y", "/?ref=friend");
    await reserveScopeSlot(page, "10:00 AM");
    await fillScopeForm(page, "y");
    await reviewScope(page);
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    await flow.codeInput("friend");
    await expectScopeControls(page);
    await flow.codeInput("save20");
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toBeVisible();
    await expectScopeControls(page);
    bfcache.priorY = await snapshot(page);
    const priorCodes = bfcache.priorY.retained.draft.packages[scopePackages.Y].checkoutCodes;
    expect(priorCodes.referral.code).toBe("friend");
    expect(priorCodes.coupon.code).toBe("save20");
    expect((await envelope(page)).choices[checkoutScope(scopePackages.Y)]).toBe("friend");
    await bookScopePackage(page, "X");
    await reserveScopeSlot(page, "11:00 AM");
    await fillScopeForm(page, "x");
    await reviewScope(page);
    bfcache.priorX = await snapshot(page);
    expect(bfcache.priorX.retained.draft.packages[scopePackages.X].form).toMatchObject(scopeForm("x"));
    expect(bfcache.priorX.retained.draft.packages[scopePackages.Y].form).toEqual(bfcache.priorY.retained.draft.packages[scopePackages.Y].form);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(2);
    await bookScopePackage(page, "Y", "/packages");
    await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
    bfcache.before = await snapshot(page);
    expect(bfcache.before.retained.hold).toEqual(bfcache.priorX.retained.hold);
    expect(bfcache.before.retained.draft.packages[scopePackages.Y].checkoutCodes).toEqual(priorCodes);
    expect(bfcache.before.retained.draft.packages[scopePackages.Y].form).toEqual(bfcache.priorY.retained.draft.packages[scopePackages.Y].form);
    await page.goto("/about?ref=unknowncreator");
    await expect.poll(() => storedReferral(page)).toBe("unknowncreator");
    bfcache.otherDocument = await snapshot(page);
    expect(bfcache.before.retained.intent.passive).toBe("friend");
    expect(bfcache.otherDocument.retained.intent.passive).toBe("unknowncreator");
    await observeBack(page, flow, bfcache, testInfo);
    flow.state.failures["/api/releaseHold"] = 503;
    bfcache.reserveBoundary = flow.state.calls.length;
    await reserveScopeSlot(page, "10:00 AM");
    await expectScopeSwap(page, flow, bfcache);
    bfcache.reviewBoundary = flow.state.calls.length;
    await reviewScope(page);
    await expectScopeControls(page);
    bfcache.settled = await snapshot(page);
    bfcache.newValidations = flow.state.calls.slice(bfcache.reserveBoundary).filter(call => call.path.startsWith("/api/ref/validate"));
    bfcache.setupComplete = true;
    await attachJson(testInfo, "cached-unready-own-candidates-before-product-assertions", bfcache);
    expect.soft(bfcache.settled.retained.draft.packages[scopePackages.Y].checkoutCodes).toEqual(priorCodes);
    await expect.soft(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible({ timeout: 3000 });
    await expect.soft(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole("button", { name: "Remove referral code unknowncreator", exact: true })).toHaveCount(0);
    expect(quoteCalls(flow, 0)).toEqual([]);
  });

  cachedTest("lifecycle diagnosis: a later passive capture cannot acknowledge a failed scope reset", async ({ page, flow, bfcache }, testInfo) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    const replacement = flow.state.calls.length;
    await submitPaymentCode(page, "save20");
    await waitQuote(flow, "save20", replacement);
    await page.getByRole("dialog").getByRole("button", { name: "Release", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto("/reviews?ref=friend");
    await expect.poll(() => storedReferral(page)).toBe("friend");
    bfcache.oldIntent = await referralIntent(page);
    expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
    await denyScopeDeletion(page, checkoutScope());
    const since = flow.state.calls.length;
    await page.goto("/booking");
    await reserveAndReview(page, flow);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    await expectScopeControls(page);
    bfcache.before = await snapshot(page);
    bfcache.resetFailures = await page.evaluate(() => window.referralResetFailures);
    expect(bfcache.before.retained.intent).toEqual(bfcache.oldIntent);
    expect(bfcache.resetFailures.length).toBeGreaterThan(0);
    const beforePayment = flow.state.calls.length;
    await flow.payment();
    await expect(paymentCode(page)).toBeEnabled();
    await waitQuote(flow, "", beforePayment);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    expect(referralLookups(flow, since, "friend")).toEqual([]);
    expect(referralLookups(flow, since, "save20")).toEqual([]);
    bfcache.initialPayment = await snapshot(page);
    bfcache.initialBlankQuotes = quoteCalls(flow, beforePayment);
    expect(bfcache.initialPayment.retained.intent).toEqual(bfcache.oldIntent);
    bfcache.passiveBoundary = flow.state.calls.length;
    await page.goto("/about?ref=friend");
    await expect.poll(() => storedReferral(page)).toBe("friend");
    bfcache.otherDocument = await snapshot(page);
    bfcache.otherDocumentResetFailures = await page.evaluate(() => window.referralResetFailures);
    expect(bfcache.otherDocument.observation.nonce).not.toBe(bfcache.initialPayment.observation.nonce);
    expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
    bfcache.newPaymentBoundary = flow.state.calls.length;
    await page.goto("/payment");
    await expect(paymentCode(page)).toBeEnabled();
    await expect.poll(() => quoteCalls(flow, bfcache.newPaymentBoundary).length).toBeGreaterThan(0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    bfcache.afterPassivePayment = await snapshot(page);
    bfcache.laterQuotes = quoteCalls(flow, bfcache.newPaymentBoundary);
    bfcache.laterResetFailures = await page.evaluate(() => window.referralResetFailures);
    bfcache.newLookups = flow.state.calls.slice(bfcache.passiveBoundary).filter(call => call.path.startsWith("/api/ref/validate"));
    bfcache.setupComplete = true;
    await attachJson(testInfo, "passive-capture-after-failed-reset-before-product-assertions", bfcache);
    expectFormAndHold(bfcache.afterPassivePayment.retained, bfcache.initialPayment.retained);
    expect.soft(bfcache.laterQuotes.every(call => call.body.referralCode === "")).toBe(true);
    expect.soft(referralLookups(flow, bfcache.passiveBoundary, "save20")).toEqual([]);
    await expect.soft(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible({ timeout: 3000 });
    if (testInfo.errors.length) return;
    await page.evaluate(() => window.restoreReferralSetter());
    const recovery = flow.state.calls.length;
    await submitPaymentCode(page, "friend");
    await waitQuote(flow, "friend", recovery);
    expect(await page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
    const reloadBoundary = flow.state.calls.length;
    await page.reload();
    await expect(paymentCode(page)).toHaveValue("friend");
    await waitQuote(flow, "friend", reloadBoundary);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toHaveCount(0);
    bfcache.recoveryBoundary = recovery;
    bfcache.reloadBoundary = reloadBoundary;
  });
  const prepareFailedResetPayment = async (page, flow, evidence) => {
    flow.state.collision = true;
    await startFriendPayment(page, flow);
    const replacement = flow.state.calls.length;
    await submitPaymentCode(page, "save20");
    await waitQuote(flow, "save20", replacement);
    await page.getByRole("dialog").getByRole("button", { name: "Release", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto("/reviews?ref=friend");
    await expect.poll(() => storedReferral(page)).toBe("friend");
    evidence.oldIntent = await referralIntent(page);
    expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
    await denyScopeDeletion(page, checkoutScope());
    const since = flow.state.calls.length;
    await page.goto("/booking");
    await reserveAndReview(page, flow);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    await expectScopeControls(page);
    evidence.before = await snapshot(page);
    evidence.resetFailures = await page.evaluate(() => window.referralResetFailures);
    expect(evidence.before.retained.intent).toEqual(evidence.oldIntent);
    expect(evidence.resetFailures.length).toBeGreaterThan(0);
    evidence.beforePayment = flow.state.calls.length;
    await flow.payment();
    await expect(paymentCode(page)).toBeEnabled();
    await waitQuote(flow, "", evidence.beforePayment);
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    expect(referralLookups(flow, since, "friend")).toEqual([]);
    expect(referralLookups(flow, since, "save20")).toEqual([]);
    evidence.initialPayment = await snapshot(page);
    evidence.initialBlankQuotes = quoteCalls(flow, evidence.beforePayment);
    expect(evidence.initialPayment.retained.intent).toEqual(evidence.oldIntent);
  };

  for (const [nextCode, title] of [
    ["friend", "a removed link cannot acknowledge another pending creator"],
    ["save20", "a qualified fresh link can replace another pending creator"],
  ]) {
    cachedTest(`pending capture recovery: ${title}`, async ({ page, flow, bfcache }, testInfo) => {
      flow.state.collision = true;
      await startFriendPayment(page, flow);
      const removalBoundary = flow.state.calls.length;
      await submitPaymentCode(page, "");
      await waitQuote(flow, "", removalBoundary);
      bfcache.removed = await snapshot(page);
      expect((await envelope(page)).codes.friend).toBe("removed");
      expect((await envelope(page)).choices[checkoutScope()]).toBe("friend");
      expect(bfcache.removed.retained.hold.holdId).toBeTruthy();
      await page.goto("/reviews?ref=save20");
      await expect.poll(() => storedReferral(page)).toBe("save20");
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
      bfcache.before = await snapshot(page);
      expect((await envelope(page)).passiveCode).toBe("save20");
      expect((await envelope(page)).codes.friend).toBe("removed");
      expectFormAndHold(bfcache.before.retained, bfcache.removed.retained);
      await page.addInitScript(() => {
        const inherited = Storage.prototype.setItem;
        window.referralCaptureFailures = [];
        window.pendingCaptureWrites = [];
        window.restorePendingCaptureSetter = () => { Storage.prototype.setItem = inherited; };
        Storage.prototype.setItem = function(key, value) {
          if (key !== "referral_dismissed") return inherited.call(this, key, value);
          const entry = { key, value, previous: this.getItem(key), guard: this.getItem("referral_capture"), at: Date.now() };
          if (JSON.parse(value).passiveCode === "newcreator") {
            entry.name = "QuotaExceededError";
            window.referralCaptureFailures.push(entry);
            window.pendingCaptureWrites.push(entry);
            throw new DOMException("Pending creator journal denied", "QuotaExceededError");
          }
          const result = inherited.call(this, key, value);
          window.pendingCaptureWrites.push({ ...entry, outcome: "stored" });
          return result;
        };
      });
      await page.goto("/about?ref=newcreator");
      await expect.poll(() => page.evaluate(() => window.referralCaptureFailures.length)).toBeGreaterThan(0);
      bfcache.pending = await snapshot(page);
      bfcache.deniedWrites = await page.evaluate(() => window.pendingCaptureWrites);
      expect(JSON.parse(bfcache.pending.retained.guard)).toEqual({ code: "newcreator" });
      expect(bfcache.pending.retained.intent).toEqual(bfcache.before.retained.intent);
      expect(bfcache.pending.retained.captureFailures.every(entry =>
        entry.name === "QuotaExceededError" && JSON.parse(entry.value).passiveCode === "newcreator" &&
        JSON.parse(entry.guard).code === "newcreator"
      )).toBe(true);
      expectFormAndHold(bfcache.pending.retained, bfcache.before.retained);
      bfcache.passiveBoundary = flow.state.calls.length;
      await page.goto(`/reviews?ref=${nextCode}`);
      await page.waitForFunction(() => Boolean(window.next?.router));
      if (nextCode === "save20") {
        await expect.poll(() => page.evaluate(() => window.pendingCaptureWrites.filter(entry => entry.outcome === "stored").length)).toBeGreaterThan(0);
      }
      bfcache.afterLink = await snapshot(page);
      bfcache.linkWrites = await page.evaluate(() => window.pendingCaptureWrites);
      bfcache.newPaymentBoundary = flow.state.calls.length;
      await page.goto("/payment");
      await expect(paymentCode(page)).toBeEnabled();
      await expect.poll(() => quoteCalls(flow, bfcache.newPaymentBoundary).length).toBeGreaterThan(0);
      bfcache.afterPayment = await snapshot(page);
      bfcache.paymentQuotes = quoteCalls(flow, bfcache.newPaymentBoundary);
      bfcache.lookups = flow.state.calls.slice(bfcache.passiveBoundary).filter(call => call.path.startsWith("/api/ref/validate"));
      bfcache.setupComplete = true;
      await attachJson(testInfo, "pending-capture-before-product-assertions", bfcache);
      expectFormAndHold(bfcache.afterPayment.retained, bfcache.before.retained);
      if (nextCode === "friend") {
        expect.soft(bfcache.paymentQuotes.every(call => call.body.referralCode === "")).toBe(true);
        expect.soft(lastQuote(flow).body.referralCode).toBe("");
        expect.soft(referralLookups(flow, bfcache.passiveBoundary, "save20")).toEqual([]);
        await expect.soft(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible({ timeout: 3000 });
        expect.soft(bfcache.afterPayment.retained.guard).toBe(bfcache.pending.retained.guard);
        expect.soft(bfcache.afterPayment.retained.intent).toEqual(bfcache.before.retained.intent);
        if (testInfo.errors.length) return;
        await page.evaluate(() => window.restorePendingCaptureSetter());
        bfcache.recoveryBoundary = flow.state.calls.length;
        await submitPaymentCode(page, "save20");
        await waitQuote(flow, "save20", bfcache.recoveryBoundary);
        expect(await page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
        expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
        bfcache.afterRecovery = await snapshot(page);
        expectFormAndHold(bfcache.afterRecovery.retained, bfcache.before.retained);
        bfcache.reloadBoundary = flow.state.calls.length;
        await page.reload();
        await waitQuote(flow, "save20", bfcache.reloadBoundary);
        await expect(paymentCode(page)).toHaveValue("save20");
        await expect(page.getByRole("alert").filter({ hasText: storageError })).toHaveCount(0);
        bfcache.afterReload = await snapshot(page);
        expectFormAndHold(bfcache.afterReload.retained, bfcache.before.retained);
      } else {
        expect(bfcache.linkWrites.some(entry => entry.outcome === "stored" &&
          JSON.parse(entry.value).passiveCode === "save20" && JSON.parse(entry.guard).code === "save20"
        )).toBe(true);
        expect(bfcache.afterLink.retained.guard).toBe("ready");
        expect(bfcache.afterPayment.retained.guard).toBe("ready");
        expect((await envelope(page)).passiveCode).toBe("save20");
        expect(bfcache.paymentQuotes.every(call => call.body.referralCode === "save20")).toBe(true);
        await expect(paymentCode(page)).toHaveValue("save20");
        await expect(page.getByRole("alert").filter({ hasText: storageError })).toHaveCount(0);
        await page.evaluate(() => window.restorePendingCaptureSetter());
      }
      await expect(page.locator(".booking-payment")).toHaveCSS("opacity", "1", { timeout: 5000 });
      await paymentCode(page).scrollIntoViewIfNeeded();
      await testInfo.attach("pending-capture-visible-payment", { body: await page.screenshot(), contentType: "image/png" });
      await attachJson(testInfo, "pending-capture-completed", bfcache);
    });
  }

  cachedTest("unknown reset recovery: another checkout scope cannot acknowledge a lost reset origin", async ({ page, flow, bfcache }, testInfo) => {
    await prepareFailedResetPayment(page, flow, bfcache);
    bfcache.markerLoss = await page.evaluate(() => {
      const before = sessionStorage.getItem("referral_capture");
      sessionStorage.removeItem("referral_capture");
      return { before, after: sessionStorage.getItem("referral_capture"), at: Date.now() };
    });
    expect(bfcache.markerLoss.after).toBeNull();
    await flow.upgrade();
    await page.getByRole("button", { name: "Check eligibility", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Upgrade Summary", exact: true })).toBeVisible();
    bfcache.upgradePaymentBoundary = flow.state.calls.length;
    await page.getByRole("button", { name: "Proceed to Payment", exact: true }).click();
    await expect(paymentCode(page)).toBeEnabled();
    await expect.poll(() => quoteCalls(flow, bfcache.upgradePaymentBoundary).length).toBeGreaterThan(0);
    bfcache.beforeManual = await snapshot(page);
    bfcache.upgradeQuotes = quoteCalls(flow, bfcache.upgradePaymentBoundary);
    bfcache.upgradeCheckout = await page.evaluate(() => JSON.parse(sessionStorage.getItem("checkout_booking_state")));
    expect(bfcache.upgradeCheckout).toMatchObject({ originalOrderId: "fixture-order", packageTitle: "Performance Vertex Max (Upgrade)" });
    expect(bfcache.upgradeQuotes.every(call => call.body.originalOrderId === "fixture-order" &&
      call.body.packageTitle === "Performance Vertex Max (Upgrade)" && call.body.referralCode === ""
    )).toBe(true);
    expect((await envelope(page)).choices).toEqual({ [checkoutScope()]: "save20" });
    expectFormAndHold(bfcache.beforeManual.retained, bfcache.initialPayment.retained);
    expect(bfcache.beforeManual.retained.intent).toEqual(bfcache.oldIntent);
    await page.evaluate(() => {
      const inherited = Storage.prototype.setItem;
      window.unknownRecoveryWrites = [];
      window.restoreUnknownRecoveryObserver = () => { Storage.prototype.setItem = inherited; };
      Storage.prototype.setItem = function(key, value) {
        if (key === "referral_dismissed") window.unknownRecoveryWrites.push({ key, value, previous: this.getItem(key), at: Date.now() });
        return inherited.call(this, key, value);
      };
    });
    bfcache.manualBoundary = flow.state.calls.length;
    await submitPaymentCode(page, "friend");
    await expect.poll(() => referralLookups(flow, bfcache.manualBoundary, "friend").length).toBeGreaterThan(0);
    await expect.poll(async () => quoteCalls(flow, bfcache.manualBoundary).some(call => call.body.referralCode === "friend") ||
      await page.getByRole("alert").filter({ hasText: storageError }).isVisible()
    ).toBe(true);
    await expect(paymentCode(page)).toBeEnabled();
    bfcache.afterManual = await snapshot(page);
    bfcache.manualQuotes = quoteCalls(flow, bfcache.manualBoundary);
    bfcache.manualJournalWrites = await page.evaluate(() => window.unknownRecoveryWrites);
    bfcache.setupComplete = true;
    await attachJson(testInfo, "unknown-reset-before-product-assertions", bfcache);
    expectFormAndHold(bfcache.afterManual.retained, bfcache.initialPayment.retained);
    expect.soft(lastQuote(flow).body.referralCode).toBe("");
    expect.soft(bfcache.manualQuotes.every(call => call.body.referralCode === "")).toBe(true);
    await expect.soft(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible({ timeout: 3000 });
    expect.soft(bfcache.afterManual.retained.guard).not.toBe("ready");
    expect.soft(bfcache.afterManual.retained.intent).toEqual(bfcache.oldIntent);
    expect.soft(bfcache.manualJournalWrites).toEqual([]);
    if (testInfo.errors.length) return;
    await page.evaluate(() => {
      window.restoreUnknownRecoveryObserver();
      window.restoreReferralSetter();
    });
    bfcache.originalScopeBoundary = flow.state.calls.length;
    await page.goto("/booking");
    await page.evaluate(() => window.restoreReferralSetter());
    const review = page.getByRole("button", { name: "Review before payment", exact: true });
    await expect.poll(async () => await review.isVisible() ||
      await page.getByRole("heading", { name: "Review your booking", exact: true }).isVisible()
    ).toBe(true);
    if (await review.isVisible()) await review.click();
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
    bfcache.originalScope = await snapshot(page);
    expectFormAndHold(bfcache.originalScope.retained, bfcache.initialPayment.retained);
    expect(referralLookups(flow, bfcache.originalScopeBoundary, "save20")).toEqual([]);
    expect((await envelope(page)).choices).toEqual({ [checkoutScope()]: "save20" });
    await flow.codeInput("friend");
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    expect((await envelope(page)).choices).toEqual({ [checkoutScope()]: "friend" });
    expect(await page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
    bfcache.recoveryBoundary = flow.state.calls.length;
    await flow.payment();
    await waitQuote(flow, "friend", bfcache.recoveryBoundary);
    expect(lastQuote(flow).body.originalOrderId).toBe("");
    bfcache.afterRecovery = await snapshot(page);
    expectFormAndHold(bfcache.afterRecovery.retained, bfcache.initialPayment.retained);
    bfcache.reloadBoundary = flow.state.calls.length;
    await page.reload();
    await waitQuote(flow, "friend", bfcache.reloadBoundary);
    await expect(paymentCode(page)).toHaveValue("friend");
    await expect(page.getByRole("alert").filter({ hasText: storageError })).toHaveCount(0);
    bfcache.afterReload = await snapshot(page);
    expectFormAndHold(bfcache.afterReload.retained, bfcache.initialPayment.retained);
    await expect(page.locator(".booking-payment")).toHaveCSS("opacity", "1", { timeout: 5000 });
    await paymentCode(page).scrollIntoViewIfNeeded();
    await testInfo.attach("unknown-reset-visible-recovery", { body: await page.screenshot(), contentType: "image/png" });
    await attachJson(testInfo, "unknown-reset-completed", bfcache);
  });

  for (const [fault, title] of [
    ["lost marker", "a lost failure marker still refuses a passive acknowledgement"],
    ["corrupt marker", "a corrupt failure marker still refuses a passive acknowledgement"],
    ["manual retry", "failed deletions stay blocked through manual retry"],
  ]) {
    cachedTest(`reset guard recovery: ${title}`, async ({ page, flow, bfcache }, testInfo) => {
      await prepareFailedResetPayment(page, flow, bfcache);
      bfcache.fault = fault;
      bfcache.initialGuard = JSON.parse(bfcache.initialPayment.retained.guard);
      if (fault !== "manual retry") {
        const corrupt = JSON.stringify({ code: "friend", resetScopes: ["not-a-canonical-scope"] });
        bfcache.markerFault = await page.evaluate(({ fault, corrupt }) => {
          const before = sessionStorage.getItem("referral_capture");
          if (fault === "lost marker") sessionStorage.removeItem("referral_capture");
          else sessionStorage.setItem("referral_capture", corrupt);
          return { fault, before, after: sessionStorage.getItem("referral_capture"), at: Date.now() };
        }, { fault, corrupt });
      }
      bfcache.passiveBoundary = flow.state.calls.length;
      await page.goto("/about?ref=friend");
      await expect.poll(() => storedReferral(page)).toBe("friend");
      bfcache.otherDocument = await snapshot(page);
      expect(bfcache.otherDocument.observation.nonce).not.toBe(bfcache.initialPayment.observation.nonce);
      expect((await envelope(page)).choices[checkoutScope()]).toBe("save20");
      bfcache.newPaymentBoundary = flow.state.calls.length;
      await page.goto("/payment");
      await expect(paymentCode(page)).toBeEnabled();
      await expect.poll(() => quoteCalls(flow, bfcache.newPaymentBoundary).length).toBeGreaterThan(0);
      bfcache.afterPassivePayment = await snapshot(page);
      bfcache.laterQuotes = quoteCalls(flow, bfcache.newPaymentBoundary);
      bfcache.laterResetFailures = await page.evaluate(() => window.referralResetFailures);
      bfcache.newLookups = flow.state.calls.slice(bfcache.passiveBoundary).filter(call => call.path.startsWith("/api/ref/validate"));
      bfcache.setupComplete = true;
      await attachJson(testInfo, "reset-guard-before-product-assertions", bfcache);
      expectFormAndHold(bfcache.afterPassivePayment.retained, bfcache.initialPayment.retained);
      expect.soft(bfcache.laterQuotes.every(call => call.body.referralCode === "")).toBe(true);
      expect.soft(referralLookups(flow, bfcache.passiveBoundary, "save20")).toEqual([]);
      await expect.soft(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible({ timeout: 3000 });
      expect.soft(bfcache.initialGuard).toEqual({ code: "", resetScopes: [checkoutScope()] });
      if (testInfo.errors.length) return;
      expect(bfcache.afterPassivePayment.retained.guard).not.toBe("ready");
      expect(bfcache.afterPassivePayment.retained.intent).toEqual(bfcache.oldIntent);
      if (fault === "manual retry") {
        await page.evaluate(scope => {
          const inherited = Storage.prototype.setItem;
          window.referralManualWriteFailures = [];
          window.restoreReferralOverwriteSetter = () => { Storage.prototype.setItem = inherited; };
          Storage.prototype.setItem = function(key, value) {
            if (key === "referral_dismissed") {
              const previous = this.getItem(key);
              if (JSON.parse(previous || "{}").choices?.[scope] === "save20" && JSON.parse(value).choices?.[scope] === "friend") {
                window.referralManualWriteFailures.push({ key, value, previous, scope, at: Date.now(), name: "QuotaExceededError" });
                throw new DOMException("Current manual journal overwrite denied", "QuotaExceededError");
              }
            }
            return inherited.call(this, key, value);
          };
        }, checkoutScope());
        bfcache.manualFailureBoundary = flow.state.calls.length;
        await submitPaymentCode(page, "friend");
        await expect(paymentCode(page)).toBeEnabled();
        await expect.poll(() => page.evaluate(() => window.referralManualWriteFailures.length)).toBe(1);
        bfcache.manualWriteFailures = await page.evaluate(() => window.referralManualWriteFailures);
        bfcache.afterFailedManual = await snapshot(page);
        bfcache.failedManualQuotes = quoteCalls(flow, bfcache.manualFailureBoundary);
        await attachJson(testInfo, "reset-guard-real-manual-write-refusal", bfcache);
        expect(referralLookups(flow, bfcache.manualFailureBoundary, "friend").length).toBeGreaterThan(0);
        expect(bfcache.manualWriteFailures[0].name).toBe("QuotaExceededError");
        expect(JSON.parse(bfcache.manualWriteFailures[0].value).choices[checkoutScope()]).toBe("friend");
        expect(bfcache.afterFailedManual.retained.intent).toEqual(bfcache.oldIntent);
        expect(bfcache.afterFailedManual.retained.guard).toBe(bfcache.afterPassivePayment.retained.guard);
        expect(bfcache.afterFailedManual.retained.guard).not.toBe("ready");
        expect(lastQuote(flow).body.referralCode).toBe("");
        expect(bfcache.failedManualQuotes.every(call => call.body.referralCode === "")).toBe(true);
        await expect(page.getByRole("alert").filter({ hasText: storageError })).toBeVisible();
        expectFormAndHold(bfcache.afterFailedManual.retained, bfcache.initialPayment.retained);
        await page.evaluate(() => window.restoreReferralOverwriteSetter());
      }
      await page.evaluate(() => window.restoreReferralSetter());
      bfcache.recoveryBoundary = flow.state.calls.length;
      await submitPaymentCode(page, "friend");
      await waitQuote(flow, "friend", bfcache.recoveryBoundary);
      expect(await page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
      expect((await envelope(page)).choices[checkoutScope()]).toBe("friend");
      bfcache.afterRecovery = await snapshot(page);
      expectFormAndHold(bfcache.afterRecovery.retained, bfcache.initialPayment.retained);
      bfcache.reloadBoundary = flow.state.calls.length;
      await page.reload();
      await expect(paymentCode(page)).toHaveValue("friend");
      await waitQuote(flow, "friend", bfcache.reloadBoundary);
      await expect(page.getByRole("alert").filter({ hasText: storageError })).toHaveCount(0);
      expect((await envelope(page)).choices[checkoutScope()]).toBe("friend");
      bfcache.afterReload = await snapshot(page);
      expectFormAndHold(bfcache.afterReload.retained, bfcache.initialPayment.retained);
      await attachJson(testInfo, "reset-guard-manual-recovery-and-reload", bfcache);
      if (fault === "manual retry") {
        const panel = page.locator(".booking-payment");
        const readPanel = () => panel.evaluate(element => ({
          at: Date.now(),
          opacity: getComputedStyle(element).opacity,
          children: [...element.children].map(child => ({
            tag: child.tagName,
            opacity: getComputedStyle(child).opacity,
          })),
        }));
        const before = await readPanel();
        await attachJson(testInfo, "payment-render-before-settle", before);
        await expect(panel).toHaveCSS("opacity", "1", { timeout: 5000 });
        for (const child of await panel.locator(":scope > div").all()) {
          await expect(child).toHaveCSS("opacity", "1", { timeout: 5000 });
        }
        const heading = page.getByRole("heading", { name: "Booking Summary", exact: true });
        await heading.scrollIntoViewIfNeeded();
        await expect(heading).toBeInViewport();
        await attachJson(testInfo, "payment-render-after-settle", { before, after: await readPanel() });
        await testInfo.attach("payment-render-settled-summary", {
          body: await page.screenshot(), contentType: "image/png",
        });
        await paymentCode(page).scrollIntoViewIfNeeded();
        await expect(paymentCode(page)).toBeInViewport();
        await testInfo.attach("payment-render-settled-code", {
          body: await page.screenshot(), contentType: "image/png",
        });
      }
    });
  }

  cachedTest("booking history authority: cached Booking before a hold keeps the newer creator", async ({ page, flow, bfcache }, testInfo) => {
    flow.state.collision = true;
    const evidence = { setupComplete: false, pageErrors: [] };
    page.on("pageerror", error => evidence.pageErrors.push({ name: error.name, message: error.message }));
    try {
      await page.goto("/booking?ref=friend");
      await expect(page).toHaveURL(/\/booking\?ref=friend$/);
      await page.waitForFunction(() => Boolean(window.next?.router));
      await expect.poll(() => storedReferral(page)).toBe("friend");
      evidence.original = await bookingHistorySnapshot(page);
      expectBookingHistoryBeforeHold(evidence.original, flow, "friend");
      bfcache.before = await snapshot(page);
      await attachJson(testInfo, "booking-history-original", evidence.original);
      await page.goto("/about?ref=save20");
      await expect.poll(() => storedReferral(page)).toBe("save20");
      bfcache.otherDocument = await snapshot(page);
      evidence.otherDocument = await bookingHistorySnapshot(page);
      expectBookingHistoryBeforeHold(evidence.otherDocument, flow, "save20");
      await observeBack(page, flow, bfcache, testInfo);
      await expect(page).toHaveURL(/\/booking\?ref=friend$/);
      await page.waitForFunction(() => Boolean(window.next?.router));
      evidence.afterBack = await bookingHistorySnapshot(page);
      expectBookingHistoryBeforeHold(evidence.afterBack, flow, "save20");
      evidence.setupComplete = true;
      await attachJson(testInfo, "booking-history-before-product-assertions", evidence);
      evidence.reserveBoundary = flow.state.calls.length;
      await reserveAndReview(page, flow);
      await verifyBookingHistoryReview(page, flow, evidence, testInfo, expect.configure({ soft: true }));
    } finally {
      await attachBookingHistory(page, flow, evidence, testInfo);
    }
  });

});

const slotSwapSnapshot = page => page.evaluate(() => {
  const keys = ["my_slot_hold", "booking_draft", "booking_modal_state", "referral_intent",
    "referral_dismissed", "referral_session", "referral_capture"];
  const raw = Object.fromEntries(keys.map(key => [key, sessionStorage.getItem(key)]));
  return {
    at: Date.now(),
    url: location.href,
    raw,
    hold: JSON.parse(raw.my_slot_hold),
    draft: JSON.parse(raw.booking_draft),
    modal: JSON.parse(raw.booking_modal_state),
    referralIntent: { journal: raw.referral_dismissed, passive: raw.referral_session, guard: raw.referral_capture },
    fields: Object.fromEntries(["discord", "email", "specs", "mainGame"].map(key => [
      key, document.querySelector(`[name="${key}"]`)?.value ?? null,
    ])),
    dialog: document.querySelector('[role="dialog"]')?.innerText || "",
  };
});

for (const [title, coupon, replacement] of [
  ["successful replacement preserves typed details", false, true],
  ["successful replacement preserves an applied coupon", true, true],
  ["same-slot refresh keeps details and coupon", true, false],
]) {
  test(`slot-swap retention: ${title}`, async ({ page, flow }, testInfo) => {
    const evidence = { title, coupon, replacement, timeline: [], pageErrors: [] };
    page.on("pageerror", error => evidence.pageErrors.push({ name: error.name, message: error.message }));
    let releaseGate;
    let finishHandler;
    let routeHandler;
    let cleanupResponse;
    let handlerEntered = false;
    const gate = new Promise(resolve => { releaseGate = resolve; });
    const handlerFinished = new Promise(resolve => { finishHandler = resolve; });
    try {
      if (coupon) {
        await flow.review();
        await flow.codeInput("save20");
        await expect(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toBeVisible();
        evidence.review = await slotSwapSnapshot(page);
        const reviewDraft = evidence.review.draft.packages[evidence.review.draft.lastTitle];
        expect(reviewDraft.checkoutCodes.coupon.code).toBe("save20");
        expect(reviewDraft.checkoutCodes.referral).toBeNull();
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toHaveCount(0);
        await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      } else {
        await flow.reserve();
        await flow.details();
      }
      evidence.before = await slotSwapSnapshot(page);
      const original = evidence.before;
      const packageTitle = original.hold.packageTitle;
      const originalDraft = original.draft.packages[packageTitle];
      expect(original.fields).toEqual({
        discord: "fixture_visitor", email: "visitor@example.invalid",
        specs: "Ryzen 7700 / RTX 4070", mainGame: "CS2",
      });
      expect(originalDraft.form).toMatchObject(original.fields);
      if (coupon) expect(originalDraft.checkoutCodes).toEqual(evidence.review.draft.packages[packageTitle].checkoutCodes);
      expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
      expect(flow.state.calls.filter(call => call.path === "/api/releaseHold")).toEqual([]);
      expect(flow.state.holds.size).toBe(1);
      if (replacement) {
        page.on("request", request => {
          if (new URL(request.url()).pathname === "/api/releaseHold") {
            evidence.timeline.push({ kind: "cleanup-request", body: request.postDataJSON(), at: Date.now() });
          }
        });
        page.on("response", response => {
          if (new URL(response.url()).pathname === "/api/holdSlot") {
            evidence.timeline.push({ kind: "replacement-response", status: response.status(), at: Date.now() });
          }
        });
        cleanupResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/releaseHold");
        let enterHandler;
        const entered = new Promise(resolve => { enterHandler = resolve; });
        routeHandler = async route => {
          handlerEntered = true;
          evidence.gatedRequest = route.request().postDataJSON();
          evidence.timeline.push({ kind: "replacement-request-entered", at: Date.now() });
          enterHandler();
          try {
            await gate;
            evidence.timeline.push({ kind: "replacement-request-fallback", at: Date.now() });
            await route.fallback();
          } finally {
            finishHandler();
          }
        };
        await page.route("**/api/holdSlot", routeHandler);
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await page.getByRole("button", { name: "11:00 AM", exact: true }).click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await entered;
        await expect(page.getByRole("button", { name: "Reserving...", exact: true })).toBeVisible();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        evidence.inflight = await slotSwapSnapshot(page);
        evidence.inflightCalls = [...flow.state.calls];
        evidence.inflightHolds = [...flow.state.holds.entries()];
        evidence.timeline.push({ kind: "gate-released", at: Date.now() });
        releaseGate();
      } else {
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
      }
      if (replacement) {
        await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold"))?.startTimeUTC)).toBe(`${flow.state.slots[0].date}T05:30:00.000Z`);
        const response = await cleanupResponse;
        evidence.cleanupResponse = { status: response.status(), body: await response.json() };
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      } else {
        await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold"))?.holdToken)).not.toBe(original.hold.holdToken);
      }
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      evidence.after = await slotSwapSnapshot(page);
      evidence.calls = [...flow.state.calls];
      evidence.activeHolds = [...flow.state.holds.entries()];
      evidence.holdCalls = flow.state.calls.filter(call => call.path === "/api/holdSlot");
      evidence.releaseCalls = flow.state.calls.filter(call => call.path === "/api/releaseHold");
      await attachJson(testInfo, "slot-swap-before-retention-assertions", evidence);
      expect(evidence.holdCalls).toHaveLength(2);
      expect(evidence.holdCalls[1].body).toMatchObject({
        previousHoldId: original.hold.holdId, previousHoldToken: original.hold.holdToken, packageTitle,
        startTimeUTC: evidence.after.hold.startTimeUTC,
      });
      expect(evidence.after.hold.packageTitle).toBe(packageTitle);
      expect(flow.state.holds.size).toBe(1);
      expect(evidence.activeHolds[0][0]).toBe(evidence.after.hold.startTimeUTC);
      expect(evidence.activeHolds[0][1].holdId).toBe(evidence.after.hold.holdId);
      if (replacement) {
        expect(evidence.after.hold.holdId).not.toBe(original.hold.holdId);
        expect(evidence.after.hold.startTimeUTC).not.toBe(original.hold.startTimeUTC);
        expect(flow.state.holds.has(original.hold.startTimeUTC)).toBe(false);
        expect(evidence.releaseCalls).toHaveLength(1);
        expect(evidence.releaseCalls[0].body).toEqual({ holdId: original.hold.holdId, holdToken: original.hold.holdToken });
        expect(evidence.gatedRequest).toEqual(evidence.holdCalls[1].body);
      } else {
        expect(evidence.after.hold.holdId).toBe(original.hold.holdId);
        expect(evidence.after.hold.startTimeUTC).toBe(original.hold.startTimeUTC);
        expect(evidence.releaseCalls).toEqual([]);
      }
      evidence.setupControlsPassed = true;
      await attachJson(testInfo, "slot-swap-setup-controls-passed", evidence);
      if (replacement) {
        expect.soft(evidence.inflight.hold, "replacement keeps the original hold until acceptance").toEqual(original.hold);
        expect.soft(evidence.inflightHolds).toHaveLength(1);
        expect.soft(evidence.inflightHolds[0]?.[0]).toBe(original.hold.startTimeUTC);
        expect.soft(evidence.inflightCalls.filter(call => call.path === "/api/releaseHold")).toEqual([]);
        expect.soft(evidence.inflight.draft.packages[packageTitle].form).toEqual(originalDraft.form);
        if (coupon) expect.soft(evidence.inflight.draft.packages[packageTitle].checkoutCodes).toEqual(originalDraft.checkoutCodes);
        const responseIndex = evidence.timeline.findIndex(event => event.kind === "replacement-response" && event.status === 200);
        expect.soft(responseIndex).toBeGreaterThan(-1);
        expect.soft(evidence.timeline.findIndex(event => event.kind === "cleanup-request")).toBeGreaterThan(responseIndex);
      }
      for (const key of ["discord", "email", "specs", "mainGame"]) {
        expect.soft(evidence.after.fields[key], `${key} survives the slot swap`).toBe(original.fields[key]);
      }
      const afterDraft = evidence.after.draft?.packages?.[packageTitle];
      expect.soft(afterDraft?.form, "stored form survives the slot swap").toEqual(originalDraft.form);
      if (coupon) {
        expect.soft(afterDraft?.checkoutCodes, "validated coupon survives the slot swap").toEqual(originalDraft.checkoutCodes);
      }
    } finally {
      releaseGate();
      if (handlerEntered) await handlerFinished;
      if (routeHandler) await page.unroute("**/api/holdSlot", routeHandler);
      evidence.final = await slotSwapSnapshot(page);
      evidence.calls = flow.state.calls;
      evidence.activeHolds = [...flow.state.holds.entries()];
      await attachJson(testInfo, "slot-swap-diagnostic", evidence);
      await testInfo.attach("slot-swap-final-page", { body: await page.screenshot(), contentType: "image/png" });
      expect(evidence.pageErrors).toEqual([]);
      expect(flow.state.calls.filter(call => call.path.startsWith("/api/payment/"))).toEqual([]);
    }
  });
}

for (const status of [503, 409]) {
  test(`slot-swap failure: ${status} preserves the prior reservation and draft for reload`, async ({ page, flow }, testInfo) => {
    const evidence = { status, pageErrors: [] };
    page.on("pageerror", error => evidence.pageErrors.push({ name: error.name, message: error.message }));
    try {
      await flow.review();
      await flow.codeInput("save20");
      await expect(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      evidence.before = await slotSwapSnapshot(page);
      const original = evidence.before;
      const packageTitle = original.hold.packageTitle;
      const draft = original.draft.packages[packageTitle];
      expect(original.fields).toEqual({ discord: "fixture_visitor", email: "visitor@example.invalid", specs: "Ryzen 7700 / RTX 4070", mainGame: "CS2" });
      expect(draft.form).toMatchObject(original.fields);
      expect(draft.checkoutCodes.coupon.code).toBe("save20");
      expect(flow.state.holds.get(original.hold.startTimeUTC).holdId).toBe(original.hold.holdId);
      flow.state.failures["/api/holdSlot"] = status;
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByRole("button", { name: "11:00 AM", exact: true }).click();
      const failedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/holdSlot" && response.request().method() === "POST");
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      const response = await failedResponse;
      evidence.response = { status: response.status(), body: await response.json() };
      await expect(page.getByRole("alert").filter({ hasText: status === 409 ? /slot was just taken/i : /could not reserve/i })).toBeVisible();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      evidence.afterFailure = await slotSwapSnapshot(page);
      evidence.failedCalls = [...flow.state.calls];
      evidence.failedHolds = [...flow.state.holds.entries()];
      await attachJson(testInfo, "slot-swap-failure-before-product-assertions", evidence);
      expect(evidence.response.status).toBe(status);
      expect(evidence.response.body.ok).toBe(false);
      const holds = flow.state.calls.filter(call => call.path === "/api/holdSlot");
      expect(holds).toHaveLength(2);
      expect(holds[1].body).toEqual({ packageTitle,
        startTimeUTC: `${flow.state.slots[0].date}T05:30:00.000Z`,
        previousHoldId: original.hold.holdId, previousHoldToken: original.hold.holdToken });
      expect(flow.state.calls.filter(call => call.path.startsWith("/api/payment/"))).toEqual([]);
      evidence.setupControlsPassed = true;
      await attachJson(testInfo, "slot-swap-failure-setup-controls-passed", evidence);
      expect.soft(evidence.afterFailure.hold, "unaccepted replacement retains the prior hold").toEqual(original.hold);
      expect.soft(evidence.afterFailure.draft?.packages?.[packageTitle]?.form, "failed replacement retains the form").toEqual(draft.form);
      expect.soft(evidence.afterFailure.draft?.packages?.[packageTitle]?.checkoutCodes, "failed replacement retains the coupon").toEqual(draft.checkoutCodes);
      expect.soft(flow.state.holds.size, "old fixture reservation remains active").toBe(1);
      expect.soft(flow.state.holds.has(original.hold.startTimeUTC)).toBe(true);
      expect.soft(flow.state.calls.filter(call => call.path === "/api/releaseHold"), "unaccepted replacement sends no release").toEqual([]);
      if (testInfo.errors.length) return;
      delete flow.state.failures["/api/holdSlot"];
      await page.reload();
      await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")))) .toEqual(original.hold);
      await expect.poll(async () => await page.getByRole("textbox", { name: "Booking email", exact: true }).isVisible() ||
        await page.getByRole("button", { name: "10:00 AM", exact: true }).isVisible()).toBe(true);
      if (!await page.getByRole("textbox", { name: "Booking email", exact: true }).isVisible()) {
        await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
      }
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      evidence.afterReload = await slotSwapSnapshot(page);
      expect(evidence.afterReload.fields).toEqual(original.fields);
      expect(evidence.afterReload.draft.packages[packageTitle].form).toEqual(draft.form);
      expect(evidence.afterReload.draft.packages[packageTitle].checkoutCodes).toEqual(draft.checkoutCodes);
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      await expect(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toBeVisible();
      evidence.reviewAfterReload = await slotSwapSnapshot(page);
      expect(evidence.reviewAfterReload.draft.packages[packageTitle].checkoutCodes).toEqual(draft.checkoutCodes);
    } finally {
      evidence.final = await slotSwapSnapshot(page);
      evidence.calls = flow.state.calls;
      evidence.activeHolds = [...flow.state.holds.entries()];
      await attachJson(testInfo, "slot-swap-failure", evidence);
      await testInfo.attach("slot-swap-failure-final-page", { body: await page.screenshot(), contentType: "image/png" });
      expect(evidence.pageErrors).toEqual([]);
      expect(flow.state.calls.filter(call => call.path.startsWith("/api/payment/"))).toEqual([]);
    }
  });
}

const bookingHistorySnapshot = page => page.evaluate(() => {
  const keys = ["referral_capture", "referral_dismissed", "referral_session", "booking_draft", "my_slot_hold"];
  const raw = Object.fromEntries(keys.map(key => [key, sessionStorage.getItem(key)]));
  return {
    url: location.href,
    raw,
    journal: JSON.parse(raw.referral_dismissed),
    draft: JSON.parse(raw.booking_draft),
    hold: JSON.parse(raw.my_slot_hold),
    observation: window.bookingHistoryObservation || window.referralBfcache,
    navigation: performance.getEntriesByType("navigation").map(entry => ({ type: entry.type })),
    fields: Object.fromEntries(["discord", "email", "specs", "mainGame"].map(key => [
      key, document.querySelector(`[name="${key}"]`)?.value ?? null,
    ])),
    badges: [...document.querySelectorAll("button")].map(button => button.getAttribute("aria-label") || button.textContent)
      .filter(text => text.startsWith("Remove referral code ")),
  };
});

const observeBookingHistory = page => page.addInitScript(() => {
  const observation = window.bookingHistoryObservation = { nonce: crypto.randomUUID(), pageshows: [] };
  window.addEventListener("pageshow", event => observation.pageshows.push({
    persisted: event.persisted, url: location.href, at: performance.now(),
  }));
});

const expectBookingHistoryBeforeHold = (state, flow, passive) => {
  expect(state.raw.referral_session).toBe(passive);
  expect(state.journal?.choices || {}).toEqual({});
  expect(state.hold).toBeNull();
  expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toEqual([]);
  expect(flow.state.holds.size).toBe(0);
  expect(flow.state.calls.filter(call => call.path === "/api/payment/quote")).toEqual([]);
  expect(state.badges).toEqual([]);
  for (const draft of Object.values(state.draft?.packages || {})) {
    expect(draft.checkoutCodes?.referral?.code || "").toBe("");
    expect(draft.checkoutCodes?.coupon?.code || "").toBe("");
  }
  expect(Object.values(state.fields).every(value => value === null || value === "")).toBe(true);
};

const verifyBookingHistoryReview = async (page, flow, evidence, testInfo, assertions) => {
  await assertions(page.getByRole("button", { name: "Remove referral code save20", exact: true }))
    .toBeVisible({ timeout: 3000 });
  evidence.review = await bookingHistorySnapshot(page);
  expect(evidence.review.hold).toMatchObject({ holdId: "fixture-hold-1", holdToken: "fixture-token-1" });
  expect(flow.state.holds.size).toBe(1);
  expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
  expect(evidence.review.draft.packages[evidence.review.draft.lastTitle].form).toMatchObject({
    email: "visitor@example.invalid", discord: "fixture_visitor", specs: "Ryzen 7700 / RTX 4070", mainGame: "CS2",
  });
  await attachJson(testInfo, "booking-history-review", evidence.review);
  assertions(evidence.review.journal?.choices?.[checkoutScope()]).toBe("save20");
  assertions(referralLookups(flow, evidence.reserveBoundary, "friend")).toEqual([]);
  evidence.quoteBoundary = flow.state.calls.length;
  await flow.payment();
  await expect.poll(() => quoteCalls(flow, evidence.quoteBoundary).length).toBeGreaterThan(0);
  await assertions.poll(() => quoteCalls(flow, evidence.quoteBoundary).at(-1)?.body.referralCode).toBe("save20");
  evidence.payment = await bookingHistorySnapshot(page);
  evidence.newQuotes = quoteCalls(flow, evidence.quoteBoundary);
  expect(evidence.payment.hold).toEqual(evidence.review.hold);
  expect(evidence.payment.draft.packages[evidence.review.draft.lastTitle].form)
    .toEqual(evidence.review.draft.packages[evidence.review.draft.lastTitle].form);
  assertions(evidence.payment.journal?.choices?.[checkoutScope()]).toBe("save20");
  assertions(referralLookups(flow, evidence.reserveBoundary, "friend")).toEqual([]);
};

const attachBookingHistory = async (page, flow, evidence, testInfo) => {
  evidence.final = await bookingHistorySnapshot(page);
  evidence.calls = flow.state.calls;
  evidence.holds = [...flow.state.holds.values()];
  evidence.newQuotes = evidence.quoteBoundary === undefined ? [] : quoteCalls(flow, evidence.quoteBoundary);
  if (evidence.setupComplete && testInfo.errors.length === 0) {
    const panel = page.locator(".booking-payment");
    const readPanel = () => panel.evaluate(element => ({
      at: Date.now(),
      opacity: getComputedStyle(element).opacity,
      children: [...element.children].map(child => ({
        tag: child.tagName,
        opacity: getComputedStyle(child).opacity,
      })),
    }));
    const before = await readPanel();
    await attachJson(testInfo, "booking-history-paint-before", before);
    await expect(panel).toHaveCSS("opacity", "1", { timeout: 5000 });
    for (const child of await panel.locator(":scope > div").all()) {
      await expect(child).toHaveCSS("opacity", "1", { timeout: 5000 });
    }
    const heading = page.getByRole("heading", { name: "Booking Summary", exact: true });
    await heading.scrollIntoViewIfNeeded();
    await expect(heading).toBeInViewport();
    await testInfo.attach("booking-history-painted-summary", {
      body: await page.screenshot(), contentType: "image/png",
    });
    await paymentCode(page).scrollIntoViewIfNeeded();
    await expect(paymentCode(page)).toBeInViewport();
    await expect(paymentCode(page)).toBeEnabled({ timeout: 5000 });
    await expect(paymentCode(page)).toHaveValue(evidence.newQuotes.at(-1).body.referralCode);
    const settled = await bookingHistorySnapshot(page);
    expect(settled.hold).toEqual(evidence.final.hold);
    expect(settled.draft).toEqual(evidence.final.draft);
    await attachJson(testInfo, "booking-history-paint-after", { before, after: await readPanel(), settled });
    await testInfo.attach("booking-history-painted-code", {
      body: await page.screenshot(), contentType: "image/png",
    });
  }
  await attachJson(testInfo, "booking-history-authority", evidence);
  await testInfo.attach("booking-history-final-page", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  expect(evidence.pageErrors).toEqual([]);
  expect(flow.state.calls.filter(call => /\/api\/payment\/(start|capture|confirm|finalize)(\/|$)/.test(call.path))).toEqual([]);
};

for (const [title, history] of [
  ["cross-document Back before a hold keeps the newer creator", "document"],
  ["reload after Back before a hold keeps the newer creator", "reload"],
  ["in-site Back before a hold keeps the newer creator", "spa"],
]) {
  test(`booking history authority: ${title}`, async ({ page, flow }, testInfo) => {
    flow.state.collision = true;
    const evidence = { history, setupComplete: false, pageErrors: [] };
    page.on("pageerror", error => evidence.pageErrors.push({ name: error.name, message: error.message }));
    await observeBookingHistory(page);
    try {
      await page.goto("/booking?ref=friend");
      await expect(page).toHaveURL(/\/booking\?ref=friend$/);
      await page.waitForFunction(() => Boolean(window.next?.router));
      await expect.poll(() => storedReferral(page)).toBe("friend");
      evidence.original = await bookingHistorySnapshot(page);
      expectBookingHistoryBeforeHold(evidence.original, flow, "friend");
      await attachJson(testInfo, "booking-history-original", evidence.original);
      if (history === "spa") await page.evaluate(() => window.next.router.push("/about?ref=save20"));
      else await page.goto("/about?ref=save20");
      await expect(page).toHaveURL(history === "spa" ? /\/about(?:\?|$)/ : /\/about\?ref=save20$/);
      await expect.poll(() => storedReferral(page)).toBe("save20");
      evidence.otherDocument = await bookingHistorySnapshot(page);
      expectBookingHistoryBeforeHold(evidence.otherDocument, flow, "save20");
      if (history === "spa") expect(evidence.otherDocument.raw.referral_capture).toBe("ready");
      await page.goBack({ waitUntil: "commit" });
      await expect(page).toHaveURL(/\/booking\?ref=friend$/);
      await page.waitForFunction(() => Boolean(window.next?.router));
      await expect.poll(() => storedReferral(page)).toBe("save20");
      evidence.afterBack = await bookingHistorySnapshot(page);
      expectBookingHistoryBeforeHold(evidence.afterBack, flow, "save20");
      if (history === "spa") {
        expect(evidence.otherDocument.observation.nonce).toBe(evidence.original.observation.nonce);
        expect(evidence.afterBack.observation.nonce).toBe(evidence.original.observation.nonce);
      } else {
        expect(evidence.afterBack.navigation[0]?.type === "back_forward" ||
          evidence.afterBack.observation.pageshows.some(event => event.persisted)).toBe(true);
      }
      if (history === "reload") {
        await page.reload();
        await expect(page).toHaveURL(/\/booking\?ref=friend$/);
        await page.waitForFunction(() => Boolean(window.next?.router));
        await expect.poll(() => storedReferral(page)).toBe("save20");
        evidence.afterReload = await bookingHistorySnapshot(page);
        expect(evidence.afterReload.navigation[0]?.type).toBe("reload");
        expectBookingHistoryBeforeHold(evidence.afterReload, flow, "save20");
      }
      evidence.setupComplete = true;
      await attachJson(testInfo, "booking-history-before-product-assertions", evidence);
      evidence.reserveBoundary = flow.state.calls.length;
      await reserveAndReview(page, flow);
      await verifyBookingHistoryReview(page, flow, evidence, testInfo, expect.configure({ soft: true }));
    } finally {
      await attachBookingHistory(page, flow, evidence, testInfo);
    }
  });
}

test("booking history authority: a fresh same-view Booking query at Review still captures", async ({ page, flow }, testInfo) => {
  flow.state.collision = true;
  const evidence = { setupComplete: false, pageErrors: [], reserveBoundary: 0 };
  page.on("pageerror", error => evidence.pageErrors.push({ name: error.name, message: error.message }));
  await observeBookingHistory(page);
  try {
    await page.goto("/booking");
    await page.waitForFunction(() => Boolean(window.next?.router));
    evidence.original = await bookingHistorySnapshot(page);
    expectBookingHistoryBeforeHold(evidence.original, flow, null);
    await reserveAndReview(page, flow);
    evidence.beforeFreshQuery = await bookingHistorySnapshot(page);
    expect(evidence.beforeFreshQuery.journal?.choices || {}).toEqual({});
    expect(evidence.beforeFreshQuery.badges).toEqual([]);
    await page.evaluate(() => window.next.router.push("/booking?ref=save20"));
    await expect(page).toHaveURL(/\/booking\?ref=save20$/);
    await expect.poll(() => storedReferral(page)).toBe("save20");
    evidence.afterFreshQuery = await bookingHistorySnapshot(page);
    evidence.routerLocations = await page.evaluate(() => {
      const heading = [...document.querySelectorAll("h1,h2,h3")]
        .find(element => element.textContent === "Review your booking");
      const key = heading && Object.keys(heading).find(name => name.startsWith("__reactFiber$"));
      const locations = [];
      for (let fiber = key ? heading[key] : null; fiber; fiber = fiber.return) {
        const value = fiber.memoizedProps?.value;
        if (value?.location && typeof value.navigationType === "string") {
          locations.push({ pathname: value.location.pathname, search: value.location.search,
            navigationType: value.navigationType });
        }
      }
      return { browser: { pathname: location.pathname, search: location.search }, locations };
    });
    await attachJson(testInfo, "booking-history-router-observation", evidence.routerLocations);
    expect(evidence.afterFreshQuery.observation.nonce).toBe(evidence.beforeFreshQuery.observation.nonce);
    expect(evidence.afterFreshQuery.hold).toEqual(evidence.beforeFreshQuery.hold);
    expect(evidence.afterFreshQuery.fields).toEqual(evidence.beforeFreshQuery.fields);
    expect(evidence.afterFreshQuery.draft.packages[evidence.beforeFreshQuery.draft.lastTitle].form)
      .toEqual(evidence.beforeFreshQuery.draft.packages[evidence.beforeFreshQuery.draft.lastTitle].form);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
    evidence.setupComplete = true;
    await attachJson(testInfo, "booking-history-before-product-assertions", evidence);
    await verifyBookingHistoryReview(page, flow, evidence, testInfo, expect);
  } finally {
    await attachBookingHistory(page, flow, evidence, testInfo);
  }
});

test("booking history authority: fresh same-view capture keeps an existing scoped choice", async ({ page, flow }, testInfo) => {
  flow.state.collision = true;
  const evidence = { setupComplete: false, pageErrors: [] };
  page.on("pageerror", error => evidence.pageErrors.push({ name: error.name, message: error.message }));
  await observeBookingHistory(page);
  try {
    await page.goto("/booking?ref=friend");
    await page.waitForFunction(() => Boolean(window.next?.router));
    await expect.poll(() => storedReferral(page)).toBe("friend");
    await reserveAndReview(page, flow);
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    await expect.poll(async () => {
      const state = await bookingHistorySnapshot(page);
      return state.draft.packages[state.draft.lastTitle].checkoutCodes?.referral?.code;
    }).toBe("friend");
    evidence.beforeScopedQuery = await bookingHistorySnapshot(page);
    expect(evidence.beforeScopedQuery.journal.choices[checkoutScope()]).toBe("friend");
    evidence.captureBoundary = flow.state.calls.length;
    await page.evaluate(() => window.next.router.push("/booking?ref=save20"));
    await expect(page).toHaveURL(/\/booking\?ref=save20$/);
    await expect.poll(() => storedReferral(page)).toBe("save20");
    evidence.afterScopedQuery = await bookingHistorySnapshot(page);
    expect(evidence.afterScopedQuery.observation.nonce).toBe(evidence.beforeScopedQuery.observation.nonce);
    expect(evidence.afterScopedQuery.hold).toEqual(evidence.beforeScopedQuery.hold);
    expect(evidence.afterScopedQuery.fields).toEqual(evidence.beforeScopedQuery.fields);
    expect(evidence.afterScopedQuery.draft.packages[evidence.beforeScopedQuery.draft.lastTitle].form)
      .toEqual(evidence.beforeScopedQuery.draft.packages[evidence.beforeScopedQuery.draft.lastTitle].form);
    expect(evidence.afterScopedQuery.draft.packages[evidence.beforeScopedQuery.draft.lastTitle].checkoutCodes)
      .toEqual(evidence.beforeScopedQuery.draft.packages[evidence.beforeScopedQuery.draft.lastTitle].checkoutCodes);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
    evidence.setupComplete = true;
    await attachJson(testInfo, "booking-history-before-product-assertions", evidence);
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
    expect(evidence.afterScopedQuery.journal.choices[checkoutScope()]).toBe("friend");
    expect(referralLookups(flow, evidence.captureBoundary, "save20")).toEqual([]);
    evidence.quoteBoundary = flow.state.calls.length;
    await flow.payment();
    await waitQuote(flow, "friend", evidence.quoteBoundary);
    evidence.payment = await bookingHistorySnapshot(page);
    expect(evidence.payment.hold).toEqual(evidence.beforeScopedQuery.hold);
    expect(evidence.payment.draft.packages[evidence.beforeScopedQuery.draft.lastTitle].form)
      .toEqual(evidence.beforeScopedQuery.draft.packages[evidence.beforeScopedQuery.draft.lastTitle].form);
    expect(evidence.payment.journal.choices[checkoutScope()]).toBe("friend");
    expect(referralLookups(flow, evidence.captureBoundary, "save20")).toEqual([]);
    expect(flow.state.calls.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
  } finally {
    await attachBookingHistory(page, flow, evidence, testInfo);
  }
});

const lockedPriceTest = test.extend({
  launchOptions: async ({ launchOptions }, use) => {
    await use({ ...launchOptions, ignoreDefaultArgs: ["--disable-back-forward-cache"] });
  },
});

lockedPriceTest("a locked checkout keeps its displayed price after a newer creator link and cached Back", async ({ page, browser, flow, baseURL }, testInfo) => {
  const evidence = { setupComplete: false, pageErrors: [], overrides: [], requests: [], responses: [] };
  const providers = {
    dodo: { enabled: true, mode: "test" },
    razorpay: { enabled: false, mode: "disabled" },
    paypal: { enabled: false, mode: "disabled" },
  };
  const blankQuote = { grossAmount: 54.95, netAmount: 54.95, isFree: false };
  const starts = () => evidence.overrides.filter(call => call.path === "/api/payment/start");
  const quotes = () => evidence.overrides.filter(call => call.path === "/api/payment/quote");
  const snapshot = async () => ({
    ...await bookingHistorySnapshot(page),
    ...await page.evaluate(() => {
      const sessionRaw = sessionStorage.getItem("payment_session_state");
      const session = sessionRaw ? JSON.parse(sessionRaw) : null;
      const panel = document.querySelector(".booking-payment");
      const heading = [...document.querySelectorAll("h3")].find(element => element.textContent === "Booking Summary");
      const summary = heading?.parentElement;
      const input = document.querySelector("#payment-referral-code");
      return {
        at: Date.now(), sessionRaw, session,
        fingerprint: session?.fingerprint ? JSON.parse(session.fingerprint) : null,
        ui: {
          panelOpacity: panel ? getComputedStyle(panel).opacity : null,
          children: panel ? [...panel.children].map(child => ({ tag: child.tagName, opacity: getComputedStyle(child).opacity })) : [],
          summary: summary?.innerText || "",
          totals: summary ? [...summary.querySelectorAll("span")].map(element => element.textContent.trim()).filter(text => /^\$[\d.]+ USD$/.test(text)) : [],
          referralInput: input?.value ?? null, referralDisabled: input?.disabled ?? null,
          lockedBanner: [...document.querySelectorAll("p")].map(element => element.textContent).find(text => text.includes("Pricing and provider selection are locked for this session.")) || "",
          resume: [...document.querySelectorAll("button")].filter(button => button.textContent.trim() === "Resume checkout").map(button => ({ disabled: button.disabled })),
          body: document.body.innerText,
        },
      };
    }),
  });
  page.on("pageerror", error => evidence.pageErrors.push({ name: error.name, message: error.message }));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) evidence.requests.push({ at: Date.now(), url: request.url(), path: url.pathname, method: request.method(), body: request.postDataJSON() });
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/")) evidence.responses.push({ at: Date.now(), url: response.url(), path: url.pathname, status: response.status() });
  });
  for (const path of ["/api/payment/providers", "/api/payment/quote", "/api/payment/start"]) {
    await page.route(`**${path}`, async route => {
      const request = route.request();
      const body = request.postDataJSON();
      const call = { at: Date.now(), path, method: request.method(), body };
      evidence.overrides.push(call);
      expect(new URL(request.url()).origin).toBe(baseURL);
      let response;
      if (path === "/api/payment/providers") {
        response = { ok: true, providers };
      } else if (path === "/api/payment/quote") {
        expect(request.method()).toBe("POST");
        expect(["", "friend"]).toContain(body.referralCode);
        response = {
          ok: true, providers, quoteFingerprint: `locked-fixture-${body.referralCode || "none"}`,
          quote: { grossAmount: 54.95, netAmount: body.referralCode === "friend" ? 49.45 : 54.95, isFree: false },
        };
      } else {
        expect(request.method()).toBe("POST");
        const hold = flow.state.holds.get(body.bookingPayload.startTimeUTC);
        expect(hold).toBeTruthy();
        response = {
          ok: true, paymentAccessToken: "fixture-payment", status: "started", quote: blankQuote,
          quoteFingerprint: "locked-fixture-none", providerPayload: { checkoutUrl: `${baseURL}/__test/checkout-handoff` },
          sessionExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
          refreshedHold: { slotHoldId: hold.holdId, slotHoldToken: hold.holdToken, slotHoldExpiresAt: hold.expiresAt, phase: "payment_pending" },
        };
        call.actualFixtureHold = { ...hold };
      }
      call.response = response;
      call.status = 200;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
      call.fulfilledAt = Date.now();
    });
  }
  await observeBookingHistory(page);
  try {
    const session = await browser.newBrowserCDPSession();
    evidence.engine = await session.send("Browser.getVersion");
    evidence.commandLine = await session.send("Browser.getBrowserCommandLine");
    await session.detach();
    expect(evidence.commandLine.arguments).not.toContain("--disable-back-forward-cache");
    expect(evidence.commandLine.arguments).toContain("--ozone-platform=x11");
    expect(evidence.commandLine.arguments).toContain(`--unsafely-treat-insecure-origin-as-secure=${baseURL}`);
    await flow.review();
    await flow.payment();
    const panel = page.locator(".booking-payment");
    const heading = page.getByRole("heading", { name: "Booking Summary", exact: true });
    const summary = heading.locator("..");
    await expect.poll(() => quotes().some(call => call.body.referralCode === "" && call.status === 200)).toBe(true);
    await expect(summary.getByText("$54.95 USD", { exact: true })).toBeVisible();
    await expect(paymentCode(page)).toHaveValue("");
    evidence.original = await snapshot();
    expect(evidence.original.journal?.choices || {}).toEqual({});
    expect(evidence.original.badges).toEqual([]);
    expect(evidence.original.draft.packages[evidence.original.draft.lastTitle].checkoutCodes?.referral?.code || "").toBe("");
    expect(evidence.original.draft.packages[evidence.original.draft.lastTitle].checkoutCodes?.coupon?.code || "").toBe("");
    expect(flow.state.holds.size).toBe(1);
    expect(evidence.original.hold.holdId).toBe([...flow.state.holds.values()][0].holdId);
    await attachJson(testInfo, "locked-price-original", evidence.original);

    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
    evidence.handoff = await snapshot();
    expect(starts()).toHaveLength(1);
    expect(starts()[0].body.provider).toBe("dodo");
    expect(starts()[0].body.bookingPayload.referralCode).toBe("");
    expect(starts()[0].body.quoteFingerprint).toBe("locked-fixture-none");
    expect(starts()[0].body.bookingPayload.slotHoldId).toBe(evidence.original.hold.holdId);
    expect(starts()[0].body.bookingPayload.slotHoldToken).toBe(evidence.original.hold.holdToken);
    expect(evidence.handoff.session.paymentAccessToken).toBe("fixture-payment");
    expect(evidence.handoff.session.provider).toBe("dodo");
    expect(evidence.handoff.fingerprint.referralCode).toBe("");
    expect(evidence.handoff.session.result.quote.netAmount).toBe(54.95);
    expect(evidence.handoff.journal?.choices || {}).toEqual({});
    await attachJson(testInfo, "locked-price-handoff", evidence.handoff);

    await page.goBack({ waitUntil: "commit" });
    await expect(page).toHaveURL(/\/payment$/);
    await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeEnabled();
    await expect(page.getByText(/Pricing and provider selection are locked for this session\./)).toBeVisible();
    await expect(summary.getByText("$54.95 USD", { exact: true })).toBeVisible();
    await expect(paymentCode(page)).toBeDisabled();
    await expect(paymentCode(page)).toHaveValue("");
    await expect(panel).toHaveCSS("opacity", "1", { timeout: 5000 });
    await heading.scrollIntoViewIfNeeded();
    await expect(heading).toBeInViewport();
    evidence.beforeB = await snapshot();
    expect(evidence.beforeB.sessionRaw).toBe(evidence.handoff.sessionRaw);
    expect(evidence.beforeB.journal?.choices || {}).toEqual({});
    expect(evidence.beforeB.hold.phase).toBe("payment_pending");
    expect(evidence.beforeB.hold.holdId).toBe(evidence.original.hold.holdId);
    expect(evidence.beforeB.hold.holdToken).toBe(evidence.original.hold.holdToken);
    expect(evidence.beforeB.hold.startTimeUTC).toBe(evidence.original.hold.startTimeUTC);
    expect(evidence.beforeB.draft.packages[evidence.beforeB.draft.lastTitle].form)
      .toEqual(evidence.original.draft.packages[evidence.original.draft.lastTitle].form);
    await attachJson(testInfo, "locked-price-before-new-link", evidence.beforeB);
    await testInfo.attach("locked-price-before-new-link-viewport", { body: await page.screenshot(), contentType: "image/png" });

    await page.goto("/about?ref=friend");
    await expect.poll(() => storedReferral(page)).toBe("friend");
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_capture"))).toBe("ready");
    evidence.otherDocument = await snapshot();
    expect(evidence.otherDocument.observation.nonce).not.toBe(evidence.beforeB.observation.nonce);
    expect(evidence.otherDocument.sessionRaw).toBe(evidence.beforeB.sessionRaw);
    evidence.backBoundary = { at: Date.now(), overrideIndex: evidence.overrides.length, flowIndex: flow.state.calls.length, requestIndex: evidence.requests.length };
    const newerQuote = page.waitForResponse(r => new URL(r.url()).pathname === "/api/payment/quote" && r.request().postDataJSON()?.referralCode === "friend", { timeout: 3000 })
      .then(async r => { await r.finished(); return { status: r.status(), body: await r.json() }; })
      .catch(e => ({ notObservedWithinMs: 3000, name: e.name }));
    await page.goBack({ waitUntil: "commit" });
    await expect(page).toHaveURL(/\/payment$/);
    await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeEnabled();
    await expect(page.getByText(/Pricing and provider selection are locked for this session\./)).toBeVisible();
    await expect.poll(async () => {
      const state = await bookingHistorySnapshot(page);
      return { nonce: state.observation.nonce, persisted: state.observation.pageshows
        .slice(evidence.beforeB.observation.pageshows.length)
        .some(event => event.persisted && new URL(event.url).pathname === "/payment") };
    }).toEqual({ nonce: evidence.beforeB.observation.nonce, persisted: true });
    evidence.afterBack = await snapshot();
    expect(evidence.afterBack.observation.nonce).toBe(evidence.beforeB.observation.nonce);
    const restoredEvents = evidence.afterBack.observation.pageshows.slice(evidence.beforeB.observation.pageshows.length);
    expect(restoredEvents.some(event => event.persisted && new URL(event.url).pathname === "/payment")).toBe(true);
    evidence.newerQuote = await newerQuote;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(panel).toHaveCSS("opacity", "1", { timeout: 5000 });
    for (const child of await panel.locator(":scope > div").all()) {
      await expect(child).toHaveCSS("opacity", "1", { timeout: 5000 });
    }
    await heading.scrollIntoViewIfNeeded();
    await expect(heading).toBeInViewport();
    evidence.settled = await snapshot();
    expect(evidence.settled.hold.holdId).toBe(evidence.beforeB.hold.holdId);
    expect(evidence.settled.hold.holdToken).toBe(evidence.beforeB.hold.holdToken);
    expect(evidence.settled.hold.startTimeUTC).toBe(evidence.beforeB.hold.startTimeUTC);
    expect(evidence.settled.session.paymentAccessToken).toBe(evidence.beforeB.session.paymentAccessToken);
    expect(evidence.settled.session.provider).toBe("dodo");
    expect(evidence.settled.draft.packages[evidence.settled.draft.lastTitle].form)
      .toEqual(evidence.beforeB.draft.packages[evidence.beforeB.draft.lastTitle].form);
    expect(flow.state.holds.size).toBe(1);
    evidence.setupComplete = true;
    await attachJson(testInfo, "locked-price-before-product-assertions", evidence);

    const soft = expect.configure({ soft: true });
    await soft(summary.getByText("$54.95 USD", { exact: true })).toBeVisible();
    await soft(summary.getByText(/friend\s*·/)).not.toBeVisible();
    await soft(paymentCode(page)).toBeDisabled();
    await soft(paymentCode(page)).toHaveValue("");
    soft(evidence.settled.sessionRaw).toBe(evidence.beforeB.sessionRaw);
    soft(evidence.settled.session.paymentAccessToken).toBe(evidence.beforeB.session.paymentAccessToken);
    soft(evidence.settled.session.fingerprint).toBe(evidence.beforeB.session.fingerprint);
    soft(evidence.settled.session.result.quote).toEqual(evidence.beforeB.session.result.quote);
    soft(evidence.settled.hold).toEqual(evidence.beforeB.hold);
    soft(evidence.settled.draft).toEqual(evidence.beforeB.draft);
    soft(starts()).toHaveLength(1);
    soft(evidence.requests.filter(call => /\/api\/payment\/(cancel|finalize|capture|confirm)(\/|$)/.test(call.path))).toEqual([]);
    soft(evidence.requests.filter(call => call.path === "/api/releaseHold")).toEqual([]);
    soft(evidence.requests.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
  } finally {
    evidence.final = await snapshot();
    evidence.flowCalls = flow.state.calls;
    evidence.holds = [...flow.state.holds.entries()];
    evidence.aborted = flow.state.aborted;
    evidence.productErrors = testInfo.errors.map(error => ({ message: error.message, stack: error.stack }));
    await attachJson(testInfo, "locked-price-diagnosis", evidence);
    await testInfo.attach("locked-price-final-viewport", { body: await page.screenshot(), contentType: "image/png" });
    await testInfo.attach("locked-price-final-fullpage", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    if (await paymentCode(page).count()) {
      await paymentCode(page).scrollIntoViewIfNeeded();
      await testInfo.attach("locked-price-final-code", { body: await page.screenshot(), contentType: "image/png" });
    }
    expect(evidence.pageErrors).toEqual([]);
    expect(flow.state.aborted).toEqual([]);
  }
});

const lockedSnapshotTest = lockedPriceTest.extend({
  locked: async ({ page, browser, flow, baseURL }, use, testInfo) => {
    const evidence = { setupComplete: false, snapshots: {}, calls: [], requests: [], responses: [], pageErrors: [], assetReadiness: [] };
    const config = { stacked: false, changed: false, failedCancels: 0 };
    const pendingAssets = new Set();
    const providers = { dodo: { enabled: true, mode: "test" }, razorpay: { enabled: false, mode: "disabled" }, paypal: { enabled: false, mode: "disabled" } };
    const quoteFor = body => {
      const stacked = body.referralCode === "friend" && body.couponCode === "save20" && !config.changed;
      const referred = body.referralCode === "friend";
      return {
        grossAmount: 54.95, netAmount: stacked ? 39.56 : referred ? (config.changed ? 52.20 : 49.45) : 54.95,
        isFree: false, referralDiscountPercent: referred ? (config.changed ? 5 : 10) : 0,
        referralDiscountAmount: stacked ? 4.4 : referred ? (config.changed ? 2.75 : 5.5) : 0,
        couponDiscountPercent: stacked ? 20 : 0, couponDiscountAmount: stacked ? 10.99 : 0,
        couponDiscountType: stacked ? "percent" : "", couponDiscountValue: stacked ? 20 : 0,
        canCombineWithReferral: true,
      };
    };
    const snapshot = async () => ({
      ...await bookingHistorySnapshot(page),
      ...await page.evaluate(() => {
        const sessionRaw = sessionStorage.getItem("payment_session_state");
        const session = sessionRaw ? JSON.parse(sessionRaw) : null;
        const panel = document.querySelector(".booking-payment");
        const summary = [...document.querySelectorAll("h3")].find(element => element.textContent === "Booking Summary")?.parentElement;
        const input = id => {
          const element = document.getElementById(id);
          return { value: element?.value ?? null, disabled: element?.disabled ?? null, invalid: element?.getAttribute("aria-invalid"), describedBy: element?.getAttribute("aria-describedby") };
        };
        return { at: Date.now(), sessionRaw, session, fingerprint: session?.fingerprint ? JSON.parse(session.fingerprint) : null,
          ui: { summary: summary?.innerText || "", body: document.body.innerText, opacity: panel ? getComputedStyle(panel).opacity : null,
            children: panel ? [...panel.children].map(child => getComputedStyle(child).opacity) : [],
            referral: input("payment-referral-code"), coupon: input("payment-coupon-code"),
            alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent) } };
      }),
    });
    const capture = async label => {
      const state = await snapshot();
      evidence.snapshots[label] = state;
      await attachJson(testInfo, `locked-price-${label}`, state);
      return state;
    };
    page.on("pageerror", error => evidence.pageErrors.push({ name: error.name, message: error.message }));
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.origin === baseURL && ["script", "stylesheet", "image", "font"].includes(request.resourceType())) pendingAssets.add(request);
      if (url.pathname.startsWith("/api/")) evidence.requests.push({ at: Date.now(), path: url.pathname, method: request.method(), body: request.postDataJSON() });
    });
    page.on("requestfinished", request => pendingAssets.delete(request));
    page.on("requestfailed", request => pendingAssets.delete(request));
    page.on("response", response => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/api/")) evidence.responses.push({ at: Date.now(), path: url.pathname, status: response.status() });
    });
    for (const path of ["/api/payment/providers", "/api/payment/quote", "/api/payment/start", "/api/payment/cancel", "/api/ref/validateReferral", "/api/ref/validateCoupon"]) {
      await page.route(`**${path}*`, async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname !== path || url.origin !== baseURL) return route.fallback();
        if (path.startsWith("/api/ref/") && !config.changed) return route.fallback();
        const call = { at: Date.now(), path, query: url.search, method: request.method(), body: request.postDataJSON(), authorization: request.headers().authorization || "" };
        evidence.calls.push(call);
        let status = 200;
        let response;
        if (path === "/api/payment/providers") response = { ok: true, providers };
        if (path === "/api/payment/quote") response = { ok: true, providers, quoteFingerprint: `saved-price-${call.body.referralCode || "none"}-${call.body.couponCode || "none"}-${config.changed ? "changed" : "initial"}`, quote: quoteFor(call.body) };
        if (path === "/api/payment/start") {
          const hold = flow.state.holds.get(call.body.bookingPayload.startTimeUTC);
          expect(hold).toBeTruthy();
          const quoted = evidence.calls.filter(entry => entry.path === "/api/payment/quote" && entry.response).at(-1);
          expect(call.body.quoteFingerprint).toBe(quoted.response.quoteFingerprint);
          expect(call.body.bookingPayload.referralCode).toBe(config.stacked ? "friend" : "");
          expect(call.body.bookingPayload.couponCode).toBe(config.stacked ? "save20" : "");
          response = { ok: true, paymentAccessToken: "fixture-payment", status: "started", quote: quoted.response.quote,
            quoteFingerprint: quoted.response.quoteFingerprint, providerPayload: { checkoutUrl: `${baseURL}/__test/checkout-handoff` },
            sessionExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
            refreshedHold: { slotHoldId: hold.holdId, slotHoldToken: hold.holdToken, slotHoldExpiresAt: hold.expiresAt, phase: "payment_pending" } };
        }
        if (path === "/api/payment/cancel") {
          const hold = [...flow.state.holds.values()][0];
          expect(hold).toBeTruthy();
          const index = evidence.calls.filter(entry => entry.path === path).length;
          if (index <= config.failedCancels) { status = 409; response = { ok: false, error: "Fixture cancellation refused." }; }
          else response = { ok: true, cancelled: true, refreshedHold: { slotHoldId: hold.holdId, slotHoldToken: hold.holdToken, slotHoldExpiresAt: hold.expiresAt, phase: "holding" } };
        }
        if (path === "/api/ref/validateReferral") response = { ok: true, active: true, eligible: true, referral: { code: "friend", currentDiscountPercent: 5 } };
        if (path === "/api/ref/validateCoupon") { status = 400; response = { ok: false, error: "This coupon has expired.", reason: "expired" }; }
        call.inflight = await snapshot();
        call.response = response;
        call.status = status;
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(response) });
        call.fulfilledAt = Date.now();
      });
    }
    const heading = page.getByRole("heading", { name: "Booking Summary", exact: true });
    const summary = heading.locator("..");
    const waitForAssets = async () => {
      const checkpoint = { at: Date.now(), url: page.url(), pending: [...pendingAssets].map(request => ({ url: request.url(), type: request.resourceType() })) };
      evidence.assetReadiness.push(checkpoint);
      await expect.poll(() => pendingAssets.size, { timeout: 10000 }).toBe(0);
      checkpoint.readyAt = Date.now();
      checkpoint.pendingAtReady = [...pendingAssets].map(request => ({ url: request.url(), type: request.resourceType() }));
    };
    const paint = async () => {
      const panel = page.locator(".booking-payment");
      await expect(panel).toHaveCSS("opacity", "1", { timeout: 5000 });
      for (const child of await panel.locator(":scope > div").all()) await expect(child).toHaveCSS("opacity", "1", { timeout: 5000 });
      await heading.scrollIntoViewIfNeeded();
      await expect(heading).toBeInViewport();
    };
    const open = async stacked => {
      config.stacked = Boolean(stacked);
      await flow.review();
      if (stacked) {
        await flow.codeInput("friend");
        await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
        await flow.codeInput("save20");
        await expect(page.getByRole("button", { name: "Remove coupon code save20", exact: true })).toBeVisible();
      }
      await flow.payment();
      await expect(summary.getByText(stacked ? "$39.56 USD" : "$54.95 USD", { exact: true })).toBeVisible();
      await capture("original");
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
      const handoff = await capture("handoff");
      expect(evidence.calls.filter(call => call.path === "/api/payment/start")).toHaveLength(1);
      expect(handoff.session.provider).toBe("dodo");
      expect(handoff.session.result.quote.netAmount).toBe(stacked ? 39.56 : 54.95);
      await page.goBack({ waitUntil: "commit" });
      await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeEnabled();
      await expect(page.getByText(/Pricing and provider selection are locked for this session\./)).toBeVisible();
      await paint();
      const baseline = await capture("baseline");
      expect(baseline.sessionRaw).toBe(handoff.sessionRaw);
      expect(baseline.hold.holdId).toBe(handoff.hold.holdId);
      expect(baseline.fingerprint.referralCode).toBe(stacked ? "friend" : "");
      expect(baseline.fingerprint.couponCode).toBe(stacked ? "save20" : "");
      return baseline;
    };
    const unchanged = (actual, baseline) => {
      const soft = expect.configure({ soft: true });
      soft(actual.sessionRaw).toBe(baseline.sessionRaw);
      soft(actual.hold).toEqual(baseline.hold);
      soft(actual.draft).toEqual(baseline.draft);
    };
    await observeBookingHistory(page);
    const browserSession = await browser.newBrowserCDPSession();
    evidence.engine = await browserSession.send("Browser.getVersion");
    evidence.commandLine = await browserSession.send("Browser.getBrowserCommandLine");
    await browserSession.detach();
    await attachJson(testInfo, "saved-price-engine", evidence.engine);
    await attachJson(testInfo, "saved-price-launch-options", evidence.commandLine);
    try {
      await use({ evidence, config, snapshot, capture, open, paint, summary, unchanged, waitForAssets });
    } finally {
      try {
        evidence.final = await snapshot();
      } catch (error) {
        evidence.final = { unavailable: true, url: page.url(), name: error.name, message: error.message };
      }
      evidence.flowCalls = flow.state.calls;
      evidence.aborted = flow.state.aborted;
      evidence.holds = [...flow.state.holds.entries()];
      evidence.errors = testInfo.errors.map(error => ({ message: error.message, stack: error.stack }));
      await attachJson(testInfo, "saved-price-evidence", evidence);
      await testInfo.attach("saved-price-summary", { body: await page.screenshot(), contentType: "image/png" });
      await testInfo.attach("saved-price-fullpage", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      if (await paymentCode(page).count()) {
        await paymentCode(page).scrollIntoViewIfNeeded();
        await expect(paymentCode(page)).toBeInViewport();
        await testInfo.attach("saved-price-code", { body: await page.screenshot(), contentType: "image/png" });
      }
      expect(evidence.pageErrors).toEqual([]);
      expect(evidence.aborted).toEqual([]);
      expect(evidence.requests.filter(call => /\/api\/payment\/(capture|confirm|finalize)(\/|$)/.test(call.path))).toEqual([]);
      expect(evidence.requests.filter(call => call.path === "/api/releaseHold")).toEqual([]);
      expect(evidence.requests.filter(call => call.path === "/api/payment/start")).toHaveLength(1);
      expect(evidence.requests.filter(call => call.path === "/api/holdSlot")).toHaveLength(1);
    }
  },
});

lockedSnapshotTest("a locked checkout keeps its price on reload and unlocks only after cancellation succeeds", async ({ page, flow, locked }, testInfo) => {
  const baseline = await locked.open(false);
  expect(baseline.journal?.choices || {}).toEqual({});
  await locked.waitForAssets();
  await page.goto("/about?ref=friend");
  await expect.poll(() => storedReferral(page)).toBe("friend");
  await locked.capture("public-link");
  await locked.waitForAssets();
  await page.goto("/payment");
  await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeEnabled();
  await locked.paint();
  await locked.waitForAssets();
  const quoteBoundary = locked.evidence.calls.length;
  await page.reload();
  await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeEnabled();
  await expect.poll(() => locked.evidence.calls.slice(quoteBoundary).some(call => call.path === "/api/payment/quote" && call.response?.quote.netAmount === 49.45)).toBe(true);
  await locked.paint();
  const restored = await locked.capture("reload");
  expect(restored.navigation[0].type).toBe("reload");
  expect(restored.session.paymentAccessToken).toBe(baseline.session.paymentAccessToken);
  expect(restored.hold.holdId).toBe(baseline.hold.holdId);
  locked.evidence.setupComplete = true;
  await attachJson(testInfo, "saved-price-setup-controls", locked.evidence);
  const soft = expect.configure({ soft: true });
  await soft(locked.summary.getByText("$54.95 USD", { exact: true })).toBeVisible();
  await soft(locked.summary.getByText(/friend\s*·/)).not.toBeVisible();
  await soft(paymentCode(page)).toHaveValue("");
  await soft(paymentCode(page)).toBeDisabled();
  locked.unchanged(restored, baseline);

  locked.config.failedCancels = 1;
  await locked.capture("before-failed-cancel");
  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Fixture cancellation refused." })).toBeVisible();
  const refused = await locked.capture("failed-cancel");
  locked.unchanged(refused, baseline);
  await soft(locked.summary.getByText("$54.95 USD", { exact: true })).toBeVisible();
  await soft(paymentCode(page)).toBeDisabled();
  expect(locked.evidence.calls.filter(call => call.path === "/api/payment/start")).toHaveLength(1);

  const beforeSuccess = locked.evidence.calls.length;
  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await expect(paymentCode(page)).toBeEnabled();
  await expect.poll(() => locked.evidence.calls.slice(beforeSuccess).some(call => call.path === "/api/payment/quote" && call.response?.quote.netAmount === 49.45)).toBe(true);
  await expect(locked.summary.getByText("$49.45 USD", { exact: true })).toBeVisible();
  await locked.paint();
  const released = await locked.capture("successful-cancel");
  expect(released.session).toBeNull();
  expect(released.hold.holdId).toBe(baseline.hold.holdId);
  expect(released.hold.holdToken).toBe(baseline.hold.holdToken);
  expect(released.hold.phase).toBe("holding");
  expect(released.draft.packages[released.draft.lastTitle].form).toEqual(baseline.draft.packages[baseline.draft.lastTitle].form);
  const cancels = locked.evidence.calls.filter(call => call.path === "/api/payment/cancel");
  expect(cancels).toHaveLength(2);
  expect(cancels.map(call => call.authorization)).toEqual(["Bearer fixture-payment", "Bearer fixture-payment"]);
  expect(cancels.map(call => call.status)).toEqual([409, 200]);
  expect(flow.state.holds.size).toBe(1);
});

lockedSnapshotTest("a locked checkout retains its saved referral and coupon amounts when their current quotes change", async ({ page, locked }, testInfo) => {
  const baseline = await locked.open(true);
  expect(baseline.session.result.quote).toMatchObject({ grossAmount: 54.95, netAmount: 39.56, referralDiscountPercent: 10, referralDiscountAmount: 4.4, couponDiscountPercent: 20, couponDiscountAmount: 10.99 });
  locked.config.changed = true;
  const boundary = locked.evidence.calls.length;
  await page.reload();
  await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeEnabled();
  await expect.poll(() => locked.evidence.calls.slice(boundary).some(call => call.path === "/api/payment/quote" && call.response?.quote.netAmount === 52.20)).toBe(true);
  await locked.paint();
  const restored = await locked.capture("changed-current-quotes");
  expect(restored.session.paymentAccessToken).toBe(baseline.session.paymentAccessToken);
  expect(restored.hold.holdId).toBe(baseline.hold.holdId);
  locked.evidence.setupComplete = true;
  await attachJson(testInfo, "saved-price-setup-controls", locked.evidence);
  const soft = expect.configure({ soft: true });
  await soft(locked.summary.getByText("$39.56 USD", { exact: true })).toBeVisible();
  await soft(locked.summary.getByText("friend · −$4.40", { exact: true })).toBeVisible();
  await soft(locked.summary.getByText("save20 · −$10.99", { exact: true })).toBeVisible();
  await soft(paymentCode(page)).toHaveValue("friend");
  await soft(paymentCode(page)).toBeDisabled();
  await soft(page.locator("#payment-coupon-code")).toHaveValue("save20");
  await soft(page.locator("#payment-coupon-code")).toBeDisabled();
  await soft(page.getByRole("alert").filter({ hasText: "This coupon has expired." })).not.toBeVisible();
  await soft(page.locator("#payment-coupon-code")).toHaveAttribute("aria-invalid", "false");
  await soft(page.locator("#payment-coupon-code")).not.toHaveAttribute("aria-describedby");
  await soft(page.getByRole("button", { name: "Remove coupon", exact: true })).toBeDisabled();
  locked.unchanged(restored, baseline);
});

lockedSnapshotTest("a locked checkout with no saved quote keeps recovery without inventing a total", async ({ page, locked }, testInfo) => {
  const baseline = await locked.open(false);
  const legacyRaw = await page.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem("payment_session_state"));
    delete session.result.quote;
    const raw = JSON.stringify(session);
    sessionStorage.setItem("payment_session_state", raw);
    return raw;
  });
  const constructed = { ...baseline, sessionRaw: legacyRaw, session: JSON.parse(legacyRaw) };
  const expected = JSON.parse(baseline.sessionRaw);
  delete expected.result.quote;
  expect(constructed.session).toEqual(expected);
  locked.evidence.constructedLegacy = constructed;
  await locked.capture("constructed-no-saved-quote");
  await page.goto("/about?ref=friend");
  await expect.poll(() => storedReferral(page)).toBe("friend");
  const boundary = locked.evidence.calls.length;
  await page.goto("/payment");
  await expect(page.getByRole("button", { name: "Resume checkout", exact: true })).toBeEnabled();
  await expect.poll(() => locked.evidence.calls.slice(boundary).some(call => call.path === "/api/payment/quote" && call.response?.quote.netAmount === 49.45)).toBe(true);
  await locked.paint();
  const restored = await locked.capture("legacy-price-unavailable");
  expect(restored.session.paymentAccessToken).toBe(baseline.session.paymentAccessToken);
  expect(restored.hold.holdId).toBe(baseline.hold.holdId);
  locked.evidence.setupComplete = true;
  await attachJson(testInfo, "saved-price-setup-controls", locked.evidence);
  const soft = expect.configure({ soft: true });
  await soft(locked.summary.getByText("Unavailable", { exact: true })).toBeVisible();
  await soft(locked.summary.getByText("Session price unavailable. Check payment status or change payment method.", { exact: true })).toBeVisible();
  await soft(locked.summary.getByText(/\$(54\.95|49\.45)(?: USD)?/)).toHaveCount(0);
  await soft(locked.summary.getByText(/friend\s*·/)).not.toBeVisible();
  await soft(page.getByRole("button", { name: "Confirm Free Booking", exact: true })).not.toBeVisible();
  await soft(page.getByRole("button", { name: "Check payment status", exact: true })).toBeEnabled();
  await soft(page.getByRole("button", { name: "Change payment method", exact: true })).toBeEnabled();
  await soft(page.getByText(/Pricing and provider selection are locked for this session\./)).toBeVisible();
  await soft(paymentCode(page)).toHaveValue("");
  await soft(paymentCode(page)).toBeDisabled();
  locked.unchanged(restored, constructed);
});
