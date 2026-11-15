const fs = require("node:fs");
const path = require("node:path");
const { test: base, expect } = require("@playwright/test");
const { heldRouteFixtures } = require("./fixtures/held-routes.cjs");
const { navLink } = require("./fixtures/nav-link.cjs");
const {
  targets, holdTarget, holdTargets, installMeasurement, armMeasurement, openPage, proofClick, finishSuperseded,
  openBooking, watchBar, barWasSeen,
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
  { id: 9, name: "Phone Proof: Benchmarks", start: "/", target: "benchmarks", mobile: true,
    menu: "Proof", link: "Benchmarks" },
  { id: 10, name: "Phone Proof: Reviews", start: "/about", target: "reviews", mobile: true,
    menu: "Proof", link: "Reviews" },
  { id: 11, name: "Phone Referrals: Sign Up", start: "/reviews", target: "register", mobile: true,
    menu: "Referrals", link: "Sign Up" },
  { id: 12, name: "Phone Referrals: Dashboard", start: "/reviews", target: "login", mobile: true,
    menu: "Referrals", link: "Dashboard" },
  { id: 13, name: "Phone Meet the Team", start: "/reviews", target: "team", mobile: true, menuLink: "Meet the Team" },
  { id: 14, name: "Phone Benefits", start: "/reviews", target: "home", mobile: true, nav: "benefits" },
  { id: 15, name: "Phone FAQ", start: "/reviews", target: "home", mobile: true, nav: "faq" },
  { id: 16, name: "Phone menu Packages", start: "/reviews", target: "home", mobile: true, nav: "plans" },
  { id: 17, name: "Phone Packages button", start: "/reviews", target: "home", mobile: true, nav: "plans", bar: true },
  { id: 18, name: "Phone logo", start: "/reviews", target: "home", mobile: true, logo: true },
  { id: 19, name: "Footer logo", start: "/reviews", target: "home", footer: "/" },
  { id: 20, name: "Footer Tools", start: "/reviews", target: "tools", footer: "/tools" },
  { id: 21, name: "Footer About", start: "/reviews", target: "about", footer: "/about" },
  { id: 22, name: "Footer Privacy Policy", start: "/reviews", target: "privacy", footer: "/privacy" },
  { id: 23, name: "Footer Terms of Service", start: "/reviews", target: "terms", footer: "/terms" },
  { id: 24, name: "Benchmarks: See the packages", start: "/benchmarks", target: "packages", link: "See the packages" },
  { id: 25, name: "Tools: See the packages", start: "/tools", target: "packages", link: "See the packages" },
  { id: 26, name: "Tools: Read the FAQ", start: "/tools", target: "home", link: "Read the FAQ", emptyTools: true },
  { id: 27, name: "Packages: Reviews", start: "/packages", target: "reviews", content: 'a[href="/reviews"]' },
  { id: 28, name: "About: Reviews", start: "/about", target: "reviews", about: true },
  { id: 29, name: "Missing page: Home", start: "/no-such-page", target: "home", link: "Back to Home" },
  { id: 30, name: "Download: Contact us", start: "/downloads/utilities", target: "contact", link: "Contact us" },
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
test.describe.configure({ retries: 0 });
test.beforeEach(async ({ page, context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  await installMeasurement(page);
});

test("Back, Forward and the back button close the phone menu without a loading flash", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, "/about");
  await proofClick(page, "Benchmarks", true);
  await expect(page).toHaveURL(/\/benchmarks$/);
  await proofClick(page, "Reviews", true);
  await expect(page).toHaveURL(/\/reviews$/);
  await watchBar(page);
  const menu = page.getByRole("button", { name: "Open menu" });
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.goBack();
  await expect(page).toHaveURL(/\/benchmarks$/);
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  expect(await barWasSeen(page)).toBe(false);
  await watchBar(page);
  await menu.click();
  await page.goForward();
  await expect(page).toHaveURL(/\/reviews$/);
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  expect(await barWasSeen(page)).toBe(false);
  await watchBar(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Go Back" }).click();
  await expect(page).toHaveURL(/\/benchmarks$/);
  expect(await barWasSeen(page)).toBe(false);
});

test("A loaded page switches without a loading flash", async ({ page }) => {
  await openPage(page, "/about");
  await proofClick(page, "Benchmarks");
  await expect(page).toHaveURL(/\/benchmarks$/);
  await proofClick(page, "Reviews");
  await expect(page).toHaveURL(/\/reviews$/);
  await watchBar(page);
  await proofClick(page, "Benchmarks");
  await expect(page).toHaveURL(/\/benchmarks$/);
  await expect(page.getByRole("heading", { name: "Performance Benchmarks" })).toBeVisible();
  expect(await barWasSeen(page)).toBe(false);
});

test("Reduced motion shows a static loading line", async ({ page, baseURL }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const held = await holdTarget(page, baseURL, "benchmarks", info.config.metadata.toolingDistDir);
  try {
    await openPage(page, "/");
    await page.locator('button[aria-controls="desktop-proof-menu"]').click();
    await armMeasurement(page, "benchmarks");
    await page.locator("#desktop-proof-menu").getByRole("link", { name: "Benchmarks" }).click();
    await held.waiting;
    expect(held.chunk.held).toBe(true);
    await page.waitForFunction(() => window.routeSwitchMeasurement.measured);
    const response = await page.evaluate(() => window.routeSwitchMeasurement.response);
    expect(response, "the reduced-motion line is visible within 300 ms").not.toBeNull();
    expect(response).toBeLessThanOrEqual(300);
    const bar = page.getByRole("progressbar", { name: "Loading page" });
    await expect(bar).toBeVisible();
    const segment = bar.locator(":scope > *").first();
    await expect(segment).toBeVisible();
    expect(await segment.evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  } finally {
    held.release();
  }
});

test("A held switch keeps the navigation row fixed without layout shift", async ({ page, baseURL }, info) => {
  const held = await holdTarget(page, baseURL, "benchmarks", info.config.metadata.toolingDistDir);
  try {
    await openPage(page, "/about");
    await page.evaluate(() => document.fonts.ready);
    await page.locator('button[aria-controls="desktop-proof-menu"]').click();
    const row = page.locator("[data-nav-row]");
    const before = await row.evaluate(node => ({ top: node.getBoundingClientRect().top, height: node.offsetHeight }));
    await page.evaluate(() => {
      window.routeLayoutShifts = [];
      window.routeLayoutObserver = new PerformanceObserver(list => {
        window.routeLayoutShifts.push(...list.getEntries().map(entry => entry.value));
      });
      window.routeLayoutObserver.observe({ type: "layout-shift" });
    });
    await armMeasurement(page, "benchmarks");
    await page.locator("#desktop-proof-menu").getByRole("link", { name: "Benchmarks" }).click();
    await held.waiting;
    expect(held.chunk.held).toBe(true);
    await page.waitForFunction(() => window.routeSwitchMeasurement.measured);
    const during = await row.evaluate(node => ({ top: node.getBoundingClientRect().top, height: node.offsetHeight }));
    const shifts = await page.evaluate(() => {
      const observer = window.routeLayoutObserver;
      window.routeLayoutShifts.push(...observer.takeRecords().map(entry => entry.value));
      observer.disconnect();
      return window.routeLayoutShifts;
    });
    const finished = held.finished();
    held.release();
    await finished;
    await expect(page).toHaveURL(/\/benchmarks$/);
    await expect(page.getByRole("heading", { name: "Performance Benchmarks" })).toBeVisible();
    const after = await row.evaluate(node => ({ top: node.getBoundingClientRect().top, height: node.offsetHeight }));
    expect(during).toEqual(before);
    expect(after).toEqual(before);
    expect(shifts.reduce((total, value) => total + value, 0)).toBe(0);
  } finally {
    held.release();
  }
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
    if (Object.keys(state.results).length !== entries.length + 4) return;
    const failures = Object.entries(state.results).filter(([, passed]) => !passed).map(([name]) => name);
    fs.writeFileSync(scoreFile, JSON.stringify({ failures }, null, 2));
    console.log(`ROUTE SWITCH FAILURES: ${failures.length}/34`);
  });

  for (const entry of entries) {
    test(`${entry.id}. ${entry.name}`, async ({ page, baseURL }, info) => {
      if (entry.mobile) await page.setViewportSize({ width: 390, height: 844 });
      const held = await holdTarget(page, baseURL, entry.target, info.config.metadata.toolingDistDir);
      try {
        if (entry.emptyTools) {
          await page.route("**/api/content/tools", route => route.fulfill({ json: { ok: true, data: [] } }));
          await openPage(page, "/about");
          await page.locator('footer a[href="/tools"]').click();
          await expect(page).toHaveURL(/\/tools$/);
          await expect(page.getByRole("link", { name: "Read the FAQ" })).toBeVisible();
        } else {
          await openPage(page, entry.start);
        }
        if (entry.id === 30) await page.getByRole("button", { name: "Verify and Download" }).click();
        if (entry.mobile && (entry.menu || entry.menuLink || (entry.nav && !entry.bar))) {
          await page.getByRole("button", { name: "Open menu" }).click();
        }
        const surface = entry.mobile ? "mobile" : "desktop";
        if (entry.menu) {
          await page.locator(`button[aria-controls="${surface}-${entry.menu.toLowerCase()}-menu"]`).click();
        }
        await armMeasurement(page, entry.target);
        if (entry.menu) {
          await page.locator(`#${surface}-${entry.menu.toLowerCase()}-menu`)
            .getByRole("link", { name: entry.link, exact: true }).click();
        } else if (entry.nav) {
          const selector = entry.mobile && !entry.bar
            ? `[data-nav-surface="mobile"][data-nav-target="${entry.nav}"]` : navLink(entry.nav);
          await page.locator(selector).click();
        } else if (entry.logo) {
          await page.locator('[data-nav-row] a[href="/"]:visible').click();
        } else if (entry.footer) {
          await page.locator(`footer a[href="${entry.footer}"]`).click();
        } else if (entry.about) {
          await page.locator('nav[aria-label="About Roo Industries"] a[href="/reviews"]').click();
        } else if (entry.menuLink) {
          await page.locator("#mobile-site-menu").getByRole("link", { name: entry.menuLink, exact: true }).click();
        } else if (entry.content) {
          await page.locator(`#main-content ${entry.content}`).click();
        } else {
          await page.getByRole("link", { name: entry.link, exact: true }).click();
        }
        await held.waiting;
        expect(held.chunk.held, "the first page file is held").toBe(true);
        await page.waitForFunction(() => window.routeSwitchMeasurement.measured);
        const second = entry.target === "benchmarks" ? "reviews" : "benchmarks";
        await proofClick(page, second === "reviews" ? "Reviews" : "Benchmarks", entry.mobile);
        await finishSuperseded(page, held, targets[second].route);
      } finally {
        held.release();
      }
    });
  }

  test("31. Packages: Book a package", async ({ page, baseURL }, info) => {
    const held = await holdTarget(page, baseURL, "booking", info.config.metadata.toolingDistDir);
    try {
      await openPage(page, "/packages");
      await armMeasurement(page, "booking");
      await page.locator(".ri-package-book-button").first().click();
      await held.waiting;
      expect(held.chunk.held, "the booking page file is held").toBe(true);
      await page.waitForFunction(() => window.routeSwitchMeasurement.measured);
      await expect(page.locator("#booking-modal-close")).toBeVisible();
      await page.locator("#booking-modal-close").click();
      await finishSuperseded(page, held, "/packages", "h2");
    } finally {
      held.release();
    }
  });

  test("32. Booking: Future Upgrade Path", async ({ page, baseURL }, info) => {
    const held = await holdTarget(page, baseURL, "home", info.config.metadata.toolingDistDir);
    try {
      await openBooking(page);
      await page.getByRole("button", { name: "View My Plan" }).click();
      await expect(page.getByRole("link", { name: "Future Upgrade Path" })).toBeVisible();
      await armMeasurement(page, "home");
      await page.getByRole("link", { name: "Future Upgrade Path" }).click();
      await held.waiting;
      expect(held.chunk.held, "the home page file is held").toBe(true);
      await page.waitForFunction(() => window.routeSwitchMeasurement.measured);
      await page.locator("#booking-modal-close").click();
      await finishSuperseded(page, held, "/packages", "h2");
    } finally {
      held.release();
    }
  });

  test("33. Booking: Contact us after availability fails", async ({ page, baseURL }, info) => {
    const held = await holdTarget(page, baseURL, "contact", info.config.metadata.toolingDistDir);
    try {
      const availability = await openBooking(page);
      availability.fail = true;
      await page.getByRole("button", { name: "Check again" }).click();
      await expect(page.getByText("Booking availability took too long to load.", { exact: true })).toBeVisible();
      await armMeasurement(page, "contact");
      await page.getByRole("link", { name: "Contact us", exact: true }).click();
      await held.waiting;
      expect(held.chunk.held, "the contact page file is held").toBe(true);
      await page.waitForFunction(() => window.routeSwitchMeasurement.measured);
      await page.locator("#booking-modal-close").click();
      await finishSuperseded(page, held, "/packages", "h2");
    } finally {
      held.release();
    }
  });

  test("34. Proof stays open when Benchmarks lands", async ({ page, baseURL }, info) => {
    const { benchmarks, reviews } = await holdTargets(
      page, baseURL, ["benchmarks", "reviews"], info.config.metadata.toolingDistDir,
    );
    try {
      await openPage(page, "/");
      await proofClick(page, "Benchmarks");
      await benchmarks.waiting;
      expect(benchmarks.chunk.held).toBe(true);
      const proof = page.locator('button[aria-controls="desktop-proof-menu"]');
      await proof.click();
      const finished = benchmarks.finished();
      benchmarks.release();
      await finished;
      await expect(page).toHaveURL(/\/benchmarks$/);
      await expect(page.getByRole("heading", { name: "Performance Benchmarks" })).toBeVisible();
      await expect(page.locator('.route-progress')).toHaveAttribute("data-state", "idle");
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const expanded = await proof.getAttribute("aria-expanded");
      expect.soft(expanded, "Proof remains open when Benchmarks lands").toBe("true");
      if (expanded !== "true") await proof.click();
      await page.locator("#desktop-proof-menu").getByRole("link", { name: "Reviews", exact: true }).click();
      await reviews.waiting;
      expect(reviews.chunk.held).toBe(true);
      const reviewFinished = reviews.finished();
      reviews.release();
      await reviewFinished;
      await expect(page).toHaveURL(/\/reviews$/);
      await expect(page.getByRole("heading", { name: "Community Reviews" })).toBeVisible();
      await expect(page.getByRole("heading", { name: /We couldn.t load this page/ })).toHaveCount(0);
    } finally {
      benchmarks.release();
      reviews.release();
    }
  });

});
