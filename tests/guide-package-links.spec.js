const { test, expect } = require("./fixtures/booking-flow.cjs");
const http = require("node:http");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", viewport: { width: 390, height: 844 } });

const storedReferral = page => page.evaluate(() => sessionStorage.getItem("referral_session"));

test("guide API requests refuse destinations outside the fixture", async ({ page }, testInfo) => {
  let hits = 0;
  const server = http.createServer((_request, response) => { hits++; response.end("outside fixture"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await expect(page.request.get(`http://127.0.0.1:${server.address().port}/`)).rejects.toThrow(/outside the local fixture/);
    expect(hits).toBe(0);
    await testInfo.attach("guarded-api-request", { body: JSON.stringify({ refused: true, hits }), contentType: "application/json" });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

for (const guide of ["/tools", "/benchmarks"]) {
  test(`${guide} serves its packages link without JavaScript`, async ({ page }) => {
    const html = await (await page.request.get(guide)).text();
    expect(html).toMatch(/<a[^>]*href="\/packages"[^>]*>See the packages<\/a>/);
  });

  test(`${guide} links to the packages and a creator's code survives to the booking`, async ({ page, flow }) => {
    await page.goto(`${guide}?ref=friend`);
    await expect.poll(() => storedReferral(page)).toBe("friend");
    await page.getByRole("link", { name: "See the packages", exact: true }).click();
    await expect(page).toHaveURL(/\/packages$/);
    await expect(page.locator(".ri-package-card").first()).toBeVisible();
    expect(await storedReferral(page)).toBe("friend");
    await flow.review();
    await expect(page.getByRole("button", { name: "Remove referral code friend", exact: true })).toBeVisible();
  });
}
