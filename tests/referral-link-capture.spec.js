const { test, expect, cookieBanner, settleIdle } = require("./fixtures/booking-flow.cjs");

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

const firstLanding = {
  utm_source: "meta.ads", utm_medium: "paid social", utm_campaign: "spring sale", utm_content: "ad+1",
  utm_term: "2026", fbclid: "IwAR.fixture_1", gclid: "Cj0K.fixture-2", ref: "friend",
};
const firstTouch = {
  landingPath: "/", creatorCode: "friend", source: "meta.ads", medium: "paid social", campaign: "spring sale",
  content: "ad+1", term: "2026", fbclid: "IwAR.fixture_1", gclid: "Cj0K.fixture-2",
};
const secondTouch = { landingPath: "/packages", creatorCode: "friend", source: "newsletter", campaign: "winter.deal" };
const attributionCookie = async (page) => (await page.context().cookies()).find(({ name }) => name === "roo_attr");
const decodeCookie = (cookie) => JSON.parse(Buffer.from(cookie.value, "base64url").toString("utf8"));
const withoutTime = ({ capturedAt, ...touch }) => {
  expect(Number.isFinite(Date.parse(capturedAt))).toBe(true);
  return touch;
};

test("an ad landing keeps first and last touch through checkout, in a cookie only after consent", async ({
  page, flow,
}) => {
  await page.goto(`/?${new URLSearchParams(firstLanding)}`);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("sales_attribution"))).not.toBeNull();
  const landing = JSON.parse(await page.evaluate(() => sessionStorage.getItem("sales_attribution")));
  expect(landing.version).toBe(2);
  expect(withoutTime(landing.firstTouch)).toEqual(firstTouch);
  expect(withoutTime(landing.lastTouch)).toEqual(firstTouch);
  expect(await attributionCookie(page)).toBeUndefined();

  await cookieBanner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect.poll(() => attributionCookie(page)).toBeDefined();
  const cookie = await attributionCookie(page);
  expect(Math.abs(cookie.expires - (Date.now() / 1000 + 90 * 86400))).toBeLessThan(300);
  expect(cookie.sameSite).toBe("Lax");
  expect(cookie.path).toBe("/");
  expect(decodeCookie(cookie)).toEqual(landing);
  expect(await page.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();

  await page.goto("/packages?utm_source=newsletter&utm_campaign=winter.deal");
  await expect.poll(async () => decodeCookie(await attributionCookie(page)).lastTouch.source).toBe("newsletter");
  const relanded = decodeCookie(await attributionCookie(page));
  expect(relanded.journeyId).toBe(landing.journeyId);
  expect(relanded.firstTouch).toEqual(landing.firstTouch);
  expect(withoutTime(relanded.lastTouch)).toEqual(secondTouch);

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
  const [start] = flow.startBodies();
  expect(start.bookingPayload.salesAttribution).toEqual(relanded);
});

const storedAttribution = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution")));
const settle = async (page) => {
  await page.waitForLoadState("networkidle");
  await settleIdle(page);
};

test("a tagged landing that drops a campaign field starts a new last touch with only its own fields", async ({
  page,
}) => {
  await page.goto("/?utm_source=meta&utm_campaign=summer");
  await expect.poll(async () => (await storedAttribution(page))?.lastTouch.campaign).toBe("summer");
  const first = await storedAttribution(page);
  await page.goto("/packages?utm_source=meta");
  await expect.poll(async () => (await storedAttribution(page)).lastTouch.landingPath).toBe("/packages");
  const relanded = await storedAttribution(page);
  expect(relanded.journeyId).toBe(first.journeyId);
  expect(relanded.firstTouch).toEqual(first.firstTouch);
  expect(withoutTime(relanded.lastTouch)).toEqual({ landingPath: "/packages", source: "meta" });
  await page.goto("/reviews");
  await settle(page);
  expect(await storedAttribution(page)).toEqual(relanded);
});

test("attribution keeps only safe labels and skips pages outside the sales journey", async ({ page }) => {
  for (const path of ["/meet-the-team", "/tourney", "/downloads/utilities"]) {
    await page.goto(`${path}?utm_source=meta&email=private@example.invalid`);
    await settle(page);
    expect(await storedAttribution(page)).toBeNull();
  }
  const unsafe = new URLSearchParams({
    utm_source: "buyer@example.invalid", utm_campaign: "https://example.invalid/?token=secret",
    utm_content: "Alice Customer", fbclid: "bad id!", ref: "winton",
  });
  await page.goto(`/?${unsafe}`);
  await expect.poll(() => storedAttribution(page)).not.toBeNull();
  const landing = await storedAttribution(page);
  expect(withoutTime(landing.lastTouch))
    .toEqual({ landingPath: "/", creatorCode: "winton", content: "Alice Customer" });
  expect(JSON.stringify(landing)).not.toMatch(/example\.invalid|token|bad id/);
  await page.goto("/upgrade-xoc?ref=winton&utm_campaign=upgrade");
  await expect.poll(async () => (await storedAttribution(page)).lastTouch.landingPath).toBe("/upgrade");
  const upgrade = await storedAttribution(page);
  expect(upgrade.journeyId).toBe(landing.journeyId);
  expect(withoutTime(upgrade.lastTouch))
    .toEqual({ landingPath: "/upgrade", creatorCode: "winton", campaign: "upgrade" });
});

