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

const sleepUntil = (time) => new Promise((resolve) => setTimeout(resolve, Math.max(0, time - Date.now())));

const fetchHome = async (request, path = "/", headers = { accept: "text/html" }) => {
  const response = await request.get(path, { headers, maxRedirects: 0 });
  return { path, status: response.status(), cache: response.headers()["x-nextjs-cache"] ?? null, body: await response.text(), at: Date.now() };
};

const untilHomeStale = async (request, path = "/") => {
  const deadline = Date.now() + 75000;
  while (Date.now() < deadline) {
    const home = await fetchHome(request, path);
    if (home.cache === "STALE") return home;
    await sleepUntil(Date.now() + 1000);
  }
  throw new Error("The home page never went stale.");
};

const contentControl = async (request, baseURL, body) => {
  const origin = new URL(baseURL);
  origin.port = String(Number(origin.port) + 1);
  const response = await request.post(new URL("/__content", origin).href, { data: body });
  expect(response.ok(), await response.text()).toBe(true);
};

const bookFromHome = async (page) => {
  await page.goto(`/?ref=${REFERRAL}&utm_source=discord`);
  await hydrated(page);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_session"))).toBe(REFERRAL);
  await page.locator(".ri-package-book-button").first().click();
  await expect(page).toHaveURL(/\/booking$/);
  await expect(page.getByRole("dialog")).toBeVisible();
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
  const ownsServer = testInfo.config.metadata.ownsToolingServer === true;
  const manifest = ownsServer ? JSON.parse(await fs.readFile(path.join(testInfo.config.metadata.toolingDistDir, "prerender-manifest.json"), "utf8")) : null;
  const home = await request.get("/", { headers: { accept: "text/html" }, maxRedirects: 0 });
  if (home.headers()["x-nextjs-cache"] === "STALE") {
    await expect.poll(async () => (await request.get("/", { headers: { accept: "text/html" }, maxRedirects: 0 })).headers()["x-nextjs-cache"], { timeout: 20000 }).toBe("HIT");
  }
  const first = await request.get("/?ref=alpha", { headers: { accept: "text/html" }, maxRedirects: 0 });
  const second = await request.get("/?ref=beta", { headers: { accept: "text/html" }, maxRedirects: 0 });
  const [firstBody, secondBody] = await Promise.all([first.text(), second.text()]);
  await record(testInfo, "home-prebuilt", {
    manifestRoute: manifest?.routes["/"] ?? null,
    headers: home.headersArray(),
    queryResponses: [
      { path: "/?ref=alpha", status: first.status(), cache: first.headers()["x-nextjs-cache"] ?? null, bytes: firstBody.length },
      { path: "/?ref=beta", status: second.status(), cache: second.headers()["x-nextjs-cache"] ?? null, bytes: secondBody.length },
    ],
    identical: firstBody === secondBody,
  });
  if (ownsServer) expect(manifest.routes["/"]?.initialRevalidateSeconds).toBe(60);
  expect(home.status()).toBe(200);
  expect(home.headers()["x-nextjs-prerender"]).toMatch(/^1(, 1)*$/);
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
  await expect.poll(() => flow.state.calls.some(({ path: called }) => called === "/api/payment/quote")).toBe(true);
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
  for (const url of ["/", `/?ref=${REFERRAL}&utm_source=discord`, "/#packages", `/?ref=${REFERRAL}#packages`]) {
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

test("going back and forward over booking keeps the home page mounted and the referral choice", async ({ page, flow }, testInfo) => {
  void flow;
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      window.__heroAtLoad = document.querySelector("#top h1");
    });
  });
  await bookFromHome(page);
  await page.evaluate(() => sessionStorage.removeItem("referral_session"));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/\\?ref=${REFERRAL}&utm_source=discord$`));
  await page.goForward();
  await expect(page).toHaveURL(/\/booking$/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/\\?ref=${REFERRAL}&utm_source=discord$`));
  await page.waitForTimeout(1000);
  const state = await page.evaluate(() => ({
    connected: Boolean(window.__heroAtLoad?.isConnected),
    same: document.querySelector("#top h1") === window.__heroAtLoad,
    referral: sessionStorage.getItem("referral_session"),
  }));
  await record(testInfo, "home-history", state);
  expect(state.connected).toBe(true);
  expect(state.same).toBe(true);
  expect(state.referral).toBeNull();
});

