const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", viewport: { width: 390, height: 844 } });

const storedReferral = page => page.evaluate(() => sessionStorage.getItem("referral_session"));

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
