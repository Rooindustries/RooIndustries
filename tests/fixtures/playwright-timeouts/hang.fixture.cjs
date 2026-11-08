const { test, expect } = require("@playwright/test");
const mode = process.env.PLAYWRIGHT_TIMEOUT_CASE;

if (mode === "unbounded" || mode === "local") {
  for (let index = 0; index < 3; index++) {
    test(`${mode}: healthy browser action ${index + 1}`, async ({ page, context, baseURL }) => {
      const { guardBrowserContext } = await import("../../../scripts/lib/test-target-safety.mjs");
      await guardBrowserContext(context, [baseURL]);
      await page.goto("/slow");
      await expect(page).toHaveTitle("Local timeout fixture");
    });
  }
} else {
  test(`${mode}: browser action`, async ({ page, context, baseURL }, testInfo) => {
    const { guardBrowserContext } = await import("../../../scripts/lib/test-target-safety.mjs");
    await guardBrowserContext(context, [baseURL]);
    await page.goto("/");
    await expect(page).toHaveTitle("Local timeout fixture");
    if (mode === "pass" || (mode === "retry" && testInfo.retry > 0)) return;
    console.log("Waiting for never-created");
    await test.step("wait for a missing page element", async () => {
      await page.getByTestId("never-created").waitFor({ timeout: 0 });
    });
  });
}
