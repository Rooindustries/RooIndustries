const { test, expect } = require("@playwright/test");
const mode = process.env.PLAYWRIGHT_TIMEOUT_CASE;

test(mode === "pass" ? "pass: healthy browser action" : `${mode}: deliberately hung browser action`, async ({ page, context, baseURL }, testInfo) => {
  const { guardBrowserContext } = await import("../../../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  await page.goto("/");
  await expect(page).toHaveTitle("Local timeout fixture");
  if (mode === "pass" || (mode === "retry" && testInfo.retry > 0)) return;
  if (process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS) {
    test.setTimeout(testInfo.duration + Number(process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS));
  }
  await test.step("wait forever for a missing page element", async () => {
    await page.getByTestId("never-created").waitFor({ timeout: 0 });
  });
});
