const fs = require("node:fs");
const path = require("node:path");
const { test, expect, cookieBanner, settleIdle } = require("./fixtures/booking-flow.cjs");
const { inspectChunks, holdChunks } = require("./fixtures/held-routes.cjs");

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
  const { ref, ...startWithoutRef } = start.bookingPayload.salesAttribution;
  expect(startWithoutRef).toEqual(relanded);
  expect(withoutTime(ref)).toEqual({ source: "friend" });
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
  const firstCode = `f${"a".repeat(57)}123456`;
  const lastCode = `l${"b".repeat(57)}654321`;
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
  const sent = await checkoutAttribution(page, flow);
  const { ref, ...sentWithoutRef } = sent;
  expect(sentWithoutRef).toEqual(stored);
  expect(withoutTime(ref)).toEqual({ source: firstCode });
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
  ...["\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\uFF0D", "\u2212"].flatMap((dash, index) => [
    [`ring 415${dash}555${dash}020${index}`, DROP], [`2025${dash}0${index + 1}${dash}1${index}`, KEEP],
  ]),
  ["\uFF10\uFF13\uFF0D\uFF11\uFF12\uFF13\uFF14\uFF0D\uFF15\uFF16\uFF17\uFF18", DROP],
  ["\uFF10\uFF13\uFF0E\uFF11\uFF12\uFF13\uFF14\uFF0E\uFF15\uFF16\uFF17\uFF18", KEEP],
  [`${"a".repeat(99)} b`, "a".repeat(99)], [`${" ".repeat(300)}spring`, "spring"],
  [`${"\u0001".repeat(400)}summer`, "summer"],
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

const readRefCookie = async (page) => {
  const cookie = (await page.context().cookies()).find(({ name }) => name === "roo_ref");
  return cookie ? { cookie, entry: JSON.parse(decodeURIComponent(cookie.value)) } : null;
};

test("inline head capture script is byte-identical to public/ref-capture.js with zero fetch calls and zero capture API traffic", async ({
  page, flow,
}) => {
  const scriptFile = fs.readFileSync(path.join(process.cwd(), "public/ref-capture.js"), "utf8");
  expect(scriptFile).not.toMatch(/\bfetch\s*\(/);

  const refCaptureRequests = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.includes("ref-capture")) refCaptureRequests.push(req.url());
  });

  for (const route of ["/?ref=gads-max", "/packages?ref=chatgpt-ads", "/reviews?ref=friend", "/BIOSGuide/index.html?ref=gads-max"]) {
    await page.goto("/robots.txt");
    await page.context().clearCookies();
    await page.evaluate(() => localStorage.removeItem("roo_ref"));
    await page.goto(route);
    const inlineScripts = await page.locator("head script").evaluateAll((nodes) => nodes.map((n) => n.textContent || ""));
    expect(inlineScripts).toContain(scriptFile);
    expect(await page.locator('head script[src*="ref-capture"]').count()).toBe(0);
    const stored = await readRefCookie(page);
    expect(stored?.entry?.source).toBe(new URLSearchParams(route.split("?")[1]).get("ref"));
    expect(await page.evaluate(() => {
      const raw = localStorage.getItem("roo_ref");
      return raw ? JSON.parse(decodeURIComponent(raw)) : null;
    })).toEqual(stored.entry);
    expect(await page.evaluate(() => localStorage.getItem("roo_ref"))).toBe(encodeURIComponent(JSON.stringify(stored.entry)));
    expect(stored.cookie.path).toBe("/");
    expect(stored.cookie.sameSite).toBe("Lax");
    expect(Math.abs(stored.cookie.expires - (Date.now() / 1000 + 30 * 86400))).toBeLessThan(300);
  }
  expect(refCaptureRequests).toEqual([]);
  const refCalls = flow.state.calls.filter((c) => c.path.includes("/api/ref/"));
  expect(refCalls).toEqual([]);

  await page.goto("/robots.txt");
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.removeItem("roo_ref"));
  await page.goto("/admin?ref=gads-max");
  expect(await readRefCookie(page)).toBeNull();
});

test("ad-only visit captures roo_ref synchronously without creatorCode or discount validation and reaches checkout", async ({
  page, flow,
}) => {
  await page.goto("/?ref=gads-max");
  const refData = await readRefCookie(page);
  expect(withoutTime(refData.entry)).toEqual({ source: "gads-max" });
  expect(await storedReferral(page)).toBeNull();
  await expect.poll(() => storedAttribution(page)).not.toBeNull();
  expect((await storedAttribution(page)).firstTouch.creatorCode).toBeUndefined();

  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
  expect(flow.state.calls.filter((c) => c.path.includes("validateReferral") || c.path.includes("validateCoupon"))).toEqual([]);
  const [start] = flow.startBodies();
  expect(start.bookingPayload.salesAttribution.ref).toEqual(refData.entry);
  expect(start.bookingPayload.salesAttribution.firstTouch.creatorCode).toBeUndefined();
});

test("non-sales routes capture roo_ref under both declined and accepted consent and creator link survives blocked analytics chunk", async ({
  page, flow, baseURL,
}) => {
  await page.goto("/meet-the-team?ref=gads-max");
  await cookieBanner(page).getByRole("button", { name: "Decline", exact: true }).click();
  expect((await readRefCookie(page))?.entry?.source).toBe("gads-max");
  expect(await storedAttribution(page)).toBeNull();

  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await page.goto("/tourney?ref=chatgpt-ads");
  await cookieBanner(page).getByRole("button", { name: "Accept", exact: true }).click();
  expect((await readRefCookie(page))?.entry?.source).toBe("chatgpt-ads");

  const isSalesAttrChunk = (body) => body.includes("roo_attr_last") && body.includes("sales_attribution");
  let blockedAttrChunks = 0;
  await page.goto("/robots.txt");
  await page.context().clearCookies();
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await inspectChunks(page, { origin: baseURL }, () => undefined, (route, response, body) => {
    if (isSalesAttrChunk(body)) {
      blockedAttrChunks += 1;
      return route.fulfill({ status: 404, body: "" });
    }
    return route.fulfill({ response, body });
  });
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => Boolean(window.history.state?.__rooLegacy))).toBe(true);
  expect(await readRefCookie(page)).toBeNull();
  await page.evaluate(() => {
    window.__sameDocMarker = 1;
    const state = { ...(window.history.state || {}), __rooLegacy: true };
    window.history.pushState(state, "", "/packages?ref=friend");
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });
  await expect(page).toHaveURL(/\/packages\?ref=friend/);
  await expect.poll(async () => (await readRefCookie(page))?.entry?.source).toBe("friend");
  expect(await page.evaluate(() => window.__sameDocMarker)).toBe(1);
  const refData = await readRefCookie(page);
  expect(refData?.entry?.source).toBe("friend");
  expect(blockedAttrChunks).toBeGreaterThan(0);
  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
  const [start] = flow.startBodies();
  expect(start.bookingPayload.salesAttribution.ref).toEqual(refData.entry);
});

