const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");

test.use({ javaScriptEnabled: true, viewport: { width: 1440, height: 900 }, serviceWorkers: "block", trace: "off", video: "off" });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  const contentURL = new URL(baseURL);
  contentURL.port = process.env.TOOLING_CONTENT_PORT || String(Number(contentURL.port) + 1);
  await guardBrowserContext(context, [baseURL, contentURL.origin]);
});

for (const [route, resource, heading] of [
  ["/tools", "tools", "All Tools & Utilities"],
  ["/reviews", "reviews-gallery", "Community Reviews"],
]) {
  if (process.env.TOOLING_CLS_RESPONSE === "failed") {
    test(`${route} shows the page error when server content fails`, async ({ page }, testInfo) => {
      await page.goto("/contact");
      const api = await page.evaluate(async (resource) => {
        const response = await fetch(`/api/content/${resource}`);
        return { status: response.status, body: await response.json() };
      }, resource);
      expect(api.status).toBe(503);
      expect(api.body.ok).toBe(false);
      const response = await page.goto(route);
      await expect(page.getByRole("heading", { name: "We couldn’t load this page." })).toBeVisible();
      await expect(page.getByRole("button", { name: "Reload page" })).toBeVisible();
      await expect(page.getByRole("heading", { name: heading, exact: true })).toHaveCount(0);
      const artifact = testInfo.outputPath("content-state.json");
      await fs.writeFile(artifact, `${JSON.stringify({ route, apiStatus: api.status, pageStatus: response.status(), errorVisible: true }, null, 2)}\n`);
      await testInfo.attach("content-state", { path: artifact, contentType: "application/json" });
      await page.screenshot({ path: testInfo.outputPath("server-error.png"), animations: "disabled" });
    });
    continue;
  }

  for (const responseState of ["success", "delayed", "failed"]) {
    test(`${route} supports client navigation with ${responseState} content`, async ({ page }, testInfo) => {
      const requests = [];
      await page.route(`**/api/content/${resource}`, async (request) => {
        requests.push(request.request().url());
        if (responseState === "delayed") await new Promise(resolve => setTimeout(resolve, 650));
        if (responseState === "failed") {
          await request.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Synthetic content is unavailable." }) });
        } else {
          await request.fallback();
        }
      });
      await page.goto("/contact");
      await expect(page.getByRole("heading", { name: "Get In Touch", exact: true })).toBeVisible();
      await page.evaluate(() => { window.__contentNavigationMarker = "same-document"; });
      if (route === "/tools") {
        await page.locator("footer").getByRole("link", { name: "Tools", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "Proof", exact: true }).click();
        await page.locator("#desktop-proof-menu").getByRole("link", { name: "Reviews", exact: true }).click();
      }
      await expect(page).toHaveURL(new RegExp(`${route}$`));
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.locator("#main-content section [aria-hidden='true']")).toHaveCount(0);
      expect(await page.evaluate(() => window.__contentNavigationMarker)).toBe("same-document");
      expect(requests).toHaveLength(1);
      const populated = process.env.TOOLING_CLS_CONTENT === "1" && responseState !== "failed";
      if (route === "/tools") {
        await expect(page.locator("main article")).toHaveCount(populated ? 4 : 0);
        if (!populated) await expect(page.getByText("No tools configured yet. Add tools in the content editor.")).toBeVisible();
      } else {
        await expect(page.locator("main section figure img")).toHaveCount(populated ? 2 : 0);
      }
      const artifact = testInfo.outputPath("content-state.json");
      await fs.writeFile(artifact, `${JSON.stringify({ route, responseState, requests, populated, sameDocument: true }, null, 2)}\n`);
      await testInfo.attach("content-state", { path: artifact, contentType: "application/json" });
      await page.screenshot({ path: testInfo.outputPath("client-navigation.png"), animations: "disabled" });
    });
  }

  if (process.env.TOOLING_CLS_CONTENT === "1") {
    test(`${route} refreshes content when revisited after its server snapshot`, async ({ page }, testInfo) => {
      await page.goto(route);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      const initial = await page.evaluate(async (resource) => (await fetch(`/api/content/${resource}`)).json(), resource);
      expect(initial.data.length).toBeGreaterThan(1);
      await page.evaluate(() => { window.__contentNavigationMarker = "same-document"; });
      await page.locator("footer").getByRole("link", { name: "About", exact: true }).click();
      await expect(page).toHaveURL(/\/about$/);
      await expect(page.getByRole("heading", { name: "About Roo Industries", exact: true })).toBeVisible();
      const refreshedLabel = `Refreshed ${resource}`;
      const refreshed = { ...initial.data[0], [route === "/tools" ? "title" : "alt"]: refreshedLabel };
      const requests = [];
      await page.route(`**/api/content/${resource}`, async (entry) => {
        requests.push(entry.request().url());
        await entry.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: [refreshed] }) });
      });
      if (route === "/tools") {
        await page.locator("footer").getByRole("link", { name: "Tools", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "Proof", exact: true }).click();
        await page.locator("#desktop-proof-menu").getByRole("link", { name: "Reviews", exact: true }).click();
      }
      await expect.poll(() => requests.length, { timeout: 5000 }).toBe(1);
      if (route === "/tools") {
        await expect(page.locator("main article")).toHaveCount(1);
        await expect(page.getByRole("heading", { name: refreshedLabel, exact: true })).toBeVisible();
      } else {
        await expect(page.locator("main section figure img")).toHaveCount(1);
        await expect(page.getByAltText(refreshedLabel, { exact: true })).toBeVisible();
      }
      expect(await page.evaluate(() => window.__contentNavigationMarker)).toBe("same-document");
      const artifact = testInfo.outputPath("content-state.json");
      await fs.writeFile(artifact, `${JSON.stringify({ route, requests, refreshedLabel, sameDocument: true }, null, 2)}\n`);
      await testInfo.attach("content-state", { path: artifact, contentType: "application/json" });
    });
  }
}
