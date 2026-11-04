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
  test.setTimeout(110000);
  const referralRequests = [];
  page.on("request", (entry) => {
    if (new URL(entry.url()).pathname === "/api/content/referral-box") referralRequests.push(entry.url());
  });
  const heading = page.locator(".ri-referral-heading");

  try {
    await page.goto("/about", { waitUntil: "networkidle" });
    await hydrated(page);
    await page.evaluate(() => { window.__cacheDocument = true; });
    await page.locator('footer a[href="/"]').first().click();
    await expect(page).toHaveURL(/\/$/);
    await page.locator("footer").last().scrollIntoViewIfNeeded();
    await expect(heading).toHaveText("Join the Referral Program");
    await expect.poll(() => referralRequests.length).toBe(1);

    await control(request, baseURL, { patch: { _id: "tooling-referralBox", heading: refreshedReferral } });
    await page.waitForTimeout(61000);
    await expect.poll(async () => (await (await request.get("/api/content/referral-box")).json()).data?.heading)
      .toBe(refreshedReferral);

    await page.locator('footer a[href="/about"]').click();
    await expect(page).toHaveURL(/\/about$/);
    await page.locator('footer a[href="/"]').first().click();
    await expect(page).toHaveURL(/\/$/);
    await page.locator("footer").last().scrollIntoViewIfNeeded();
    await expect(heading).toHaveText(refreshedReferral);
    expect(referralRequests.length).toBeGreaterThan(1);
    expect(await page.evaluate(() => window.__cacheDocument)).toBe(true);
  } finally {
    await control(request, baseURL, { reset: true });
  }
});
