const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const { waitForHydrated } = require("./fixtures/react-hydration.cjs");
const { navLink } = require("./fixtures/nav-link.cjs");

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  throw new Error("BASE_URL is required for section-nav reliability tests.");
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
  throw new Error(
    `Unexpected BASE_URL for mission-critical nav suite: ${BASE_URL}`
  );
}

test.use({ javaScriptEnabled: true });

const DEFAULT_REPEAT_COUNTS = {
  desktop: Number(process.env.NAV_REPEAT_COUNT_DESKTOP || 5),
  mobile: Number(process.env.NAV_REPEAT_COUNT_MOBILE || 3),
};
if (!Object.values(DEFAULT_REPEAT_COUNTS).every((count) => Number.isInteger(count) && count > 0)) {
  throw new Error("Navigation repeat counts must be positive integers.");
}
const FINAL_OFFSET_MAX = 140;
const DRIFT_MAX = 40;
const CPU_THROTTLE_RATE = Number(process.env.NAV_CPU_THROTTLE_RATE || 1);
if (!Number.isFinite(CPU_THROTTLE_RATE) || CPU_THROTTLE_RATE < 1 || CPU_THROTTLE_RATE > 4) {
  throw new Error("NAV_CPU_THROTTLE_RATE must be between 1 and 4.");
}

const VIEWPORTS = [
  {
    name: "desktop",
    viewport: { width: 1536, height: 960 },
    hashLatencyMaxMs: 500,
    settleMaxMs: 1200,
    repeatCount: DEFAULT_REPEAT_COUNTS.desktop,
  },
  {
    name: "mobile",
    viewport: { width: 390, height: 844 },
    hashLatencyMaxMs: 900,
    settleMaxMs: 2200,
    repeatCount: DEFAULT_REPEAT_COUNTS.mobile,
  },
];

const ORIGINS = ["/benchmarks", "/reviews", "/meet-the-team", "/packages", "/tools", "/"];
const ACTIONS = [
  { label: "Benefits", hash: "#services", target: "benefits" },
  { label: "Plans", hash: "#packages", target: "plans" },
  { label: "FAQ", hash: "#faq", target: "faq" },
];
const FLOW_ORIGINS = [
  {
    label: "meet-the-team",
    route: "/meet-the-team",
    open: async (page) => {
      const viewport = page.viewportSize();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await waitForHydrated(page, 'button[aria-label="Open menu"]');
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.getByRole("link", { name: "Meet the Team" }).first().click();
      await page.waitForURL(`${BASE_URL}/meet-the-team`);
      await page.setViewportSize(viewport);
    },
  },
  {
    label: "reviews",
    route: "/reviews",
    open: async (page) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await waitForHydrated(
        page,
        'button[aria-controls="desktop-proof-menu"]'
      );

      const proofButton = page.getByRole("button", { name: "Proof" }).first();
      await proofButton.click();
      await expect(proofButton).toHaveAttribute("aria-expanded", "true");

      const reviewsLink = page.getByRole("link", { name: "Reviews" }).first();
      await reviewsLink.waitFor({ state: "visible" });
      await reviewsLink.click();
      await page.waitForURL(`${BASE_URL}/reviews`);
    },
  },
  {
    label: "benchmarks",
    route: "/benchmarks",
    open: async (page) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await waitForHydrated(
        page,
        'button[aria-controls="desktop-proof-menu"]'
      );

      const proofButton = page.getByRole("button", { name: "Proof" }).first();
      await proofButton.click();
      await expect(proofButton).toHaveAttribute("aria-expanded", "true");

      const benchmarksLink = page
        .getByRole("link", { name: "Benchmarks" })
        .first();
      await benchmarksLink.waitFor({ state: "visible" });
      await benchmarksLink.click();
      await page.waitForURL(`${BASE_URL}/benchmarks`);
    },
  },
];

const auditDir = path.join(process.cwd(), "audit");
const navArtifactPath = path.join(auditDir, "phase1-nav-reliability.json");
const crashArtifactPath = path.join(auditDir, "phase1-client-crash-log.json");
const hydrationArtifactPath = path.join(auditDir, "phase1-hydration-log.json");

