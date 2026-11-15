const {
  test: bookingTest, expect, cookieBanner, acceptCookies, declineCookies, cookieSettingsReady, openCookieSettings,
  settleIdle, productionHostFixtures, openFreePayment,
} = require("./fixtures/booking-flow.cjs");
const { posthogFixtures, postHogCode, named, pageviews } = require("./fixtures/posthog.cjs");

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
const holdChunk = async (page, { origin, loopback }, ...markers) => {
  const hold = { held: false };
  const gate = new Promise((resolve) => { hold.release = resolve; });
  await page.route(`${origin}/_next/static/chunks/**`, async (route) => {
    const response = await route.fetch({ url: route.request().url().replace(origin, loopback) });
    const body = await response.body();
    if (!markers.some((marker) => body.includes(marker))) return route.fallback();
    hold.held = true;
    await gate;
    return route.fulfill({ response, body });
  });
  return hold;
};
const holdPostHog = (page, productionHost) => holdChunk(page, productionHost, "[PostHog.js]");
const holdOutbox = (page, productionHost) => holdChunk(page, productionHost, "roo-posthog-outbox");
const holdRequest = async (page, path, answer = (route) => route.fallback()) => {
  const hold = { held: false };
  const gate = new Promise((resolve) => { hold.release = resolve; });
  await page.context().route(`**${path}`, async (route) => {
    hold.held = true;
    await gate;
    return answer(route);
  }, { times: 1 });
  return hold;
};
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
  await other.goto("/about");
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

test.afterEach(({ page }) => page.unrouteAll({ behavior: "ignoreErrors" }));

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

    await page.goto("/packages");
    await expect.poll(() => named(seen, "checkout_started").length).toBe(1);
    const started = named(seen, "checkout_started")[0];
    expect(started.properties.$current_url).toBe(`${baseURL}${paymentPath}`);
    expect(sentAt(started)).toBeGreaterThanOrEqual(clickedAt);
    expect(sentAt(started)).toBeLessThanOrEqual(leftAt);
    await expect.poll(() => pageviews(seen).at(-1)).toBe(`${baseURL}/packages`);
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
    await page.goto("/packages");
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
    await other.goto("/about");
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
    await page.goto("/packages");
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

      await expect.poll(() => pageviews(seen)).toContain(`${baseURL}/about`);
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
      await page.goto(`${productionHost.loopback}/about`);
      const other = await context.newPage();
      await other.goto("/about");
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
      await expect.poll(() => pageviews(seen)).toContain(`${baseURL}/packages`);
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

  test("a creator code from the link is never stored, and the booking still reaches PostHog with it", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    test.setTimeout(180000);
    const hold = await holdPostHog(page, productionHost);
    await page.goto("/packages?ref=creatorref");
    await acceptCookies(page);
    await confirmBooking(page, baseURL, { receipt: { referralCode: "typedcode" } });
    await expect.poll(() => outbox(page)).toContain("booking_completed");
    expect(await storedOutbox(page)).not.toContain("creatorref");

    hold.release();
    await expect.poll(() => named(seen, "booking_completed").length).toBe(1);
    expect(named(seen, "booking_completed")[0].properties)
      .toMatchObject({ creator_code: "creatorref", referral_code: "typedcode", event_id: eventId });
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
    await page.goto("/packages");
    await acceptCookies(page);
    await openFreePayment(page, flow);
    await page.route("**/api/payment/start", (route) => route.fulfill({ json: freeBooking }));
    await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
    await expect.poll(() => outbox(page)).toContain("free_booking_completed");
    expect(new URL(page.url()).pathname).toBe("/payment");

    hold.release();
    await expect(page).toHaveURL((url) => url.pathname === "/thank-you");
    await expect.poll(() => named(seen, "free_booking_completed").length).toBe(1);
    await pastPostHogStart(page, seen);
    expect(named(seen, "free_booking_completed")).toHaveLength(1);
  });

  test("a service visit is stored the moment it begins and sent once, ahead of later page views", async ({
    page, posthog: seen, baseURL, productionHost,
  }) => {
    const hold = await holdChunk(page, productionHost, "first_campaign");
    await page.goto("/meet-the-team");
    await acceptCookies(page);
    await page.getByRole("link", { name: "Packages", exact: true }).first().click();
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await expect.poll(() => outbox(page)).toContain("service_visit");
    const visit = (await outboxEntries(page)).find(({ event }) => event === "service_visit");
    const visited = new URL(page.url()).pathname;

    await page.goto("/tourney");
    await expect.poll(async () => (await outboxEntries(page)).map(({ path }) => path)).toContain("/tourney");
    await page.goto(visited);
    hold.release();
    await expect.poll(() => named(seen, "service_visit").length).toBe(1);
    await expect.poll(() => pageviews(seen).at(-1)).toBe(`${baseURL}${visited}`);
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
    await page.goto("/meet-the-team");
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
    await expect.poll(() => pageviews(seen)).toContain(`${baseURL}/meet-the-team`);
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
    await other.goto("/about");
    await acceptCookies(other);
    await expect.poll(() => outbox(page)).toEqual(["$pageview"]);
    hold.release();

    await page.goto("/packages");
    await expect.poll(() => pageviews(seen)).toContain(`${baseURL}/packages`);
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
    await page.goto("/packages");
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
    await page.goto("/packages");
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await acceptCookies(page);
    await seeDetails(page);
    await page.goto("/about");
    hold.release();
    await page.goto("/packages");

    await expect.poll(() => named(seen, "view_item").length).toBe(1);
    await pastPostHogStart(page, seen);
    await settleIdle(page);
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

    await page.goto("/packages");
    await expect.poll(() => named(seen, "checkout_started").length).toBe(1);
    await expect.poll(() => pageviews(seen).at(-1)).toBe(`${baseURL}/packages`);
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
    await copy.goto("/packages");
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
    await page.goto("/admin/content");
    await settleIdle(page);
    expect(await outbox(page)).toEqual(["$pageview"]);

    const other = await context.newPage();
    await other.goto("/about");
    await openCookieSettings(other);
    await declineCookies(other);
    await expect.poll(() => outbox(page)).toBeNull();
    await other.close();
  });
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
