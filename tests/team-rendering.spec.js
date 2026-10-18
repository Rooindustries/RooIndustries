const { test, expect } = require("@playwright/test");

const cmsTeam = ["Fixture Founder", "Fixture Member Alpha", "Fixture Member Beta"];
const fallbackOnly = ["Josh369", "Wailshark", "Core Team"];

test.use({ javaScriptEnabled: true, serviceWorkers: "block" });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("/meet-the-team renders the CMS team", async ({ page }, testInfo) => {
    const response = await page.goto("/meet-the-team", { waitUntil: "domcontentloaded" });
    const main = page.locator("main#main-content");
    const text = await main.innerText();
    await testInfo.attach("team-server-content", {
      body: JSON.stringify({ status: response.status(), headings: await main.locator("h1, h2, h3").allTextContents(), text }, null, 2),
      contentType: "application/json",
    });
    expect(response.status()).toBe(200);
    await expect(main.locator("h1")).toHaveText("Meet the Team");
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(main).toContainText("Synthetic Crew");
    for (const name of cmsTeam) await expect(main.getByText(name, { exact: true })).toHaveCount(1);
    for (const name of fallbackOnly) expect(text).not.toContain(name);
    await expect(page.locator('section[aria-label="No-JS SEO fallback"]')).toHaveCount(0);
  });
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`/meet-the-team hydrates the server-rendered team without swapping it at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const messages = [];
    const teamRequests = [];
    page.on("console", message => messages.push(`${message.type()}: ${message.text()}`));
    page.on("pageerror", error => messages.push(`pageerror: ${error.message}`));
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/content/team") teamRequests.push(request.url());
    });
    await page.addInitScript(() => {
      window.__teamShift = 0;
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__teamShift += entry.value;
      }).observe({ type: "layout-shift", buffered: true });
      document.addEventListener("DOMContentLoaded", () => {
        window.__teamCardAtLoad = [...document.querySelectorAll("main *")].find(node => node.childElementCount === 0 && node.textContent.trim() === "Fixture Member Alpha") || null;
      });
    });
    await page.goto("/meet-the-team", { waitUntil: "networkidle" });
    const main = page.locator("main#main-content");
    const state = await page.evaluate(() => ({
      cardAtLoad: window.__teamCardAtLoad?.textContent ?? null,
      sameCard: Boolean(window.__teamCardAtLoad?.isConnected),
      layoutShift: window.__teamShift,
    }));
    await testInfo.attach("team-hydration", {
      body: JSON.stringify({ viewport, ...state, teamRequests, messages }, null, 2),
      contentType: "application/json",
    });
    expect(state.cardAtLoad).toBe("Fixture Member Alpha");
    expect(state.sameCard).toBe(true);
    expect(teamRequests).toEqual([]);
    expect(state.layoutShift).toBeLessThan(0.01);
    await expect(main.locator("h1")).toHaveText("Meet the Team");
    for (const name of cmsTeam) await expect(main.getByText(name, { exact: true })).toHaveCount(1);
    for (const name of fallbackOnly) await expect(main.getByText(name, { exact: true })).toHaveCount(0);
    expect(messages.filter(message => /hydrat|did not match|server rendered|server HTML|#418|#423|#425/i.test(message))).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("team-hydrated.png"), fullPage: true, animations: "disabled" });
  });
}

test("/meet-the-team fetches the team again when revisited inside the app", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const teamRequests = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/content/team") teamRequests.push(request.url());
  });
  await page.goto("/meet-the-team", { waitUntil: "networkidle" });
  expect(teamRequests).toEqual([]);
  await page.getByRole("link", { name: "Roo Industries Precision Performance Engineering", exact: true }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("button", { name: "Open menu" }).click();
  const revisit = page.waitForResponse(response => new URL(response.url()).pathname === "/api/content/team", { timeout: 15000 });
  await page.getByRole("link", { name: "Meet the Team", exact: true }).filter({ visible: true }).click();
  const response = await revisit;
  await testInfo.attach("team-revisit", { body: JSON.stringify({ teamRequests, status: response.status() }, null, 2), contentType: "application/json" });
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(/\/meet-the-team$/);
  await expect(page.locator("main#main-content").getByText("Fixture Member Alpha", { exact: true })).toHaveCount(1);
});
