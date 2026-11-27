const {
  test: bookingTest, expect, cookieBanner, acceptCookies, declineCookies, cookieSettingsReady, openCookieSettings,
  settleIdle, productionHostFixtures, openFreePayment, installProductionOnlyScripts,
} = require("./fixtures/booking-flow.cjs");
const { posthogFixtures, postHogCode, named, pageviews, arrived, closeTab, expectLeavesFollowViews,
  recordSends, sendsFrom } =
  require("./fixtures/posthog.cjs");
const { holdRoute, holdChunks, holdChunksOnServer } = require("./fixtures/held-routes.cjs");
const { waitForHydrated } = require("./fixtures/react-hydration.cjs");

const eventId = "a".repeat(40);
const desktopChrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const customer = ["visitor@example.invalid", "fixture_visitor", "Ryzen 7700", "RTX 4070"];

const test = bookingTest.extend({ ...productionHostFixtures, ...posthogFixtures });
const cachedTest = test.extend({
  launchOptions: [async ({ launchOptions }, use) => use({
    ...launchOptions, ignoreDefaultArgs: ["--disable-back-forward-cache"],
  }), { scope: "worker" }],
});

test.use({
  javaScriptEnabled: true,
  timezoneId: "Asia/Kolkata",
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
  userAgent: desktopChrome,
  actionTimeout: 10000,
  navigationTimeout: 30000,
  trace: "off",
  video: "off",
});

const journeyOf = async (page) => {
  const cookie = (await page.context().cookies()).find(({ name }) => name === "roo_attr");
  return cookie ? JSON.parse(Buffer.from(cookie.value, "base64url").toString("utf8")).journeyId : undefined;
};
const receiptJourney = "8f0c6a52-7d1e-4b3a-9c2d-1e5f6a7b8c9d";
const receiptAttribution = (fields) => {
  const touch = { capturedAt: "2026-11-01T10:00:00.000Z", landingPath: "/packages", ...fields };
  return { version: 2, journeyId: receiptJourney, firstTouch: touch, lastTouch: { ...touch } };
};
const SALES_LABELS = [
  "journey_id", "landing_path", "creator_code", "campaign_source", "campaign_medium", "campaign", "campaign_content",
  "campaign_term", "referrer_host", "first_source", "first_campaign", "has_fbclid", "has_gclid",
];
const salesLabels = (properties) =>
  Object.fromEntries(SALES_LABELS.filter((key) => Object.hasOwn(properties, key))
    .map((key) => [key, properties[key]]));