test("reserved ad tags and malformed refs never override saved referral or fire validation across all restore stores", async ({
  page, context, flow, baseURL,
}) => {
  await page.goto("/?ref=friend");
  await expect.poll(() => storedReferral(page)).toBe("friend");
  await page.goto("/booking?ref=gads-max");
  expect(await storedReferral(page)).toBe("friend");
  await page.goto("/booking?ref=promo-2026-11-24");
  expect(await storedReferral(page)).toBe("friend");

  await page.evaluate(() => {
    sessionStorage.setItem("booking_draft", JSON.stringify({
      lastTitle: "Performance Vertex Overhaul",
      packages: {
        "Performance Vertex Overhaul": {
          selectedPackage: { title: "Performance Vertex Overhaul", price: "$84.99" },
          checkoutCodes: {
            referral: { code: "gads-max" },
            coupon: { code: "chatgpt-ads" },
            dismissedReferralCode: "gads-max",
          },
        },
      },
    }));
  });
  await flow.review("/booking?package=overhaul");
  await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
  expect(flow.state.calls.filter((c) => /gads-max|chatgpt-ads/i.test(c.query))).toEqual([]);

  const futureExpiry = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const checkoutState = {
    packageTitle: "Performance Vertex Overhaul", packagePrice: "$84.99",
    email: "visitor@example.invalid", discord: "fixture_visitor", specs: "pc", mainGame: "CS2",
    localTimeZone: "Asia/Kolkata", startTimeUTC: `${flow.state.slots[0].date}T04:30:00.000Z`,
    displayDate: flow.state.slots[0].date, displayTime: "10:00 AM",
    slotHoldId: "fixture-hold-1", slotHoldToken: "fixture-token-1", slotHoldExpiresAt: futureExpiry,
    referralCode: "gads-max", couponCode: "chatgpt-ads",
  };

  await page.evaluate((state) => {
    sessionStorage.clear();
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(state));
  }, checkoutState);
  await page.goto("/payment");
  await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
  await expect(page.locator("#payment-referral-code")).toHaveValue("");
  await expect(page.locator("#payment-coupon-code")).toHaveValue("");
  expect(flow.state.calls.filter((c) => /gads-max|chatgpt-ads/i.test(c.query))).toEqual([]);

  for (const tag of ["gads-max", "chatgpt-ads"]) {
    const tabHist = await context.newPage();
    await tabHist.goto(`${baseURL}/payment`);
    await tabHist.evaluate(({ state, reservedTag }) => {
      sessionStorage.clear();
      window.history.replaceState(
        { ...(window.history.state || {}), usr: { bookingData: { ...state, referralCode: reservedTag, couponCode: reservedTag } } },
        "",
        "/payment"
      );
    }, { state: checkoutState, reservedTag: tag });
    await tabHist.reload();
    await expect(tabHist.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
    await expect(tabHist.locator("#payment-referral-code")).toHaveValue("");
    await expect(tabHist.locator("#payment-coupon-code")).toHaveValue("");
    await tabHist.close();
  }
  expect(flow.state.calls.filter((c) => /gads-max|chatgpt-ads/i.test(c.query))).toEqual([]);

  await page.route("**/api/payment/status", (route) => route.fulfill({ json: { ok: true, status: "started" } }));
  await page.evaluate((state) => {
    sessionStorage.clear();
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(state));
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo",
      paymentAccessToken: "fixture-payment",
      providerPayload: { checkoutUrl: "/__test/checkout-handoff", orderId: "fixture-order-1" },
      fingerprint: JSON.stringify({
        packageTitle: state.packageTitle, originalOrderId: "", startTimeUTC: state.startTimeUTC,
        email: state.email, referralCode: "gads-max", couponCode: "chatgpt-ads",
      }),
      sessionExpiresAt: state.slotHoldExpiresAt,
      result: {
        ok: true,
        status: "started",
        quoteFingerprint: "pre-rollout-frozen-fp",
        quote: {
          grossAmount: 84.99, discountAmount: 17, discountPercent: 20, netAmount: 67.99, isFree: false,
          referralDiscountPercent: 20, referralDiscountAmount: 17, commissionPercent: 18,
          couponDiscountPercent: 0, couponDiscountAmount: 0, couponDiscountType: "", couponDiscountValue: 0,
          canCombineWithReferral: false,
        },
      },
    }));
  }, checkoutState);
  await page.goto("/payment?ref=gads-max");
  await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
  await expect(page.locator("#payment-referral-code")).toHaveValue("");
  await expect(page.locator("#payment-coupon-code")).toHaveValue("");
  await expect(page.getByText("$67.99 USD", { exact: true })).toBeVisible();
  await expect(page.getByText("$84.99 USD", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Change payment method", exact: true })).toBeVisible();
  expect(flow.state.calls.filter((c) => /gads-max|chatgpt-ads/i.test(c.query))).toEqual([]);
  await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
});

