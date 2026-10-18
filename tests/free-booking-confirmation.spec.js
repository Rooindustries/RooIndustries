const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", actionTimeout: 10000, reducedMotion: "reduce" });

const bookingId = "fixture-free-confirmation";

const openFreePayment = async (page, flow) => {
  await page.route("**/api/ref/validateCoupon?code=free100*", route => route.fulfill({
    json: { ok: true, coupon: { code: "free100", discountType: "percent", discountPercent: 100, canCombineWithReferral: true } },
  }));
  await page.route("**/api/payment/quote", route => {
    const free = route.request().postDataJSON().couponCode === "free100";
    return route.fulfill({ json: {
      ok: true,
      quoteFingerprint: free ? "fixture-approved-free" : "fixture-paid",
      quote: { grossAmount: 84.99, netAmount: free ? 0 : 84.99, isFree: free },
    } });
  });
  await flow.review();
  await flow.codeInput("free100");
  await expect(page.getByRole("button", { name: "Remove coupon code free100", exact: true })).toBeVisible();
  await flow.payment();
  await expect(page.getByRole("button", { name: "Confirm Free Booking", exact: true })).toBeEnabled();
};

const holdConfirmation = async (page, fail = false) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const requests = [];
  await page.route("**/api/payment/start", async route => {
    const payload = route.request().postDataJSON();
    requests.push({ payload, startedAt: Date.now() });
    await pending;
    await route.fulfill(fail ? {
      status: 503, json: { ok: false, error: "Synthetic free confirmation outage." },
    } : { status: 200, json: {
      ok: true, status: "booked", provider: "free", bookingId,
      paymentAccessToken: "fixture-free-access",
      emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } },
      emailDispatchToken: "",
      refreshedHold: {
        slotHoldId: payload.bookingPayload.slotHoldId,
        slotHoldToken: payload.bookingPayload.slotHoldToken,
        slotHoldExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
        phase: "payment_pending",
      },
    } });
  });
  return { requests, release };
};

const waitPastExpiry = async (page, hold) => {
  await page.waitForTimeout(Math.max(0, Date.parse(hold.expiresAt) - Date.now()) + 1500);
};

