const { test, expect } = require("@playwright/test");

test(`${process.env.PLAYWRIGHT_TIMEOUT_CASE}: deliberately hung browser action`, async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Local timeout fixture");
  await test.step("wait forever for a missing page element", async () => {
    await page.getByTestId("never-created").waitFor({ timeout: 0 });
  });
});
