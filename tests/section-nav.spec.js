const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  throw new Error("BASE_URL is required for section-nav reliability tests.");
}
if (BASE_URL !== "http://127.0.0.1:3001") {
  throw new Error(
    `Unexpected BASE_URL for mission-critical nav suite: ${BASE_URL}`
  );
}

test.use({ javaScriptEnabled: true });
test.describe.configure({ mode: "serial" });

const DEFAULT_REPEAT_COUNTS = {
  desktop: Number(process.env.NAV_REPEAT_COUNT_DESKTOP || 5),
  mobile: Number(process.env.NAV_REPEAT_COUNT_MOBILE || 3),
};
const FINAL_OFFSET_MAX = 140;
const DRIFT_MAX = 40;

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
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.getByRole("link", { name: "Meet the Team" }).first().click();
      await page.waitForURL(`${BASE_URL}/meet-the-team`);
    },
  },
  {
    label: "reviews",
    route: "/reviews",
    open: async (page) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Proof" }).first().click();
      await page.getByRole("link", { name: "Reviews" }).first().click();
      await page.waitForURL(`${BASE_URL}/reviews`);
    },
  },
  {
    label: "benchmarks",
    route: "/benchmarks",
    open: async (page) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Proof" }).first().click();
      await page.getByRole("link", { name: "Benchmarks" }).first().click();
      await page.waitForURL(`${BASE_URL}/benchmarks`);
    },
  },
];

const auditDir = path.join(process.cwd(), "audit");
const navArtifactPath = path.join(auditDir, "phase1-nav-reliability.json");
const crashArtifactPath = path.join(auditDir, "phase1-client-crash-log.json");
const hydrationArtifactPath = path.join(auditDir, "phase1-hydration-log.json");

const navMetrics = [];
const navFailures = [];
const crashLog = [];

const ensureAuditDir = () => {
  fs.mkdirSync(auditDir, { recursive: true });
};

const nowMs = () => Date.now();

const waitForHash = async (page, expectedHash, timeoutMs) => {
  const start = nowMs();
  while (nowMs() - start <= timeoutMs) {
    const currentHash = new URL(page.url()).hash;
    if (currentHash === expectedHash) {
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
  while (nowMs() - start <= timeoutMs) {
    top = await measureOffset(page, hash);
    if (top !== null && Math.abs(top) <= FINAL_OFFSET_MAX) {
      return { ok: true, timeToTargetMs: nowMs() - start, top };
    }
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
    await page.getByRole("button", { name: "Open menu" }).click();
    await page
      .locator(`[data-nav-surface="mobile"][data-nav-target="${target}"]`)
      .first()
      .click();
    return;
  }
  await page
    .locator(`[data-nav-surface="desktop"][data-nav-target="${target}"]`)
    .first()
    .click();
};

const getDesktopNavRowMetrics = async (page) =>
  page.evaluate(() => {
    const nav = document.querySelector("nav.hidden.md\\:flex");
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

          const stableTop = await measureOffset(page, action.hash);
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
          if (settleResult.timeToTargetMs > viewportCfg.settleMaxMs) {
            reasons.push("settle_time_exceeded");
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
      const stableTop = await measureOffset(page, action.hash);

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

test.afterAll(async () => {
  ensureAuditDir();

  const payload = {
    generatedAt: new Date().toISOString(),
    repeatCount: DEFAULT_REPEAT_COUNTS,
    thresholds: {
      finalOffsetPxMax: FINAL_OFFSET_MAX,
      driftPxMax: DRIFT_MAX,
      desktop: {
        hashLatencyMsMax: VIEWPORTS[0].hashLatencyMaxMs,
        settleMsMax: VIEWPORTS[0].settleMaxMs,
      },
      mobile: {
        hashLatencyMsMax: VIEWPORTS[1].hashLatencyMaxMs,
        settleMsMax: VIEWPORTS[1].settleMaxMs,
      },
    },
    summary: {
      totalCases: navMetrics.length,
      failures: navFailures.length,
      pass: navFailures.length === 0,
    },
    metrics: navMetrics,
    failures: navFailures,
  };

  fs.writeFileSync(navArtifactPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    crashArtifactPath,
    JSON.stringify(
      {
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
        generatedAt: new Date().toISOString(),
        errors: hydrationErrors,
      },
      null,
      2
    )
  );

  expect(navFailures, "navigation reliability failures").toEqual([]);
  expect(crashLog.length, "client crash/hydration errors captured").toBe(0);
  expect(hydrationErrors.length, "hydration mismatch errors captured").toBe(0);
});
