const {
  test, expect, cookieBanner: banner, settleIdle: settle, bookingEventId, routePaidStart, startInTwoTabsAndReload,
} = require("./fixtures/booking-flow.cjs");

const pixelId = String(process.env.TOOLING_META_PIXEL_ID || "").trim();
const fakeFbevents = `(function () {
  var fbq = window.fbq;
  var record = function (args) {
    var copy = JSON.parse(JSON.stringify(args));
    (window.__metaCalls = window.__metaCalls || []).push(copy);
    if (window.__recordMeta) window.__recordMeta(copy);
  };
  fbq.callMethod = function () { record(Array.prototype.slice.call(arguments)); };
  fbq.queue.splice(0).forEach(record);
})();`;
const paidEventId = bookingEventId("fixture-consent-paid-record");
const freeEventId = bookingEventId("fixture-consent-free-record");
const overhaul = "Performance Vertex Overhaul";

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce", actionTimeout: 10000 });

let meta;

test.beforeEach(async ({ page, context, flow }) => {
  expect(flow.state.calls).toEqual([]);
  meta = { scripts: [], beacons: [], calls: [] };
  await context.exposeBinding("__recordMeta", ({ page: source }, args) => meta.calls.push({
    path: new URL(source.url()).pathname, tab: source === page ? "first" : "other", args,
  }));
  await context.route("https://connect.facebook.net/**", (route) => {
    meta.scripts.push(route.request().url());
    return route.fulfill({ contentType: "application/javascript", body: fakeFbevents });
  });
  await context.route("https://www.facebook.com/**", (route) => {
    meta.beacons.push(route.request().url());
    return route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/ref/sendBookingEmails", (route) =>
    route.fulfill({ json: { ok: true, emailDispatch: { allSent: true } } }));
  await page.addInitScript(() => {
    const shifts = window.__consentShifts = { bannerSources: 0, bannerAt: null };
    new MutationObserver(() => {
      if (shifts.bannerAt !== null || !document.querySelector("[data-consent-banner]")) return;
      shifts.bannerAt = performance.now();
    }).observe(document, { childList: true, subtree: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        const nodes = entry.sources.map((source) =>
          source.node?.nodeType === Node.TEXT_NODE ? source.node.parentElement : source.node);
        if (nodes.some((node) => node?.closest?.("[data-consent-banner]"))) shifts.bannerSources += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
});

const overhaulCard = (page) => page.locator(".ri-package-card")
  .filter({ has: page.getByRole("heading", { name: overhaul, exact: true }) });
const overhaulDetails = (page) => overhaulCard(page).locator(".ri-package-details-button");
const shownPrice = async (locator) => Number((await locator.first().textContent()).replace(/[^0-9.]/g, ""));
const closeDetails = async (page) => {
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
};
const tracked = (name) => meta.calls.filter(({ args }) => args[0] === "track" && args[1] === name);

async function expectBannerPlacement(page) {
  const box = await banner(page).locator("> div").boundingBox();
  const view = await page.evaluate(() => ({
    width: window.innerWidth, height: window.innerHeight, scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  expect(view.scrollWidth).toBeLessThanOrEqual(view.width);
  const launcherZone = { left: view.width - 84, top: view.height - 84 };
  const clearOfLauncher = box.x + box.width <= launcherZone.left || box.y + box.height <= launcherZone.top;
  expect(clearOfLauncher).toBe(true);
  for (const name of ["Accept", "Decline"]) {
    await expect(banner(page).getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
  }
}

async function expectNoBannerShift(page) {
  await page.waitForTimeout(500);
  const shifts = await page.evaluate(() => window.__consentShifts);
  expect(shifts.bannerAt).not.toBeNull();
  expect(shifts.bannerSources).toBe(0);
  expect(await banner(page).evaluate((node) => getComputedStyle(node).position)).toBe("fixed");
}

const tabStop = (page) => page.evaluate(() => {
  const node = document.activeElement;
  if (node?.closest("[data-consent-banner]")) return "banner";
  return node?.closest('[aria-modal="true"]') ? "dialog" : "page";
});

async function tabStops(page, presses) {
  const stops = [];
  for (let press = 0; press < presses; press += 1) {
    await page.keyboard.press("Tab");
    stops.push(await tabStop(page));
  }
  return stops;
}

async function tabToBanner(page) {
  for (let press = 0; press < 400; press += 1) {
    await page.keyboard.press("Tab");
    if (await tabStop(page) === "banner") return true;
  }
  return false;
}

const journeyId = "12345678-1234-4123-8123-123456789abc";
const touch = { capturedAt: "2026-09-11T10:00:00.000Z", landingPath: "/", source: "meta" };
const adCookieValue = Buffer.from(JSON.stringify({ version: 2, journeyId, firstTouch: touch, lastTouch: touch }))
  .toString("base64url");
const adCookie = async (context) => (await context.cookies()).find(({ name }) => name === "roo_attr");
const setAdCookie = (context, url) => context.addCookies([{ name: "roo_attr", value: adCookieValue, url }]);
const sessionJourney = (page) =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution"))?.journeyId);
const shot = (page, name) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });
const closeBooking = async (page) => {
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
};

const routeFreeQuote = async (page, startResponse) => {
  const quote = { grossAmount: 84.99, netAmount: 0, isFree: true };
  const providers = {
    dodo: { enabled: true, mode: "test" }, paypal: { enabled: false }, razorpay: { enabled: false },
  };
  await page.route("**/api/payment/quote", (route) =>
    route.fulfill({ json: { ok: true, quoteFingerprint: "fixture-free-quote", providers, quote } }));
  await page.route("**/api/payment/start", (route) => route.fulfill({ json: { ...startResponse, quote } }));
};

const payAndReturn = async (page, flow) => {
  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
  await page.goto("/payment?dodo_return=1", { waitUntil: "domcontentloaded" });
};

const restingY = (page) => page.evaluate(() => new Promise((resolve) => {
  let last = window.scrollY;
  let still = 0;
  const frame = () => {
    still = window.scrollY === last ? still + 1 : 0;
    last = window.scrollY;
    if (still >= 20) resolve(Math.round(last));
    else requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}));

const scrollToEnd = async (page) => {
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  return restingY(page);
};

const scrollLandings = async (page, ready) => {
  await page.goto("/");
  await ready();
  await page.locator('[data-nav-surface="desktop"][data-nav-target="faq"]').click();
  await expect(page).toHaveURL(/\/#faq$/);
  const section = await restingY(page);
  await page.goto("/");
  await ready();
  const bottom = await scrollToEnd(page);
  await page.locator('footer a[href="/tools"]').click();
  await expect(page).toHaveURL(/\/tools$/);
  const tools = await restingY(page);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  const back = await restingY(page);
  await page.goForward();
  await expect(page).toHaveURL(/\/tools$/);
  const forward = await restingY(page);
  return { section, bottom, tools, back, forward };
};

if (!pixelId) {
  for (const width of [360, 390, 1280]) {
    test.describe(`cookie banner at ${width}px`, () => {
      test.use({ viewport: { width, height: 844 } });

      test("shows without layout shift, persists Accept and loads nothing from Meta", async ({ page }) => {
        await page.goto("/packages");
        await expect(banner(page)).toBeVisible();
        await expect(banner(page)).toContainText("Roo Industries uses cookies to measure visits and ads.");
        await expect(banner(page).getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
        await expectBannerPlacement(page);
        await expectNoBannerShift(page);
        await page.keyboard.press("Escape");
        await expect(banner(page)).toBeVisible();
        await banner(page).getByRole("button", { name: "Accept", exact: true }).focus();
        await page.keyboard.press("Enter");
        await expect(banner(page)).toHaveCount(0);
        expect(await page.evaluate(() => localStorage.getItem("roo-consent"))).toBe("granted");
        await page.reload();
        await settle(page);
        await page.waitForLoadState("networkidle");
        await expect(banner(page)).toHaveCount(0);
        expect(await page.evaluate(() => typeof window.fbq)).toBe("undefined");
        expect(meta.scripts).toEqual([]);
        expect(meta.beacons).toEqual([]);
      });

      test("persists Decline and Cookie settings reopens the choice", async ({ page }) => {
        await page.goto("/");
        await expect(banner(page)).toBeVisible();
        await scrollToEnd(page);
        await expectBannerPlacement(page);
        await shot(page, `home-footer-banner-${width}`);
        await banner(page).getByRole("button", { name: "Decline", exact: true }).click();
        await expect(banner(page)).toHaveCount(0);
        await page.reload();
        await settle(page);
        await page.waitForLoadState("networkidle");
        await expect(banner(page)).toHaveCount(0);
        expect(await page.evaluate(() => localStorage.getItem("roo-consent"))).toBe("denied");
        await page.getByRole("button", { name: "Cookie settings", exact: true }).click();
        await expect(banner(page)).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem("roo-consent"))).toBeNull();
        await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
        await expect(banner(page)).toHaveCount(0);
        expect(meta.scripts).toEqual([]);
        expect(meta.beacons).toEqual([]);
      });

      test("leaves while the booking dialog is open and comes back by keyboard after it closes", async ({ page }) => {
        await page.goto("/");
        await expect(banner(page)).toBeVisible();
        await expectBannerPlacement(page);
        await shot(page, `home-banner-${width}`);
        await page.locator('a[href^="/booking"]').first().click();
        await expect(page).toHaveURL(/\/booking\?package=overhaul$/);
        await expect(page.locator(".ri-booking-package-title")).toHaveText(overhaul);
        await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
        await settle(page);
        await expect(banner(page)).toHaveCount(0);
        expect(new Set(await tabStops(page, 30))).toEqual(new Set(["dialog"]));
        await closeBooking(page);
        await expect(banner(page)).toBeVisible();
        await expectBannerPlacement(page);
        await shot(page, `after-close-banner-${width}`);
        await page.locator("body").focus();
        expect(await tabToBanner(page)).toBe(true);
        await expect(banner(page).getByRole("link", { name: "Privacy Policy" })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(banner(page).getByRole("button", { name: "Accept", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(banner(page)).toHaveCount(0);
      });
    });
  }

  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
    test.describe(`dialogs at ${viewport.width}x${viewport.height}`, () => {
      test.use({ viewport });

      test("a direct load of a dialog page keeps the banner away until the dialog closes", async ({ page }) => {
        for (const route of ["/payment-success", "/thank-you", "/booking"]) {
          await page.goto(route);
          await expect(page.getByRole("dialog")).toBeVisible();
          await settle(page);
          await expect(banner(page)).toHaveCount(0);
        }
        await expect(page.locator(".ri-booking-package-title")).toBeVisible();
        await shot(page, `booking-dialog-banner-pending-${viewport.width}x${viewport.height}`);
        await closeBooking(page);
        await expect(banner(page)).toBeVisible();
      });
    });
  }

  test.describe("scroll landings at 1280x720", () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test("a pending banner moves no section landing or Back/Forward restore", async ({ page }) => {
      const pending = await scrollLandings(page, () => expect(banner(page)).toBeVisible());
      await page.evaluate(() => localStorage.setItem("roo-consent", "denied"));
      const answered = await scrollLandings(page, async () => {
        await settle(page);
        await expect(banner(page)).toHaveCount(0);
      });
      expect(pending.section).toBeGreaterThan(0);
      expect(pending.back).toBeGreaterThan(0);
      expect(pending).toEqual(answered);
    });
  });

  test("Decline and Cookie settings remove the ad cookie on pages without sales tracking", async ({
    page, context, baseURL,
  }) => {
    await setAdCookie(context, baseURL);
    await page.goto("/referrals/login");
    await expect(banner(page)).toBeVisible();
    await expect.poll(() => adCookie(context)).toBeUndefined();
    expect(await sessionJourney(page)).toBe(journeyId);
    await setAdCookie(context, baseURL);
    await banner(page).getByRole("button", { name: "Decline", exact: true }).click();
    await expect(banner(page)).toHaveCount(0);
    await expect.poll(() => adCookie(context)).toBeUndefined();

    await page.evaluate(() => {
      localStorage.setItem("roo-consent", "granted");
      sessionStorage.clear();
    });
    await setAdCookie(context, baseURL);
    await page.goto("/meet-the-team");
    await settle(page);
    expect((await adCookie(context))?.value).toBe(adCookieValue);
    await page.getByRole("button", { name: "Cookie settings", exact: true }).click();
    await expect(banner(page)).toBeVisible();
    await expect.poll(() => adCookie(context)).toBeUndefined();
    expect(await sessionJourney(page)).toBe(journeyId);
  });

  test("the Markdown privacy page has the cookie notice and the CSP allows Meta, not Formspree", async ({
    page,
  }) => {
    const markdown = await (await page.request.get("/markdown?path=/privacy")).text();
    expect(markdown).toContain("## Cookies and browser storage");
    expect(markdown).toContain("roo\\_attr cookie keeps the ad");
    const csp = (await page.request.get("/privacy")).headers()["content-security-policy"];
    expect(csp).toContain("form-action 'self';");
    expect(csp).not.toContain("formspree");
    expect(csp).toMatch(/script-src [^;]*https:\/\/connect\.facebook\.net/);
    expect(csp).toMatch(/img-src [^;]*https:\/\/www\.facebook\.com/);
    expect(csp).toMatch(/connect-src [^;]*https:\/\/www\.facebook\.com https:\/\/connect\.facebook\.net/);
  });
} else {
  const paidReceipt = {
    eventId: paidEventId, paymentType: "paid", provider: "dodo", amount: 84.99, currency: "USD",
    packageTitle: overhaul, referralCode: "", attribution: null,
  };

  const paidFinalize = {
    ok: true, status: "booked", provider: "dodo", bookingId: "fixture-consent-paid",
    emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } }, emailDispatchToken: "",
    analyticsReceipt: paidReceipt,
  };

  test.describe("Meta pixel build", () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test("nothing reaches Meta before a choice or after Decline", async ({ page }) => {
      await page.goto("/packages");
      await expect(banner(page)).toBeVisible();
      await settle(page);
      expect(await page.evaluate(() => typeof window.fbq)).toBe("undefined");
      await overhaulDetails(page).click();
      await closeDetails(page);
      await banner(page).getByRole("button", { name: "Decline", exact: true }).click();
      await page.goto("/booking?package=overhaul");
      await expect(page.locator(".ri-booking-package-title")).toHaveText(overhaul);
      await settle(page);
      await page.waitForLoadState("networkidle");
      expect(await page.evaluate(() => typeof window.fbq)).toBe("undefined");
      expect(meta.scripts).toEqual([]);
      expect(meta.beacons).toEqual([]);
      expect(meta.calls).toEqual([]);
    });

    test("after Accept the pixel sends PageView, ViewContent, InitiateCheckout and Purchase", async ({
      page, flow, baseURL,
    }) => {
      await routePaidStart(page, baseURL);
      let finalizeRoute;
      await page.route("**/api/payment/finalize", (route) => { finalizeRoute = route; });
      await page.goto("/packages");
      await expect(banner(page)).toBeVisible();
      expect(meta.scripts).toEqual([]);
      await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
      await expect.poll(() => meta.scripts).toEqual(["https://connect.facebook.net/en_US/fbevents.js"]);
      await expect.poll(() => tracked("PageView").length).toBe(1);
      expect(meta.calls.slice(0, 4).map(({ args }) => args)).toEqual([
        ["consent", "grant"], ["set", "autoConfig", false, pixelId], ["init", pixelId], ["track", "PageView"],
      ]);

      const cardPrice = await shownPrice(overhaulCard(page).locator(".ri-price-current"));
      await overhaulDetails(page).click();
      await expect.poll(() => tracked("ViewContent").length).toBe(1);
      expect(tracked("ViewContent")[0].args[2]).toMatchObject({
        content_name: overhaul, content_ids: ["overhaul"], value: cardPrice, currency: "USD",
      });
      await closeDetails(page);

      await page.goto("/booking?package=overhaul");
      await expect(page.locator(".ri-booking-package-title")).toHaveText(overhaul);
      await expect.poll(() => tracked("ViewContent").map(({ path }) => path)).toEqual(["/packages", "/booking"]);
      const bookingCard = page.locator(".ri-booking-package-title").locator("..");
      expect(tracked("ViewContent")[1].args[2]).toMatchObject({ content_ids: ["overhaul"], currency: "USD" });
      await expect(bookingCard).toContainText(`$${tracked("ViewContent")[1].args[2].value.toFixed(2)}`);
      await expect.poll(() => tracked("PageView").map(({ path }) => path)).toEqual(["/packages", "/booking"]);

      await payAndReturn(page, flow);
      expect(tracked("InitiateCheckout")).toHaveLength(1);
      expect(tracked("InitiateCheckout")[0].args[2]).toMatchObject({
        content_name: overhaul, content_ids: ["overhaul"], value: 84.99, currency: "USD", num_items: 1,
      });
      await expect.poll(() => Boolean(finalizeRoute)).toBe(true);
      await finalizeRoute.fulfill({ json: paidFinalize });
      await expect(page).toHaveURL(/\/payment-success$/);
      await expect.poll(() => tracked("Purchase").length).toBe(1);
      const [, , data, options] = tracked("Purchase")[0].args;
      expect(options).toEqual({ eventID: paidEventId });
      expect(data).toMatchObject({ value: 84.99, currency: "USD", content_name: overhaul, content_ids: ["overhaul"] });
      expect(JSON.stringify(meta.calls)).not.toMatch(/visitor@example\.invalid|fixture_visitor|Ryzen|em=|ph=/);
      const inits = meta.calls.filter(({ args }) => args[0] === "init");
      expect(inits.every(({ args }) => args.length === 2)).toBe(true);
      expect(meta.beacons).toEqual([]);
    });

    test("a free booking sends no Purchase", async ({ page, flow }) => {
      await routeFreeQuote(page, {
        ok: true, status: "booked", provider: "free", bookingId: "fixture-consent-free",
        emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } }, emailDispatchToken: "",
        analyticsReceipt: { ...paidReceipt, eventId: freeEventId, paymentType: "free", provider: "free", amount: 0 },
      });
      await page.goto("/");
      await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
      await expect.poll(() => tracked("PageView").length).toBe(1);
      await flow.review();
      await flow.payment();
      await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
      await expect(page).toHaveURL(/\/thank-you$/);
      await expect(page.getByRole("heading", { level: 1, name: "Thank You!", exact: true })).toBeVisible();
      await settle(page);
      expect(tracked("Purchase")).toEqual([]);
      expect(tracked("InitiateCheckout")).toEqual([]);
    });

    test("a Purchase waits for Accept after the receipt and is sent once with the server's event id", async ({
      page, flow, baseURL,
    }) => {
      await routePaidStart(page, baseURL);
      let finalized = 0;
      await page.route("**/api/payment/finalize", (route) => {
        finalized += 1;
        return route.fulfill({ json: paidFinalize });
      });
      await payAndReturn(page, flow);
      await expect(page).toHaveURL(/\/payment-success$/);
      await settle(page);
      await expect(banner(page)).toHaveCount(0);
      expect(meta.calls).toEqual([]);
      const purchaseKey = `meta_purchase_tracked:${paidEventId}`;
      expect(await page.evaluate((key) => sessionStorage.getItem(key), purchaseKey)).toBeNull();
      await closeBooking(page);
      await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
      await expect.poll(() => tracked("Purchase").length).toBe(1);
      const [, , data, options] = tracked("Purchase")[0].args;
      expect(options).toEqual({ eventID: paidEventId });
      expect(data).toMatchObject({ value: 84.99, currency: "USD", content_ids: ["overhaul"] });
      expect(tracked("InitiateCheckout")).toEqual([]);
      expect(await page.evaluate((key) => sessionStorage.getItem(key), purchaseKey)).toBe("1");
      await settle(page);
      expect(tracked("Purchase")).toHaveLength(1);
      expect(finalized).toBe(1);
    });

    test("a Decline that cannot be saved still stops the pixel for the session", async ({ page }) => {
      await page.goto("/packages");
      await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
      await expect.poll(() => tracked("PageView").length).toBe(1);
      await page.evaluate(() => {
        const failOnLocal = (original) => function failingStorage(...args) {
          if (this === window.localStorage) throw new DOMException("Storage is full", "QuotaExceededError");
          return original.apply(this, args);
        };
        Storage.prototype.setItem = failOnLocal(Storage.prototype.setItem);
        Storage.prototype.removeItem = failOnLocal(Storage.prototype.removeItem);
      });
      await page.getByRole("button", { name: "Cookie settings", exact: true }).click();
      await banner(page).getByRole("button", { name: "Decline", exact: true }).click();
      await expect(banner(page)).toHaveCount(0);
      expect(meta.calls.at(-1).args).toEqual(["consent", "revoke"]);
      const before = meta.calls.length;
      await overhaulDetails(page).click();
      await closeDetails(page);
      expect(await page.evaluate(() => localStorage.getItem("roo-consent"))).toBe("granted");
      await page.goto("/booking?package=overhaul");
      await expect(page.locator(".ri-booking-package-title")).toHaveText(overhaul);
      await settle(page);
      await page.waitForLoadState("networkidle");
      await expect(banner(page)).toHaveCount(0);
      expect(meta.calls.slice(before)).toEqual([]);
    });

    test("a saved Accept sends one PageView per page view whichever module loads first", async ({ page }) => {
      await page.addInitScript(() => {
        if (!localStorage.getItem("roo-consent")) localStorage.setItem("roo-consent", "granted");
      });
      let delayed = 0;
      await page.route("**/_next/static/chunks/**", async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        if (body.includes("service_visit")) {
          delayed += 1;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        await route.fulfill({ status: response.status(), contentType: response.headers()["content-type"], body });
      });
      await page.goto("/packages");
      await settle(page);
      await page.waitForLoadState("networkidle");
      expect(delayed).toBeGreaterThan(0);
      await expect.poll(() => tracked("PageView").length).toBe(1);
      await page.locator('main a[href="/reviews"], footer a[href="/reviews"]').first().click();
      await expect(page).toHaveURL(/\/reviews$/);
      await expect.poll(() => tracked("PageView").length).toBe(2);
      await page.goBack();
      await expect(page).toHaveURL(/\/packages$/);
      await expect.poll(() => tracked("PageView").length).toBe(3);
      await settle(page);
      expect(tracked("PageView").map(({ path }) => path)).toEqual(["/packages", "/reviews", "/packages"]);
    });

    test("InitiateCheckout is sent once per created checkout across tabs and a reload", async ({
      page, flow, baseURL,
    }) => {
      await routePaidStart(page, baseURL);
      await page.goto("/packages");
      await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
      await expect.poll(() => tracked("PageView").length).toBe(1);
      await startInTwoTabsAndReload(page, flow);
      expect(tracked("InitiateCheckout")).toHaveLength(1);
    });

    const fromFirstTab = () => meta.calls.filter(({ tab }) => tab === "first");
    const reviewsLink = (page) => page.locator('main a[href="/reviews"], footer a[href="/reviews"]').first();

    test("a Decline in another tab stops the pixel and removes the ad cookie here", async ({ page, context }) => {
      await page.goto("/packages?utm_source=meta&utm_campaign=spring");
      await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
      await expect.poll(() => tracked("PageView").length).toBe(1);
      await expect.poll(() => adCookie(context)).toBeDefined();
      const other = await context.newPage();
      await other.goto("/reviews");
      await other.getByRole("button", { name: "Cookie settings", exact: true }).click();
      await banner(other).getByRole("button", { name: "Decline", exact: true }).click();
      await expect.poll(() => adCookie(context)).toBeUndefined();
      const revokes = () => fromFirstTab().filter(({ args }) => args.join() === "consent,revoke").length;
      await expect.poll(revokes).toBe(2);
      const before = fromFirstTab().length;
      await overhaulDetails(page).click();
      await closeDetails(page);
      await reviewsLink(page).click();
      await expect(page).toHaveURL(/\/reviews$/);
      await settle(page);
      await page.waitForLoadState("networkidle");
      expect(fromFirstTab().slice(before)).toEqual([]);
      expect(await adCookie(context)).toBeUndefined();
      await expect(banner(page)).toHaveCount(0);
    });

    test("an Accept in another tab starts the pixel here", async ({ page, context }) => {
      await page.goto("/packages");
      await expect(banner(page)).toBeVisible();
      await settle(page);
      const other = await context.newPage();
      await other.goto("/reviews");
      await banner(other).getByRole("button", { name: "Accept", exact: true }).click();
      await expect(banner(page)).toHaveCount(0);
      await expect.poll(() => fromFirstTab().filter(({ args }) => args[1] === "PageView").map(({ path }) => path))
        .toEqual(["/packages"]);
      await overhaulDetails(page).click();
      await expect.poll(() => fromFirstTab().filter(({ args }) => args[1] === "ViewContent").length).toBe(1);
      await closeDetails(page);
    });
  });
}