const runId = process.ppid;
const readRunArtifact = (file) => {
  try {
    const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
    return artifact.runId === runId ? artifact : null;
  } catch {
    return null;
  }
};
const earlierNav = readRunArtifact(navArtifactPath);
const navMetrics = earlierNav?.metrics || [];
const navFailures = earlierNav?.failures || [];
const settleSummaries = earlierNav?.settleSummaries || [];
const crashLog = readRunArtifact(crashArtifactPath)?.errors || [];

const ensureAuditDir = () => {
  fs.mkdirSync(auditDir, { recursive: true });
};

const nowMs = () => Date.now();

const waitForHash = async (page, expectedHash, timeoutMs) => {
  const start = nowMs();
  while (nowMs() - start <= timeoutMs) {
    const current = new URL(page.url());
    if (current.pathname === "/" && current.hash === expectedHash) {
      return { ok: true, latencyMs: nowMs() - start };
    }
    await page.waitForTimeout(25);
  }
  return { ok: false, latencyMs: nowMs() - start };
};

const measureOffset = async (page, hash) =>
  page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    return Math.round(el.getBoundingClientRect().top);
  }, hash);

const waitForTargetSettle = async (page, hash, timeoutMs) => {
  const start = nowMs();
  let top = null;
  let lastTop = null;
  let stableSince = null;
  while (nowMs() - start <= timeoutMs) {
    top = await measureOffset(page, hash);
    if (top !== null && Math.abs(top) <= FINAL_OFFSET_MAX) {
      if (stableSince === null || lastTop === null || Math.abs(top - lastTop) > 1) {
        stableSince = nowMs();
      }
      if (nowMs() - stableSince >= 150) {
        return { ok: true, timeToTargetMs: nowMs() - start, top };
      }
    } else {
      stableSince = null;
    }
    lastTop = top;
    await page.waitForTimeout(50);
  }
  return {
    ok: false,
    timeToTargetMs: nowMs() - start,
    top,
  };
};

const clickNav = async (page, target, viewportName) => {
  if (viewportName === "mobile") {
    const menuButtonSelector = 'button[aria-label="Open menu"]';
    await waitForHydrated(page, menuButtonSelector);

    const menuButton = page.getByRole("button", { name: "Open menu" });
    await menuButton.click();
    await expect(menuButton).toHaveAttribute("aria-expanded", "true");

    const mobileLink = page
      .locator(`[data-nav-surface="mobile"][data-nav-target="${target}"]`)
      .first();
    await mobileLink.waitFor({ state: "visible" });
    await mobileLink.click();
    return;
  }
  await page
    .locator(navLink(target))
    .first()
    .click();
};

const getDesktopNavRowMetrics = async (page) =>
  page.evaluate(() => {
    const nav = document.querySelector('nav:has([data-nav-surface="desktop"])');
    if (!nav) return null;
    const desktopLinks = [...nav.querySelectorAll('[data-nav-surface="desktop"]')];
    const proofButton = [...nav.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Proof")
    );
    const items = [
      ...desktopLinks.map((el) => ({
        label: el.textContent?.trim() || "",
        top: Math.round(el.getBoundingClientRect().top),
        height: Math.round(el.getBoundingClientRect().height),
      })),
      proofButton
        ? {
            label: "Proof",
            top: Math.round(proofButton.getBoundingClientRect().top),
            height: Math.round(proofButton.getBoundingClientRect().height),
          }
        : null,
    ].filter(Boolean);

    return {
      navHeight: Math.round(nav.getBoundingClientRect().height),
      items,
    };
  });

