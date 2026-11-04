const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const { launchUnemulatedChromium } = require("./fixtures/unemulated-chromium.cjs");

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  throw new Error("BASE_URL is required for nav-chaos tests.");
}
let testUrl;
try {
  testUrl = new URL(BASE_URL);
} catch {
  testUrl = null;
}
if (
  !testUrl ||
  !["http:", "https:"].includes(testUrl.protocol) ||
  !["localhost", "127.0.0.1", "[::1]", testHost].includes(testUrl.hostname)
) {
  throw new Error(`Unexpected BASE_URL for nav-chaos suite: ${BASE_URL}`);
}

test.use({ javaScriptEnabled: true });

const auditDir = path.join(process.cwd(), "audit");
const chaosReportPath = path.join(auditDir, "phase1-nav-chaos.md");
const chaosStatePath = path.join(auditDir, "phase1-nav-chaos.json");
const runId = process.ppid;
const earlierRun = (() => {
  try {
    const state = JSON.parse(fs.readFileSync(chaosStatePath, "utf8"));
    return state.runId === runId ? state : null;
  } catch {
    return null;
  }
})();
const failures = earlierRun?.failures || [];
const CPU_THROTTLE_RATE = Number(process.env.NAV_CPU_THROTTLE_RATE || 1);
if (!Number.isFinite(CPU_THROTTLE_RATE) || CPU_THROTTLE_RATE < 1 || CPU_THROTTLE_RATE > 4) {
  throw new Error("NAV_CPU_THROTTLE_RATE must be between 1 and 4.");
}

const ORIGINS = ["/benchmarks", "/reviews", "/meet-the-team"];
const ACTIONS = [
  { label: "Benefits", hash: "#services", target: "benefits" },
  { label: "Plans", hash: "#packages", target: "plans" },
  { label: "FAQ", hash: "#faq", target: "faq" },
];

const clickDesktopTarget = async (page, target) => {
  await page
    .locator(`[data-nav-surface="desktop"][data-nav-target="${target}"]`)
    .first()
    .click();
};

const recordFailure = async (page, context, reason) => {
  fs.mkdirSync(auditDir, { recursive: true });
  const shot = path.join(
    auditDir,
    `chaos-failure-${Date.now()}-${context.replace(/[^a-z0-9-_]/gi, "_")}.png`
  );
  await page.screenshot({ path: shot, fullPage: true });
  failures.push({
    context,
    reason,
    url: page.url(),
    screenshot: shot,
  });
};

const verifyHashAndTarget = async (page, hash, settleMs = 2500) => {
  const start = Date.now();
  while (Date.now() - start <= settleMs) {
    const current = new URL(page.url());
    let top = null;
    try {
      top = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        return Math.round(el.getBoundingClientRect().top);
      }, hash);
    } catch (error) {
      const message = String(error?.message || error || "");
      const isExpectedNavigationRace =
        message.includes("Execution context was destroyed") ||
        message.includes("Cannot find context with specified id") ||
        message.includes("Target page, context or browser has been closed") ||
        message.includes("Frame was detached");

      if (!isExpectedNavigationRace) {
        throw error;
      }

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(50);
      continue;
    }
    if (current.pathname === "/" && current.hash === hash && top !== null && Math.abs(top) <= 160) {
      return true;
    }
    await page.waitForTimeout(50);
  }
  return false;
};

const hasHostDrift = (url) => !String(url || "").startsWith(BASE_URL);

test("rapid click storm on section links remains deterministic", async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  for (const origin of ORIGINS) {
    for (const action of ACTIONS) {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      for (let i = 0; i < 8; i += 1) {
        await clickDesktopTarget(page, action.target);
      }
      const ok = await verifyHashAndTarget(page, action.hash, 3000);
      if (!ok) {
        await recordFailure(
          page,
          `storm:${origin}:${action.label}`,
          "failed_to_stabilize_after_rapid_clicks"
        );
      } else if (hasHostDrift(page.url())) {
        await recordFailure(page, `storm:${origin}:${action.label}`, "host_drift");
      }
    }
  }
});

test("click while page is actively scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  for (const origin of ORIGINS) {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.mouse.wheel(0, 1800);
    await page.mouse.wheel(0, -1200);
    await clickDesktopTarget(page, "plans");
    const ok = await verifyHashAndTarget(page, "#packages", 3000);
    if (!ok) {
      await recordFailure(
        page,
        `scroll-click:${origin}:Plans`,
        "failed_to_land_after_scroll_motion"
      );
    } else if (hasHostDrift(page.url())) {
      await recordFailure(page, `scroll-click:${origin}:Plans`, "host_drift");
    }
  }
});

test("back/forward behavior stays idempotent after hash jumps", async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto("/reviews", { waitUntil: "domcontentloaded" });
  await clickDesktopTarget(page, "faq");
  const landed = await verifyHashAndTarget(page, "#faq", 3000);
  if (!landed) {
    await recordFailure(page, "history:land", "initial_hash_navigation_failed");
    return;
  }
  if (hasHostDrift(page.url())) {
    await recordFailure(page, "history:land", "host_drift");
  }
  const historyLength = await page.evaluate(() => window.history.length);

  await page.goBack();
  const backLanded = await page
    .waitForFunction(
      () =>
        window.location.pathname === "/reviews" &&
        !window.location.hash &&
        Boolean(document.querySelector('main [data-route-key="/reviews"]')),
      null,
      { timeout: 3000 }
    )
    .then(() => true, () => false);
  if (!backLanded) {
    const pathAfterBack = new URL(page.url()).pathname;
    await recordFailure(page, "history:back", `expected_/reviews_got_${pathAfterBack}`);
  }

  await page.goForward();
  const forwardLanded = await verifyHashAndTarget(page, "#faq", 3000);
  if (!forwardLanded) {
    const hashAfterForward = new URL(page.url()).hash;
    await recordFailure(
      page,
      "history:forward",
      `expected_#faq_got_${hashAfterForward || "none"}`
    );
  }
  const historyLengthAfter = await page.evaluate(() => window.history.length);
  if (historyLengthAfter !== historyLength) {
    await recordFailure(
      page,
      "history:entries",
      `expected_${historyLength}_entries_got_${historyLengthAfter}`
    );
  }
});

