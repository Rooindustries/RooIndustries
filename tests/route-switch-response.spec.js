const fs = require("node:fs");
const path = require("node:path");
const { test: base, expect } = require("@playwright/test");
const { heldRouteFixtures } = require("./fixtures/held-routes.cjs");
const { navLink } = require("./fixtures/nav-link.cjs");
const {
  targets, holdTarget, installMeasurement, armMeasurement, openPage, proofClick,
} = require("./fixtures/route-switch-response.cjs");

const test = base.extend(heldRouteFixtures);
const entries = [
  { id: 1, name: "Desktop Proof: Benchmarks", start: "/", target: "benchmarks", menu: "Proof", link: "Benchmarks" },
  { id: 2, name: "Desktop Proof: Reviews", start: "/about", target: "reviews", menu: "Proof", link: "Reviews" },
  { id: 3, name: "Desktop Referrals: Sign Up", start: "/reviews", target: "register",
    menu: "Referrals", link: "Sign Up" },
  { id: 4, name: "Desktop Referrals: Dashboard", start: "/reviews", target: "login",
    menu: "Referrals", link: "Dashboard" },
  { id: 5, name: "Desktop Benefits", start: "/reviews", target: "home", nav: "benefits" },
  { id: 6, name: "Desktop FAQ", start: "/reviews", target: "home", nav: "faq" },
  { id: 7, name: "Desktop Packages button", start: "/reviews", target: "home", nav: "plans" },
  { id: 8, name: "Desktop logo", start: "/reviews", target: "home", logo: true },
];
const scoreDir = path.resolve("test-results");
const stateFile = path.join(scoreDir, "route-switch-state.json");
const scoreFile = path.join(scoreDir, "route-switch-score.json");
const runId = process.ppid;

const readState = () => {
  if (!fs.existsSync(stateFile)) return { runId, results: {} };
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  return state.runId === runId ? state : { runId, results: {} };
};

test.use({ javaScriptEnabled: true, viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
test.beforeEach(async ({ page, context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  await installMeasurement(page);
});

test.describe("Scored page switches", () => {
  test.afterEach(async ({}, info) => {
    fs.mkdirSync(scoreDir, { recursive: true });
    const state = readState();
    state.results[info.title] = info.status === "passed";
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  });

  test.afterAll(async () => {
    const state = readState();
    if (Object.keys(state.results).length !== entries.length + 1) return;
    const failures = Object.entries(state.results).filter(([, passed]) => !passed).map(([name]) => name);
    fs.writeFileSync(scoreFile, JSON.stringify({ failures }, null, 2));
    console.log(`ROUTE SWITCH FAILURES: ${failures.length}/35`);
  });

  for (const entry of entries) {
    test(`${entry.id}. ${entry.name}`, async ({ page, baseURL }, info) => {
      const held = await holdTarget(page, baseURL, entry.target, info.config.metadata.toolingDistDir);
      try {
        await openPage(page, entry.start);
        if (entry.menu) {
          await page.locator(`button[aria-controls="desktop-${entry.menu.toLowerCase()}-menu"]`).click();
        }
        await armMeasurement(page, entry.target);
        if (entry.menu) {
          await page.locator(`#desktop-${entry.menu.toLowerCase()}-menu`)
            .getByRole("link", { name: entry.link, exact: true }).click();
        } else if (entry.nav) {
          await page.locator(navLink(entry.nav)).click();
        } else {
          await page.locator('[data-nav-row] a[href="/"]:visible').click();
        }
        await expect.poll(() => held.chunk.held, { message: "the first page file is held" }).toBe(true);
        await page.waitForFunction(() => window.routeSwitchMeasurement.measured);
        const second = entry.target === "benchmarks" ? "reviews" : "benchmarks";
        await proofClick(page, second === "reviews" ? "Reviews" : "Benchmarks");
        await expect(page).toHaveURL(new RegExp(`${targets[second].route}$`));
        await expect(page.locator(`#main-content [data-route-key="${targets[second].route}"] h1`)).toBeVisible();
        const finished = held.finished();
        held.release();
        await finished;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const result = await page.evaluate(() => window.routeSwitchMeasurement);
        expect(result.mounted, "the superseded page never mounted").toBe(false);
        await expect(page).toHaveURL(new RegExp(`${targets[second].route}$`));
        await expect(page.getByRole("heading", { name: /We couldn.t load this page/ })).toHaveCount(0);
        expect(result.response, "a response is visible within 300 ms").not.toBeNull();
        expect(result.response, "a response is visible within 300 ms").toBeLessThanOrEqual(300);
      } finally {
        held.release();
      }
    });
  }

  test("34. Proof stays open when Benchmarks lands", async ({ page, baseURL }, info) => {
    const benchmarks = await holdTarget(page, baseURL, "benchmarks", info.config.metadata.toolingDistDir);
    let reviews;
    try {
      await openPage(page, "/");
      await proofClick(page, "Benchmarks");
      await expect.poll(() => benchmarks.chunk.held).toBe(true);
      const proof = page.locator('button[aria-controls="desktop-proof-menu"]');
      await proof.click();
      const finished = benchmarks.finished();
      benchmarks.release();
      await finished;
      await expect(page).toHaveURL(/\/benchmarks$/);
      await expect(page.getByRole("heading", { name: "Performance Benchmarks" })).toBeVisible();
      const expanded = await proof.getAttribute("aria-expanded");
      expect.soft(expanded, "Proof remains open when Benchmarks lands").toBe("true");
      if (expanded !== "true") await proof.click();
      reviews = await holdTarget(page, baseURL, "reviews", info.config.metadata.toolingDistDir);
      await page.locator("#desktop-proof-menu").getByRole("link", { name: "Reviews", exact: true }).click();
      await expect.poll(() => reviews.chunk.held).toBe(true);
      const reviewFinished = reviews.finished();
      reviews.release();
      await reviewFinished;
      await expect(page).toHaveURL(/\/reviews$/);
      await expect(page.getByRole("heading", { name: "Community Reviews" })).toBeVisible();
      await expect(page.getByRole("heading", { name: /We couldn.t load this page/ })).toHaveCount(0);
    } finally {
      benchmarks.release();
      reviews?.release();
    }
  });
});