for (const viewportCfg of VIEWPORTS) {
  test(`section nav reliability matrix (${viewportCfg.name}, repeats=${viewportCfg.repeatCount})`, async ({
    page,
  }) => {
    test.setTimeout(60 * 60 * 1000);
    await page.setViewportSize(viewportCfg.viewport);

    page.on("pageerror", (err) => {
      crashLog.push({
        type: "pageerror",
        message: err.message,
        stack: String(err.stack || ""),
        viewport: viewportCfg.name,
        url: page.url(),
        ts: new Date().toISOString(),
      });
    });

    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      crashLog.push({
        type: "console.error",
        message: msg.text(),
        viewport: viewportCfg.name,
        url: page.url(),
        ts: new Date().toISOString(),
      });
    });

    for (const origin of ORIGINS) {
      for (const action of ACTIONS) {
        for (let run = 1; run <= viewportCfg.repeatCount; run += 1) {
          const caseId = `${viewportCfg.name}:${origin}:${action.label}:run-${run}`;
          const startedAt = nowMs();

          await page.goto(origin, { waitUntil: "domcontentloaded" });
          await clickNav(page, action.target, viewportCfg.name);

          const hashResult = await waitForHash(
            page,
            action.hash,
            viewportCfg.hashLatencyMaxMs + 1200
          );
          await page.waitForSelector(action.hash, { state: "attached" });

          const settleResult = await waitForTargetSettle(
            page,
            action.hash,
            viewportCfg.settleMaxMs + 1500
          );

          const stableTop = settleResult.top;
          await page.waitForTimeout(2000);
          const driftTop = await measureOffset(page, action.hash);
          const driftPx =
            stableTop === null || driftTop === null
              ? Number.POSITIVE_INFINITY
              : Math.abs(driftTop - stableTop);

          const result = {
            caseId,
            viewport: viewportCfg.name,
            origin,
            action: action.label,
            expectedHash: action.hash,
            endUrl: page.url(),
            hashUpdated: hashResult.ok,
            hashLatencyMs: hashResult.latencyMs,
            settled: settleResult.ok,
            settleMs: settleResult.timeToTargetMs,
            finalOffsetPx: driftTop,
            driftPx,
            totalMs: nowMs() - startedAt,
          };
          navMetrics.push(result);

          const reasons = [];
          if (!result.endUrl.startsWith(BASE_URL)) {
            reasons.push("host_drift");
          }
          if (!hashResult.ok) reasons.push("hash_not_updated");
          if (hashResult.latencyMs > viewportCfg.hashLatencyMaxMs) {
            reasons.push("hash_latency_exceeded");
          }
          if (!settleResult.ok) reasons.push("target_not_settled");
          if (settleResult.timeToTargetMs > viewportCfg.settleMaxMs + 1500) {
            reasons.push("settle_deadline_exceeded");
          }
          if (driftTop === null || Math.abs(driftTop) > FINAL_OFFSET_MAX) {
            reasons.push("final_offset_exceeded");
          }
          const shouldCheckDrift = !(
            action.target === "faq" && origin !== "/"
          );
          if (
            shouldCheckDrift &&
            (!Number.isFinite(driftPx) || driftPx > DRIFT_MAX)
          ) {
            reasons.push("drift_exceeded");
          }

          if (reasons.length > 0) {
            const screenshotPath = path.join(
              auditDir,
              `nav-failure-${caseId.replace(/[^a-z0-9-_:.]/gi, "_")}.png`
            );
            await page.screenshot({ path: screenshotPath, fullPage: true });
            navFailures.push({
              ...result,
              reasons,
              screenshot: screenshotPath,
            });
          }
        }
      }
    }

    const attemptMetrics = navMetrics.slice(navMetricsAtStart);
    const samples = attemptMetrics
      .filter((result) => result.viewport === viewportCfg.name)
      .map((result) => result.settleMs)
      .sort((a, b) => a - b);
    const summary = {
      viewport: viewportCfg.name,
      sampleCount: samples.length,
      medianMs: samples[Math.ceil(samples.length * 0.5) - 1],
      p90Ms: samples[Math.ceil(samples.length * 0.9) - 1],
      maxMs: samples[samples.length - 1],
      cases: ORIGINS.flatMap((origin) => ACTIONS.map((action) => {
        const times = attemptMetrics
          .filter((result) => result.viewport === viewportCfg.name && result.origin === origin && result.action === action.label)
          .map((result) => result.settleMs)
          .sort((a, b) => a - b);
        return { origin, action: action.label, sampleCount: times.length, medianMs: times[Math.ceil(times.length * 0.5) - 1] };
      })),
    };
    settleSummaries.push(summary);
    if (summary.p90Ms > viewportCfg.settleMaxMs) navFailures.push({ ...summary, reasons: ["settle_p90_exceeded"] });
    for (const result of summary.cases) {
      if (result.medianMs > viewportCfg.settleMaxMs) {
        navFailures.push({ viewport: viewportCfg.name, ...result, reasons: ["settle_case_median_exceeded"] });
      }
    }
  });
}