test("closing booking opened from a referral link returns to the same link", async ({ page, flow }, testInfo) => {
  void flow;
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      window.__homeBeforeBooking = document.querySelector("#top h1");
    });
  });
  await bookFromHome(page);
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.waitForTimeout(500);
  const address = await page.evaluate(() => `${window.location.pathname}${window.location.search}`);
  const pageNode = await page.evaluate(() => ({
    connected: window.__homeBeforeBooking.isConnected,
    same: document.querySelector("#top h1") === window.__homeBeforeBooking,
  }));
  await record(testInfo, "home-close", { address, ...pageNode });
  expect(address).toBe(`/?ref=${REFERRAL}&utm_source=discord`);
  expect(pageNode).toEqual({ connected: true, same: true });
});

test.describe("rebuilds of the prebuilt home page", () => {
  test("a rebuild triggered by a query never bakes that query into the shared page", async ({ request }, testInfo) => {
    test.slow();
    const trigger = await untilHomeStale(request, "/?ref=leakprobe&gclid=leakprobe");
    await sleepUntil(trigger.at + 3000);
    const html = await fetchHome(request);
    const rsc = await fetchHome(request, "/", { rsc: "1" });
    await record(testInfo, "home-leak", {
      trigger: { path: trigger.path, cache: trigger.cache },
      html: { cache: html.cache, leaked: html.body.includes("leakprobe") },
      rsc: { cache: rsc.cache, leaked: rsc.body.includes("leakprobe") },
    });
    expect(html.body).not.toContain("leakprobe");
    expect(rsc.body).not.toContain("leakprobe");
  });

  test("a rebuild reads content changed in the backend even while the content cache is warm", async ({ request, baseURL }, testInfo) => {
    test.slow();
    const marker = `Backend hero ${Date.now()}`;
    const timeline = [];
    try {
      const regenerated = await untilHomeStale(request);
      timeline.push({ step: "previous rebuild", at: regenerated.at });
      await sleepUntil(regenerated.at + 61000);
      const warm = await request.get("/booking", { headers: { accept: "text/html" } });
      expect(warm.ok()).toBe(true);
      timeline.push({ step: "content cache refilled by another page", at: Date.now() });
      await contentControl(request, baseURL, { patch: { _id: "tooling-hero", headingLine1: marker } });
      timeline.push({ step: "backend changed", at: Date.now() });
      const trigger = await fetchHome(request);
      timeline.push({ step: "rebuild triggered", at: trigger.at, cache: trigger.cache });
      await sleepUntil(trigger.at + 3000);
      const after = await fetchHome(request);
      timeline.push({ step: "after rebuild", at: after.at, cache: after.cache, hasMarker: after.body.includes(marker) });
      await record(testInfo, "home-backend-change", { marker, timeline });
      expect(trigger.cache).toBe("STALE");
      expect(after.body).toContain(marker);
    } finally {
      await contentControl(request, baseURL, { reset: true });
      const restore = await untilHomeStale(request);
      await sleepUntil(restore.at + 3000);
      const restored = await fetchHome(request);
      await record(testInfo, "home-backend-restore", { cache: restored.cache, hasMarker: restored.body.includes(marker) });
      expect(restored.body).not.toContain(marker);
    }
  });

  test("a content outage during a rebuild keeps serving the previous home page", async ({ request, baseURL }, testInfo) => {
    test.slow();
    const before = await fetchHome(request);
    expect(before.body).toContain("Fixture Hero Heading One");
    expect(before.body).toContain("Performance Vertex Overhaul");
    try {
      await contentControl(request, baseURL, { outage: true });
      const trigger = await untilHomeStale(request);
      await sleepUntil(trigger.at + 3000);
      const after = await fetchHome(request);
      await record(testInfo, "home-outage", {
        trigger: { cache: trigger.cache },
        after: { cache: after.cache, hero: after.body.includes("Fixture Hero Heading One"), packages: after.body.includes("Performance Vertex Overhaul") },
      });
      expect(after.body).toContain("Fixture Hero Heading One");
      expect(after.body).toContain("Performance Vertex Overhaul");
    } finally {
      await contentControl(request, baseURL, { reset: true });
    }
  });
});
