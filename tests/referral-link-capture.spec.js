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

  const consent = page.getByRole("region", { name: "Cookie choice", exact: true });
  await consent.getByRole("button", { name: "Accept", exact: true }).click();
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