test("in-app route transitions keep browser path synchronized for section links", async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORTS[0].viewport);

  for (const origin of FLOW_ORIGINS) {
    for (const action of ACTIONS) {
      await origin.open(page);

      const beforePath = new URL(page.url()).pathname;
      expect(beforePath).toBe(origin.route);

      await clickNav(page, action.target, "desktop");

      const hashResult = await waitForHash(page, action.hash, 1700);
      const settleResult = await waitForTargetSettle(page, action.hash, 2600);
      const afterUrl = new URL(page.url());
      const stableTop = settleResult.top;

      expect(hashResult.ok, `${origin.label} -> ${action.label} hash update`).toBe(
        true
      );
      expect(settleResult.ok, `${origin.label} -> ${action.label} settle`).toBe(
        true
      );
      expect(afterUrl.pathname, `${origin.label} -> ${action.label} path`).toBe(
        "/"
      );
      expect(Math.abs(stableTop ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(
        FINAL_OFFSET_MAX
      );
    }
  }
});

test("desktop navbar stays on a single visual row", async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 903 });
  await page.goto("/", { waitUntil: "networkidle" });

  const metrics = await getDesktopNavRowMetrics(page);
  expect(metrics).not.toBeNull();

  const tops = metrics.items.map((item) => item.top);
  const baselineTop = tops[0];
  const maxDelta = Math.max(...tops.map((top) => Math.abs(top - baselineTop)));

  expect(metrics.navHeight).toBeLessThanOrEqual(70);
  expect(maxDelta).toBeLessThanOrEqual(2);
});

test("an abandoned section request does not carry into a later homepage visit", async ({ page }) => {
  await page.setViewportSize(VIEWPORTS[0].viewport);
  await page.goto("/reviews", { waitUntil: "domcontentloaded" });
  const sectionLink = navLink("faq");
  await waitForHydrated(page, sectionLink);
  const request = await page.evaluate((selector) => {
    document.querySelector(selector).click();
    const request = sessionStorage.getItem("roo_pending_section");
    window.location.assign("/tools");
    return request;
  }, sectionLink);
  expect(request).not.toBeNull();
  await page.waitForURL(`${BASE_URL}/tools`);
  await waitForHydrated(page, sectionLink);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForHydrated(page, sectionLink);
  await expect.poll(() => page.evaluate(() => ({
    hash: window.location.hash,
    top: window.scrollY <= 140,
    section: document.querySelector('[data-nav-target][aria-current="location"]')?.dataset.navTarget || "",
  }))).toEqual({ hash: "", top: true, section: "" });
});

for (const route of ["/tourney", "/admin/content", "/BIOSGuide"]) {
  test(`a section trip interrupted by ${route} leaves a later Home visit at the top`, async ({ page }, testInfo) => {
    await page.setViewportSize(VIEWPORTS[0].viewport);
    await page.goto("/reviews", { waitUntil: "domcontentloaded" });
    const selector = navLink("faq");
    await waitForHydrated(page, selector);
    const request = await page.evaluate(({ selector, route }) => {
      document.querySelector(selector).click();
      const saved = sessionStorage.getItem("roo_pending_section");
      window.location.assign(route);
      return saved;
    }, { selector, route });
    expect(request).not.toBeNull();
    await page.waitForURL(`${BASE_URL}${route}`);
    if (route === "/tourney") {
      await page.locator("a.tourney-brand").click();
    } else {
      await page.goto("/", { waitUntil: "domcontentloaded" });
    }
    await waitForHydrated(page, selector);
    await expect.poll(() => page.evaluate(() => ({
      hash: window.location.hash,
      top: window.scrollY <= 140,
      pending: sessionStorage.getItem("roo_pending_section"),
    }))).toEqual({ hash: "", top: true, pending: null });
    await page.screenshot({ path: testInfo.outputPath("home-after-interrupted-section-trip.png") });
  });
}

for (const [label, request] of [
  ["legacy", "#faq"],
  ["bound", JSON.stringify({ hash: "#faq", path: "/" })],
]) {
  test(`a saved ${label} section request expires on arrival at another page`, async ({ page }, testInfo) => {
    await page.setViewportSize(VIEWPORTS[0].viewport);
    await page.goto("/reviews", { waitUntil: "domcontentloaded" });
    const sectionLink = navLink("faq");
    await waitForHydrated(page, sectionLink);
    await page.evaluate(request => sessionStorage.setItem("roo_pending_section", request), request);
    await page.goto("/tools", { waitUntil: "domcontentloaded" });
    await waitForHydrated(page, sectionLink);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("roo_pending_section"))).toBeNull();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForHydrated(page, sectionLink);
    await expect.poll(() => page.evaluate(() => ({
      hash: window.location.hash,
      top: window.scrollY <= 140,
    }))).toEqual({ hash: "", top: true });
    await page.screenshot({ path: testInfo.outputPath("home-after-expired-request.png") });
  });
}

