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
const AD_COOKIES = ["roo_attr", "roo_attr_last"];
const adCookies = async (page) => (await page.context().cookies()).filter(({ name }) => AD_COOKIES.includes(name));
const decodeCookie = (cookie) => JSON.parse(Buffer.from(cookie.value, "base64url").toString("utf8"));
const cookieAttribution = async (page) => {
  const cookies = await adCookies(page);
  const [first, last] = AD_COOKIES.map((name) => cookies.find((cookie) => cookie.name === name));
  if (!first || !last) return null;
  const stored = decodeCookie(first);
  const { journeyId, lastTouch, ...rest } = decodeCookie(last);
  expect(stored.lastTouch).toBeUndefined();
  expect(rest).toEqual({});
  expect(journeyId).toBe(stored.journeyId);
  return { ...stored, lastTouch };
};
const encodeCookie = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
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
  expect(await adCookies(page)).toEqual([]);

  await cookieBanner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect.poll(() => cookieAttribution(page)).not.toBeNull();
  for (const cookie of await adCookies(page)) {
    expect(Math.abs(cookie.expires - (Date.now() / 1000 + 90 * 86400))).toBeLessThan(300);
    expect(cookie.sameSite).toBe("Lax");
    expect(cookie.path).toBe("/");
  }
  expect(await cookieAttribution(page)).toEqual(landing);
  expect(await page.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();

  await page.goto("/packages?utm_source=newsletter&utm_campaign=winter.deal");
  await expect.poll(async () => (await cookieAttribution(page)).lastTouch.source).toBe("newsletter");
  const relanded = await cookieAttribution(page);
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

const LABEL_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
const LABEL_FIELDS = ["source", "medium", "campaign", "content", "term"];
const inFives = (rows) => rows.reduce((groups, row, index) =>
  (index % 5 ? groups[groups.length - 1].push(row) : groups.push([row])) && groups, []);
const landLabels = async (page, labels, marker, read) => {
  const landing = Object.fromEntries(labels.map((text, index) => [LABEL_PARAMS[index], text]));
  await page.goto(`/?${new URLSearchParams({ ...landing, gclid: marker })}`);
  await expect.poll(async () => (await read(page))?.lastTouch.gclid).toBe(marker);
  const { lastTouch } = await read(page);
  return labels.map((_, index) => lastTouch[LABEL_FIELDS[index]] ?? null);
};
const checkoutAttribution = async (page, flow) => {
  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
  const [start] = flow.startBodies();
  return start.bookingPayload.salesAttribution;
};

const SCRIPTS = {
  "one-byte": "a", "two-byte": "ж", "three-byte": "夏", "four-byte": "𠀀",
  "combining mark": "q̃", "format character": "\u200D",
};
const codePoints = (unit, count) => Array.from(unit.repeat(count)).slice(0, count).join("");
const lengthRows = Object.entries(SCRIPTS).flatMap(([script, unit]) => [99, 100, 101].map((count) => ({
  name: `${script} ${count}`, text: codePoints(unit, count), kept: codePoints(unit, Math.min(count, 100)),
})));

test("labels keep up to 100 code points in every script, in both cookies and the checkout", async ({
  page, flow,
}) => {
  await page.goto("/reviews");
  await cookieBanner(page).getByRole("button", { name: "Accept", exact: true }).click();
  const results = [];
  for (const [index, rows] of inFives(lengthRows).entries()) {
    const stored = await landLabels(page, rows.map(({ text }) => text), `length-${index}`, cookieAttribution);
    results.push(...rows.map(({ name, kept }, row) => [name, stored[row] === kept]));
  }
  expect(results).toEqual(lengthRows.map(({ name }) => [name, true]));
  const stored = await cookieAttribution(page);
  expect(await checkoutAttribution(page, flow)).toEqual(stored);
});

const longestHost = `${"a".repeat(63)}.${"b".repeat(32)}.com`;
const longestLabel = (offset) => String.fromCodePoint(0x20000 + offset).repeat(100);
const longestLanding = (offset, creatorCode) => ({
  utm_source: longestLabel(offset), utm_medium: longestLabel(offset + 1), utm_campaign: longestLabel(offset + 2),
  utm_content: longestLabel(offset + 3), utm_term: longestLabel(offset + 4),
  fbclid: `IwAR${String(offset).repeat(196)}`.slice(0, 200), gclid: `Cj0K${String(offset).repeat(196)}`.slice(0, 200),
  ref: creatorCode,
});
const longestTouch = (landingPath, landing) => ({
  landingPath, referrerHost: longestHost, creatorCode: landing.ref, source: landing.utm_source,
  medium: landing.utm_medium, campaign: landing.utm_campaign, content: landing.utm_content, term: landing.utm_term,
  fbclid: landing.fbclid, gclid: landing.gclid,
});
const cookieLine = ({ name, value }) => `${name}=${value}; Path=/; Max-Age=7776000; SameSite=Lax; Secure`;

test("ten labels of 100 four-byte characters and the longest ids stay whole in both cookies and checkout", async ({
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
  await expect.poll(() => cookieAttribution(page)).not.toBeNull();
  await page.goto(`/packages?${new URLSearchParams(last)}`, { referer });
  await expect.poll(async () => (await cookieAttribution(page))?.lastTouch.source).toBe(last.utm_source);
  const stored = await cookieAttribution(page);
  const sizes = (await adCookies(page)).map((cookie) => Buffer.byteLength(cookieLine(cookie)));
  await test.info().attach("ad-cookie-sizes", { body: JSON.stringify(sizes), contentType: "application/json" });
  expect(sizes).toHaveLength(2);
  for (const size of sizes) expect(size).toBeLessThanOrEqual(3840);
  expect(withoutTime(stored.firstTouch)).toEqual(longestTouch("/", first));
  expect(withoutTime(stored.lastTouch)).toEqual(longestTouch("/packages", last));
  expect(await page.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();
  expect(await checkoutAttribution(page, flow)).toEqual(stored);
});

const KEEP = "keep";
const DROP = "drop";
const filterRows = [
  ["+919876543210", DROP], ["+44 7700 900123", DROP], ["+1 (212) 555-0199", DROP], ["+123456", KEEP], ["ad+1", KEEP],
  ["212 555 0199", DROP], ["212.555.0199", DROP], ["212-555-0199", DROP], ["(212) 555-0199", DROP],
  ["(212)5550199", DROP], ["call 212-555-0199 today", DROP], ["212-555-0199 212-555-0198", DROP],
  ["212-555-0199, 212-555-0198", DROP], ["2026-11-27 212-555-0199", DROP], ["212.555.0199 27.11.2026", DROP],
  ["212-555-0199 120210123456789012", DROP], ["120210123456789012 212 555 0199", DROP], ["123-456", KEEP],
  ["123-4567", DROP], ["12345-67890-12345", DROP], ["12345678-12345678", KEEP], ["2026-11-27", KEEP],
  ["2026.11.27", KEEP], ["2026/11/27", KEEP], ["2026 11 27", KEEP], ["27-11-2026", KEEP], ["27.11.2026", KEEP],
  ["11/27/2026", KEEP], ["27 11 2026", KEEP], ["bf-2026-11-27-v2", KEEP], ["sale 27.11.2026 final", KEEP],
  ["2026-11-27 to 2026-11-30", KEEP], ["launch 2026 11 27", KEEP], ["2026-13-45", DROP], ["1202101234", KEEP],
  ["120210123456789012", KEEP], ["brand_12345678901", KEEP], ["meta120210123456789012ad", KEEP],
  ["120210123456789012 2026-11-27", KEEP], ["spring-sale-2026", KEEP], ["promo 10-20-30", KEEP],
  ["top 10 2026", KEEP], ["q4 2026 v2", KEEP], ["٢١٢-٥٥٥-٠١٩٩", DROP], ["buyer@example.invalid", DROP],
  ["https://example.invalid/promo", DROP], ["www.example.invalid", DROP], ["example.invalid/reset/abc", DROP],
  ["l.facebook.com", KEEP], ["50% off, today!", KEEP],
  ["https://example.com", DROP], ["sale HTTP://EXAMPLE.COM now", DROP], ["open android-app://com.example", DROP],
  ["visit WWW.EXAMPLE.COM today", DROP], ["find us at www.example", DROP], ["//cdn.example.com", DROP],
  ["see //CDN.example.com/a now", DROP], ["assets //static.example", DROP], ["example.com?token=sample", DROP],
  ["a EXAMPLE.COM?x b", DROP], ["ref example.com?", DROP], ["example.com#top", DROP], ["x Example.Com#Top y", DROP],
  ["go example.com#", DROP], ["Example.com/Sale now", DROP], ["visit example.com/", DROP],
  ["example.com:8080", DROP], ["dev localhost.test:3000 build", DROP], ["staging EXAMPLE.COM:443", DROP],
  ["10.0.0.1/admin", DROP], ["server 192.168.1.1:8080 live", DROP], ["ip 127.0.0.1?x", DROP],
  ["1.2.3.4#a", DROP], ["google.com", KEEP], ["Meta.Ads", KEEP], ["newsletter.example.com", KEEP],
  ["google.com spring sale", KEEP], ["10.0.0.1", KEEP], ["v2.1", KEEP], ["release V2.1 beta", KEEP],
  ["1.5x", KEEP], ["boost 1.5x faster", KEEP], ["Spring sale.", KEEP], ["Big sale. Ends soon.", KEEP],
  ["first+tag@example.com", DROP], ["mail first.last@example.co.uk now", DROP], ["Contact US@EXAMPLE.COM", DROP],
  ["a\uFF20example.com", KEEP], ["@handle", KEEP], ["hi@there", KEEP], ["\uFF21\uFF22\uFF23", KEEP],
  ["cafe\u0301", KEEP],
  ["\uFB01nal \u2460", KEEP], ["MiXeD Case", KEEP], ["spring   sale  \u3000 2026", "spring sale 2026"],
  ["\uFF12\uFF10\uFF12\uFF16-\uFF11\uFF11-\uFF12\uFF17", KEEP],
  ["\u0662\u0660\u0662\u0666-\u0661\u0661-\u0662\u0667", KEEP],
  ["\u0662\u0667-\u0661\u0661-\u0662\u0660\u0662\u0666", KEEP],
  ["\uFF12\uFF10\uFF12\uFF16-\uFF11\uFF13-\uFF14\uFF15", DROP],
  ["v2.1/beta", KEEP], ["2.5/5", KEEP], ["ready for 2.0?", KEEP], ["1.5:1", KEEP], ["example.com/x", DROP],
  ["cdn.example.co.uk#a", DROP], ["deal@2.5", KEEP], ["x@10.0.0.1", DROP], ["example\uFF0Ecom/x", KEEP],
  ["example.com\uFF0Fx", KEEP], ["team \u{1F468}\u200D\u{1F469}\u200D\u{1F467} sale", KEEP],
  ["\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645", KEEP], ["spring\u00ADsale", KEEP],
  ["\u200Fsale\u200E", KEEP], ["\uFEFFsale\uFEFF", KEEP], ["spring\u0007sale", "springsale"],
  ["spring\u00A0sale", "spring sale"], ["spring\u3000\u3000sale", "spring sale"],
  ["buyer@example.com_campaign", DROP], ["list buyer@example.com.au-sale", DROP], ["promo//host.com", DROP],
  ["promo//10.0.0.1", DROP], ["promo//host", KEEP], ["summer//sale", KEEP], ["a//b.c", KEEP],
  ["promo//1.2.3.4.5", KEEP], ["ver 1.2.3.4.5#a", KEEP], ["x@1.2.3.4.5", KEEP], ["build 1.2.3.45/x", DROP],
  ["deal//shop.com5", KEEP], ["promo//cdn.example.com/a", DROP],
];

test("labels with an email, a URL or a formatted phone number are dropped and every other label is kept", async ({
  page, flow,
}) => {
  const results = [];
  for (const [index, rows] of inFives(filterRows).entries()) {
    const labels = rows.map(([text]) => text);
    const stored = await landLabels(page, labels, `filter-${index}`, storedAttribution);
    results.push(...labels.map((text, row) => [text, stored[row] === text ? KEEP : stored[row] ?? DROP]));
  }
  expect(results).toEqual(filterRows);
  const sent = await checkoutAttribution(page, flow);
  expect(sent).toEqual(await storedAttribution(page));
  const dropped = filterRows.filter(([, verdict]) => verdict === DROP).map(([text]) => text);
  for (const text of dropped) expect(JSON.stringify(sent)).not.toContain(text);
});

test("a missing or damaged attribution cookie is read without errors or invented touches", async ({
  page, context, baseURL,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const journeyId = "8f0c6a52-7d1e-4b3a-9c2d-1e5f6a7b8c9d";
  const first = { capturedAt: "2026-11-01T10:00:00.000Z", landingPath: "/", source: "meta", campaign: "spring" };
  const last = { capturedAt: "2026-11-05T10:00:00.000Z", landingPath: "/packages", source: "newsletter" };
  const firstCookie = encodeCookie({ version: 2, journeyId, firstTouch: first });
  const lastCookie = encodeCookie({ journeyId, lastTouch: last });
  await page.goto("/reviews");
  await cookieBanner(page).getByRole("button", { name: "Accept", exact: true }).click();
  const land = async (cookies) => {
    await context.clearCookies();
    await page.evaluate(() => sessionStorage.clear());
    await context.addCookies(Object.entries(cookies).map(([name, value]) => ({ name, value, url: baseURL })));
    await page.goto("/reviews");
    await settle(page);
    return cookieAttribution(page);
  };
  const kept = { version: 2, journeyId, firstTouch: first };
  expect(await land({ roo_attr: firstCookie, roo_attr_last: lastCookie })).toEqual({ ...kept, lastTouch: last });
  for (const damaged of [{ roo_attr_last: "damaged!" }, {}, { roo_attr_last: encodeCookie({ lastTouch: last }) }]) {
    expect(await land({ roo_attr: firstCookie, ...damaged })).toEqual({ ...kept, lastTouch: first });
  }
  for (const orphan of [{ roo_attr_last: lastCookie }, { roo_attr: "damaged!", roo_attr_last: lastCookie }]) {
    const fresh = await land(orphan);
    expect(fresh.journeyId).not.toBe(journeyId);
    expect(withoutTime(fresh.firstTouch)).toEqual({ landingPath: "/reviews" });
    expect(fresh.lastTouch).toEqual(fresh.firstTouch);
  }
  expect(errors).toEqual([]);
});