const recordVercel = async (context) => {
  const sent = [];
  await context.exposeFunction("__recordVercel", (payload) => sent.push(payload));
  await context.addInitScript(() => {
    window.va = (method, payload) => method === "event" && window.__recordVercel(payload);
  });
  return (name) => sent.find((payload) => payload?.name === name)?.data;
};
const seeDetails = async (page) => {
  await page.getByRole("button", { name: "See What's Included" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
};
const browserNow = (page) => page.evaluate(() => Date.now());
const interactUntilReplay = (page, seen, found) => {
  let step = 0;
  return expect.poll(async () => {
    step += 1;
    await page.mouse.move(300 + (step % 6) * 60, 380 + (step % 2) * 80);
    return seen.snapshots.some(found);
  }, { timeout: 20000 }).toBe(true);
};
const fullSnapshot = (item) => item.type === 2;
const sentBetween = (seen, from, to) => [
  ...seen.events.filter((event) => Date.parse(event.timestamp) > from && Date.parse(event.timestamp) < to),
  ...seen.snapshots.filter((item) => item.timestamp > from && item.timestamp < to),
];
const sentAt = (event) => Date.parse(event.timestamp);
const since = (from) => (event) => sentAt(event) >= from;
const fromTab = (seen, tab) => (event) => seen.senders.get(event) === tab;
const storedOutbox = (page) => page.evaluate(() => sessionStorage.getItem("roo-posthog-outbox"));
const outboxEntries = async (page) => JSON.parse(await storedOutbox(page));
const outbox = async (page) => (await outboxEntries(page))?.map((item) => item.event) ?? null;
const confirmedBooking = {
  ok: true, status: "booked", provider: "dodo", bookingId: "fixture-posthog-booking",
  emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } },
  emailDispatchToken: "",
  analyticsReceipt: {
    eventId, packageTitle: "Performance Vertex Overhaul", paymentType: "paid",
    provider: "dodo", amount: 84.99, currency: "USD", referralCode: "", attribution: null,
  },
};
const freeBooking = {
  ...confirmedBooking, provider: "free", bookingId: "fixture-posthog-free-booking",
  paymentAccessToken: "fixture-free-access",
  analyticsReceipt: { ...confirmedBooking.analyticsReceipt, paymentType: "free", provider: "free", amount: 0 },
};
const idleStart = (page) => page.evaluate(() => new Promise((resolve) => {
  window.requestIdleCallback(() => resolve(), { timeout: 4000 });
}));
const pastPostHogStart = async (page, seen) => {
  for (const round of ["start", "first send"]) {
    await idleStart(page);
    await expect.poll(() => seen.loading.size, { message: round }).toBe(0);
  }
};
const pickSlot = async (page, time = "10:00 AM") => {
  await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await page.getByRole("button", { name: time, exact: true }).click();
};
const reserveSlot = (page) => page.getByRole("button", { name: "Next", exact: true }).last().click();
const reachPayment = async (page, time) => {
  await pickSlot(page, time);
  await reserveSlot(page);
  await page.getByRole("textbox", { name: "Discord username", exact: true }).fill("fixture_visitor");
  await page.getByRole("textbox", { name: "Booking email", exact: true }).fill("visitor@example.invalid");
  await page.getByRole("textbox", { name: "PC specifications", exact: true }).fill("Ryzen 7700 / RTX 4070");
  await page.getByRole("textbox", { name: "Main game or application", exact: true }).fill("CS2");
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue to payment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
};
const confirmBooking = async (page, baseURL, { receipt, beforeReturn, afterFinalize, time } = {}) => {
  await page.getByRole("link", { name: /Book Now/ }).first().click();
  await expect(page).toHaveURL((url) => url.pathname === "/booking");
  await reachPayment(page, time);
  let finalizeRoute;
  await page.route("**/api/payment/finalize", (route) => { finalizeRoute = route; });
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/__test/checkout-handoff`);
  await beforeReturn?.();
  await page.goto("/payment?dodo_return=1", { waitUntil: "domcontentloaded" });
  await expect.poll(() => Boolean(finalizeRoute)).toBe(true);
  const analyticsReceipt = { ...confirmedBooking.analyticsReceipt, ...receipt };
  await finalizeRoute.fulfill({ json: { ...confirmedBooking, analyticsReceipt } });
  await afterFinalize?.();
  await expect(page).toHaveURL(`${baseURL}/payment-success`);
};
const storedMarks = (page) => page.evaluate(() => sessionStorage.getItem("roo-posthog-counted") || "");
const sessionKeys = (page) => page.evaluate(() => Object.keys(sessionStorage));
const holdChunk = (page, { origin, loopback }, ...markers) =>
  holdChunks(page, { origin, fetchOrigin: loopback }, (body) => markers.some((marker) => body.includes(marker)));
const holdPostHog = (page, productionHost) => holdChunk(page, productionHost, "[PostHog.js]");
const holdOutbox = (page, productionHost) => holdChunk(page, productionHost, "roo-posthog-outbox");
const holdRequest = (page, path, answer = (route) => route.fallback()) =>
  holdRoute(page.context(), `**${path}`, answer, { times: 1 });
const failedAnswer = (route) => route.fulfill({ status: 500, json: { ok: false, error: "Fixture start failed." } });
const postHogKeys = async (page) => (await sessionKeys(page)).filter((key) => /^(roo-)?posthog/.test(key));
const otherMarks = async (page) =>
  (await sessionKeys(page))
    .filter((key) => /^(booking_completion_tracked|meta_purchase_tracked|sales_visit):/.test(key));
const choose = async (tab, choice) => {
  if (await cookieBanner(tab).isHidden()) await openCookieSettings(tab);
  await (choice === "Decline" ? declineCookies : acceptCookies)(tab);
};
const chooseInOtherTab = async (context, choices) => {
  const other = await context.newPage();
  await other.goto("/about", { waitUntil: "domcontentloaded" });
  for (const choice of choices) await choose(other, choice);
  return other;
};
const inFlightRequests = [
  {
    name: "the payment start", path: "/api/payment/start", event: "checkout_started",
    open: async (page) => {
      await page.getByRole("link", { name: /Book Now/ }).first().click();
      await reachPayment(page);
    },
    send: (page) => page.getByRole("button", { name: "Pay your way", exact: true }).click(),
    succeeded: async (page) => {
      await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
      await page.goto("/packages");
    },
    failed: (page) => expect(page.getByText("Fixture start failed.")).toBeVisible(),
  },
  {
    name: "the slot hold", path: "/api/holdSlot", event: "booking_slot_reserved",
    open: async (page) => {
      await page.getByRole("link", { name: /Book Now/ }).first().click();
      await pickSlot(page);
    },
    send: reserveSlot,
    succeeded: (page) => expect(page.getByRole("textbox", { name: "Discord username", exact: true })).toBeVisible(),
    failed: (page) => expect(page.getByText("Could not reserve this slot. Please check your internet and try again."))
      .toBeVisible(),
  },
];

test.describe("production host", () => {
  test("PostHog records the booking funnel without customer details", async ({ page, posthog: seen, baseURL }) => {
    test.setTimeout(180000);

    await page.goto("/packages?utm_source=launch&utm_campaign=posthog");
    await acceptCookies(page);
    await expect.poll(() => pageviews(seen)).toContain(`${baseURL}/packages`);
    const landing = named(seen, "$pageview")[0];
    expect(landing.properties.$pathname).toBe("/packages");
    expect(landing.properties.utm_source).toBe("launch");

    await page.getByRole("button", { name: "See What's Included" }).first().click();
    await expect.poll(() => named(seen, "view_item").length).toBe(1);
    const viewed = named(seen, "view_item")[0].properties;
    expect(viewed.package).toBeTruthy();
    expect(viewed.surface).toBe("packages");
    const dialog = page.getByRole("dialog", { name: viewed.package });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(page).toHaveURL((url) => url.pathname === "/booking");
    await expect.poll(() => pageviews(seen)).toContain(`${baseURL}/booking`);
    await expect.poll(() => named(seen, "package_selected").map((event) => event.properties.package))
      .toEqual([viewed.package]);
    expect(named(seen, "package_selected")[0].properties.$current_url).toBe(`${baseURL}/packages`);

    let finalizeRoute;
    await page.route("**/api/payment/finalize", (route) => { finalizeRoute = route; });
    await reachPayment(page);
    await interactUntilReplay(page, seen, fullSnapshot);
    await settleIdle(page);
    expect(named(seen, "checkout_started")).toEqual([]);

    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/__test/checkout-handoff`);
    await expect.poll(() => named(seen, "checkout_started").length).toBe(1);
    await page.goto("/payment?dodo_return=1", { waitUntil: "domcontentloaded" });
    await expect.poll(() => Boolean(finalizeRoute)).toBe(true);
    await finalizeRoute.fulfill({ json: confirmedBooking });
    await expect(page).toHaveURL(`${baseURL}/payment-success`);
    await expect.poll(() => named(seen, "booking_completed").length).toBe(1);
    await expect.poll(() => named(seen, "$identify").length).toBe(1);
    expect(named(seen, "checkout_started")).toHaveLength(1);

    const completed = named(seen, "booking_completed")[0].properties;
    expect(completed).toMatchObject({
      event_id: eventId, payment_type: "paid", payment_provider: "dodo", amount: 84.99, currency: "USD",
    });
    expect(completed.distinct_id).toBe(eventId);
    const identify = named(seen, "$identify")[0];
    expect(identify.properties.distinct_id).toBe(eventId);

    const journeyId = await journeyOf(page);
    expect(identify.properties.$anon_distinct_id).toBe(journeyId);
    const anonymous = seen.events.filter((event) => event.properties.distinct_id !== eventId);
    expect(new Set(anonymous.map((event) => event.properties.distinct_id))).toEqual(new Set([journeyId]));

    for (const event of seen.events) {
      const url = event.properties.$current_url;
      expect(url.startsWith(`${baseURL}/`), url).toBe(true);
      expect(url).not.toMatch(/[?#]/);
    }
    expect(seen.posthogHosts).toEqual([]);
    const sent = JSON.stringify([seen.events, seen.snapshots]);
    for (const value of customer) expect(sent).not.toContain(value);
    const replay = JSON.stringify(seen.snapshots);
    expect(seen.snapshots.filter((item) => item.type === 3 && item.data.adds?.length).length).toBeGreaterThan(0);
    expect(replay).toContain(`${baseURL}/packages`);
    expect(replay).not.toContain("Review your booking");
    expect(replay).not.toContain("utm_source");

    const stored = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
    expect(stored.filter((key) => /^(ph_|__ph)/.test(key))).toEqual([]);
    expect((await page.context().cookies()).filter((cookie) => cookie.name.startsWith("ph_"))).toEqual([]);
  });

  test("a private landing waits, then starts with the journey after in-app navigation", async ({
    page, posthog: seen, baseURL,
  }) => {
    await page.goto("/referrals/login");
    await expect(page.locator("main")).toBeVisible();
    await acceptCookies(page);
    await pastPostHogStart(page, seen);
    expect(seen.requests).toEqual([]);
    expect(seen.posthogHosts).toEqual([]);

    await page.getByRole("link", { name: "Packages", exact: true }).first().click();
    await expect(page).not.toHaveURL(`${baseURL}/referrals/login`);
    const pathname = new URL(page.url()).pathname;
    await expect.poll(() => pageviews(seen)).toEqual([`${baseURL}${pathname}`]);
    const journeyId = await journeyOf(page);
    expect(new Set(seen.events.map((event) => event.properties.distinct_id))).toEqual(new Set([journeyId]));
    expect(seen.posthogHosts).toEqual([]);
  });

  test("each public page view is sent once, from Accept after load through Back and Forward", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    const hold = await holdPostHog(page, productionHost);
    const viewsBecome = async (paths) => {
      await expect.poll(() => pageviews(seen)).toEqual(paths.map((path) => `${baseURL}${path}`));
    };

    await page.goto("/packages?utm_source=launch#included");
    await settleIdle(page);
    await acceptCookies(page);
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await settleIdle(page);
    expect(seen.events).toEqual([]);
    hold.release();
    await viewsBecome(["/packages"]);

    await page.getByRole("link", { name: /Book Now/ }).first().click();
    await viewsBecome(["/packages", "/booking"]);
    await page.goBack();
    await viewsBecome(["/packages", "/booking", "/packages"]);
    await page.goForward();
    await viewsBecome(["/packages", "/booking", "/packages", "/booking"]);
    await page.goBack();
    await viewsBecome(["/packages", "/booking", "/packages", "/booking", "/packages"]);
    await page.getByRole("button", { name: "Referrals", exact: true }).click();
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page.locator("#ref-login-identifier")).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === "/packages");
    await viewsBecome(["/packages", "/booking", "/packages", "/booking", "/packages", "/packages"]);
    await settleIdle(page);
    expect(pageviews(seen)).toHaveLength(6);
    for (const event of named(seen, "$pageview")) {
      expect(event.properties.$pathname).toBe(new URL(event.properties.$current_url).pathname);
      expect(JSON.stringify(event.properties)).not.toMatch(/utm_source=|#included|ref-login/);
    }
  });

  test("page leaves follow page views during navigation and tab close", async ({ page, posthog: seen }) => {
    await page.goto("/packages");
    await acceptCookies(page);
    await expect.poll(async () => (await arrived(seen, "$pageview")).map((event) => event.properties.$pathname))
      .toEqual(["/packages"]);
    await page.goto("/about");
    await expect.poll(async () => (await arrived(seen, "$pageview")).map((event) => event.properties.$pathname))
      .toEqual(["/packages", "/about"]);
    await expect.poll(async () => (await arrived(seen, "$pageleave"))
      .map((event) => event.properties.$prev_pageview_pathname)).toContain("/packages");
    await closeTab(page);
    await expect.poll(async () => (await arrived(seen, "$pageleave"))
      .map((event) => event.properties.$prev_pageview_pathname)).toContain("/about");
    expectLeavesFollowViews(seen);
    expect(seen.posthogHosts).toEqual([]);
  });

  test("leaving while PostHog download is held sends page views before page leaves", async ({
    page, posthog: seen, productionHost,
  }) => {
    const hold = await holdPostHog(page, productionHost);
    await page.goto("/packages");
    await acceptCookies(page);
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    expect(await arrived(seen, "$pageview")).toEqual([]);
    expect(await arrived(seen, "$pageleave")).toEqual([]);
    expect(hold.answered).toBeFalsy();
    await page.goto("/about", { waitUntil: "domcontentloaded" });
    await waitForHydrated(page, "#main-content");
    expect(hold.answered).toBeFalsy();
    expect(await arrived(seen, "$pageview")).toEqual([]);
    expect(await arrived(seen, "$pageleave")).toEqual([]);
    hold.release();
    await expect.poll(async () => (await arrived(seen, "$pageview")).map((event) => event.properties.$pathname))
      .toEqual(["/packages", "/about"]);
    await closeTab(page);
    await expect.poll(async () => (await arrived(seen, "$pageleave"))
      .map((event) => event.properties.$prev_pageview_pathname)).toContain("/about");
    expectLeavesFollowViews(seen);
    expect(seen.posthogHosts).toEqual([]);
  });

  test("closing before any page view sends no page leave", async ({
    page, context, flow, posthog: seen, productionHost,
  }) => {
    await recordSends(page);
    const hold = await holdChunksOnServer(page, {
      origin: productionHost.origin, fetchOrigin: productionHost.loopback,
    }, (body) => body.includes("[PostHog.js]"));
    await page.goto("/packages");
    await acceptCookies(page);
    await expect.poll(() => hold.held(), { timeout: 20000 }).toBe(true);
    expect(await arrived(seen, "$pageview")).toEqual([]);
    expect(await arrived(seen, "$pageleave")).toEqual([]);
    const journeyId = await journeyOf(page);
    expect(journeyId).toBeTruthy();
    expect(await sendsFrom(page)).toEqual([]);
    const closed = page.waitForEvent("close");
    await closeTab(page);
    await closed;

    await flow.restoreRoutes();
    await installProductionOnlyScripts(context);
    await seen.restoreRoutes();
    const next = await context.newPage();
    await next.goto("/about");
    expect(await sendsFrom(next)).toEqual([]);
    await expect.poll(async () => (await arrived(seen, "$pageview")).map((event) => event.properties.$pathname))
      .toEqual(["/about"]);
    expect(named(seen, "$pageview").filter(fromTab(seen, next))).toHaveLength(1);
    expect(await journeyOf(next)).toBe(journeyId);
    await closeTab(next);
    await expect.poll(async () => (await arrived(seen, "$pageleave"))
      .map((event) => event.properties.$prev_pageview_pathname)).toContain("/about");
    expect(named(seen, "$pageleave").map((event) => event.properties.$prev_pageview_pathname))
      .not.toContain("/packages");
    expectLeavesFollowViews(seen);
    expect(seen.posthogHosts).toEqual([]);
  });

  test("a never-visible tab sends a page view before its page leave", async ({ page, posthog: seen }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Document.prototype, "visibilityState", { get: () => "hidden" });
      Object.defineProperty(Document.prototype, "hidden", { get: () => true });
    });
    await page.goto("/packages");
    expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
    await acceptCookies(page);
    await expect.poll(async () => (await arrived(seen, "$pageview")).map((event) => event.properties.$pathname))
      .toEqual(["/packages"]);
    await closeTab(page);
    await expect.poll(async () => (await arrived(seen, "$pageleave"))
      .map((event) => event.properties.$prev_pageview_pathname)).toContain("/packages");
    expectLeavesFollowViews(seen);
    expect(seen.posthogHosts).toEqual([]);
  });

  test("an event keeps the page it happened on while PostHog is still loading", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    const hold = await holdPostHog(page, productionHost);

    await page.goto("/packages");
    await acceptCookies(page);
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await page.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(page).toHaveURL((url) => url.pathname === "/booking");
    hold.release();

    await expect.poll(() => named(seen, "package_selected").length).toBe(1);
    expect(named(seen, "package_selected")[0].properties.$current_url).toBe(`${baseURL}/packages`);
    expect(named(seen, "package_selected")[0].properties.$pathname).toBe("/packages");
  });

  test("a public event is still sent when PostHog finishes loading on a private page", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    const hold = await holdPostHog(page, productionHost);

    await page.goto("/packages");
    await acceptCookies(page);
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await seeDetails(page);
    await page.getByRole("button", { name: "Referrals", exact: true }).click();
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page.locator("#ref-login-identifier")).toBeVisible();
    hold.release();

    await expect.poll(() => named(seen, "view_item").length, { timeout: 20000 }).toBe(1);
    expect(named(seen, "view_item")[0].properties.$current_url).toBe(`${baseURL}/packages`);
    await pastPostHogStart(page, seen);
    await page.goBack();
    await expect.poll(() => pageviews(seen)).toEqual([`${baseURL}/packages`, `${baseURL}/packages`]);
    expect(seen.events.filter((event) => !event.properties.$current_url.startsWith(`${baseURL}/packages`)))
      .toEqual([]);
    expect(JSON.stringify(seen.snapshots)).not.toContain("ref-login-identifier");
    expect(seen.posthogHosts).toEqual([]);
  });

  test("replay records nothing from a private page visited in the app", async ({ page, posthog: seen, baseURL }) => {
    await page.goto("/packages");
    await acceptCookies(page);
    await expect.poll(() => seen.requests.some((pathname) => pathname.startsWith("/ingest/static/")), {
      timeout: 20000,
    }).toBe(true);
    await interactUntilReplay(page, seen, fullSnapshot);

    await page.getByRole("button", { name: "Referrals", exact: true }).click();
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page.locator("#ref-login-identifier")).toBeVisible();
    await page.waitForTimeout(500);
    await page.goBack();
    await expect(page).toHaveURL(`${baseURL}/packages`);
    await page.waitForTimeout(300);
    await page.goForward();
    await expect(page.locator("#ref-login-identifier")).toBeVisible();
    await page.waitForTimeout(300);
    const finalBack = await browserNow(page);
    await page.goBack();
    await expect(page).toHaveURL(`${baseURL}/packages`);
    const returned = await browserNow(page);
    await interactUntilReplay(page, seen, (item) => item.timestamp > returned + 3000);

    expect(JSON.stringify(seen.snapshots)).not.toContain("ref-login-identifier");
    expect(seen.snapshots.some((item) => item.type === 2 && item.timestamp >= finalBack)).toBe(true);
    expect(seen.events.filter((event) => !event.properties.$current_url.startsWith(`${baseURL}/packages`)))
      .toEqual([]);
  });

  test("one page view when Accept is clicked, and one when Accept is already stored at load", async ({
    page, posthog: seen, baseURL,
  }) => {
    await page.goto("/packages");
    await settleIdle(page);
    await acceptCookies(page);
    await expect.poll(() => pageviews(seen)).toEqual([`${baseURL}/packages`]);
    await page.goto("/about");
    await expect.poll(() => pageviews(seen)).toEqual([`${baseURL}/packages`, `${baseURL}/about`]);
    await page.goto("/packages");
    await settleIdle(page);
    await seeDetails(page);
    await expect.poll(() => named(seen, "view_item").length).toBe(1);
    expect(pageviews(seen)).toEqual([`${baseURL}/packages`, `${baseURL}/about`, `${baseURL}/packages`]);
  });

  test("Accept and a navigation before PostHog has downloaded keep both page views, in order", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    const hold = await holdPostHog(page, productionHost);
    await page.goto("/packages");
    const acceptedAt = await browserNow(page);
    await acceptCookies(page);
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    const navigatedAt = await browserNow(page);
    await page.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(page).toHaveURL((url) => url.pathname === "/booking");
    hold.release();

    await expect.poll(() => pageviews(seen)).toEqual([`${baseURL}/packages`, `${baseURL}/booking`]);
    const [landing, booking] = named(seen, "$pageview");
    expect(landing.properties.$pathname).toBe("/packages");
    expect(booking.properties.$pathname).toBe("/booking");
    expect(sentAt(landing)).toBeGreaterThanOrEqual(acceptedAt);
    expect(sentAt(landing)).toBeLessThan(navigatedAt);
    expect(sentAt(booking)).toBeGreaterThanOrEqual(navigatedAt);
  });

  test("a tab that is never visible still sends its page view", async ({ page, posthog: seen, baseURL }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Document.prototype, "visibilityState", { get: () => "hidden" });
      Object.defineProperty(Document.prototype, "hidden", { get: () => true });
    });
    await page.goto("/packages");
    expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
    await acceptCookies(page);
    await expect.poll(() => pageviews(seen)).toEqual([`${baseURL}/packages`]);
  });

  test("checkout_started survives the redirect to the provider before PostHog has started", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    test.setTimeout(180000);
    const hold = await holdPostHog(page, productionHost);
    await page.goto("/packages");
    await acceptCookies(page);
    await page.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(page).toHaveURL((url) => url.pathname === "/booking");
    await reachPayment(page);
    const paymentPath = new URL(page.url()).pathname;
    const clickedAt = await browserNow(page);
    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/__test/checkout-handoff`);
    const leftAt = await browserNow(page);
    expect(hold.held).toBe(true);
    expect(seen.events).toEqual([]);
    hold.release();

    const returnedAt = await browserNow(page);
    await page.goto("/packages");
    await expect.poll(() => named(seen, "checkout_started").length).toBe(1);
    const started = named(seen, "checkout_started")[0];
    expect(started.properties.$current_url).toBe(`${baseURL}${paymentPath}`);
    expect(sentAt(started)).toBeGreaterThanOrEqual(clickedAt);
    expect(sentAt(started)).toBeLessThanOrEqual(leftAt);
    await expect.poll(() => pageviews(seen, since(returnedAt))).toEqual([`${baseURL}/packages`]);
    const views = pageviews(seen).length;

    await page.reload();
    await expect.poll(() => pageviews(seen).length).toBe(views + 1);
    expect(named(seen, "checkout_started")).toHaveLength(1);
    expect(await outbox(page)).toBeNull();
  });

  test("a standalone public page is counted", async ({ page, posthog: seen, baseURL }) => {
    await page.goto("/tourney");
    await acceptCookies(page);
    await expect.poll(() => pageviews(seen)).toEqual([`${baseURL}/tourney`]);
    expect(seen.posthogHosts).toEqual([]);
  });

  test("a non-sales landing is counted and the journey id carries across reloads", async ({
    page, posthog: seen, baseURL,
  }) => {
    await page.goto("/meet-the-team");
    await acceptCookies(page);
    await expect.poll(() => pageviews(seen)).toEqual([`${baseURL}/meet-the-team`]);
    const landingId = named(seen, "$pageview")[0].properties.distinct_id;

    await page.getByRole("link", { name: "Packages", exact: true }).first().click();
    await expect(page).not.toHaveURL(`${baseURL}/meet-the-team`);
    await expect.poll(() => journeyOf(page)).toBeTruthy();
    const journeyId = await journeyOf(page);
    expect(journeyId).not.toBe(landingId);
    await expect.poll(() => named(seen, "service_visit").map((event) => event.properties.distinct_id))
      .toEqual([journeyId]);

    await page.reload();
    await expect.poll(() => named(seen, "$pageview").length).toBe(3);
    expect(named(seen, "$pageview").at(-1).properties.distinct_id).toBe(journeyId);
    expect(seen.posthogHosts).toEqual([]);
  });
});

test.describe("cookie choice", () => {
  for (const choice of ["no choice", "Decline"]) {
    test(`${choice} sends nothing and downloads no PostHog code until Accept`, async ({
      page, posthog: seen, baseURL,
    }) => {
      await page.goto("/packages");
      await expect(cookieBanner(page)).toBeVisible();
      if (choice === "Decline") await declineCookies(page);
      await seeDetails(page);
      await pastPostHogStart(page, seen);
      expect(await postHogCode(seen)).toEqual([]);
      expect(seen.requests).toEqual([]);

      if (choice === "Decline") await openCookieSettings(page);
      await acceptCookies(page);
      await expect.poll(() => pageviews(seen)).toEqual([`${baseURL}/packages`]);
      expect((await postHogCode(seen)).length).toBeGreaterThan(0);
      await seeDetails(page);
      await expect.poll(() => named(seen, "view_item").length).toBe(1);
      await settleIdle(page);
      expect(named(seen, "view_item")).toHaveLength(1);
      expect(seen.posthogHosts).toEqual([]);
    });
  }

  test("Decline after Accept stops capture and replay until the next Accept", async ({
    page, posthog: seen, baseURL,
  }) => {
    await page.goto("/packages");
    await acceptCookies(page);
    await expect.poll(() => pageviews(seen)).toEqual([`${baseURL}/packages`]);
    await interactUntilReplay(page, seen, fullSnapshot);

    await openCookieSettings(page);
    await declineCookies(page);
    await expect(cookieBanner(page)).toBeHidden();
    const declinedAt = await browserNow(page);
    await seeDetails(page);
    for (let step = 0; step < 4; step += 1) await page.mouse.move(300 + step * 80, 420);
    await settleIdle(page);

    const acceptedAt = await browserNow(page);
    await openCookieSettings(page);
    await page.evaluate(() => localStorage.setItem("roo-consent-declined", String(Date.now() + 3600000)));
    await acceptCookies(page);
    await seeDetails(page);
    await expect.poll(() => named(seen, "view_item").length).toBe(1);
    const correctedDecline = Number(await page.evaluate(() => localStorage.getItem("roo-consent-declined")));
    expect(correctedDecline).toBeLessThanOrEqual(await browserNow(page));
    await interactUntilReplay(page, seen, (item) => item.timestamp > acceptedAt);
    expect(sentBetween(seen, declinedAt, acceptedAt)).toEqual([]);
    expect(Date.parse(named(seen, "view_item")[0].timestamp)).toBeGreaterThan(acceptedAt);
  });

  test("an event fired before Accept is never sent, however long its module took to load", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    const hold = await holdChunk(page, productionHost, "first_campaign");
    await page.goto("/packages", { waitUntil: "domcontentloaded" });
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await seeDetails(page);
    const acceptedAt = await browserNow(page);
    await acceptCookies(page);
    hold.release();

    await expect.poll(() => pageviews(seen)).toEqual([`${baseURL}/packages`]);
    await seeDetails(page);
    await expect.poll(() => named(seen, "view_item").length).toBe(1);
    expect(sentAt(named(seen, "view_item")[0])).toBeGreaterThan(acceptedAt);
    expect(seen.events.filter((event) => sentAt(event) < acceptedAt)).toEqual([]);
  });

  test("Decline after Accept clears the waiting list and sends none of it", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    const hold = await holdPostHog(page, productionHost);
    await page.goto("/packages");
    await acceptCookies(page);
    await seeDetails(page);
    await expect.poll(() => outbox(page)).toEqual(["$pageview", "view_item"]);
    await openCookieSettings(page);
    await declineCookies(page);
    expect(await outbox(page)).toBeNull();
    hold.release();
    await seeDetails(page);
    expect(await outbox(page)).toBeNull();

    const acceptedAt = await browserNow(page);
    await openCookieSettings(page);
    await acceptCookies(page);
    await expect.poll(() => pageviews(seen)).toEqual([`${baseURL}/packages`]);
    expect(seen.events.filter((event) => sentAt(event) < acceptedAt)).toEqual([]);
    expect(named(seen, "view_item")).toEqual([]);
  });

  test("Decline in another tab clears this tab's waiting list and its next event", async ({
    page, context, posthog: seen, baseURL, productionHost,
  }) => {
    const hold = await holdPostHog(page, productionHost);
    const here = () => seen.events.filter((event) => event.properties.$current_url === `${baseURL}/packages`);
    await page.goto("/packages");
    await acceptCookies(page);
    await expect.poll(() => outbox(page)).toEqual(["$pageview"]);
    const other = await context.newPage();
    await other.goto("/about", { waitUntil: "domcontentloaded" });
    await openCookieSettings(other);
    await declineCookies(other);
    await expect.poll(() => outbox(page)).toBeNull();
    await seeDetails(page);
    expect(await outbox(page)).toBeNull();
    hold.release();

    const acceptedAt = await browserNow(page);
    await openCookieSettings(other);
    await acceptCookies(other);
    await expect.poll(() => here().map((event) => event.event)).toEqual(["$pageview"]);
    expect(sentAt(here()[0])).toBeGreaterThan(acceptedAt);
    await other.close();
  });

  test("a choice made in another tab starts and stops PostHog here", async ({
    page, context, posthog: seen, baseURL,
  }) => {
    await page.goto("/packages");
    await expect(cookieBanner(page)).toBeVisible();
    const other = await context.newPage();
    await other.goto("/about");
    await acceptCookies(other);
    await expect(cookieBanner(page)).toBeHidden();
    await expect.poll(() => pageviews(seen).sort()).toEqual([`${baseURL}/about`, `${baseURL}/packages`]);

    await openCookieSettings(other);
    await declineCookies(other);
    const declinedAt = await browserNow(page);
    await seeDetails(page);
    await settleIdle(page);

    const acceptedAt = await browserNow(page);
    await openCookieSettings(other);
    await acceptCookies(other);
    await seeDetails(page);
    await expect.poll(() => named(seen, "view_item").length).toBe(1);
    expect(named(seen, "view_item")[0].properties.$current_url).toBe(`${baseURL}/packages`);
    expect(sentBetween(seen, declinedAt, acceptedAt)).toEqual([]);
    await other.close();
  });
  for (const choice of ["no choice", "Decline"]) {
    test(`a booking confirmed with ${choice} keeps no PostHog mark and is not sent after Accept`, async ({
      page, posthog: seen, baseURL,
    }) => {
      test.setTimeout(180000);
      const marks = async () => (await sessionKeys(page)).filter((key) => /^(roo-)?posthog/.test(key));
      await page.goto("/packages");
      if (choice === "Decline") await declineCookies(page);
      await confirmBooking(page, baseURL);
      await expect.poll(() => sessionKeys(page)).toContain(`booking_completion_tracked:${eventId}`);
      expect(await marks()).toEqual([]);

      await page.goto("/packages");
      if (choice === "Decline") await openCookieSettings(page);
      await acceptCookies(page);
      await expect.poll(() => pageviews(seen)).toEqual([`${baseURL}/packages`]);
      await pastPostHogStart(page, seen);
      await settleIdle(page);
      expect(named(seen, "booking_completed")).toEqual([]);
      expect(await marks()).toEqual([]);
    });
  }

  test("a service visit made before Accept is never stored or sent, however long attribution took", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    const hold = await holdChunk(page, productionHost, "first_campaign");
    await page.goto("/packages", { waitUntil: "domcontentloaded" });
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await acceptCookies(page);
    await expect.poll(() => outbox(page)).toEqual(["$pageview"]);
    hold.release();

    const visited = async () => (await sessionKeys(page)).some((key) => key.startsWith("sales_visit:"));
    await expect.poll(visited).toBe(true);
    expect(await outbox(page) ?? []).not.toContain("service_visit");
    await expect.poll(() => pageviews(seen)).toEqual([`${baseURL}/packages`]);
    await pastPostHogStart(page, seen);
    await settleIdle(page);
    expect(named(seen, "service_visit")).toEqual([]);
  });

  const loading = [
    ["this tab", "the waiting list", "roo-posthog-outbox"],
    ["another tab", "the waiting list", "roo-posthog-outbox"],
    ["another tab", "the new page's code", ""],
  ];
  for (const [where, what, marker] of loading) {
    test(`Decline then Accept in ${where} before ${what} loads drops what the first Accept kept`, async ({
      page, context, posthog: seen, baseURL, productionHost,
    }) => {
      const postHog = await holdPostHog(page, productionHost);
      await page.goto("/packages");
      await acceptCookies(page);
      await seeDetails(page);
      await expect.poll(() => outbox(page)).toEqual(["$pageview", "view_item"]);
      const hold = await holdChunk(page, productionHost, marker);
      await page.goto("/about", { waitUntil: "commit" });
      await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);

      if (where === "this tab") {
        await choose(page, "Decline");
        await choose(page, "Accept");
      } else await (await chooseInOtherTab(context, ["Decline", "Accept"])).close();
      hold.release();
      postHog.release();

      await expect.poll(() => pageviews(seen, fromTab(seen, page))).toContain(`${baseURL}/about`);
      await pastPostHogStart(page, seen);
      await settleIdle(page);
      expect(seen.events.filter((event) => event.properties.$pathname === "/packages")).toEqual([]);
      expect(named(seen, "view_item")).toEqual([]);
    });
  }

  test("entries dropped as stale or private are removed from storage at once", async ({
    page, context, posthog: seen, productionHost,
  }) => {
    const postHog = await holdPostHog(page, productionHost);
    await page.goto("/packages");
    await acceptCookies(page);
    await seeDetails(page);
    await expect.poll(() => outbox(page)).toEqual(["$pageview", "view_item"]);
    const hold = await holdOutbox(page, productionHost);
    await page.goto("/referrals/login", { waitUntil: "commit" });
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await (await chooseInOtherTab(context, ["Decline", "Accept"])).close();
    hold.release();
    await expect.poll(() => storedOutbox(page)).toBeNull();

    postHog.release();
    await pastPostHogStart(page, seen);
    expect(await storedOutbox(page)).toBeNull();
    expect(seen.events.filter((event) => event.properties.$pathname === "/packages")).toEqual([]);
  });

  test("Decline after a counted booking removes every PostHog key and keeps the other marks", async ({
    page, posthog: seen, baseURL,
  }) => {
    test.setTimeout(180000);
    await page.goto("/packages");
    await acceptCookies(page);
    await confirmBooking(page, baseURL);
    await expect.poll(() => named(seen, "booking_completed").length).toBe(1);
    await expect.poll(() => sessionKeys(page)).toContain(`booking_completion_tracked:${eventId}`);
    expect(await postHogKeys(page)).not.toEqual([]);
    const marks = await otherMarks(page);

    await page.goto("/packages");
    await openCookieSettings(page);
    await declineCookies(page);
    await expect.poll(() => postHogKeys(page)).toEqual([]);
    expect(await otherMarks(page)).toEqual(marks);
  });

  test("a booking counted before a Decline in another tab counts again once, though the list was loading", async ({
    page, context, posthog: seen, baseURL, productionHost,
  }) => {
    test.setTimeout(240000);
    await page.goto("/packages");
    await acceptCookies(page);
    await confirmBooking(page, baseURL);
    await expect.poll(() => named(seen, "booking_completed").length).toBe(1);
    await expect.poll(() => storedMarks(page)).toContain(`booking:${eventId}`);
    const hold = await holdOutbox(page, productionHost);
    await page.goto("/packages", { waitUntil: "commit" });
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await (await chooseInOtherTab(context, ["Decline", "Accept"])).close();
    hold.release();
    await expect.poll(() => storedMarks(page)).not.toContain(`booking:${eventId}`);

    await confirmBooking(page, baseURL, { time: "11:00 AM" });
    await expect.poll(() => named(seen, "booking_completed").length).toBe(2);
    await settleIdle(page);
    expect(named(seen, "booking_completed")).toHaveLength(2);
  });

  for (const request of inFlightRequests) {
    for (const choice of ["Accept", "Decline"]) {
      test(`${choice} in another tab while ${request.name} is in flight decides ${request.event}`, async ({
        page, context, posthog: seen,
      }) => {
        test.setTimeout(180000);
        await page.goto("/packages");
        if (choice === "Decline") await acceptCookies(page);
        await request.open(page);
        const other = await context.newPage();
        await other.goto("/about");
        await cookieSettingsReady(other);
        const hold = await holdRequest(page, request.path);
        await request.send(page);
        await expect.poll(() => hold.held).toBe(true);
        await choose(other, choice);
        const releasedAt = await browserNow(page);
        hold.release();
        await request.succeeded(page);
        if (choice === "Accept") await expect.poll(() => named(seen, request.event).length).toBe(1);
        else {
          await choose(other, "Accept");
          await expect.poll(() => named(seen, "$pageview").filter((event) => sentAt(event) > releasedAt).length)
            .toBeGreaterThan(0);
        }
        await pastPostHogStart(page, seen);
        expect(named(seen, request.event)).toHaveLength(choice === "Accept" ? 1 : 0);
        await other.close();
      });
    }

    test(`${request.name} that fails makes no ${request.event}`, async ({ page, posthog: seen }) => {
      test.setTimeout(180000);
      await page.goto("/packages");
      await acceptCookies(page);
      await request.open(page);
      await page.route(`**${request.path}`, failedAnswer, { times: 1 });
      await request.send(page);
      await request.failed(page);
      await pastPostHogStart(page, seen);
      expect(named(seen, request.event)).toEqual([]);
      expect(await outbox(page) ?? []).not.toContain(request.event);
    });
  }

  for (const choices of [["Decline"], ["Decline", "Accept"]]) {
    const title = `a page restored by Back after ${choices.join(" then ")} in another tab drops its waiting list`;
    cachedTest(title, async ({
      page, context, posthog: seen, baseURL, productionHost,
    }) => {
      await page.addInitScript(() => window.addEventListener("pageshow", (event) => {
        if (event.persisted) window.restoredFromCache = true;
      }));
      const hold = await holdPostHog(page, productionHost);
      await page.goto("/packages");
      await acceptCookies(page);
      await seeDetails(page);
      await expect.poll(() => outbox(page)).toEqual(["$pageview", "view_item"]);
      const leftAt = await browserNow(page);
      await page.goto(`${productionHost.loopback}/about`, { waitUntil: "domcontentloaded" });
      const other = await context.newPage();
      await other.goto("/about", { waitUntil: "domcontentloaded" });
      for (const choice of choices) {
        await openCookieSettings(other);
        await (choice === "Decline" ? declineCookies : acceptCookies)(other);
      }
      await other.close();

      await page.goBack({ waitUntil: "commit" });
      await expect.poll(() => page.evaluate(() => window.restoredFromCache === true)).toBe(true);
      if (choices.length === 1) {
        expect(await outbox(page)).toBeNull();
        await openCookieSettings(page);
        await acceptCookies(page);
      }
      hold.release();
      await expect.poll(() => pageviews(seen, since(leftAt))).toContain(`${baseURL}/packages`);
      await pastPostHogStart(page, seen);
      await settleIdle(page);
      const here = seen.events.filter((event) => event.properties.$pathname === "/packages");
      expect(here.filter((event) => sentAt(event) < leftAt)).toEqual([]);
      expect(named(seen, "view_item")).toEqual([]);
    });
  }
});

test.describe("waiting list", () => {
  const leaked = [
    "buyer@example.com", "buyer%40example.com", "evil.example", "555-0199", "fbclid-value-1234", "creatorref",
  ];

  test("a creator code from the link is never stored, and reaches PostHog with the visit and the booking", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    test.setTimeout(180000);
    const hold = await holdPostHog(page, productionHost);
    await page.goto("/packages?ref=creatorref");
    await acceptCookies(page);
    await seeDetails(page);
    await expect.poll(() => outbox(page)).toEqual(["$pageview", "view_item"]);
    expect(await storedOutbox(page)).not.toContain("creatorref");
    const attribution = receiptAttribution({ creatorCode: "creatorref" });
    await confirmBooking(page, baseURL, { receipt: { referralCode: "typedcode", attribution } });
    await expect.poll(() => outbox(page)).toContain("booking_completed");

    hold.release();
    await expect.poll(() => named(seen, "booking_completed").length).toBe(1);
    expect(named(seen, "view_item")[0].properties).toMatchObject({ creator_code: "creatorref" });
    expect(named(seen, "booking_completed")[0].properties)
      .toMatchObject({ creator_code: "creatorref", referral_code: "typedcode", event_id: eventId });
  });

  test("a booking reaches PostHog with its receipt's campaign, though the browser's changed before hand-over", async ({
    page, context, posthog: seen, baseURL, productionHost,
  }) => {
    test.setTimeout(180000);
    const vercelCopy = await recordVercel(context);
    const hold = await holdPostHog(page, productionHost);
    await page.goto("/packages");
    await acceptCookies(page);
    const attribution = receiptAttribution({ source: "meta", campaign: "autumn" });
    await confirmBooking(page, baseURL, { receipt: { attribution } });
    await expect.poll(() => outbox(page)).toContain("booking_completed");
    await expect.poll(() => vercelCopy("booking_completed")).toBeTruthy();

    const other = await context.newPage();
    await other.goto("/packages?utm_source=launch&utm_campaign=spring", { waitUntil: "domcontentloaded" });
    await expect.poll(() => named(seen, "$pageview").filter(fromTab(seen, other)).map(({ properties }) =>
      properties.campaign)).toEqual(["spring"]);
    await other.close();
    hold.release();

    await expect.poll(() => named(seen, "booking_completed").length).toBe(1);
    const booked = named(seen, "booking_completed")[0].properties;
    expect(booked).toMatchObject({ journey_id: receiptJourney, campaign_source: "meta", campaign: "autumn" });
    expect(salesLabels(booked)).toEqual(salesLabels(vercelCopy("booking_completed")));
    expect(Object.values(salesLabels(booked))).not.toContain("spring");
    expect(Object.values(salesLabels(booked))).not.toContain("launch");
    const views = named(seen, "$pageview").filter(fromTab(seen, page));
    expect(views.length).toBeGreaterThan(0);
    for (const view of views) {
      expect(view.properties.campaign_source).toBeUndefined();
      expect(view.properties.campaign).toBeUndefined();
    }
    await page.goto("/about");
    await expect.poll(
      () => named(seen, "$pageview").filter(fromTab(seen, page)).find((ev) => ev.properties?.$pathname === "/about"),
      { timeout: 20000 },
    ).toBeTruthy();
    const afterView = named(seen, "$pageview")
      .filter(fromTab(seen, page))
      .find((ev) => ev.properties?.$pathname === "/about");
    expect(afterView.properties).toMatchObject({ campaign_source: "launch", campaign: "spring" });
  });

  test("a booking whose receipt has no campaign reaches PostHog with none, and a visit keeps the browser's", async ({
    page, context, posthog: seen, baseURL,
  }) => {
    test.setTimeout(180000);
    const vercelCopy = await recordVercel(context);
    await page.goto("/packages?utm_source=launch&utm_campaign=spring");
    await acceptCookies(page);
    await seeDetails(page);
    await confirmBooking(page, baseURL);
    await expect.poll(() => named(seen, "booking_completed").length).toBe(1);
    await expect.poll(() => vercelCopy("booking_completed")).toBeTruthy();
    expect(salesLabels(named(seen, "booking_completed")[0].properties)).toEqual({});
    expect(salesLabels(vercelCopy("booking_completed"))).toEqual({});
    expect(named(seen, "view_item")[0].properties).toMatchObject({ campaign_source: "launch", campaign: "spring" });
  });

  test("a code typed at checkout reaches PostHog on the booking from the receipt", async ({
    page, posthog: seen, baseURL,
  }) => {
    test.setTimeout(180000);
    await page.goto("/packages");
    await acceptCookies(page);
    await confirmBooking(page, baseURL, { receipt: { referralCode: "typedcode" } });
    await expect.poll(() => named(seen, "booking_completed").length).toBe(1);
    const booked = named(seen, "booking_completed")[0].properties;
    expect(booked.referral_code).toBe("typedcode");
    expect(booked).not.toHaveProperty("creator_code");
  });

  test("a confirmed booking is stored before the confirmation page's code has loaded", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    test.setTimeout(180000);
    await page.goto("/packages");
    await acceptCookies(page);
    let hold;
    let seenAt;
    await confirmBooking(page, baseURL, {
      beforeReturn: async () => {
        hold = await holdChunk(page, productionHost, "[PostHog.js]", "Looking for your booking?");
      },
      afterFinalize: () => expect.poll(async () => {
        seenAt = await page.evaluate(() => ({
          path: window.location.pathname, stored: sessionStorage.getItem("roo-posthog-outbox") || "",
        }));
        return seenAt.stored.includes("booking_completed");
      }).toBe(true),
    });
    expect(seenAt.path).toBe("/payment");
    hold.release();
    await expect.poll(() => named(seen, "booking_completed").length).toBe(1);
  });

  test("a free booking is stored when its receipt arrives, before the checkout count has loaded", async ({
    page, flow, posthog: seen, productionHost,
  }) => {
    test.setTimeout(180000);
    const hold = await holdChunk(page, productionHost, "[PostHog.js]", "roo-checkouts-counted");
    await page.goto("/packages", { waitUntil: "domcontentloaded" });
    await acceptCookies(page);
    await openFreePayment(page, flow, { waitUntil: "domcontentloaded" });
    await page.route("**/api/payment/start", (route) => route.fulfill({ json: freeBooking }));
    await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
    await expect.poll(() => outbox(page)).toContain("free_booking_completed");
    await expect(page).toHaveURL((url) => url.pathname === "/thank-you");
    expect(hold.held).toBe(true);

    hold.release();
    await expect.poll(() => named(seen, "free_booking_completed").length).toBe(1);
    await pastPostHogStart(page, seen);
    expect(named(seen, "free_booking_completed")).toHaveLength(1);
  });

  test("a service visit is stored the moment it begins and sent once, ahead of later page views", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    const hold = await holdChunk(page, productionHost, "first_campaign");
    await page.goto("/meet-the-team", { waitUntil: "domcontentloaded" });
    await acceptCookies(page);
    await page.getByRole("link", { name: "Packages", exact: true }).first().click();
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await expect.poll(() => outbox(page)).toContain("service_visit");
    const visit = (await outboxEntries(page)).find(({ event }) => event === "service_visit");
    const visited = new URL(page.url()).pathname;

    await page.goto("/tourney", { waitUntil: "domcontentloaded" });
    await expect.poll(async () => (await outboxEntries(page)).map(({ path }) => path)).toContain("/tourney");
    const returnedAt = await browserNow(page);
    await page.goto(visited, { waitUntil: "domcontentloaded" });
    hold.release();
    await expect.poll(() => named(seen, "service_visit").length).toBe(1);
    await expect.poll(() => pageviews(seen, since(returnedAt))).toEqual([`${baseURL}${visited}`]);
    await pastPostHogStart(page, seen);
    expect(named(seen, "service_visit").map((event) => event.uuid)).toEqual([visit.id]);
    const order = seen.events.map((event) => event.uuid);
    const later = named(seen, "$pageview").filter((event) => sentAt(event) > visit.at);
    expect(later.length).toBeGreaterThan(1);
    for (const view of later) expect(order.indexOf(view.uuid)).toBeGreaterThan(order.indexOf(visit.id));
  });

  test("an event handed over on a page outside the sales pages keeps its labels and journey", async ({
    page, context, posthog: seen, baseURL, productionHost,
  }) => {
    const hold = await holdPostHog(page, productionHost);
    await page.goto("/packages?utm_source=launch&utm_campaign=spring");
    await acceptCookies(page);
    await seeDetails(page);
    await expect.poll(() => outbox(page)).toEqual(["$pageview", "view_item"]);
    await page.goto("/meet-the-team", { waitUntil: "domcontentloaded" });
    hold.release();

    await expect.poll(() => named(seen, "view_item").length).toBe(1);
    const journeyId = await journeyOf(page);
    expect(journeyId).toBeTruthy();
    expect(named(seen, "view_item")[0].properties).toMatchObject({
      campaign_source: "launch", campaign: "spring", journey_id: journeyId, distinct_id: journeyId,
      $current_url: `${baseURL}/packages`,
    });

    const landing = await context.newPage();
    await context.clearCookies({ name: "roo_attr" });
    await context.clearCookies({ name: "roo_attr_last" });
    await landing.goto("/meet-the-team?utm_source=elsewhere");
    await expect.poll(() => pageviews(seen, fromTab(seen, landing))).toEqual([`${baseURL}/meet-the-team`]);
    await settleIdle(landing);
    expect(await journeyOf(landing)).toBeUndefined();
    expect(await landing.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();
    const landed = named(seen, "$pageview").filter((event) => event.properties.distinct_id !== journeyId);
    expect(landed).toHaveLength(1);
    for (const label of ["journey_id", "campaign_source", "landing_path"]) {
      expect(landed[0].properties).not.toHaveProperty(label);
    }
    await landing.close();
  });

  test("nothing from the landing address is stored, and PostHog gets only cleaned labels", async ({
    page, posthog: seen, productionHost,
  }) => {
    const hold = await holdPostHog(page, productionHost);
    await page.goto("/packages?utm_source=buyer%40example.com&utm_medium=https%3A%2F%2Fevil.example%2Fad" +
      "&utm_campaign=call%20(212)%20555-0199&utm_term=spring&fbclid=fbclid-value-1234&ref=creatorref");
    await acceptCookies(page);
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await seeDetails(page);
    await expect.poll(() => outbox(page)).toEqual(["$pageview", "view_item"]);
    const text = await storedOutbox(page);
    for (const value of [...leaked, "utm_", "spring", "?", "fbclid"]) expect(text).not.toContain(value);

    hold.release();
    await expect.poll(() => named(seen, "view_item").length).toBe(1);
    const sent = JSON.stringify(seen.events);
    for (const value of leaked.slice(0, -1)) expect(sent).not.toContain(value);
    for (const event of [named(seen, "$pageview")[0], named(seen, "view_item")[0]]) {
      expect(event.properties).toMatchObject({ has_fbclid: true, campaign_term: "spring" });
      expect(event.properties.$current_url).not.toMatch(/[?#]/);
      for (const label of ["campaign_source", "campaign_medium", "campaign", "fbclid"]) {
        expect(event.properties).not.toHaveProperty(label);
      }
    }
  });

  test("a booking confirmed before Accept is never stored or sent, however long attribution took", async ({
    page, context, posthog: seen, baseURL, productionHost,
  }) => {
    test.setTimeout(180000);
    await page.goto("/packages");
    let hold;
    await confirmBooking(page, baseURL, {
      beforeReturn: async () => { hold = await holdChunk(page, productionHost, "first_campaign"); },
    });
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    const other = await context.newPage();
    await other.goto("/about", { waitUntil: "domcontentloaded" });
    await acceptCookies(other);
    await expect.poll(() => outbox(page)).toEqual(["$pageview"]);
    hold.release();

    const returnedAt = await browserNow(page);
    await page.goto("/packages");
    await expect.poll(() => pageviews(seen, since(returnedAt))).toContain(`${baseURL}/packages`);
    await pastPostHogStart(page, seen);
    await settleIdle(page);
    expect(named(seen, "booking_completed")).toEqual([]);
    expect(await outbox(page)).toBeNull();
    await other.close();
  });

  test("events made while attribution loads are stored and sent in the order they happened", async ({
    page, posthog: seen, productionHost,
  }) => {
    const hold = await holdChunk(page, productionHost, "first_campaign");
    await page.goto("/packages", { waitUntil: "domcontentloaded" });
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await acceptCookies(page);
    await seeDetails(page);
    await page.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(page).toHaveURL((url) => url.pathname === "/booking");
    await expect.poll(async () => (await outbox(page))?.filter((name) => name === "$pageview").length).toBe(2);
    const stored = await outboxEntries(page);
    const names = stored.map(({ event }) => event);
    expect(names).toContain("view_item");
    expect(names.indexOf("view_item")).toBeLessThan(names.lastIndexOf("$pageview"));
    expect(stored.map(({ at }) => at)).toEqual(stored.map(({ at }) => at).sort((a, b) => a - b));

    hold.release();
    const ids = stored.map(({ id }) => id);
    const received = () => seen.events.filter((event) => ids.includes(event.uuid));
    await expect.poll(() => received().length).toBe(ids.length);
    expect(received().map((event) => event.uuid)).toEqual(ids);
    expect(received().map(sentAt)).toEqual(stored.map(({ at }) => at));
  });

  test("an event made while attribution loads survives leaving the page", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    const hold = await holdChunk(page, productionHost, "first_campaign");
    await page.goto("/packages", { waitUntil: "domcontentloaded" });
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await acceptCookies(page);
    await seeDetails(page);
    await page.goto("/about", { waitUntil: "domcontentloaded" });
    hold.release();
    await page.goto("/packages");

    await expect.poll(() => named(seen, "view_item").length).toBe(1);
    await pastPostHogStart(page, seen);
    await settleIdle(page);
    expect(pageviews(seen)).toContain(`${baseURL}/packages`);
    expect(named(seen, "view_item")).toHaveLength(1);
    expect(named(seen, "view_item")[0].properties.$current_url).toBe(`${baseURL}/packages`);
  });

  cachedTest("a payment page restored by Back sends nothing twice, and every event carries its entry's id", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    test.setTimeout(180000);
    await page.addInitScript(() => window.addEventListener("pageshow", (event) => {
      if (event.persisted) window.restoredFromCache = true;
    }));
    const hold = await holdPostHog(page, productionHost);
    await page.goto("/packages");
    await acceptCookies(page);
    await page.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(page).toHaveURL((url) => url.pathname === "/booking");
    await reachPayment(page);
    const paymentPath = new URL(page.url()).pathname;
    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/__test/checkout-handoff`);
    const stored = await outboxEntries(page);
    expect(stored.map(({ event }) => event)).toContain("checkout_started");
    hold.release();

    const returnedAt = await browserNow(page);
    await page.goto("/packages");
    await expect.poll(() => named(seen, "checkout_started").length).toBe(1);
    await expect.poll(() => pageviews(seen, since(returnedAt))).toEqual([`${baseURL}/packages`]);
    expect(await outbox(page)).toBeNull();
    await page.goBack({ waitUntil: "commit" });
    await page.goBack({ waitUntil: "commit" });
    await expect(page).toHaveURL(`${baseURL}${paymentPath}`);
    await expect.poll(() => page.evaluate(() => window.restoredFromCache === true)).toBe(true);
    await page.goBack({ waitUntil: "commit" });
    await expect.poll(() => new URL(page.url()).pathname).toBe("/booking");
    await expect.poll(() => pageviews(seen).slice(-3))
      .toEqual([`${baseURL}/packages`, `${baseURL}${paymentPath}`, `${baseURL}/booking`]);
    await pastPostHogStart(page, seen);
    await settleIdle(page);

    expect(named(seen, "checkout_started")).toHaveLength(1);
    const uuids = seen.events.map((event) => event.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
    for (const { id, event } of stored) {
      expect(seen.events.filter((sent) => sent.uuid === id).map((sent) => sent.event)).toEqual([event]);
    }
  });

  test("a tab copied before the hand-over sends the same event ids", async ({
    page, context, posthog: seen, productionHost,
  }) => {
    const hold = await holdPostHog(page, productionHost);
    await page.goto("/packages");
    await acceptCookies(page);
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await seeDetails(page);
    await expect.poll(() => outbox(page)).toEqual(["$pageview", "view_item"]);
    const stored = await outboxEntries(page);
    const copied = await page.evaluate(() => Object.entries(sessionStorage));
    const copy = await context.newPage();
    await copy.addInitScript((items) => {
      if (!sessionStorage.length) for (const [key, value] of items) sessionStorage.setItem(key, value);
    }, copied);
    await copy.goto("/packages", { waitUntil: "domcontentloaded" });
    hold.release();

    const ids = stored.map(({ id }) => id);
    await expect.poll(() => seen.events.filter((event) => ids.includes(event.uuid)).length).toBe(ids.length * 2);
    for (const { id, event } of stored) {
      expect(seen.events.filter((sent) => sent.uuid === id).map((sent) => sent.event)).toEqual([event, event]);
    }
    await copy.close();
  });

  test("Decline in another tab clears the waiting list of a tab on a staff page at once", async ({
    page, context, productionHost,
  }) => {
    await holdPostHog(page, productionHost);
    await page.goto("/packages");
    await acceptCookies(page);
    await expect.poll(() => outbox(page)).toEqual(["$pageview"]);
    await page.goto("/admin/content", { waitUntil: "domcontentloaded" });
    await waitForHydrated(page, "#content-admin-email");
    await settleIdle(page);
    expect(await outbox(page)).toEqual(["$pageview"]);

    const other = await context.newPage();
    await other.goto("/about", { waitUntil: "domcontentloaded" });
    await openCookieSettings(other);
    await declineCookies(other);
    await expect.poll(() => outbox(page)).toBeNull();
    await other.close();
  });

  test("untagged CTA queued before a later tagged page never inherits the later campaign", async ({
    page, context, posthog: seen, baseURL, productionHost,
  }) => {
    const vercel = await recordVercel(context);
    const salesHold = await holdChunks(
      page,
      { origin: productionHost.origin, fetchOrigin: productionHost.loopback },
      (body) => body.includes("roo_attr_last") && body.includes("has_fbclid"),
    );
    await page.goto("/packages", { waitUntil: "domcontentloaded" });
    await expect.poll(() => salesHold.held, { timeout: 20000 }).toBe(true);
    await acceptCookies(page);
    await seeDetails(page);
    await expect.poll(() => outbox(page)).toContain("view_item");

    const laterTab = await context.newPage();
    await laterTab.goto("/?utm_source=later_meta&utm_campaign=later_spring", {
      waitUntil: "domcontentloaded",
    });
    await expect.poll(
      () => pageviews(seen).some((url) => url === `${baseURL}/`),
      { timeout: 20000 },
    ).toBe(true);
    await expect.poll(async () => {
      const c = (await context.cookies()).find(({ name }) => name === "roo_attr_last");
      return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8"))?.lastTouch?.campaign : null;
    }, { timeout: 20000 }).toBe("later_spring");

    salesHold.release();
    await expect.poll(() => named(seen, "view_item").length, { timeout: 20000 }).toBe(1);
    await expect.poll(() => Boolean(vercel("view_item")), { timeout: 20000 }).toBe(true);

    const phView = named(seen, "view_item")[0].properties;
    expect(phView.campaign_source).toBeUndefined();
    expect(phView.campaign).toBeUndefined();
    expect(phView.landing_path).toBe("/packages");
    const vaView = vercel("view_item");
    expect(vaView.campaign_source).toBeUndefined();
    expect(vaView.campaign).toBeUndefined();
    const homePv = seen.events.find(
      (ev) => ev.event === "$pageview" && ev.properties?.$pathname === "/",
    );
    expect(homePv?.properties?.campaign_source).toBe("later_meta");
    expect(homePv?.properties?.campaign).toBe("later_spring");
    await laterTab.close();
  });

  test("queued PostHog events keep landing context out of outbox, match /upgrade/max canonically, and clear landings on flush", async ({
    page, posthog: seen, productionHost,
  }) => {
    await page.goto("/packages");
    await acceptCookies(page);
    await expect.poll(() => pageviews(seen).length, { timeout: 20000 }).toBeGreaterThan(0);

    const phHold = await holdPostHog(page, productionHost);
    await page.goto("/upgrade/max?utm_source=yt_upgrade&utm_campaign=max_push", {
      waitUntil: "domcontentloaded",
    });
    await expect.poll(() => outbox(page), { timeout: 20000 }).toEqual(
      expect.arrayContaining(["$pageview", "service_visit"]),
    );

    const rawOutbox = await outboxEntries(page);
    for (const item of rawOutbox) {
      expect(item.landing).toBeUndefined();
      expect(item.attribution).toBeUndefined();
    }
    const landings = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("roo_posthog_outbox_landings") || "null"),
    );
    const pvItem = rawOutbox.find((item) => item.event === "$pageview");
    const visitItem = rawOutbox.find((item) => item.event === "service_visit");
    expect(landings?.[pvItem.id]).toMatchObject({
      landingPath: "/upgrade",
      campaign: { source: "yt_upgrade", campaign: "max_push" },
    });
    expect(landings?.[visitItem.id]).toMatchObject({
      landingPath: "/upgrade",
      campaign: { source: "yt_upgrade", campaign: "max_push" },
    });

    phHold.release();
    await expect.poll(
      () => seen.events.some((ev) => ev.uuid === pvItem.id) && seen.events.some((ev) => ev.uuid === visitItem.id),
      { timeout: 20000 },
    ).toBe(true);
    const pv = seen.events.find((ev) => ev.uuid === pvItem.id);
    expect(pv.properties.$pathname).toBe("/upgrade");
    expect(pv.properties.landing_path).toBe("/upgrade");
    expect(pv.properties.campaign_source).toBe("yt_upgrade");
    expect(pv.properties.campaign).toBe("max_push");
    const visit = seen.events.find((ev) => ev.uuid === visitItem.id);
    expect(visit.properties.landing_path).toBe("/upgrade");
    expect(visit.properties.campaign_source).toBe("yt_upgrade");
    expect(visit.properties.campaign).toBe("max_push");
    await expect.poll(
      () => page.evaluate(() => sessionStorage.getItem("roo_posthog_outbox_landings")),
    ).toBeNull();
  });

  test("queued untagged click keeps the campaign current when clicked after a third campaign arrives", async ({
    page, posthog: seen, productionHost,
  }) => {
    const phHold = await holdPostHog(page, productionHost);
    await page.goto("/?utm_source=first-touch&utm_campaign=first-campaign", { waitUntil: "domcontentloaded" });
    await acceptCookies(page);
    await expect.poll(async () => {
      const c = (await page.context().cookies()).find(({ name }) => name === "roo_attr_last");
      return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8")).lastTouch?.source : null;
    }, { timeout: 20000 }).toBe("first-touch");

    await page.goto("/reviews?utm_source=second-touch&utm_campaign=second-campaign", {
      waitUntil: "domcontentloaded",
    });
    await expect.poll(async () => {
      const c = (await page.context().cookies()).find(({ name }) => name === "roo_attr_last");
      return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8")).lastTouch?.source : null;
    }, { timeout: 20000 }).toBe("second-touch");

    await page.goto("/packages", { waitUntil: "domcontentloaded" });
    await seeDetails(page);
    await expect.poll(() => outbox(page)).toContain("view_item");
    const clicked = (await outboxEntries(page)).find((item) => item.event === "view_item");

    await page.goto("/?utm_source=third-touch&utm_campaign=third-campaign", { waitUntil: "domcontentloaded" });
    await expect.poll(async () => {
      const c = (await page.context().cookies()).find(({ name }) => name === "roo_attr_last");
      return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8")).lastTouch?.source : null;
    }, { timeout: 20000 }).toBe("third-touch");

    phHold.release();
    await expect.poll(() => seen.events.some((ev) => ev.uuid === clicked.id), { timeout: 20000 }).toBe(true);
    const delivered = seen.events.find((ev) => ev.uuid === clicked.id);
    expect(delivered.properties.campaign_source).toBe("second-touch");
    expect(delivered.properties.campaign).toBe("second-campaign");
    expect(delivered.properties.first_source).toBe("first-touch");
    const finalCookie = (await page.context().cookies()).find(({ name }) => name === "roo_attr_last");
    expect(JSON.parse(Buffer.from(finalCookie.value, "base64url").toString("utf8")).lastTouch?.source).toBe(
      "third-touch",
    );
  });

  test("queued PostHog click keeps the pending campaign current when clicked after a later pending touch overwrites it", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    const phHold = await holdPostHog(page, productionHost);
    await page.goto("/packages", { waitUntil: "domcontentloaded" });
    await acceptCookies(page);
    await expect.poll(() => outbox(page)).toContain("$pageview");

    const now = Date.now();
    const journeyId = "66666666-6666-4666-8666-666666666666";
    const oldTouch = { capturedAt: new Date(now - 60_000).toISOString(), landingPath: "/", source: "persisted-prior" };
    await page.context().addCookies([
      { name: "roo_attr", value: Buffer.from(JSON.stringify({ version: 2, journeyId, firstTouch: oldTouch })).toString("base64url"), url: baseURL },
      { name: "roo_attr_last", value: Buffer.from(JSON.stringify({ journeyId, lastTouch: oldTouch })).toString("base64url"), url: baseURL },
    ]);
    await page.evaluate((capturedAt) => {
      sessionStorage.setItem("roo_pending_arrival_touch", JSON.stringify({
        landingPath: "/reviews",
        capturedAt,
        referrerHost: "",
        campaign: { source: "first-pending", campaign: "first-pending-campaign" },
        referral: "",
        ignoreUrlReferral: false,
      }));
    }, new Date(now - 10_000).toISOString());

    await seeDetails(page);
    await expect.poll(() => outbox(page)).toContain("view_item");
    const clicked = (await outboxEntries(page)).find((item) => item.event === "view_item");

    await page.goto("/reviews?utm_source=later-pending&utm_campaign=later-pending-campaign", {
      waitUntil: "domcontentloaded",
    });
    await expect.poll(async () => {
      const c = (await page.context().cookies()).find(({ name }) => name === "roo_attr_last");
      return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8"))?.lastTouch?.source : null;
    }).toBe("later-pending");

    phHold.release();
    await expect.poll(() => seen.events.some((ev) => ev.uuid === clicked.id), { timeout: 20000 }).toBe(true);
    const delivered = seen.events.find((ev) => ev.uuid === clicked.id);
    expect(delivered.properties.campaign_source).toBe("first-pending");
    expect(delivered.properties.campaign).toBe("first-pending-campaign");
    expect(delivered.properties.landing_path).toBe("/reviews");
  });

  test("slow attribution on a first tagged visit keeps one canonical journey across page view and package click", async ({
    page, posthog: seen, productionHost,
  }) => {
    const salesHold = await holdChunk(page, productionHost, "first_campaign");
    await page.goto("/packages?utm_source=first-tagged&utm_campaign=first-campaign", {
      waitUntil: "domcontentloaded",
    });
    await expect.poll(() => salesHold.held, { timeout: 20000 }).toBe(true);
    await expect.poll(
      () => page.evaluate(() => sessionStorage.getItem("roo_pending_arrival_touch") || ""),
      { timeout: 20000 },
    ).toContain("first-tagged");

    await acceptCookies(page);
    await seeDetails(page);
    await expect.poll(() => outbox(page), { timeout: 20000 }).toEqual(
      expect.arrayContaining(["$pageview", "view_item"]),
    );
    expect(await journeyOf(page)).toBeUndefined();

    salesHold.release();
    await expect.poll(() => journeyOf(page), { timeout: 20000 }).toBeTruthy();
    const journeyId = await journeyOf(page);
    await expect.poll(
      () => named(seen, "$pageview").length > 0 && named(seen, "view_item").length > 0,
      { timeout: 20000 },
    ).toBe(true);

    const pv = named(seen, "$pageview").at(-1);
    const click = named(seen, "view_item").at(-1);
    for (const ev of [pv, click]) {
      expect(ev.properties.distinct_id).toBe(journeyId);
      expect(ev.properties.journey_id).toBe(journeyId);
      expect(ev.properties.campaign_source).toBe("first-tagged");
      expect(ev.properties.campaign).toBe("first-campaign");
      expect(ev.properties.first_campaign).toBe("first-campaign");
    }
  });

  test("clicks in an older tab join the saved journey after a second tab saves attribution", async ({
    page, context, posthog: seen, productionHost,
  }) => {
    const vercel = await recordVercel(context);
    const salesHold = await holdChunk(page, productionHost, "first_campaign");
    await page.goto("/packages", { waitUntil: "domcontentloaded" });
    await expect.poll(() => salesHold.held, { timeout: 20000 }).toBe(true);
    await acceptCookies(page);
    await expect.poll(() => outbox(page), { timeout: 20000 }).toContain("$pageview");
    expect(await journeyOf(page)).toBeUndefined();

    const other = await context.newPage();
    await other.goto("/reviews?utm_source=later-tab&utm_campaign=later-campaign", {
      waitUntil: "domcontentloaded",
    });
    await expect.poll(async () => {
      const c = (await context.cookies()).find(({ name }) => name === "roo_attr_last");
      return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8"))?.lastTouch?.source : null;
    }, { timeout: 20000 }).toBe("later-tab");
    const tabBJourney = await journeyOf(page);
    expect(tabBJourney).toBeTruthy();

    await seeDetails(page);
    await seeDetails(page);
    await expect.poll(
      async () => (await outbox(page))?.filter((name) => name === "view_item").length ?? 0,
      { timeout: 20000 },
    ).toBe(2);
    const queued = await outboxEntries(page);
    const pvId = queued.find((item) => item.event === "$pageview").id;
    const clickIds = queued.filter((item) => item.event === "view_item").map((item) => item.id);

    salesHold.release();
    await expect.poll(
      () => [pvId, ...clickIds].every((id) => seen.events.some((ev) => ev.uuid === id)),
      { timeout: 20000 },
    ).toBe(true);
    await expect.poll(async () => {
      const c = (await context.cookies()).find(({ name }) => name === "roo_attr");
      return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8"))?.firstTouch?.landingPath : null;
    }, { timeout: 20000 }).toBe("/packages");
    await expect.poll(() => vercel("view_item")?.journey_id, { timeout: 20000 }).toBe(tabBJourney);

    const pv = seen.events.find((ev) => ev.uuid === pvId);
    expect(pv.properties.distinct_id).toBe(tabBJourney);
    expect(pv.properties.journey_id).toBe(tabBJourney);
    for (const id of clickIds) {
      const ev = seen.events.find((item) => item.uuid === id);
      expect(ev.properties.distinct_id).toBe(tabBJourney);
      expect(ev.properties.journey_id).toBe(tabBJourney);
      expect(ev.properties.campaign_source).toBe("later-tab");
      expect(ev.properties.campaign).toBe("later-campaign");
    }
    const lastCookie = (await context.cookies()).find(({ name }) => name === "roo_attr_last");
    expect(JSON.parse(Buffer.from(lastCookie.value, "base64url").toString("utf8")).journeyId).toBe(tabBJourney);
    await other.close();
  });

  test("delayed PostHog startup on an older tagged tab preserves a newer tab campaign through payment start", async ({
    page, context, flow, posthog: seen, productionHost,
  }) => {
    const vercel = await recordVercel(context);
    const salesHold = await holdChunk(page, productionHost, "first_campaign");
    await page.goto("/packages?utm_source=earlier-tab&utm_campaign=earlier-campaign", {
      waitUntil: "domcontentloaded",
    });
    await expect.poll(() => salesHold.held, { timeout: 20000 }).toBe(true);
    await acceptCookies(page);
    await expect.poll(() => outbox(page), { timeout: 20000 }).toContain("$pageview");
    expect(await journeyOf(page)).toBeUndefined();

    const tabB = await context.newPage();
    await tabB.goto("/reviews?utm_source=later-tab&utm_campaign=later-campaign", {
      waitUntil: "domcontentloaded",
    });
    await expect.poll(async () => {
      const c = (await context.cookies()).find(({ name }) => name === "roo_attr_last");
      return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8"))?.lastTouch?.campaign : null;
    }, { timeout: 20000 }).toBe("later-campaign");
    const tabBJourney = await journeyOf(page);

    await seeDetails(page);
    await seeDetails(page);
    await expect.poll(
      async () => (await outboxEntries(page)).filter((item) => item.event === "view_item").length,
      { timeout: 15000 },
    ).toBe(2);
    const queued = await outboxEntries(page);
    const queuedIds = queued.filter((item) => item.event === "$pageview" || item.event === "view_item").map((item) => item.id);

    salesHold.release();
    await expect.poll(
      () => queuedIds.every((id) => seen.events.some((ev) => ev.uuid === id)),
      { timeout: 20000 },
    ).toBe(true);
    for (const id of queuedIds) {
      const ev = seen.events.find((item) => item.uuid === id);
      expect(ev?.properties?.journey_id).toBe(tabBJourney);
      expect(ev?.properties?.campaign_source).toBe("earlier-tab");
      expect(ev?.properties?.campaign).toBe("earlier-campaign");
    }
    await expect.poll(() => vercel("view_item")?.journey_id, { timeout: 20000 }).toBe(tabBJourney);
    await expect.poll(async () => {
      const c = (await context.cookies()).find(({ name }) => name === "roo_attr");
      return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8"))?.firstTouch?.campaign : null;
    }, { timeout: 20000 }).toBe("earlier-campaign");

    const decode = (name) => {
      const c = context.cookies().then((list) => list.find((item) => item.name === name));
      return c.then((item) => (item ? JSON.parse(Buffer.from(item.value, "base64url").toString("utf8")) : null));
    };
    expect((await decode("roo_attr"))?.firstTouch?.campaign).toBe("earlier-campaign");
    expect((await decode("roo_attr_last"))?.lastTouch?.campaign).toBe("later-campaign");
    expect((await decode("roo_attr_last"))?.journeyId).toBe(tabBJourney);

    const tabC = await context.newPage();
    await tabC.goto("/packages", { waitUntil: "domcontentloaded" });
    await seeDetails(tabC);
    await tabC.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(tabC).toHaveURL((url) => url.pathname === "/booking");
    await reachPayment(tabC);
    await tabC.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(tabC).toHaveURL(/\/__test\/checkout-handoff$/);

    const startBody = flow.startBodies().at(-1)?.bookingPayload?.salesAttribution;
    expect(startBody?.journeyId).toBe(tabBJourney);
    expect(startBody?.firstTouch?.campaign).toBe("earlier-campaign");
    expect(startBody?.lastTouch?.campaign).toBe("later-campaign");
    await tabC.close();
    await tabB.close();
  });

  test("stripping an ignored coupon from the payment URL keeps a newer tab campaign", async ({
    page, context, flow, posthog: seen,
  }) => {
    const decode = async (name) => {
      const c = (await context.cookies()).find((item) => item.name === name);
      return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8")) : null;
    };
    await page.goto("/about", { waitUntil: "domcontentloaded" });
    await acceptCookies(page);

    const futureExpiry = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const state = {
      packageTitle: "Performance Vertex Overhaul", packagePrice: "$84.99",
      email: "a@example.invalid", discord: "user_a", specs: "pc", mainGame: "CS2",
      localTimeZone: "Asia/Kolkata", startTimeUTC: `${flow.state.slots[0].date}T04:30:00.000Z`,
      displayDate: flow.state.slots[0].date, displayTime: "10:00 AM",
      slotHoldId: "hold-passive-utm", slotHoldToken: "tok-passive-utm", slotHoldExpiresAt: futureExpiry,
      couponCode: "save20",
    };
    let releasePassive;
    const passiveSeen = new Promise((resolve) => {
      page.route("**/api/ref/validateCoupon*", async (route) => {
        const code = (new URL(route.request().url()).searchParams.get("code") || "").toLowerCase();
        if (code === "passivea") {
          resolve();
          await new Promise((r) => { releasePassive = r; });
          return route.fulfill({ json: { ok: true, coupon: { code: "passivea", discountType: "percent", discountPercent: 10, canCombineWithReferral: true } } });
        }
        if (code === "save20") {
          return route.fulfill({ json: { ok: true, coupon: { code: "save20", discountType: "percent", discountPercent: 20, canCombineWithReferral: true } } });
        }
        return route.fulfill({ json: { ok: false, reason: "not_found" } });
      });
    });
    await page.route("**/api/ref/validateReferral*", (route) =>
      route.fulfill({ json: { ok: false, reason: "not_found" } }),
    );
    await page.evaluate((checkout) => {
      sessionStorage.setItem("checkout_booking_state", JSON.stringify(checkout));
      sessionStorage.setItem("referral_session", "passivea");
    }, state);

    await page.goto("/payment?ref=passivea&utm_source=earlier-tab&utm_campaign=earlier-campaign", {
      waitUntil: "domcontentloaded",
    });
    await passiveSeen;
    await expect.poll(async () => (await decode("roo_attr_last"))?.lastTouch?.campaign, { timeout: 20000 })
      .toBe("earlier-campaign");
    await expect.poll(
      () => named(seen, "$pageview").some((ev) => ev.properties.$pathname === "/payment"),
      { timeout: 20000 },
    ).toBe(true);

    const tabB = await context.newPage();
    await tabB.goto("/reviews?utm_source=later-tab&utm_campaign=later-campaign", {
      waitUntil: "domcontentloaded",
    });
    await expect.poll(async () => (await decode("roo_attr_last"))?.lastTouch?.campaign, { timeout: 20000 })
      .toBe("later-campaign");
    const laterSaved = await decode("roo_attr_last");

    releasePassive();
    await expect.poll(() => new URL(page.url()).searchParams.has("ref"), { timeout: 20000 }).toBe(false);
    expect(new URL(page.url()).searchParams.get("utm_campaign")).toBe("earlier-campaign");
    await expect(page.locator("#payment-coupon-code")).toHaveValue("save20");
    await settleIdle(page);

    const afterStrip = await decode("roo_attr_last");
    expect(afterStrip?.lastTouch?.campaign).toBe("later-campaign");
    expect(afterStrip?.lastTouch?.capturedAt).toBe(laterSaved?.lastTouch?.capturedAt);

    const tabC = await context.newPage();
    await tabC.goto("/packages", { waitUntil: "domcontentloaded" });
    await tabC.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(tabC).toHaveURL((url) => url.pathname === "/booking");
    await reachPayment(tabC, "11:00 AM");
    await tabC.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(tabC).toHaveURL(/\/__test\/checkout-handoff$/);

    const startAttr = flow.startBodies().at(-1)?.bookingPayload?.salesAttribution;
    expect(startAttr?.lastTouch?.campaign).toBe("later-campaign");
    expect(startAttr?.lastTouch?.capturedAt).toBe(laterSaved?.lastTouch?.capturedAt);
    await tabC.close();
    await tabB.close();
  });

  for (const returnAction of ["close", "back"]) {
    test(`returning to an earlier tagged packages page via ${returnAction} keeps a newer tab campaign`, async ({
      page, context, flow, posthog: seen,
    }) => {
      const decode = async (name) => {
        const c = (await context.cookies()).find((item) => item.name === name);
        return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8")) : null;
      };
      await page.goto("/about", { waitUntil: "domcontentloaded" });
      await acceptCookies(page);
      await page.goto("/packages?utm_source=earlier-tab&utm_campaign=earlier-campaign", {
        waitUntil: "domcontentloaded",
      });
      await expect.poll(async () => (await decode("roo_attr_last"))?.lastTouch?.campaign, { timeout: 20000 })
        .toBe("earlier-campaign");
      await expect.poll(
        () => named(seen, "$pageview").some((ev) => ev.properties.$pathname === "/packages"),
        { timeout: 20000 },
      ).toBe(true);

      await page.getByRole("link", { name: /Book Now/ }).first().click();
      await expect(page).toHaveURL((url) => url.pathname === "/booking");
      await expect(page.getByRole("dialog")).toBeVisible();

      const tabB = await context.newPage();
      await tabB.goto("/reviews?utm_source=later-tab&utm_campaign=later-campaign", {
        waitUntil: "domcontentloaded",
      });
      await expect.poll(async () => (await decode("roo_attr_last"))?.lastTouch?.campaign, { timeout: 20000 })
        .toBe("later-campaign");
      const laterSaved = await decode("roo_attr_last");

      if (returnAction === "close") {
        await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
      } else {
        await page.goBack();
      }
      await expect(page).toHaveURL(/\/packages\?utm_source=earlier-tab&utm_campaign=earlier-campaign$/);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await settleIdle(page);

      const afterReturn = await decode("roo_attr_last");
      expect(afterReturn?.lastTouch?.campaign).toBe("later-campaign");
      expect(afterReturn?.lastTouch?.capturedAt).toBe(laterSaved?.lastTouch?.capturedAt);

      const tabC = await context.newPage();
      await tabC.goto("/packages", { waitUntil: "domcontentloaded" });
      await tabC.getByRole("link", { name: /Book Now/ }).first().click();
      await expect(tabC).toHaveURL((url) => url.pathname === "/booking");
      await reachPayment(tabC, "11:00 AM");
      await tabC.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect(tabC).toHaveURL(/\/__test\/checkout-handoff$/);

      const startAttr = flow.startBodies().at(-1)?.bookingPayload?.salesAttribution;
      expect(startAttr?.lastTouch?.campaign).toBe("later-campaign");
      expect(startAttr?.lastTouch?.capturedAt).toBe(laterSaved?.lastTouch?.capturedAt);
      await tabC.close();
      await tabB.close();
    });
  }

  for (const holdSalesOnReload of [false, true]) {
    test(`reloading a tagged payment page keeps a newer tab campaign at payment start (${holdSalesOnReload ? "chunk held" : "chunk loaded"})`, async ({
      page, context, flow, productionHost,
    }) => {
      const decode = async (name) => {
        const c = (await context.cookies()).find((item) => item.name === name);
        return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8")) : null;
      };
      await page.goto("/about", { waitUntil: "domcontentloaded" });
      await acceptCookies(page);
      await page.goto("/packages", { waitUntil: "domcontentloaded" });
      await page.getByRole("link", { name: /Book Now/ }).first().click();
      await expect(page).toHaveURL((url) => url.pathname === "/booking");
      await reachPayment(page);

      await page.goto("/payment?utm_source=earlier-tab&utm_campaign=earlier-campaign", {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
      await expect.poll(async () => (await decode("roo_attr_last"))?.lastTouch?.campaign, { timeout: 20000 })
        .toBe("earlier-campaign");

      const tabB = await context.newPage();
      await tabB.goto("/reviews?utm_source=later-tab&utm_campaign=later-campaign", {
        waitUntil: "domcontentloaded",
      });
      await expect.poll(async () => (await decode("roo_attr_last"))?.lastTouch?.campaign, { timeout: 20000 })
        .toBe("later-campaign");
      const laterSaved = await decode("roo_attr_last");

      const salesHold = holdSalesOnReload ? await holdChunk(page, productionHost, "first_campaign") : null;
      let salesLoaded = false;
      const onChunkResponse = async (res) => {
        if (salesLoaded || !res.ok() || !res.url().includes("/_next/static/chunks/")) return;
        try {
          if ((await res.text()).includes("first_campaign")) salesLoaded = true;
        } catch {}
      };
      if (!holdSalesOnReload) page.on("response", onChunkResponse);
      await page.reload({ waitUntil: "domcontentloaded" });
      if (salesHold) await expect.poll(() => salesHold.held, { timeout: 20000 }).toBe(true);
      else await expect.poll(() => salesLoaded, { timeout: 20000 }).toBe(true);
      if (!holdSalesOnReload) page.off("response", onChunkResponse);
      await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
      expect(await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.type)).toBe("reload");
      expect((await decode("roo_attr_last"))?.lastTouch).toEqual(laterSaved?.lastTouch);

      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);

      const startAttr = flow.startBodies().at(-1)?.bookingPayload?.salesAttribution;
      expect(startAttr?.lastTouch).toEqual(laterSaved?.lastTouch);
      expect((await decode("roo_attr_last"))?.lastTouch).toEqual(laterSaved?.lastTouch);
      salesHold?.release();
      await tabB.close();
    });
  }

  for (const returnAction of ["close", "back"]) {
    test(`reloading Packages then returning from Booking via ${returnAction} keeps a newer tab campaign`, async ({
      page, context,
    }) => {
      const decode = async (name) => {
        const c = (await context.cookies()).find((item) => item.name === name);
        return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8")) : null;
      };
      await page.goto("/packages?utm_source=earlier-tab&utm_campaign=earlier-campaign", {
        waitUntil: "domcontentloaded",
      });
      await acceptCookies(page);
      await expect.poll(async () => (await decode("roo_attr_last"))?.lastTouch?.campaign, { timeout: 20000 })
        .toBe("earlier-campaign");
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.type)).toBe("reload");

      await page.getByRole("link", { name: /Book Now/ }).first().click();
      await expect(page).toHaveURL((url) => url.pathname === "/booking");
      await expect(page.getByRole("dialog")).toBeVisible();

      const tabB = await context.newPage();
      await tabB.goto("/reviews?utm_source=later-tab&utm_campaign=later-campaign", {
        waitUntil: "domcontentloaded",
      });
      await expect.poll(async () => (await decode("roo_attr_last"))?.lastTouch?.campaign, { timeout: 20000 })
        .toBe("later-campaign");
      const laterSaved = await decode("roo_attr_last");

      if (returnAction === "close") {
        await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
      } else {
        await page.goBack();
      }
      await expect(page).toHaveURL(/\/packages\?utm_source=earlier-tab&utm_campaign=earlier-campaign$/);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await settleIdle(page);

      expect((await decode("roo_attr_last"))?.lastTouch).toEqual(laterSaved?.lastTouch);
      await tabB.close();
    });
  }

  test("a quota error on a full outbox rotates when 100 entries fit and preserves paired landings with zero orphans on write failure", async ({
    page, posthog: seen, productionHost,
  }) => {
    const postHog = await holdPostHog(page, productionHost);
    const longCampaign = `quota-old-${"x".repeat(80)}`;
    const longQuery = new URLSearchParams({
      utm_source: `src-${"a".repeat(80)}`,
      utm_medium: `med-${"b".repeat(80)}`,
      utm_campaign: longCampaign,
      utm_content: `cnt-${"c".repeat(80)}`,
      utm_term: `trm-${"d".repeat(80)}`,
      fbclid: `fb-${"e".repeat(180)}`,
      gclid: `gc-${"f".repeat(180)}`,
    }).toString();
    await page.goto(`/packages?${longQuery}`, { waitUntil: "domcontentloaded" });
    await acceptCookies(page);
    await seeDetails(page);
    await expect.poll(() => outbox(page)).toContain("view_item");
    const longLanding = await page.evaluate(() => {
      const items = JSON.parse(sessionStorage.getItem("roo-posthog-outbox") || "[]");
      const landings = JSON.parse(sessionStorage.getItem("roo_posthog_outbox_landings") || "{}");
      const first = items.find((item) => item.event === "view_item");
      return { first, landing: landings[first.id] };
    });

    await page.goto("/packages?utm_campaign=short", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "See What's Included" }).first()).toBeVisible();
    await expect.poll(() => outbox(page).then((events) => events.filter((name) => name === "$pageview").length)).toBe(2);
    await page.evaluate(({ first, landing }) => {
      const base = first.at;
      const keptItems = [{ id: first.id, event: "$pageview", path: "/packages", at: base }];
      const keptLandings = { [first.id]: landing };
      for (let i = 0; i < 99; i += 1) {
        const id = `seed-${String(i).padStart(3, "0")}`;
        keptItems.push({ id, event: "$pageview", path: "/packages", at: base });
        keptLandings[id] = { ...landing, campaign: { campaign: "short" }, capturedAt: new Date(base).toISOString() };
      }
      sessionStorage.setItem("roo-posthog-outbox", JSON.stringify(keptItems));
      sessionStorage.setItem("roo_posthog_outbox_landings", JSON.stringify(keptLandings));
      const totalBudget = (sessionStorage.getItem("roo-posthog-outbox") || "").length +
        (sessionStorage.getItem("roo_posthog_outbox_landings") || "").length;
      window.__quotaMode = "fail-outbox";
      window.__quotaHits = { outbox: 0, landings: 0 };
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function patchedSetItem(k, v) {
        if (this === window.sessionStorage) {
          if (window.__quotaMode === "fail-outbox" && k === "roo-posthog-outbox") {
            window.__quotaHits.outbox += 1;
            throw new DOMException("QuotaExceededError", "QuotaExceededError");
          }
          if (window.__quotaMode === "fail-landings" && k === "roo_posthog_outbox_landings") {
            window.__quotaHits.landings += 1;
            throw new DOMException("QuotaExceededError", "QuotaExceededError");
          }
          if (window.__quotaMode === "combined-cap" && (k === "roo-posthog-outbox" || k === "roo_posthog_outbox_landings")) {
            const otherKey = k === "roo-posthog-outbox" ? "roo_posthog_outbox_landings" : "roo-posthog-outbox";
            const otherLen = (window.sessionStorage.getItem(otherKey) || "").length;
            if (v.length + otherLen > totalBudget) {
              throw new DOMException("QuotaExceededError", "QuotaExceededError");
            }
          }
        }
        return orig.call(this, k, v);
      };
      window.__firstViewId = first.id;
    }, longLanding);

    const readPair = () => page.evaluate(() => {
      const items = JSON.parse(sessionStorage.getItem("roo-posthog-outbox") || "[]");
      const landings = JSON.parse(sessionStorage.getItem("roo_posthog_outbox_landings") || "{}");
      return {
        count: items.length,
        landingCount: Object.keys(landings).length,
        firstId: items[0]?.id,
        expectedFirstId: window.__firstViewId,
        firstCampaign: landings[items[0]?.id]?.campaign?.campaign || "",
        hits: window.__quotaHits,
      };
    });

    await seeDetails(page);
    const afterOutboxFail = await readPair();
    expect(afterOutboxFail).toEqual({
      count: 100,
      landingCount: 100,
      firstId: afterOutboxFail.expectedFirstId,
      expectedFirstId: afterOutboxFail.expectedFirstId,
      firstCampaign: longCampaign,
      hits: { outbox: 1, landings: 0 },
    });

    await page.evaluate(() => { window.__quotaMode = "fail-landings"; });
    await seeDetails(page);
    const afterLandingFail = await readPair();
    expect(afterLandingFail).toEqual({
      count: 100,
      landingCount: 100,
      firstId: afterLandingFail.expectedFirstId,
      expectedFirstId: afterLandingFail.expectedFirstId,
      firstCampaign: longCampaign,
      hits: { outbox: 1, landings: 1 },
    });

    await page.evaluate(() => { window.__quotaMode = "combined-cap"; });
    await seeDetails(page);
    const firstViewId = await page.evaluate(() => window.__firstViewId);
    await page.goto("/about", { waitUntil: "domcontentloaded" });
    const afterRotate = await page.evaluate((oldId) => {
      const items = JSON.parse(sessionStorage.getItem("roo-posthog-outbox") || "[]");
      const landings = JSON.parse(sessionStorage.getItem("roo_posthog_outbox_landings") || "{}");
      const queueIds = items.map((item) => String(item.id));
      const landingKeys = Object.keys(landings);
      return {
        count: items.length,
        landingCount: landingKeys.length,
        hasNewViewItem: items.some((item) => item.event === "view_item" && item.id !== oldId),
        oldEvicted: !items.some((item) => item.id === oldId),
        everyPaired: items.every((item) => Boolean(landings[item.id])),
        uniqueQueueIds: new Set(queueIds).size === queueIds.length,
        landingsMatchQueue: landingKeys.length === queueIds.length && landingKeys.every((key) => queueIds.includes(key)),
      };
    }, firstViewId);
    expect(afterRotate).toEqual({
      count: 100,
      landingCount: 100,
      hasNewViewItem: true,
      oldEvicted: true,
      everyPaired: true,
      uniqueQueueIds: true,
      landingsMatchQueue: true,
    });
    postHog.release();
    await expect.poll(() => named(seen, "view_item").length, { timeout: 20000 }).toBeGreaterThan(0);
  });

  test("pending attribution overlay wins over an older cookie while the cookie lock is held and pending storage is unavailable", async ({
    page, context, flow,
  }) => {
    await page.goto("/about", { waitUntil: "domcontentloaded" });
    await acceptCookies(page);
    await page.goto("/packages?utm_source=older&utm_campaign=older-cookie", { waitUntil: "domcontentloaded" });
    const cookieCampaign = async () => {
      const c = (await context.cookies()).find((item) => item.name === "roo_attr_last");
      return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8"))?.lastTouch?.campaign : "";
    };
    await expect.poll(cookieCampaign, { timeout: 20000 }).toBe("older-cookie");

    const holder = await context.newPage();
    await holder.goto("/about", { waitUntil: "domcontentloaded" });
    await holder.evaluate(() => new Promise((ready) => {
      navigator.locks.request("roo_sales_attribution_cookie", () => new Promise((release) => {
        window.__releaseAttrLock = release;
        ready();
      }));
    }));

    await page.addInitScript(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function patchedSetItem(k, v) {
        if (this === window.sessionStorage && k === "roo_pending_arrival_touch") {
          throw new DOMException("QuotaExceededError", "QuotaExceededError");
        }
        return orig.call(this, k, v);
      };
    });
    await page.goto("/packages?utm_source=newer&utm_campaign=newer-overlay", { waitUntil: "domcontentloaded" });
    await expect.poll(
      () => page.evaluate(() => ({
        overlay: window.__rooAttrOverlay?.lastTouch?.campaign || "",
        pending: sessionStorage.getItem("roo_pending_arrival_touch"),
      })),
      { timeout: 20000 },
    ).toEqual({ overlay: "newer-overlay", pending: null });

    await page.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(page).toHaveURL((url) => url.pathname === "/booking");
    await reachPayment(page);
    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
    expect(flow.startBodies().at(-1)?.bookingPayload?.salesAttribution?.lastTouch?.campaign).toBe("newer-overlay");
    expect(await cookieCampaign()).toBe("older-cookie");

    await holder.evaluate(() => window.__releaseAttrLock?.());
    await holder.close();
  });

  test("a session-storage read error keeps cookie attribution intact when payment start times out", async ({
    page, context, flow, productionHost,
  }) => {
    await page.goto("/about", { waitUntil: "domcontentloaded" });
    await acceptCookies(page);
    await page.goto("/packages?utm_campaign=before-booking", { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(page).toHaveURL((url) => url.pathname === "/booking");
    await reachPayment(page);

    const tabB = await context.newPage();
    await tabB.goto("/reviews?utm_campaign=newest-cookie", { waitUntil: "domcontentloaded" });
    await expect.poll(
      async () => {
        const c = (await context.cookies()).find((item) => item.name === "roo_attr_last");
        return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8"))?.lastTouch?.campaign : "";
      },
      { timeout: 20000 },
    ).toBe("newest-cookie");

    const hold = await holdChunk(page, productionHost, "first_campaign");
    let readFaults = 0;
    await page.exposeFunction("__recordSalesAttrReadFault", () => { readFaults += 1; });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await page.evaluate(() => {
      const orig = Storage.prototype.getItem;
      Storage.prototype.getItem = function patchedGetItem(k) {
        if (this === window.sessionStorage && k === "sales_attribution") {
          window.__recordSalesAttrReadFault?.();
          throw new DOMException("SecurityError", "SecurityError");
        }
        return orig.call(this, k);
      };
    });
    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
    expect(readFaults).toBeGreaterThan(0);
    expect(flow.startBodies().at(-1)?.bookingPayload?.salesAttribution?.lastTouch?.campaign).toBe("newest-cookie");
    hold.release();
    await tabB.close();
  });

  test("payment timeout fallback does not write session attribution while the cookie lock is held", async ({
    page, context, flow, productionHost,
  }) => {
    await page.goto("/packages", { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(page).toHaveURL((url) => url.pathname === "/booking");
    await reachPayment(page);

    const holder = await context.newPage();
    await holder.goto("/about", { waitUntil: "domcontentloaded" });
    await holder.evaluate(() => new Promise((ready) => {
      navigator.locks.request("roo_sales_attribution_cookie", () => new Promise((release) => {
        window.__releaseAttrLock = release;
        ready();
      }));
    }));

    const hold = await holdChunk(page, productionHost, "first_campaign");
    await page.goto("/payment?utm_source=timeout&utm_campaign=timeout-lock", { waitUntil: "domcontentloaded" });
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await page.evaluate(() => {
      sessionStorage.removeItem("sales_attribution");
      document.cookie = "roo_attr=; Path=/; Max-Age=0";
      document.cookie = "roo_attr_last=; Path=/; Max-Age=0";
    });

    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
    expect(flow.startBodies().at(-1)?.bookingPayload?.salesAttribution?.lastTouch?.campaign).toBe("timeout-lock");
    expect(await page.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();

    await holder.evaluate(() => window.__releaseAttrLock?.());
    hold.release();
    await holder.close();
  });

  for (const mode of ["loaded-on-click", "timeout"]) {
    test(`untagged checkout sends identical null attribution (${mode})`, async ({
      page, flow, productionHost,
    }) => {
      await page.goto("/packages", { waitUntil: "domcontentloaded" });
      await page.getByRole("link", { name: /Book Now/ }).first().click();
      await expect(page).toHaveURL((url) => url.pathname === "/booking");
      await reachPayment(page);

      const holdLoaded = await holdChunk(page, productionHost, "first_campaign");
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => holdLoaded.held, { timeout: 20000 }).toBe(true);
      await page.evaluate(() => {
        sessionStorage.removeItem("sales_attribution");
        sessionStorage.removeItem("roo_pending_arrival_touch");
      });
      let chunkResolved = false;
      if (mode === "loaded-on-click") {
        await page.exposeFunction("__releaseSalesChunkOnClick", () => {
          holdLoaded.release();
          chunkResolved = true;
        });
        await page.getByRole("button", { name: "Pay your way", exact: true }).evaluate((btn) => {
          btn.addEventListener("click", () => { queueMicrotask(() => window.__releaseSalesChunkOnClick()); }, { once: true });
        });
      }
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
      if (mode === "loaded-on-click") expect(chunkResolved).toBe(true);
      expect(flow.startBodies().at(-1)?.bookingPayload?.salesAttribution).toBeNull();
      holdLoaded.release();
    });
  }

  test("pageshow restore does not persist a booking mark whose outbox write failed", async ({
    page, productionHost,
  }) => {
    const postHog = await holdPostHog(page, productionHost);
    await page.goto("/about", { waitUntil: "domcontentloaded" });
    await acceptCookies(page);
    await page.goto("/packages", { waitUntil: "domcontentloaded" });
    await expect.poll(() => outbox(page)).toContain("service_visit");
    await page.evaluate(() => {
      sessionStorage.removeItem("roo-posthog-counted");
      window.__outboxRejected = 0;
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function patchedSetItem(k, v) {
        if (this === window.sessionStorage && k === "roo-posthog-outbox" && String(v).includes("service_visit")) {
          window.__outboxRejected += 1;
          throw new DOMException("QuotaExceededError", "QuotaExceededError");
        }
        return orig.call(this, k, v);
      };
    });
    await page.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(page).toHaveURL((url) => url.pathname === "/booking");
    await expect.poll(() => page.evaluate(() => window.__outboxRejected)).toBeGreaterThan(0);
    expect(await page.evaluate(() => sessionStorage.getItem("roo-posthog-counted"))).toBeNull();
    await page.evaluate(() => {
      const ev = new Event("pageshow");
      Object.defineProperty(ev, "persisted", { value: true });
      window.dispatchEvent(ev);
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
    expect(await page.evaluate(() => sessionStorage.getItem("roo-posthog-counted"))).toBeNull();
    postHog.release();
  });

  for (const releaseBeforeTimeout of [true, false]) {
    test(`chunk load and timeout both reuse a journey saved during the payment-start wait (${releaseBeforeTimeout ? "loaded" : "timeout"})`, async ({
      page, context, flow, productionHost,
    }) => {
      const decode = async (name) => {
        const c = (await context.cookies()).find((item) => item.name === name);
        return c ? JSON.parse(Buffer.from(c.value, "base64url").toString("utf8")) : null;
      };
      await page.goto("/about", { waitUntil: "domcontentloaded" });
      await acceptCookies(page);
      await page.goto("/packages", { waitUntil: "domcontentloaded" });
      await page.getByRole("link", { name: /Book Now/ }).first().click();
      await expect(page).toHaveURL((url) => url.pathname === "/booking");
      await reachPayment(page);
      await context.clearCookies();
      await page.evaluate(() => {
        const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "null");
        if (checkout) {
          delete checkout.salesAttribution;
          sessionStorage.setItem("checkout_booking_state", JSON.stringify(checkout));
        }
        sessionStorage.removeItem("sales_attribution");
        sessionStorage.removeItem("roo_pending_arrival_touch");
        delete window.__rooAttrOverlay;
      });
      const tabB = await context.newPage();
      const hold = await holdChunk(page, productionHost, "first_campaign");
      await page.addInitScript(() => {
        const orig = window.setTimeout;
        window.setTimeout = (fn, ms, ...args) => orig(fn, ms === 300 ? 4000 : ms, ...args);
      });
      await page.goto("/payment?utm_campaign=click-a", { waitUntil: "domcontentloaded" });
      await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
      await context.clearCookies();
      await page.evaluate(() => {
        sessionStorage.removeItem("sales_attribution");
        sessionStorage.removeItem("roo_pending_arrival_touch");
        delete window.__rooAttrOverlay;
      });
      const beforeStarts = flow.startBodies().length;
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await tabB.goto("/reviews?utm_campaign=peer-b", { waitUntil: "domcontentloaded" });
      await expect.poll(async () => (await decode("roo_attr_last"))?.lastTouch?.campaign, { timeout: 20000 }).toBe("peer-b");
      expect(flow.startBodies().length).toBe(beforeStarts);
      const peerJourney = (await decode("roo_attr_last"))?.journeyId;
      if (releaseBeforeTimeout) hold.release();
      await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
      const sent = flow.startBodies().at(-1)?.bookingPayload?.salesAttribution;
      hold.release();
      await tabB.close();
      expect(sent?.lastTouch?.campaign).toBe("click-a");
      expect(sent?.journeyId).toBe(peerJourney);
    });
  }

  for (const releaseBeforeTimeout of [true, false]) {
    test(`inverted cookie pair is rejected consistently across chunk load and timeout (${releaseBeforeTimeout ? "loaded" : "timeout"})`, async ({
      page, context, flow, productionHost, baseURL,
    }) => {
      const b64u = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
      const badId = "11111111-1111-4111-8111-111111111111";
      const goodId = "22222222-2222-4222-8222-222222222222";
      await page.goto("/about", { waitUntil: "domcontentloaded" });
      await acceptCookies(page);
      await page.goto("/packages", { waitUntil: "domcontentloaded" });
      await page.getByRole("link", { name: /Book Now/ }).first().click();
      await expect(page).toHaveURL((url) => url.pathname === "/booking");
      await reachPayment(page);
      await context.clearCookies();
      await page.evaluate(() => {
        const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "null");
        if (checkout) {
          delete checkout.salesAttribution;
          sessionStorage.setItem("checkout_booking_state", JSON.stringify(checkout));
        }
        sessionStorage.removeItem("sales_attribution");
        sessionStorage.removeItem("roo_pending_arrival_touch");
        delete window.__rooAttrOverlay;
      });
      const hold = await holdChunk(page, productionHost, "first_campaign");
      await page.addInitScript(() => {
        const orig = window.setTimeout;
        window.setTimeout = (fn, ms, ...args) => orig(fn, ms === 300 ? 1500 : ms, ...args);
      });
      await page.goto("/payment?utm_campaign=click-a", { waitUntil: "domcontentloaded" });
      await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
      await context.clearCookies();
      await page.evaluate(() => {
        sessionStorage.removeItem("sales_attribution");
        sessionStorage.removeItem("roo_pending_arrival_touch");
        delete window.__rooAttrOverlay;
      });
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await context.addCookies([
        {
          name: "roo_attr",
          value: b64u({
            version: 2,
            journeyId: badId,
            firstTouch: { capturedAt: "2026-11-02T00:00:00.000Z", landingPath: "/packages", campaign: "bad-first" },
            lastTouch: { capturedAt: "2026-11-02T00:00:00.000Z", landingPath: "/packages", campaign: "bad-first" },
          }),
          url: baseURL,
        },
        {
          name: "roo_attr_last",
          value: b64u({
            version: 2,
            journeyId: badId,
            lastTouch: { capturedAt: "2026-11-01T00:00:00.000Z", landingPath: "/packages", campaign: "bad-last" },
          }),
          url: baseURL,
        },
      ]);
      await page.evaluate((id) => {
        sessionStorage.setItem("sales_attribution", JSON.stringify({
          version: 2,
          journeyId: id,
          firstTouch: { capturedAt: "2026-11-03T00:00:00.000Z", landingPath: "/reviews", campaign: "good-tab" },
          lastTouch: { capturedAt: "2026-11-03T00:00:00.000Z", landingPath: "/reviews", campaign: "good-tab" },
        }));
      }, goodId);
      if (releaseBeforeTimeout) hold.release();
      await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
      const sent = flow.startBodies().at(-1)?.bookingPayload?.salesAttribution;
      hold.release();
      expect(sent?.lastTouch?.campaign).toBe("click-a");
      expect(sent?.journeyId).toBe(goodId);
    });
  }
});

const localTest = bookingTest.extend(posthogFixtures);

localTest("PostHog stays off on local hosts", async ({ page, flow, posthog: seen }) => {
  await page.goto("/packages");
  await acceptCookies(page);
  await seeDetails(page);
  await pastPostHogStart(page, seen);
  expect(seen.requests).toEqual([]);
  expect(await postHogCode(seen)).toEqual([]);
});

localTest("trailing slashes still redirect outside the PostHog proxy", async ({ request }) => {
  const redirects = [
    ["/about/", "/about"], ["/upgrade/max/", "/upgrade/max"], ["/tourney/bracket/", "/tourney/bracket"],
  ];
  for (const [from, to] of redirects) {
    const response = await request.get(from, { maxRedirects: 0 });
    expect(response.status(), from).toBe(308);
    expect(new URL(response.headers().location, "http://local").pathname, from).toBe(to);
  }
});