for (const [label, request, hash] of [
  ["matching history entry", { hash: "faq", path: "/", entry: "saved-trip" }, "#faq"],
  ["different history entry", { hash: "#faq", path: "/", entry: "other-trip" }, ""],
  ["missing history entry", { hash: "#faq", path: "/" }, ""],
  ["different destination", { hash: "#faq", path: "/tools" }, ""],
  ["missing destination", { hash: "#faq" }, ""],
  ["malformed request", null, ""],
]) {
  test(`a saved section request handles its ${label}`, async ({ page }) => {
    await page.addInitScript((request) => {
      window.history.replaceState({
        ...window.history.state,
        __rooSectionTrip: { key: "saved-trip" },
      }, "", window.location.href);
      sessionStorage.setItem("roo_pending_section", JSON.stringify(request));
    }, request);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForHydrated(page, navLink("faq"));
    await expect.poll(() => page.evaluate(() => ({
      hash: window.location.hash,
      pending: sessionStorage.getItem("roo_pending_section"),
    }))).toEqual({ hash, pending: null });
    if (hash) {
      const settled = await waitForTargetSettle(page, hash, 2600);
      expect(settled.ok).toBe(true);
    } else {
      expect(await page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(140);
    }
  });
}

test.afterAll(async () => {
  ensureAuditDir();

  const payload = {
    runId,
    generatedAt: new Date().toISOString(),
    cpuThrottleRate: CPU_THROTTLE_RATE,
    repeatCount: DEFAULT_REPEAT_COUNTS,
    thresholds: {
      finalOffsetPxMax: FINAL_OFFSET_MAX,
      driftPxMax: DRIFT_MAX,
      desktop: {
        hashLatencyMsMax: VIEWPORTS[0].hashLatencyMaxMs,
        caseSettleMedianMsMax: VIEWPORTS[0].settleMaxMs,
        settleP90MsMax: VIEWPORTS[0].settleMaxMs,
        settleDeadlineMs: VIEWPORTS[0].settleMaxMs + 1500,
      },
      mobile: {
        hashLatencyMsMax: VIEWPORTS[1].hashLatencyMaxMs,
        caseSettleMedianMsMax: VIEWPORTS[1].settleMaxMs,
        settleP90MsMax: VIEWPORTS[1].settleMaxMs,
        settleDeadlineMs: VIEWPORTS[1].settleMaxMs + 1500,
      },
    },
    summary: {
      totalCases: navMetrics.length,
      failures: navFailures.length,
      pass: navFailures.length === 0,
    },
    metrics: navMetrics,
    settleSummaries,
    failures: navFailures,
  };

  fs.writeFileSync(navArtifactPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    crashArtifactPath,
    JSON.stringify(
      {
        runId,
        generatedAt: new Date().toISOString(),
        errors: crashLog,
      },
      null,
      2
    )
  );
  const hydrationErrors = crashLog.filter((item) =>
    /hydration|hydrated|didn't match|server rendered html/i.test(
      item.message || ""
    )
  );
  fs.writeFileSync(
    hydrationArtifactPath,
    JSON.stringify(
      {
        runId,
        generatedAt: new Date().toISOString(),
        errors: hydrationErrors,
      },
      null,
      2
    )
  );
});

let navFailuresAtStart = 0;
let crashLogAtStart = 0;
let navMetricsAtStart = 0;

test.beforeEach(async ({ context, page, baseURL }) => {
  navFailuresAtStart = navFailures.length;
  crashLogAtStart = crashLog.length;
  navMetricsAtStart = navMetrics.length;
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  if (CPU_THROTTLE_RATE > 1) {
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE_RATE });
  }
});

test.afterEach(async () => {
  expect.soft(navFailures.slice(navFailuresAtStart), "navigation reliability failures").toEqual([]);
  expect.soft(
    crashLog.slice(crashLogAtStart).map(({ type, viewport, url, message }) => ({ type, viewport, url, message })),
    "client crash/hydration errors captured"
  ).toEqual([]);
});