test("checkout still starts when the browser cannot make a journey id", async ({ page, flow }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, "randomUUID", {
      configurable: true, value: () => { throw new Error("Browser randomness unavailable"); },
    });
  });
  await page.goto("/?utm_source=meta");
  await settle(page);
  expect(await storedAttribution(page)).toBeNull();
  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
  const [start] = flow.startBodies();
  expect(start.bookingPayload.salesAttribution ?? null).toBeNull();
});

const longestHost = `${["a", "b", "c"].map((letter) => letter.repeat(63)).join(".")}.${"d".repeat(57)}.com`;
const fourByteLabel = (offset) => String.fromCodePoint(0x20000 + offset).repeat(25);
const longestLanding = (offset, creatorCode) => ({
  utm_source: fourByteLabel(offset), utm_medium: fourByteLabel(offset + 1), utm_campaign: fourByteLabel(offset + 2),
  utm_content: fourByteLabel(offset + 3), utm_term: fourByteLabel(offset + 4),
  fbclid: `IwAR${String(offset).repeat(196)}`.slice(0, 200), gclid: `Cj0K${String(offset).repeat(196)}`.slice(0, 200),
  ref: creatorCode,
});
const longestTouch = (landingPath, landing) => ({
  landingPath, referrerHost: longestHost, creatorCode: landing.ref, source: landing.utm_source,
  medium: landing.utm_medium, campaign: landing.utm_campaign, content: landing.utm_content, term: landing.utm_term,
  fbclid: landing.fbclid, gclid: landing.gclid,
});

test("the longest multi-byte values in every field keep both touches in the cookie and the checkout", async ({
  page, flow,
}) => {
  const firstCode = `f${"1".repeat(63)}`;
  const lastCode = `l${"2".repeat(63)}`;
  await page.route("**/api/ref/validateReferral*", (route) => {
    const code = new URL(route.request().url()).searchParams.get("code");
    const referral = { code, currentDiscountPercent: 0 };
    return route.fulfill({ json: { ok: true, active: true, eligible: true, referral } });
  });
  const first = longestLanding(1, firstCode);
  const last = longestLanding(6, lastCode);
  const referer = `http://${longestHost}/`;
  await page.goto(`/?${new URLSearchParams(first)}`, { referer });
  await cookieBanner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect.poll(() => attributionCookie(page)).toBeDefined();
  await page.goto(`/packages?${new URLSearchParams(last)}`, { referer });
  await expect.poll(async () => decodeCookie(await attributionCookie(page)).lastTouch.source).toBe(last.utm_source);
  const stored = decodeCookie(await attributionCookie(page));
  expect(withoutTime(stored.firstTouch)).toEqual(longestTouch("/", first));
  expect(withoutTime(stored.lastTouch)).toEqual(longestTouch("/packages", last));
  expect(await page.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
  const [start] = flow.startBodies();
  expect(start.bookingPayload.salesAttribution).toEqual(stored);
});

test("phone numbers in campaign fields are dropped and numeric ad ids are kept", async ({ page, flow }) => {
  const phones = {
    utm_source: "+44 7700 900123", utm_medium: "(555) 123-4567", utm_campaign: "+919876543210",
    utm_content: "555.123.4567", utm_term: "call +1 555 123 4567", fbclid: "555-123-4567", gclid: "Cj0K.fixture-2",
  };
  await page.goto(`/?${new URLSearchParams(phones)}`);
  await expect.poll(() => storedAttribution(page)).not.toBeNull();
  const phoneTouch = { landingPath: "/", gclid: "Cj0K.fixture-2" };
  expect(withoutTime((await storedAttribution(page)).lastTouch)).toEqual(phoneTouch);

  const ids = {
    utm_source: "meta", utm_campaign: "120210123456789012", utm_content: "23851234567890123", utm_term: "9876543210",
  };
  await page.goto(`/packages?${new URLSearchParams(ids)}`);
  await expect.poll(async () => (await storedAttribution(page)).lastTouch.landingPath).toBe("/packages");
  const idTouch = {
    landingPath: "/packages", source: "meta", campaign: "120210123456789012", content: "23851234567890123",
    term: "9876543210",
  };
  const landed = await storedAttribution(page);
  expect(withoutTime(landed.firstTouch)).toEqual(phoneTouch);
  expect(withoutTime(landed.lastTouch)).toEqual(idTouch);

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
  const [start] = flow.startBodies();
  expect(start.bookingPayload.salesAttribution).toEqual(landed);
  expect(JSON.stringify(start)).not.toMatch(/900123|123-4567|123\.4567|919876543210/);
});
