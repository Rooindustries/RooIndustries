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
});
