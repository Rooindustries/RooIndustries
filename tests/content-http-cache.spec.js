const { test, expect } = require("@playwright/test");

const target = new URL(process.env.BASE_URL || "http://127.0.0.1:4173");
const refreshedReferral = "Referral heading published after the first visit";

test.use({
  javaScriptEnabled: true,
  reducedMotion: "reduce",
  launchOptions: {
    args: [
      "--ozone-platform=x11",
      `--unsafely-treat-insecure-origin-as-secure=${target.origin}`,
      `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${target.hostname}`,
    ],
  },
});

const control = async (request, baseURL, data) => {
  const origin = new URL(baseURL);
  origin.port = process.env.TOOLING_CONTENT_PORT || String(Number(origin.port) + 1);
  const response = await request.post(new URL("/__content", origin).href, { data });
  expect(response.status()).toBe(200);
};

const hydrated = (page) => page.waitForFunction(() => window.history.state?.__rooLegacy === true);

test("a background refresh goes past the browser's cached content response", async ({ page, request, baseURL }) => {
  const referralRequests = [];
  const referralResponses = [];
  page.on("request", (entry) => {
    if (new URL(entry.url()).pathname === "/api/content/referral-box") referralRequests.push(entry.url());
  });
  page.on("response", (entry) => {
    if (new URL(entry.url()).pathname === "/api/content/referral-box") referralResponses.push(entry);
  });
  const heading = page.locator(".ri-referral-heading");
  const revisitHome = async () => {
    await page.locator('footer a[href="/about"]').click();
    await expect(page).toHaveURL(/\/about$/);
    await page.locator('footer a[href="/"]').first().click();
    await expect(page).toHaveURL(/\/$/);
    await page.locator("footer").last().scrollIntoViewIfNeeded();
  };

  try {
    await page.clock.install();
    await page.goto("/about", { waitUntil: "networkidle" });
    await hydrated(page);
    await page.evaluate(() => { window.__cacheDocument = true; });
    await page.locator('footer a[href="/"]').first().click();
    await expect(page).toHaveURL(/\/$/);
    await page.locator("footer").last().scrollIntoViewIfNeeded();
    await expect(heading).toHaveText("Join the Referral Program");
    await expect.poll(() => referralRequests.length).toBe(1);

    await expect.poll(() => referralResponses.length).toBe(1);
    const firstResponse = referralResponses[0];
    expect(firstResponse.status()).toBe(200);

    await control(request, baseURL, { patch: { _id: "tooling-referralBox", heading: refreshedReferral } });
    await expect.poll(async () => (await (await request.get("/api/content/referral-box")).json()).data?.heading)
      .toBe(refreshedReferral);

    await revisitHome();
    await expect(heading).toHaveText("Join the Referral Program");
    expect(referralRequests).toHaveLength(1);

    await page.clock.fastForward("01:01");
    await revisitHome();
    await expect(heading).toHaveText(refreshedReferral);
    expect(referralRequests).toHaveLength(2);
    await expect.poll(() => referralResponses.length).toBe(2);
    const refreshed = referralResponses[1];
    expect(refreshed.status()).toBe(200);
    expect((await refreshed.json()).data?.heading).toBe(refreshedReferral);
    expect(refreshed.headers()["cache-control"]).toBe(firstResponse.headers()["cache-control"]);
    expect(refreshed.headers()["etag"]).not.toBe(firstResponse.headers()["etag"]);
    expect(await page.evaluate(() => window.__cacheDocument)).toBe(true);
  } finally {
    await control(request, baseURL, { reset: true });
  }
});
