const {
  test: bookingTest, expect, cookieBanner, acceptCookies, declineCookies, settleIdle, productionHostFixtures,
} = require("./fixtures/booking-flow.cjs");
const { posthogFixtures, postHogCode, named, pageviews } = require("./fixtures/posthog.cjs");

const eventId = "a".repeat(40);
const desktopChrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const customer = ["visitor@example.invalid", "fixture_visitor", "Ryzen 7700", "RTX 4070"];

const test = bookingTest.extend({ ...productionHostFixtures, ...posthogFixtures });

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
const openCookieSettings = (page) => page.getByRole("button", { name: "Cookie settings", exact: true }).click();
const seeDetails = async (page) => {
  await page.getByRole("button", { name: "See What's Included" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
};
const browserNow = (page) => page.evaluate(() => Date.now());
const sentBetween = (seen, from, to) => [
  ...seen.events.filter((event) => Date.parse(event.timestamp) > from && Date.parse(event.timestamp) < to),
  ...seen.snapshots.filter((item) => item.timestamp > from && item.timestamp < to),
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
    await page.getByRole("button", { name: /^Earliest available:/ }).click();
    await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).last().click();
    await page.getByRole("textbox", { name: "Discord username", exact: true }).fill("fixture_visitor");
    await page.getByRole("textbox", { name: "Booking email", exact: true }).fill("visitor@example.invalid");
    await page.getByRole("textbox", { name: "PC specifications", exact: true }).fill("Ryzen 7700 / RTX 4070");
    await page.getByRole("textbox", { name: "Main game or application", exact: true }).fill("CS2");
    await page.getByRole("button", { name: "Review before payment", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Continue to payment", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
    await expect.poll(() => seen.snapshots.some((item) => item.type === 2)).toBe(true);
    await settleIdle(page);
    expect(named(seen, "checkout_started")).toEqual([]);

    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/__test/checkout-handoff`);
    await expect.poll(() => named(seen, "checkout_started").length).toBe(1);
    await page.goto("/payment?dodo_return=1", { waitUntil: "domcontentloaded" });
    await expect.poll(() => Boolean(finalizeRoute)).toBe(true);
    await finalizeRoute.fulfill({ json: {
      ok: true, status: "booked", provider: "dodo", bookingId: "fixture-posthog-booking",
      emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } },
      emailDispatchToken: "",
      analyticsReceipt: {
        eventId, packageTitle: "Performance Vertex Overhaul", paymentType: "paid",
        provider: "dodo", amount: 84.99, currency: "USD", referralCode: "", attribution: null,
      },
    } });
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
    expect(replay).toContain("rooindustries.com");
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
    await settleIdle(page);
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

  const holdPostHog = async (page, { origin, loopback }) => {
    const hold = { held: false };
    const gate = new Promise((resolve) => { hold.release = resolve; });
    await page.route(`${origin}/_next/static/chunks/**`, async (route) => {
      const response = await route.fetch({ url: route.request().url().replace(origin, loopback) });
      const body = await response.body();
      if (body.includes("[PostHog.js]")) {
        hold.held = true;
        await gate;
      }
      return route.fulfill({ response, body });
    });
    return hold;
  };

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
    await settleIdle(page);
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
    await page.mouse.move(400, 300);
    await page.mouse.move(600, 500);
    await expect.poll(() => seen.snapshots.some((item) => item.type === 2), { timeout: 20000 }).toBe(true);

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
    for (let step = 0; step < 5; step += 1) {
      await page.mouse.move(300 + step * 60, 400);
      await page.waitForTimeout(800);
    }
    await expect.poll(() => seen.snapshots.some((item) => item.timestamp > returned + 3000), { timeout: 20000 })
      .toBe(true);

    expect(JSON.stringify(seen.snapshots)).not.toContain("ref-login-identifier");
    expect(seen.snapshots.some((item) => item.type === 2 && item.timestamp >= finalBack)).toBe(true);
    expect(seen.events.filter((event) => !event.properties.$current_url.startsWith(`${baseURL}/packages`)))
      .toEqual([]);
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
      await settleIdle(page);
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
    await page.mouse.move(400, 300);
    await expect.poll(() => seen.snapshots.some((item) => item.type === 2), { timeout: 20000 }).toBe(true);

    await openCookieSettings(page);
    await declineCookies(page);
    await expect(cookieBanner(page)).toBeHidden();
    const declinedAt = await browserNow(page);
    await seeDetails(page);
    for (let step = 0; step < 4; step += 1) await page.mouse.move(300 + step * 80, 420);
    await settleIdle(page);

    const acceptedAt = await browserNow(page);
    await openCookieSettings(page);
    await acceptCookies(page);
    await seeDetails(page);
    await expect.poll(() => named(seen, "view_item").length).toBe(1);
    for (let step = 0; step < 4; step += 1) await page.mouse.move(320 + step * 80, 460);
    await expect.poll(() => seen.snapshots.some((item) => item.timestamp > acceptedAt), { timeout: 20000 })
      .toBe(true);
    expect(sentBetween(seen, declinedAt, acceptedAt)).toEqual([]);
    expect(Date.parse(named(seen, "view_item")[0].timestamp)).toBeGreaterThan(acceptedAt);
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
});

const localTest = bookingTest.extend(posthogFixtures);

localTest("PostHog stays off on local hosts", async ({ page, flow, posthog: seen }) => {
  await page.goto("/packages");
  await acceptCookies(page);
  await seeDetails(page);
  await settleIdle(page);
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
