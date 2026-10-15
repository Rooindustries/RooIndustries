const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");

const REFERRAL = "friend";

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce", trace: "off", video: "off" });

const watchConsole = (page) => {
  const messages = [];
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) messages.push(`${message.type()}: ${message.text()}`);
  });
  return messages;
};

const hydrated = (page) => page.waitForFunction(() => window.history.state?.__rooLegacy === true);

const record = async (testInfo, name, value) => {
  const artifact = testInfo.outputPath(`${name}.json`);
  await fs.writeFile(artifact, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path: artifact, contentType: "application/json" });
};

function sessionCls(shifts) {
  let cls = 0;
  let session = 0;
  let sessionStart = 0;
  let lastShift = 0;
  for (const shift of shifts) {
    if (shift.hadRecentInput) continue;
    if (shift.time - lastShift > 1000 || shift.time - sessionStart > 5000) {
      session = 0;
      sessionStart = shift.time;
    }
    session += shift.value;
    lastShift = shift.time;
    cls = Math.max(cls, session);
  }
  return cls;
}

test("the home page is served as a prebuilt page that ignores the query string", async ({ request }, testInfo) => {
  const manifest = JSON.parse(await fs.readFile(path.join(testInfo.config.metadata.toolingDistDir, "prerender-manifest.json"), "utf8"));
  const home = await request.get("/", { headers: { accept: "text/html" }, maxRedirects: 0 });
  const first = await request.get("/?ref=alpha", { headers: { accept: "text/html" }, maxRedirects: 0 });
  const second = await request.get("/?ref=beta", { headers: { accept: "text/html" }, maxRedirects: 0 });
  const [firstBody, secondBody] = await Promise.all([first.text(), second.text()]);
  await record(testInfo, "home-prebuilt", {
    manifestRoute: manifest.routes["/"] ?? null,
    headers: home.headersArray(),
    queryResponses: [
      { path: "/?ref=alpha", status: first.status(), cache: first.headers()["x-nextjs-cache"] ?? null, bytes: firstBody.length },
      { path: "/?ref=beta", status: second.status(), cache: second.headers()["x-nextjs-cache"] ?? null, bytes: secondBody.length },
    ],
    identical: firstBody === secondBody,
  });
  expect(manifest.routes["/"]?.initialRevalidateSeconds).toBe(60);
  expect(home.status()).toBe(200);
  expect(home.headers()["x-nextjs-prerender"]).toBe("1");
  expect(home.headers()["x-nextjs-cache"]).toMatch(/^(HIT|STALE)$/);
  expect(first.status()).toBe(200);
  expect(second.status()).toBe(200);
  expect(firstBody).not.toContain("alpha");
  expect(secondBody).toBe(firstBody);
});

test("a referral link keeps its code and campaign and applies the referral in booking", async ({ page, flow }, testInfo) => {
  const messages = watchConsole(page);
  await page.goto(`/?ref=${REFERRAL}&utm_source=discord&junkparam=1`);
  await hydrated(page);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_session"))).toBe(REFERRAL);
  await expect.poll(() => page.evaluate(() => window.location.search)).toBe(`?ref=${REFERRAL}&utm_source=discord`);
  await page.locator(".ri-package-book-button").first().click();
  await expect(page).toHaveURL(/\/booking$/);
  await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await flow.details();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Remove referral code ${REFERRAL}`, exact: true })).toBeVisible();
  await flow.payment();
  const quote = flow.state.calls.filter(({ path: called }) => called === "/api/payment/quote").at(-1)?.body ?? null;
  await record(testInfo, "home-referral", {
    referralSession: await page.evaluate(() => sessionStorage.getItem("referral_session")),
    quote,
    messages,
  });
  expect(quote?.referralCode).toBe(REFERRAL);
});

test("the home page keeps the server-rendered hero after hydration on a referral link", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const shifts = window.__homeShifts = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) shifts.push({ value: entry.value, time: entry.startTime, hadRecentInput: entry.hadRecentInput });
    }).observe({ type: "layout-shift", buffered: true });
    document.addEventListener("DOMContentLoaded", () => {
      window.__heroAtLoad = document.querySelector("#top h1");
    });
  });
  await page.goto(`/?ref=${REFERRAL}`);
  await hydrated(page);
  expect(await page.evaluate(() => Boolean(window.__heroAtLoad))).toBe(true);
  await page.waitForTimeout(2000);
  const state = await page.evaluate(() => ({
    connected: window.__heroAtLoad.isConnected,
    same: document.querySelector("#top h1") === window.__heroAtLoad,
    shifts: window.__homeShifts,
  }));
  const cls = sessionCls(state.shifts);
  await record(testInfo, "home-hero-node", { connected: state.connected, same: state.same, cls, shifts: state.shifts });
  expect(state.connected).toBe(true);
  expect(state.same).toBe(true);
  expect(cls).toBeLessThan(0.1);
});

test("a static page keeps its campaign query in the address bar after hydration", async ({ page }, testInfo) => {
  await page.goto("/benchmarks?utm_source=x");
  await hydrated(page);
  await page.waitForTimeout(500);
  const search = await page.evaluate(() => window.location.search);
  await record(testInfo, "benchmarks-query", { search });
  expect(search).toBe("?utm_source=x");
});

test("the home page hydrates without warnings", async ({ page }, testInfo) => {
  const results = [];
  for (const url of ["/", `/?ref=${REFERRAL}&utm_source=discord`, "/#packages"]) {
    const messages = watchConsole(page);
    await page.goto(url);
    await hydrated(page);
    await page.waitForTimeout(1000);
    results.push({ url, messages: [...messages] });
    page.removeAllListeners("console");
    page.removeAllListeners("pageerror");
  }
  await record(testInfo, "home-hydration", results);
  for (const { url, messages } of results) {
    expect(messages.filter((text) => /hydrat|did not match|server rendered|server HTML|#418|#423|#425/i.test(text)), url).toEqual([]);
  }
});