test("browser __rooReadRef enforces exact ISO-UTC boundaries, 3-store precedence, remaining Max-Age reconciliation, and two-tab first touch", async ({
  page, context, baseURL,
}) => {
  const fixedNow = Date.now();
  await page.addInitScript((nowMs) => {
    window.__nowMs = nowMs;
    Date.now = () => window.__nowMs;
    window.__cookieWrites = [];
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get() { return desc.get.call(this); },
      set(val) { window.__cookieWrites.push(String(val)); return desc.set.call(this, val); },
    });
  }, fixedNow);

  await page.goto("/");
  const check = await page.evaluate((nowMs) => {
    const DAY = 86400000;
    const setOnlyLS = (obj) => {
      document.cookie = "roo_ref=; Path=/; Max-Age=0; SameSite=Lax";
      localStorage.setItem("roo_ref", encodeURIComponent(JSON.stringify(obj)));
    };
    setOnlyLS({ source: "gads-max", capturedAt: new Date(nowMs - (30 * DAY - 1)).toISOString() });
    const valid30 = window.__rooReadRef();
    window.__nowMs = nowMs + 1;
    const exp30 = window.__rooReadRef();
    window.__nowMs = nowMs;
    setOnlyLS({ source: "gads-max", capturedAt: new Date(nowMs + 3600000).toISOString() });
    const validFuture = window.__rooReadRef();
    window.__nowMs = nowMs - 1;
    const expFuture = window.__rooReadRef();
    window.__nowMs = nowMs;
    setOnlyLS({ source: "gads-max", capturedAt: "2026-02-30T12:00:00.000Z" });
    const rollover = window.__rooReadRef();

    window.__cookieWrites = [];
    setOnlyLS({ source: "gads-max", capturedAt: new Date(nowMs - 29 * DAY).toISOString() });
    const reconciled = window.__rooReadRef();
    const writes = [...window.__cookieWrites];
    return { valid30, exp30, validFuture, expFuture, rollover, reconciled, writes };
  }, fixedNow);

  expect(check.valid30?.source).toBe("gads-max");
  expect(check.exp30).toBeNull();
  expect(check.validFuture?.source).toBe("gads-max");
  expect(check.expFuture).toBeNull();
  expect(check.rollover).toBeNull();
  expect(check.reconciled?.source).toBe("gads-max");
  const recWrite = check.writes.find((w) => w.startsWith("roo_ref=") && !w.includes("Max-Age=0"));
  const maxAge = Number(recWrite.match(/Max-Age=(\d+)/)?.[1]);
  expect(maxAge).toBeGreaterThanOrEqual(86300);
  expect(maxAge).toBeLessThanOrEqual(86400);

  await page.goto("/robots.txt");
  const tiePage = await context.newPage();
  const tieTs = new Date(Date.now() - 5000).toISOString();
  await tiePage.goto(`${baseURL}/robots.txt`);
  await context.clearCookies();
  await tiePage.evaluate((ts) => {
    localStorage.setItem("roo_ref", encodeURIComponent(JSON.stringify({ source: "chatgpt-ads", capturedAt: ts })));
    document.cookie = `roo_ref=${encodeURIComponent(JSON.stringify({ source: "gads-max", capturedAt: ts }))}; Path=/; Max-Age=1000; SameSite=Lax`;
  }, tieTs);
  await tiePage.goto(`${baseURL}/`);
  const tieCheck = await tiePage.evaluate((ts) => {
    const cookieOverStorageWinner = window.__rooReadRef();
    document.cookie = "roo_ref=; Path=/; Max-Age=0; SameSite=Lax";
    localStorage.setItem("roo_ref", encodeURIComponent(JSON.stringify({ source: "chatgpt-ads", capturedAt: ts })));
    const storageOverMemoryWinner = window.__rooReadRef();
    localStorage.removeItem("roo_ref");
    document.cookie = `roo_ref=${encodeURIComponent(JSON.stringify({ source: "gads-max", capturedAt: ts }))}; Path=/; Max-Age=1000; SameSite=Lax`;
    const cookieOverMemoryWinner = window.__rooReadRef();
    return { cookieOverStorageWinner, storageOverMemoryWinner, cookieOverMemoryWinner };
  }, tieTs);
  expect(tieCheck.cookieOverStorageWinner).toEqual({ source: "gads-max", capturedAt: tieTs });
  expect(tieCheck.storageOverMemoryWinner).toEqual({ source: "chatgpt-ads", capturedAt: tieTs });
  expect(tieCheck.cookieOverMemoryWinner).toEqual({ source: "gads-max", capturedAt: tieTs });
  await tiePage.close();

  await page.goto("/robots.txt");
  await context.clearCookies();
  await page.evaluate(() => localStorage.removeItem("roo_ref"));
  const tab1 = await context.newPage();
  await tab1.goto(`${baseURL}/?ref=friend`);
  const tab2 = await context.newPage();
  await tab2.goto(`${baseURL}/packages?ref=chatgpt-ads`);
  expect(await tab2.evaluate(() => window.__rooReadRef()?.source)).toBe("friend");
  await tab1.close();
  await tab2.close();
});