const assertConfirmation = async page => {
  await expect(page).toHaveURL(url => url.pathname === "/thank-you");
  await expect(page.getByRole("heading", { name: "Thank You!", exact: true })).toBeVisible();
  await expect(page.getByText(bookingId, { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("my_slot_hold"))).toBeNull();
};

test.beforeEach(async ({ page }) => {
  page.freeConfirmationPaths = [];
  page.on("framenavigated", frame => {
    if (frame === page.mainFrame()) page.freeConfirmationPaths.push(new URL(frame.url()).pathname);
  });
});

test.afterEach(async ({ page }, info) => {
  const state = await page.evaluate(() => ({
    path: location.pathname,
    hold: JSON.parse(sessionStorage.getItem("my_slot_hold")),
    receipt: JSON.parse(sessionStorage.getItem("booking_confirmation_state")),
  }));
  await info.attach("free-confirmation-state", {
    body: JSON.stringify({ ...state, paths: page.freeConfirmationPaths }, null, 2), contentType: "application/json",
  });
  const heading = page.getByRole("heading", { name: "Thank You!", exact: true });
  if (await heading.count()) {
    await expect.poll(() => heading.evaluate(element => {
      for (let node = element; node; node = node.parentElement) {
        if (Number(getComputedStyle(node).opacity) < 0.999) return false;
      }
      return true;
    })).toBe(true);
  }
  await page.screenshot({ path: info.outputPath("free-booking-confirmation.png"), animations: "disabled" });
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("a free booking confirmed just before its hold expires still shows the confirmation", async ({ page, flow }, info) => {
      flow.state.holdMs = 12000;
      const pending = await holdConfirmation(page);
      try {
        await openFreePayment(page, flow);
        const hold = await page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")));
        await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
        await expect.poll(() => pending.requests.length).toBe(1);
        expect(pending.requests[0].startedAt).toBeLessThan(Date.parse(hold.expiresAt));
        expect(pending.requests[0].payload).toMatchObject({ provider: "free", bookingPayload: { couponCode: "free100" } });
        await waitPastExpiry(page, hold);
        await info.attach("pending-after-expiry", { body: JSON.stringify({ hold, paths: page.freeConfirmationPaths }), contentType: "application/json" });
        expect(page.freeConfirmationPaths).not.toContain("/");
        await expect(page).toHaveURL(url => url.pathname === "/payment");
        expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")))).toMatchObject(hold);
        pending.release();
        await assertConfirmation(page);
        expect(page.freeConfirmationPaths).not.toContain("/");
        expect(pending.requests).toHaveLength(1);
      } finally {
        pending.release();
        await page.unrouteAll({ behavior: "wait" });
      }
    });

    test("codes are locked while a free booking is being confirmed", async ({ page, flow }) => {
      const pending = await holdConfirmation(page);
      try {
        await openFreePayment(page, flow);
        await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
        await expect.poll(() => pending.requests.length).toBe(1);
        for (const id of ["payment-referral-code", "payment-coupon-code"]) {
          const input = page.locator(`#${id}`);
          await expect(input).toBeDisabled();
          await expect(input.locator("..").getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
        }
        await expect(page.getByRole("button", { name: "Remove coupon", exact: true })).toBeDisabled();
        await expect(page.locator("#payment-coupon-code")).toHaveValue("free100");
        pending.release();
        await assertConfirmation(page);
        expect(pending.requests).toHaveLength(1);
      } finally {
        pending.release();
        await page.unrouteAll({ behavior: "wait" });
      }
    });

    test("a free booking waits for code validation already in progress", async ({ page, flow }) => {
      const pending = await holdConfirmation(page);
      try {
        await openFreePayment(page, flow);
        for (const [id, code, endpoint] of [
          ["payment-referral-code", "friend", "validateReferral"],
          ["payment-coupon-code", "free100", "validateCoupon"],
        ]) {
          let releaseValidation;
          const validation = new Promise(resolve => { releaseValidation = resolve; });
          const pattern = `**/api/ref/${endpoint}?code=${code}*`;
          const handler = async route => {
            await validation;
            await route.fallback();
          };
          await page.route(pattern, handler);
          try {
            const input = page.locator(`#${id}`);
            await input.fill(code);
            const requested = page.waitForRequest(pattern);
            await input.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
            await requested;
            await expect(page.getByRole("button", { name: "Confirm Free Booking", exact: true })).toBeDisabled();
            expect(pending.requests).toHaveLength(0);
          } finally {
            releaseValidation();
          }
          await expect(page.getByRole("button", { name: "Confirm Free Booking", exact: true })).toBeEnabled();
          await page.unroute(pattern, handler);
        }
        await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
        await expect.poll(() => pending.requests.length).toBe(1);
        expect(pending.requests[0].payload.bookingPayload).toMatchObject({ referralCode: "friend", couponCode: "free100" });
        pending.release();
        await assertConfirmation(page);
        expect(pending.requests).toHaveLength(1);
      } finally {
        pending.release();
        await page.unrouteAll({ behavior: "wait" });
      }
    });

    test("a free confirmation that fails after the hold expired follows the expiry path", async ({ page, flow }) => {
      flow.state.holdMs = 12000;
      const pending = await holdConfirmation(page, true);
      try {
        await openFreePayment(page, flow);
        const hold = await page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")));
        await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
        await expect.poll(() => pending.requests.length).toBe(1);
        expect(pending.requests[0].startedAt).toBeLessThan(Date.parse(hold.expiresAt));
        await waitPastExpiry(page, hold);
        await expect(page).toHaveURL(url => url.pathname === "/payment");
        expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")))).toMatchObject(hold);
        pending.release();
        await expect(page).toHaveURL(url => url.pathname === "/");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("flow_background_location"))?.pathname)).toBe("/");
        expect(await page.evaluate(() => sessionStorage.getItem("my_slot_hold"))).toBeNull();
        expect(await page.evaluate(() => sessionStorage.getItem("booking_confirmation_state"))).toBeNull();
      } finally {
        pending.release();
        await page.unrouteAll({ behavior: "wait" });
      }
    });
  });
}
