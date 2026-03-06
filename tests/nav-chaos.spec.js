const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  throw new Error("BASE_URL is required for nav-chaos tests.");
}
if (BASE_URL !== "http://127.0.0.1:3001") {
  throw new Error(`Unexpected BASE_URL for nav-chaos suite: ${BASE_URL}`);
}

test.use({ javaScriptEnabled: true });
test.describe.configure({ mode: "serial" });

const auditDir = path.join(process.cwd(), "audit");
const chaosReportPath = path.join(auditDir, "phase1-nav-chaos.md");
const failures = [];
const notes = [];

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
    const currentHash = new URL(page.url()).hash;
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
    if (currentHash === hash && top !== null && Math.abs(top) <= 160) {
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

  await page.goBack();
  const pathAfterBack = new URL(page.url()).pathname;
  if (pathAfterBack !== "/reviews") {
    await recordFailure(page, "history:back", `expected_/reviews_got_${pathAfterBack}`);
  }

  await page.goForward();
  const hashAfterForward = new URL(page.url()).hash;
  if (hashAfterForward !== "#faq") {
    await recordFailure(
      page,
      "history:forward",
      `expected_#faq_got_${hashAfterForward || "none"}`
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

  await page.goto("/meet-the-team", { waitUntil: "domcontentloaded" });
  await clickDesktopTarget(page, "faq");
  await page.waitForTimeout(10);
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

test("visibility transition does not break section navigation", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto("/benchmarks", { waitUntil: "domcontentloaded" });

  if (browserName !== "chromium") {
    notes.push("Visibility transition test skipped for non-chromium browser.");
    return;
  }

  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setPageVisibilityState", {
      visibilityState: "hidden",
    });
    await cdp.send("Emulation.setPageVisibilityState", {
      visibilityState: "visible",
    });
  } catch (err) {
    notes.push(`Visibility transition API unavailable: ${String(err.message || err)}`);
  }

  await clickDesktopTarget(page, "benefits");
  const ok = await verifyHashAndTarget(page, "#services", 3500);
  if (!ok) {
    await recordFailure(page, "visibility:benefits", "failed_after_visibility_transition");
  } else if (hasHostDrift(page.url())) {
    await recordFailure(page, "visibility:benefits", "host_drift");
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

  if (notes.length) {
    lines.push("## Notes", "");
    notes.forEach((note) => lines.push(`- ${note}`));
    lines.push("");
  }

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
  expect(failures, "chaos navigation failures").toEqual([]);
});