test("paymentStartBody produces identical snapshot-vs-live ref ranking across loaded, 404, and timed-out chunk", async ({
  page, flow, baseURL,
}) => {
  const runMode = async (mode, liveTs, snapTs) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await flow.restoreRoutes();
    const isSalesAttrChunk = (body) => body.includes("roo_attr_last") && body.includes("sales_attribution");
    let held = null;
    if (mode === "404") {
      await inspectChunks(page, { origin: baseURL }, () => undefined, (route, response, body) =>
        isSalesAttrChunk(body) ? route.fulfill({ status: 404, body: "" }) : route.fulfill({ response, body }));
    } else if (mode === "timeout") {
      held = await holdChunks(page, { origin: baseURL }, isSalesAttrChunk);
    }
    const checkoutState = {
      packageTitle: "Performance Vertex Overhaul", packagePrice: "$84.99",
      email: "visitor@example.invalid", discord: "fixture_visitor", specs: "pc", mainGame: "CS2",
      localTimeZone: "Asia/Kolkata", startTimeUTC: `${flow.state.slots[0].date}T04:30:00.000Z`,
      displayDate: flow.state.slots[0].date, displayTime: "10:00 AM",
      slotHoldId: `fixture-hold-${mode}`, slotHoldToken: "fixture-token-1",
      slotHoldExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      salesAttribution: { ref: { source: "chatgpt-ads", capturedAt: snapTs } },
    };
    await page.goto("/robots.txt");
    await page.evaluate(({ state, ts }) => {
      sessionStorage.clear();
      const live = { source: "gads-max", capturedAt: ts };
      document.cookie = `roo_ref=${encodeURIComponent(JSON.stringify(live))}; Path=/; Max-Age=2592000; SameSite=Lax`;
      localStorage.setItem("roo_ref", encodeURIComponent(JSON.stringify(live)));
      sessionStorage.setItem("checkout_booking_state", JSON.stringify(state));
    }, { state: checkoutState, ts: liveTs });
    flow.state.calls.length = 0;
    await page.goto("/payment", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
    if (held) held.release();
    return flow.startBodies()[0].bookingPayload.salesAttribution.ref;
  };

  const tOld = new Date(Date.now() - 20_000).toISOString();
  const tNew = new Date(Date.now() - 10_000).toISOString();
  for (const [liveTs, snapTs, expectedSource] of [
    [tOld, tNew, "gads-max"],
    [tOld, tOld, "gads-max"],
    [tNew, tOld, "chatgpt-ads"],
  ]) {
    const loaded = await runMode("loaded", liveTs, snapTs);
    const missing = await runMode("404", liveTs, snapTs);
    const slow = await runMode("timeout", liveTs, snapTs);
    expect(loaded.source).toBe(expectedSource);
    expect(missing).toEqual(loaded);
    expect(slow).toEqual(loaded);
  }
});

test("legacy promo-2026-11-24 is rejected on links, migrates from pre-PR stores, and survives manual edits on /payment", async ({
  page, context, flow, baseURL,
}) => {
  await context.route("**/api/ref/validateReferral*", (route) => {
    const code = (new URL(route.request().url()).searchParams.get("code") || "").toLowerCase();
    if (code === "promo-2026-11-24" || code === "friend") {
      return route.fulfill({ json: { ok: true, active: true, eligible: true, referral: { code, currentDiscountPercent: 10 } } });
    }
    return route.fallback();
  });
  await context.route("**/api/payment/quote", (route) => {
    const body = route.request().postDataJSON() || {};
    if (String(body.referralCode || "").toLowerCase() === "promo-2026-11-24") {
      return route.fulfill({
        json: {
          ok: true,
          quoteFingerprint: "fixture-quote-legacy",
          providers: { dodo: { enabled: true, mode: "test" }, razorpay: { enabled: false, mode: "disabled" }, paypal: { enabled: false, mode: "disabled" } },
          quote: {
            grossAmount: 84.99, netAmount: 76.49, isFree: false,
            couponDiscountAmount: 0, referralDiscountAmount: 8.5, referralDiscountPercent: 10,
          },
        },
      });
    }
    return route.fallback();
  });

  await page.goto("/?ref=promo-2026-11-24");
  expect(await storedReferral(page)).toBeNull();
  expect(await readRefCookie(page)).toBeNull();

  await page.evaluate(() => sessionStorage.setItem("referral_session", "promo-2026-11-24"));
  await flow.review("/booking?package=overhaul");
  await expect(page.getByRole("button", { name: /Remove referral code/ })).toHaveCount(0);

  flow.state.holds.clear();
  const tabLocal = await context.newPage();
  await tabLocal.goto(`${baseURL}/reviews`);
  await tabLocal.evaluate(() => {
    sessionStorage.clear();
    localStorage.setItem("booking_draft", JSON.stringify({
      lastTitle: "Performance Vertex Overhaul",
      packages: {
        "Performance Vertex Overhaul": {
          selectedPackage: { title: "Performance Vertex Overhaul", price: "$84.99" },
          checkoutCodes: { referral: { code: "promo-2026-11-24" } },
        },
      },
    }));
  });
  await tabLocal.goto(`${baseURL}/booking?package=overhaul`);
  await tabLocal.getByRole("button", { name: /^Earliest available:/ }).click();
  await tabLocal.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await tabLocal.getByRole("button", { name: "Next", exact: true }).last().click();
  await tabLocal.getByRole("textbox", { name: "Discord username", exact: true }).fill("fixture_visitor");
  await tabLocal.getByRole("textbox", { name: "Booking email", exact: true }).fill("visitor@example.invalid");
  await tabLocal.getByRole("textbox", { name: "PC specifications", exact: true }).fill("Ryzen 7700 / RTX 4070");
  await tabLocal.getByRole("textbox", { name: "Main game or application", exact: true }).fill("CS2");
  await tabLocal.getByRole("button", { name: "Review before payment", exact: true }).click();
  await expect(tabLocal.getByRole("button", { name: "Remove referral code promo-2026-11-24", exact: true })).toBeVisible();
  expect(await tabLocal.evaluate(() => localStorage.getItem("booking_draft"))).toBeNull();
  await tabLocal.close();

  const futureExpiry = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const baseCheckout = {
    packageTitle: "Performance Vertex Overhaul", packagePrice: "$84.99",
    email: "visitor@example.invalid", discord: "fixture_visitor", specs: "pc", mainGame: "CS2",
    localTimeZone: "Asia/Kolkata", startTimeUTC: `${flow.state.slots[0].date}T04:30:00.000Z`,
    displayDate: flow.state.slots[0].date, displayTime: "10:00 AM",
    slotHoldId: "fixture-hold-legacy", slotHoldToken: "fixture-token-legacy", slotHoldExpiresAt: futureExpiry,
  };
  const tabHistory = await context.newPage();
  await tabHistory.goto(`${baseURL}/payment`);
  await tabHistory.evaluate((state) => {
    sessionStorage.clear();
    window.history.replaceState({ ...(window.history.state || {}), usr: { bookingData: { ...state, referralCode: "promo-2026-11-24" } } }, "", "/payment");
  }, baseCheckout);
  await tabHistory.reload();
  await expect(tabHistory.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
  await expect(tabHistory.locator("#payment-referral-code")).toHaveValue("promo-2026-11-24");
  await tabHistory.close();

  await page.evaluate((state) => {
    sessionStorage.clear();
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(state));
  }, baseCheckout);
  await page.goto("/payment?ref=friend");
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await page.locator("#payment-referral-code").fill("promo-2026-11-24");
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL(/\/payment$/);
  await page.reload();
  await expect(page.locator("#payment-referral-code")).toHaveValue("promo-2026-11-24");
  await expect(page.getByText("$76.49")).toBeVisible();

  await page.goto("/payment?ref=friend");
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  await page.locator("#payment-referral-code").fill("");
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL(/\/payment$/);
  await page.reload();
  await expect(page.locator("#payment-referral-code")).toHaveValue("");
  await expect(page.getByText("$84.99").first()).toBeVisible();
  await expect(page.getByText("$76.49")).toHaveCount(0);
});