test("latest rapid navbar click wins across section and route transitions", async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });

  await page.goto("/meet-the-team", { waitUntil: "domcontentloaded" });
  await clickDesktopTarget(page, "benefits");
  await page.waitForTimeout(10);
  await clickDesktopTarget(page, "faq");
  const faqWon = await verifyHashAndTarget(page, "#faq", 3500);
  if (!faqWon) {
    await recordFailure(
      page,
      "latest-click:benefits-then-faq",
      "latest_section_target_did_not_win"
    );
  } else if (hasHostDrift(page.url())) {
    await recordFailure(page, "latest-click:benefits-then-faq", "host_drift");
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/meet-the-team", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Open menu"]');
    return button && Object.keys(button).some(key => key.startsWith("__reactProps$"));
  });
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.locator('[data-nav-surface="mobile"][data-nav-target="faq"]').click();
  await page.waitForTimeout(10);
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Meet the Team" }).first().click();
  await page.waitForTimeout(1200);
  const pathAfterRouteClick = new URL(page.url()).pathname;
  const hashAfterRouteClick = new URL(page.url()).hash;
  const routeScrollY = await page.evaluate(() => Math.round(window.scrollY));

  if (pathAfterRouteClick !== "/meet-the-team" || hashAfterRouteClick) {
    await recordFailure(
      page,
      "latest-click:faq-then-team",
      `expected_/meet-the-team_without_hash_got_${pathAfterRouteClick}${hashAfterRouteClick || ""}`
    );
  } else if (routeScrollY > 160) {
    await recordFailure(
      page,
      "latest-click:faq-then-team",
      `expected_route_scroll_reset_got_${routeScrollY}`
    );
  } else if (hasHostDrift(page.url())) {
    await recordFailure(page, "latest-click:faq-then-team", "host_drift");
  }
});

test("visibility transition does not break section navigation", async ({ baseURL }, testInfo) => {
  const browser = await launchUnemulatedChromium({
    baseURL,
    userDataDir: testInfo.outputPath("unemulated-chromium"),
    width: 1536,
    height: 960,
  });
  try {
    const tab = await browser.openTab(`${baseURL}/benchmarks`);
    await tab.evaluate(() => {
      window.__visibilityStates = [document.visibilityState];
      document.addEventListener("visibilitychange", () => {
        window.__visibilityStates.push(document.visibilityState);
      });
    });
    const hydrated = await tab.waitFor(() => {
      const link = document.querySelector('[data-nav-surface="desktop"][data-nav-target="benefits"]');
      return Boolean(link && Object.keys(link).some((key) => key.startsWith("__reactProps$")));
    });
    expect(hydrated, "benefits link hydrated").toBe(true);

    const otherTab = await browser.openTab("about:blank");
    expect(await tab.waitFor(() => document.visibilityState === "hidden"), "page hidden behind another tab").toBe(true);
    await tab.activate();
    expect(await tab.waitFor(() => document.visibilityState === "visible"), "page visible again").toBe(true);
    await otherTab.close();

    const states = await tab.evaluate(() => window.__visibilityStates);
    testInfo.annotations.push({ type: "visibility states", description: states.join(" -> ") });
    expect(states).toEqual(["visible", "hidden", "visible"]);

    await tab.click('[data-nav-surface="desktop"][data-nav-target="benefits"]');
    const landed = await tab.waitFor(() => {
      const target = document.querySelector("#services");
      return (
        window.location.pathname === "/" &&
        window.location.hash === "#services" &&
        Boolean(target) &&
        Math.abs(Math.round(target.getBoundingClientRect().top)) <= 160
      );
    }, null, 3500);
    if (!landed) {
      fs.mkdirSync(auditDir, { recursive: true });
      const screenshot = path.join(auditDir, `chaos-failure-${Date.now()}-visibility_benefits.png`);
      await tab.screenshot(screenshot);
      failures.push({
        context: "visibility:benefits",
        reason: "failed_after_visibility_transition",
        url: await tab.evaluate(() => window.location.href),
        screenshot,
      });
    }
    expect(browser.blockedRequests, "nonlocal browser requests").toEqual([]);
  } finally {
    await browser.close();
  }
});

test.afterAll(async () => {
  fs.mkdirSync(auditDir, { recursive: true });
  const lines = [
    "# Phase 1 Nav Chaos Report",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Failures: ${failures.length}`,
    "",
  ];

  if (failures.length) {
    lines.push("## Failures", "");
    failures.forEach((f, idx) => {
      lines.push(
        `${idx + 1}. Context: \`${f.context}\` | Reason: \`${f.reason}\` | URL: ${f.url} | Screenshot: ${f.screenshot}`
      );
    });
  } else {
    lines.push("## Result", "", "- All chaos interaction scenarios passed.");
  }

  fs.writeFileSync(chaosReportPath, lines.join("\n"));
  fs.writeFileSync(chaosStatePath, JSON.stringify({ runId, failures }, null, 2));
});

let failuresAtStart = 0;

test.beforeEach(async ({ context, page, baseURL }) => {
  failuresAtStart = failures.length;
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  if (CPU_THROTTLE_RATE > 1) {
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE_RATE });
  }
});

test.afterEach(async () => {
  expect(failures.slice(failuresAtStart), "chaos navigation failures").toEqual([]);
});
