const { createHash } = require("node:crypto");
const { test, expect } = require("./fixtures/booking-flow.cjs");

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
const bookingEventId = (record) =>
  createHash("sha256").update(`booking-confirmed:${record}`).digest("hex").slice(0, 40);
const paidEventId = bookingEventId("fixture-consent-paid-record");
const freeEventId = bookingEventId("fixture-consent-free-record");
const overhaul = "Performance Vertex Overhaul";

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce", actionTimeout: 10000 });

let meta;

test.beforeEach(async ({ page, flow }) => {
  expect(flow.state.calls).toEqual([]);
  meta = { scripts: [], beacons: [], calls: [] };
  await page.exposeFunction("__recordMeta", (args) => meta.calls.push({ path: new URL(page.url()).pathname, args }));
  await page.route("https://connect.facebook.net/**", (route) => {
    meta.scripts.push(route.request().url());
    return route.fulfill({ contentType: "application/javascript", body: fakeFbevents });
  });
  await page.route("https://www.facebook.com/**", (route) => {
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

const metaOf = () => meta;
const banner = (page) => page.getByRole("region", { name: "Cookie choice", exact: true });
const settle = (page) => page.evaluate(() => new Promise((resolve) => {
  const done = () => setTimeout(resolve, 400);
  if ("requestIdleCallback" in window) window.requestIdleCallback(done, { timeout: 5000 });
  else setTimeout(done, 1500);
}));
const overhaulCard = (page) => page.locator(".ri-package-card")
  .filter({ has: page.getByRole("heading", { name: overhaul, exact: true }) });
const overhaulDetails = (page) => overhaulCard(page).locator(".ri-package-details-button");
const shownPrice = async (locator) => Number((await locator.first().textContent()).replace(/[^0-9.]/g, ""));
const closeDetails = async (page) => {
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
};
const tracked = (name) => metaOf().calls.filter(({ args }) => args[0] === "track" && args[1] === name);

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

async function controlsClearOfBanner(page) {
  const result = await page.evaluate(() => {
    const card = document.querySelector("[data-consent-banner] > div").getBoundingClientRect();
    const stage = document.querySelector(".booking-dialog-stage").getBoundingClientRect();
    const covers = (rect) => rect.width > 0 && rect.height > 0 && rect.left < card.right && rect.right > card.left &&
      rect.top < card.bottom && rect.bottom > card.top;
    const controls = [...document.querySelectorAll('[role="dialog"].ri-booking :is(h2, h3, button, a[href], input)')]
      .filter((node) => node.checkVisibility({ visibilityProperty: true }));
    const covered = controls.filter((node) => {
      node.scrollIntoView({ block: "nearest", behavior: "instant" });
      return covers(node.getBoundingClientRect());
    }).map((node) => node.getAttribute("aria-label") || node.textContent.trim());
    return { count: controls.length, stageBottom: stage.bottom, bannerTop: card.top, covered };
  });
  expect(result.count).toBeGreaterThan(0);
  expect(result.stageBottom).toBeLessThanOrEqual(result.bannerTop);
  expect(result.covered).toEqual([]);
}

const routeFreeQuote = async (page, startResponse) => {
  const quote = { grossAmount: 84.99, netAmount: 0, isFree: true };
  const providers = {
    dodo: { enabled: true, mode: "test" }, paypal: { enabled: false }, razorpay: { enabled: false },
  };
  await page.route("**/api/payment/quote", (route) =>
    route.fulfill({ json: { ok: true, quoteFingerprint: "fixture-free-quote", providers, quote } }));
  if (startResponse) {
    await page.route("**/api/payment/start", (route) => route.fulfill({ json: { ...startResponse, quote } }));
  }
};

const reviewWithBanner = async (page, flow) => {
  await page.goto("/booking?package=overhaul");
  await expect(page.locator(".ri-booking-package-title")).toHaveText(overhaul);
  await expect(banner(page)).toBeVisible();
  await controlsClearOfBanner(page);
  await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await controlsClearOfBanner(page);
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await controlsClearOfBanner(page);
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await flow.details();
  await controlsClearOfBanner(page);
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await controlsClearOfBanner(page);
  await flow.payment();
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
        expect(metaOf().scripts).toEqual([]);
        expect(metaOf().beacons).toEqual([]);
      });

      test("persists Decline and Cookie settings reopens the choice", async ({ page }) => {
        await page.goto("/");
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
        expect(metaOf().scripts).toEqual([]);
        expect(metaOf().beacons).toEqual([]);
      });

      test("stays clear of the booking dialog and the Pay buttons", async ({ page, flow }) => {
        await reviewWithBanner(page, flow);
        await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeVisible();
        await controlsClearOfBanner(page);
        await expectNoBannerShift(page);
        await test.info().attach("payment-with-banner", { body: await page.screenshot(), contentType: "image/png" });
      });

      test("stays clear of the free booking Confirm button", async ({ page, flow }) => {
        await routeFreeQuote(page);
        await reviewWithBanner(page, flow);
        await expect(page.getByRole("button", { name: "Confirm Free Booking", exact: true })).toBeVisible();
        await controlsClearOfBanner(page);
      });
    });
  }

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
      expect(metaOf().scripts).toEqual([]);
      expect(metaOf().beacons).toEqual([]);
      expect(metaOf().calls).toEqual([]);
    });

    test("after Accept the pixel sends PageView, ViewContent, InitiateCheckout and Purchase", async ({
      page, flow, baseURL,
    }) => {
      await page.route("**/api/payment/start", (route) => route.fulfill({ json: {
        ok: true, paymentAccessToken: "fixture-payment", status: "started",
        providerPayload: { checkoutUrl: `${baseURL}/__test/checkout-handoff` },
        sessionExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
      } }));
      let finalizeRoute;
      await page.route("**/api/payment/finalize", (route) => { finalizeRoute = route; });
      await page.goto("/packages");
      await expect(banner(page)).toBeVisible();
      expect(metaOf().scripts).toEqual([]);
      await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
      await expect.poll(() => metaOf().scripts).toEqual(["https://connect.facebook.net/en_US/fbevents.js"]);
      await expect.poll(() => tracked("PageView").length).toBe(1);
      expect(metaOf().calls.slice(0, 4).map(({ args }) => args)).toEqual([
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

      await flow.review();
      await flow.payment();
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
      expect(tracked("InitiateCheckout")).toHaveLength(1);
      expect(tracked("InitiateCheckout")[0].args[2]).toMatchObject({
        content_name: overhaul, content_ids: ["overhaul"], value: 84.99, currency: "USD", num_items: 1,
      });

      await page.goto("/payment?dodo_return=1", { waitUntil: "domcontentloaded" });
      await expect.poll(() => Boolean(finalizeRoute)).toBe(true);
      await finalizeRoute.fulfill({ json: {
        ok: true, status: "booked", provider: "dodo", bookingId: "fixture-consent-paid",
        emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } }, emailDispatchToken: "",
        analyticsReceipt: paidReceipt,
      } });
      await expect(page).toHaveURL(/\/payment-success$/);
      await expect.poll(() => tracked("Purchase").length).toBe(1);
      const [, , data, options] = tracked("Purchase")[0].args;
      expect(options).toEqual({ eventID: paidEventId });
      expect(data).toMatchObject({ value: 84.99, currency: "USD", content_name: overhaul, content_ids: ["overhaul"] });
      expect(JSON.stringify(metaOf().calls)).not.toMatch(/visitor@example\.invalid|fixture_visitor|Ryzen|em=|ph=/);
      const inits = metaOf().calls.filter(({ args }) => args[0] === "init");
      expect(inits.every(({ args }) => args.length === 2)).toBe(true);
      expect(metaOf().beacons).toEqual([]);
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
  });
}