test("applying a referral after changing payment method keeps the refreshed hold token across reload", async ({
  page, flow,
}) => {
  const futureExpiry = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const slotTime = `${flow.state.slots[0].date}T04:30:00.000Z`;
  const checkoutState = {
    packageTitle: "Performance Vertex Overhaul", packagePrice: "$84.99",
    email: "visitor@example.invalid", discord: "fixture_visitor", specs: "pc", mainGame: "CS2",
    localTimeZone: "Asia/Kolkata", startTimeUTC: slotTime,
    displayDate: flow.state.slots[0].date, displayTime: "10:00 AM",
    slotHoldId: "hold-ui-1", slotHoldToken: "hold-token-ui", slotHoldExpiresAt: futureExpiry,
  };
  await page.route("**/api/payment/cancel", (route) =>
    route.fulfill({
      json: {
        ok: true,
        cancelled: true,
        refreshedHold: {
          slotHoldId: "hold-ui-1",
          slotHoldToken: "hold-refreshed-token",
          slotHoldExpiresAt: futureExpiry,
        },
      },
    }));
  await page.goto("/robots.txt");
  await page.evaluate(({ state, expiry }) => {
    sessionStorage.clear();
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(state));
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo",
      paymentAccessToken: "dodo-active-token",
      providerPayload: { orderId: "cks_active", checkoutUrl: "https://checkout.dodopayments.com/session/cks_active" },
      sessionExpiresAt: expiry,
      fingerprint: JSON.stringify({
        packageTitle: state.packageTitle, originalOrderId: "", startTimeUTC: state.startTimeUTC,
        email: state.email, referralCode: "", couponCode: "",
      }),
    }));
  }, { state: checkoutState, expiry: futureExpiry });

  await page.goto("/payment");
  await expect(page.getByRole("button", { name: "Change payment method", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await expect(page.getByText("Payment method released. Choose a payment method below.")).toBeVisible();

  await page.locator("#payment-referral-code").fill("friend");
  await page.locator("#payment-referral-code").locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("$76.49")).toBeVisible();

  const beforeReload = await page.evaluate(() => ({
    storedToken: JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}").slotHoldToken,
    historyToken: window.history?.state?.usr?.bookingData?.slotHoldToken,
  }));
  expect(beforeReload).toEqual({
    storedToken: "hold-refreshed-token",
    historyToken: "hold-refreshed-token",
  });

  await page.reload();
  await expect(page.locator("#payment-referral-code")).toHaveValue("friend");
  const afterReload = await page.evaluate(() => ({
    storedToken: JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}").slotHoldToken,
    historyToken: window.history?.state?.usr?.bookingData?.slotHoldToken,
  }));
  expect(afterReload).toEqual({
    storedToken: "hold-refreshed-token",
    historyToken: "hold-refreshed-token",
  });

  flow.state.calls.length = 0;
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
  expect(flow.startBodies()[0].bookingPayload.slotHoldToken).toBe("hold-refreshed-token");
});

test("in-flight referral validation finishing after Razorpay release keeps the rotated hold token across reload", async ({
  page, flow,
}) => {
  const providers = {
    dodo: { enabled: true, mode: "test" },
    razorpay: { enabled: true, mode: "test" },
    paypal: { enabled: false, mode: "disabled" },
  };
  await page.route("https://checkout.razorpay.com/v1/checkout.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `window.Razorpay = class {
      constructor(options) { this.options = options; }
      on() {}
      open() {
        const button = document.createElement("button");
        button.textContent = "Close Razorpay checkout";
        button.style = "position:fixed;right:0;top:0;z-index:2147483647;background:white;color:black";
        button.onclick = () => { button.remove(); this.options.modal.ondismiss(); };
        document.body.append(button);
      }
    }`,
  }));
  await page.route("**/api/payment/providers", (route) => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", (route) => {
    const referral = route.request().postDataJSON()?.referralCode === "friend";
    return route.fulfill({
      json: {
        ok: true,
        quoteFingerprint: "fixture-quote",
        providers,
        quote: {
          grossAmount: 84.99,
          netAmount: referral ? 76.49 : 84.99,
          isFree: false,
          couponDiscountAmount: 0,
          referralDiscountAmount: referral ? 8.5 : 0,
          referralDiscountPercent: referral ? 10 : 0,
        },
      },
    });
  });
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  const submittedTokens = [];
  await page.route("**/api/payment/start", (route) => {
    const body = route.request().postDataJSON();
    const payload = body.bookingPayload;
    holdId = payload.slotHoldId;
    if (body.provider !== "razorpay") {
      submittedTokens.push(payload.slotHoldToken);
      return route.fulfill({
        status: payload.slotHoldToken === "cancel-hold-token" ? 200 : 403,
        json: payload.slotHoldToken === "cancel-hold-token"
          ? { ok: true, status: "started", checkoutCreated: true, paymentAccessToken: "dodo-next", sessionExpiresAt: expiry, providerPayload: { orderId: "cks_next", checkoutUrl: "/__test/checkout-handoff" } }
          : { ok: false, error: `Submitted hold token: ${payload.slotHoldToken}` },
      });
    }
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        checkoutCreated: true,
        paymentAccessToken: "razorpay-fixture-token",
        sessionExpiresAt: expiry,
        quoteFingerprint: "fixture-quote",
        providerPayload: { orderId: "order_fixture", key: "rzp_test_fixture", amount: 8499, currency: "USD" },
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "start-hold-token", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  await page.route("**/api/payment/cancel", (route) => route.fulfill({
    json: {
      ok: true,
      cancelled: true,
      refreshedHold: { slotHoldId: holdId, slotHoldToken: "cancel-hold-token", slotHoldExpiresAt: expiry, phase: "holding" },
    },
  }));

  await flow.review();
  await flow.payment();
  const referralInput = page.locator("#payment-referral-code");
  let allowReply;
  const replyGate = new Promise((resolve) => { allowReply = resolve; });
  await page.route("**/api/ref/validateReferral?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("code") !== "friend") return route.fallback();
    await replyGate;
    return route.fallback();
  });
  await referralInput.fill("friend");
  await referralInput.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(referralInput.locator("..").getByRole("button", { name: "Checking..." })).toBeVisible();

  await page.getByRole("button", { name: "Pay with Razorpay", exact: true }).click();
  await page.getByRole("button", { name: "Close Razorpay checkout", exact: true }).click();
  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await expect(page.getByText("Payment method released. Choose a payment method below.")).toBeVisible();

  allowReply();
  await expect(page.getByText("$76.49")).toBeVisible();
  const afterApply = await page.evaluate(() => ({
    storage: JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}").slotHoldToken,
    history: window.history?.state?.usr?.bookingData?.slotHoldToken,
    referralCode: window.history?.state?.usr?.bookingData?.referralCode,
  }));
  expect(afterApply).toEqual({
    storage: "cancel-hold-token",
    history: "cancel-hold-token",
    referralCode: "friend",
  });

  await page.reload();
  await expect(referralInput).toHaveValue("friend");
  const afterReload = await page.evaluate(() => ({
    storage: JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}").slotHoldToken,
    history: window.history?.state?.usr?.bookingData?.slotHoldToken,
  }));
  expect(afterReload).toEqual({
    storage: "cancel-hold-token",
    history: "cancel-hold-token",
  });

  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
  expect(submittedTokens).toEqual(["cancel-hold-token"]);
});

test("in-flight referral replying while Razorpay release is pending does not discard the rotated hold token or lock Pay your way", async ({
  page, flow,
}) => {
  const providers = {
    dodo: { enabled: true, mode: "test" },
    razorpay: { enabled: true, mode: "test" },
    paypal: { enabled: false, mode: "disabled" },
  };
  await page.route("https://checkout.razorpay.com/v1/checkout.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `window.Razorpay = class {
      constructor(options) { this.options = options; }
      on() {}
      open() {
        const button = document.createElement("button");
        button.textContent = "Close Razorpay checkout";
        button.style = "position:fixed;right:0;top:0;z-index:2147483647;background:white;color:black";
        button.onclick = () => { button.remove(); this.options.modal.ondismiss(); };
        document.body.append(button);
      }
    }`,
  }));
  await page.route("**/api/payment/providers", (route) => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", (route) => {
    const referral = route.request().postDataJSON()?.referralCode === "friend";
    return route.fulfill({
      json: {
        ok: true,
        quoteFingerprint: "fixture-quote",
        providers,
        quote: {
          grossAmount: 84.99,
          netAmount: referral ? 76.49 : 84.99,
          isFree: false,
          couponDiscountAmount: 0,
          referralDiscountAmount: referral ? 8.5 : 0,
          referralDiscountPercent: referral ? 10 : 0,
        },
      },
    });
  });
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  const submittedTokens = [];
  await page.route("**/api/payment/start", (route) => {
    const body = route.request().postDataJSON();
    const payload = body.bookingPayload;
    holdId = payload.slotHoldId;
    if (body.provider !== "razorpay") {
      submittedTokens.push(payload.slotHoldToken);
      return route.fulfill({
        status: payload.slotHoldToken === "cancel-hold-token" ? 200 : 403,
        json: payload.slotHoldToken === "cancel-hold-token"
          ? { ok: true, status: "started", checkoutCreated: true, paymentAccessToken: "dodo-next", sessionExpiresAt: expiry, providerPayload: { orderId: "cks_next", checkoutUrl: "/__test/checkout-handoff" } }
          : { ok: false, error: "This slot reservation is not valid for your session." },
      });
    }
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        checkoutCreated: true,
        paymentAccessToken: "razorpay-fixture-token",
        sessionExpiresAt: expiry,
        quoteFingerprint: "fixture-quote",
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false },
        providerPayload: { orderId: "order_fixture", key: "rzp_test_fixture", amount: 8499, currency: "USD" },
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "start-hold-token", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  let completeCancel;
  const cancelGate = new Promise((resolve) => { completeCancel = resolve; });
  await page.route("**/api/payment/cancel", async (route) => {
    await cancelGate;
    return route.fulfill({
      json: {
        ok: true,
        status: "abandoned",
        cancelled: true,
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "cancel-hold-token", slotHoldExpiresAt: expiry, phase: "holding" },
      },
    });
  });

  await flow.review();
  await flow.payment();
  const referralInput = page.locator("#payment-referral-code");
  let allowReply;
  const replyGate = new Promise((resolve) => { allowReply = resolve; });
  await page.route("**/api/ref/validateReferral?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("code") !== "friend") return route.fallback();
    await replyGate;
    return route.fallback();
  });
  await referralInput.fill("friend");
  await referralInput.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(referralInput.locator("..").getByRole("button", { name: "Checking..." })).toBeVisible();

  await page.getByRole("button", { name: "Pay with Razorpay", exact: true }).click();
  await page.getByRole("button", { name: "Close Razorpay checkout", exact: true }).click();
  const pendingCancel = page.waitForRequest((req) => req.url().endsWith("/api/payment/cancel"));
  const responseCancel = page.waitForResponse((res) => res.url().endsWith("/api/payment/cancel"));
  await page.getByRole("button", { name: "Change payment method", exact: true }).click();
  await pendingCancel;

  allowReply();
  await expect(referralInput.locator("..").getByRole("button", { name: "Checking..." })).toHaveCount(0);
  const whilePending = await page.evaluate(() => ({
    storage: JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}").slotHoldToken,
    history: window.history?.state?.usr?.bookingData?.slotHoldToken,
    referralCode: window.history?.state?.usr?.bookingData?.referralCode || "",
  }));
  expect(whilePending).toEqual({
    storage: "start-hold-token",
    history: "start-hold-token",
    referralCode: "",
  });

  completeCancel();
  expect((await responseCancel).status()).toBe(200);
  const pay = page.getByRole("button", { name: "Pay your way", exact: true });
  await expect(pay).toBeEnabled();

  await page.reload();
  await expect(pay).toBeEnabled();
  const afterReload = await page.evaluate(() => ({
    storage: JSON.parse(sessionStorage.getItem("checkout_booking_state") || "{}").slotHoldToken,
    history: window.history?.state?.usr?.bookingData?.slotHoldToken,
    provider: JSON.parse(sessionStorage.getItem("payment_session_state") || "{}").provider || "",
  }));
  expect(afterReload).toEqual({
    storage: "cancel-hold-token",
    history: "cancel-hold-token",
    provider: "",
  });

  await pay.click();
  await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
  expect(submittedTokens).toEqual(["cancel-hold-token"]);
});

test("saved creator discount survives reloading a locked Razorpay checkout and releasing the payment method", async ({
  page, flow,
}) => {
  const providers = {
    dodo: { enabled: true, mode: "test" },
    razorpay: { enabled: true, mode: "test" },
    paypal: { enabled: false, mode: "disabled" },
  };
  await page.route("https://checkout.razorpay.com/v1/checkout.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `window.Razorpay = class {
      constructor(options) { this.options = options; }
      on() {}
      open() {
        const button = document.createElement("button");
        button.textContent = "Close Razorpay checkout";
        button.style = "position:fixed;right:0;top:0;z-index:2147483647;background:white;color:black";
        button.onclick = () => { button.remove(); this.options.modal.ondismiss(); };
        document.body.append(button);
      }
    }`,
  }));
  await page.route("**/api/payment/providers", (route) => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", (route) => {
    const referral = route.request().postDataJSON()?.referralCode === "friend";
    return route.fulfill({
      json: {
        ok: true,
        providers,
        quoteFingerprint: "fixture-quote",
        quote: {
          grossAmount: 84.99,
          netAmount: referral ? 76.49 : 84.99,
          isFree: false,
          couponDiscountAmount: 0,
          referralDiscountAmount: referral ? 8.5 : 0,
          referralDiscountPercent: referral ? 10 : 0,
        },
      },
    });
  });
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  await page.route("**/api/payment/start", (route) => {
    const payload = route.request().postDataJSON().bookingPayload;
    expect(payload.referralCode).toBe("friend");
    holdId = payload.slotHoldId;
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        checkoutCreated: true,
        paymentAccessToken: "razorpay-fixture-token",
        sessionExpiresAt: expiry,
        quoteFingerprint: "fixture-quote",
        quote: { grossAmount: 84.99, netAmount: 76.49, isFree: false, referralDiscountAmount: 8.5, referralDiscountPercent: 10 },
        providerPayload: { orderId: "order_fixture", key: "rzp_test_fixture", amount: 7649, currency: "USD" },
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "start-hold-token", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  await page.route("**/api/payment/cancel", (route) => route.fulfill({
    json: {
      ok: true,
      status: "abandoned",
      cancelled: true,
      refreshedHold: { slotHoldId: holdId, slotHoldToken: "cancel-hold-token", slotHoldExpiresAt: expiry, phase: "holding" },
    },
  }));

  await flow.review();
  await flow.payment();
  const referral = page.locator("#payment-referral-code");
  await referral.fill("friend");
  await referral.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  const discountedTotal = page.getByText("$76.49 USD", { exact: true });
  await expect(discountedTotal).toBeVisible();

  await page.getByRole("button", { name: "Pay with Razorpay", exact: true }).click();
  await page.getByRole("button", { name: "Close Razorpay checkout", exact: true }).click();

  let allowRestore;
  const restoreGate = new Promise((resolve) => { allowRestore = resolve; });
  await page.route("**/api/ref/validateReferral?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("code") === "friend") await restoreGate;
    return route.fallback();
  });
  const restored = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/ref/validateReferral");
  await page.reload();
  const release = page.getByRole("button", { name: "Change payment method", exact: true });
  await expect(release).toBeVisible();
  await expect(discountedTotal).toBeVisible();
  allowRestore();
  expect((await (await restored).json()).referral.code).toBe("friend");

  const quoteAfterRelease = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/payment/quote");
  await release.click();
  const quoteRes = await quoteAfterRelease;
  await expect(page.getByText("Payment method released. Choose a payment method below.")).toBeVisible();
  await expect(referral).toHaveValue("friend");
  expect(quoteRes.request().postDataJSON().referralCode).toBe("friend");
  expect((await quoteRes.json()).quote.netAmount).toBe(76.49);
  await expect(discountedTotal).toBeVisible();
});

test("resumed locked Razorpay checkout still finalizes when saved referral restore finishes while modal is open", async ({
  page, flow,
}) => {
  const providers = {
    dodo: { enabled: true, mode: "test" },
    razorpay: { enabled: true, mode: "test" },
    paypal: { enabled: false, mode: "disabled" },
  };
  await page.route("https://checkout.razorpay.com/v1/checkout.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `window.Razorpay = class {
      constructor(options) { this.options = options; }
      on() {}
      open() {
        const closeBtn = document.createElement("button");
        closeBtn.textContent = "Close Razorpay checkout";
        closeBtn.style = "position:fixed;right:0;top:0;z-index:2147483647;background:white;color:black";
        const completeBtn = document.createElement("button");
        completeBtn.textContent = "Complete Razorpay checkout";
        completeBtn.style = "position:fixed;right:0;top:40px;z-index:2147483647;background:white;color:black";
        closeBtn.onclick = () => { closeBtn.remove(); completeBtn.remove(); this.options.modal.ondismiss(); };
        completeBtn.onclick = () => {
          closeBtn.remove();
          completeBtn.remove();
          this.options.handler({
            razorpay_order_id: "order_fixture",
            razorpay_payment_id: "pay_fixture",
            razorpay_signature: "fixture-signature",
          });
        };
        document.body.append(closeBtn, completeBtn);
      }
    }`,
  }));
  await page.route("**/api/payment/providers", (route) => route.fulfill({ json: { ok: true, providers } }));
  await page.route("**/api/payment/quote", (route) => {
    const referral = route.request().postDataJSON()?.referralCode === "friend";
    return route.fulfill({
      json: {
        ok: true,
        providers,
        quoteFingerprint: "fixture-quote",
        quote: {
          grossAmount: 84.99,
          netAmount: referral ? 76.49 : 84.99,
          isFree: false,
          couponDiscountAmount: 0,
          referralDiscountAmount: referral ? 8.5 : 0,
          referralDiscountPercent: referral ? 10 : 0,
        },
      },
    });
  });
  const expiry = new Date(Date.now() + 20 * 60_000).toISOString();
  let holdId = "";
  await page.route("**/api/payment/start", (route) => {
    const payload = route.request().postDataJSON().bookingPayload;
    expect(payload.referralCode).toBe("friend");
    holdId = payload.slotHoldId;
    return route.fulfill({
      json: {
        ok: true,
        status: "started",
        checkoutCreated: true,
        paymentAccessToken: "razorpay-fixture-token",
        sessionExpiresAt: expiry,
        quoteFingerprint: "fixture-quote",
        quote: { grossAmount: 84.99, netAmount: 76.49, isFree: false, referralDiscountAmount: 8.5, referralDiscountPercent: 10 },
        providerPayload: { orderId: "order_fixture", key: "rzp_test_fixture", amount: 7649, currency: "USD" },
        refreshedHold: { slotHoldId: holdId, slotHoldToken: "start-hold-token", slotHoldExpiresAt: expiry, phase: "payment_pending" },
      },
    });
  });
  await page.route("**/api/payment/status", (route) => route.fulfill({ json: { ok: true, status: "started" } }));

  await flow.review();
  await flow.payment();
  const referral = page.locator("#payment-referral-code");
  await referral.fill("friend");
  await referral.locator("..").getByRole("button", { name: "Apply", exact: true }).click();
  const discountedTotal = page.getByText("$76.49 USD", { exact: true });
  await expect(discountedTotal).toBeVisible();

  await page.getByRole("button", { name: "Pay with Razorpay", exact: true }).click();
  await page.getByRole("button", { name: "Close Razorpay checkout", exact: true }).click();

  let allowRestore;
  const restoreGate = new Promise((resolve) => { allowRestore = resolve; });
  await page.route("**/api/ref/validateReferral?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("code") === "friend") await restoreGate;
    return route.fallback();
  });
  const restored = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/ref/validateReferral");
  await page.reload();
  await expect(page.getByRole("button", { name: "Change payment method", exact: true })).toBeVisible();
  await expect(discountedTotal).toBeVisible();

  await page.getByRole("button", { name: "Pay with Razorpay", exact: true }).click();
  const complete = page.getByRole("button", { name: "Complete Razorpay checkout", exact: true });
  await expect(complete).toBeVisible();

  allowRestore();
  expect((await (await restored).json()).referral.code).toBe("friend");
  await expect(page.getByText(/friend · −\$8\.50/)).toBeVisible();

  let finalizations = 0;
  await page.route("**/api/payment/finalize", (route) => {
    finalizations += 1;
    return route.fulfill({ json: { ok: true, status: "booked", bookingId: "booking-fixture" } });
  });
  await complete.click();
  await expect.poll(() => finalizations, { timeout: 5000 }).toBe(1);
});

const SYNTHETIC_PAYPAL_SDK = `window.paypal = {
  FUNDING: { PAYPAL: "paypal" },
  Buttons: () => ({
    isEligible: () => true,
    render: (container) => {
      const host = typeof container === "string" ? document.querySelector(container) : container;
      if (host) host.innerHTML = '<button type="button">Pay with PayPal</button>';
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  }),
};`;

for (const failureTarget of ["sdk", "chunk"]) {
  test(`failed PayPal ${failureTarget} download shows retry state and clicking Retry PayPal restores the PayPal checkout button`, async ({
    page, flow, baseURL,
  }) => {
    let paypalChunkRequests = 0;
    let paypalSdkRequests = 0;
    if (failureTarget === "chunk") {
      await inspectChunks(page, { origin: baseURL }, () => undefined, (route, response, body) => {
        if (body.includes("data-react-paypal-script-id")) {
          paypalChunkRequests += 1;
          if (paypalChunkRequests === 1) {
            return route.fulfill({ status: 500, body: "" });
          }
        }
        return route.fulfill({ response, body });
      });
    }
    await page.route("https://www.paypal.com/sdk/js*", (route) => {
      paypalSdkRequests += 1;
      if (failureTarget === "sdk" && paypalSdkRequests === 1) {
        return route.fulfill({ status: 503, contentType: "text/plain", body: "unavailable" });
      }
      return route.fulfill({ status: 200, contentType: "application/javascript", body: SYNTHETIC_PAYPAL_SDK });
    });
    const paypalProviders = {
      dodo: { enabled: true, mode: "test" },
      razorpay: { enabled: false, mode: "disabled" },
      paypal: { enabled: true, mode: "sandbox", clientId: "sb-test-client" },
    };
    await page.route("**/api/payment/providers", (route) => route.fulfill({
      json: { ok: true, providers: paypalProviders },
    }));
    await page.route("**/api/payment/quote", (route) => route.fulfill({
      json: {
        ok: true,
        quoteFingerprint: "fixture-quote",
        providers: paypalProviders,
        quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false, couponDiscountAmount: 0, referralDiscountAmount: 0, referralDiscountPercent: 0 },
      },
    }));
    await flow.review();
    await flow.payment();
    await expect(page.getByText("PayPal couldn’t load. Please try again.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Pay with PayPal", exact: true })).toHaveCount(0);
    const retry = page.getByRole("button", { name: "Retry PayPal", exact: true });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(page.getByRole("button", { name: "Pay with PayPal", exact: true })).toBeVisible();
    if (failureTarget === "sdk") {
      expect(paypalSdkRequests).toBe(2);
    } else {
      expect(paypalChunkRequests).toBe(2);
    }
  });
}
