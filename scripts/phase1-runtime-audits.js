/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { chromium, firefox, webkit } = require("playwright");

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error("[phase1-runtime-audits] BASE_URL is required");
  process.exit(1);
}
const auditDir = path.join(process.cwd(), "audit");
const visualDir = path.join(auditDir, "visual");

const run = (cmd) => {
  try {
    return {
      code: 0,
      output: execSync(cmd, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (err) {
    return {
      code: typeof err.status === "number" ? err.status : 1,
      output: String(err.stdout || err.stderr || err.message || ""),
    };
  }
};

const writeFile = (name, content) => {
  fs.mkdirSync(auditDir, { recursive: true });
  const out = path.join(auditDir, name);
  fs.writeFileSync(out, content);
  return out;
};

const withBaseUrl = (cmd) => `BASE_URL=${BASE_URL} ${cmd}`;

const captureSeoReport = () => {
  const checkSeo = run(withBaseUrl("npm run check:seo"));
  const nonJs = run(withBaseUrl("npm run test:seo:nonjs -- --reporter=line"));
  const lines = [
    "# Phase 1 SEO and Non-JS Report",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- check:seo exit: ${checkSeo.code}`,
    `- test:seo:nonjs exit: ${nonJs.code}`,
    "",
    "## check:seo",
    "",
    "```text",
    checkSeo.output.trim() || "(no output)",
    "```",
    "",
    "## test:seo:nonjs",
    "",
    "```text",
    nonJs.output.trim() || "(no output)",
    "```",
  ];
  writeFile("phase1-seo-nonjs-report.md", `${lines.join("\n")}\n`);
  if (checkSeo.code !== 0 || nonJs.code !== 0) {
    throw new Error("SEO/non-JS checks failed");
  }
};

const captureCssIntegrity = async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1536, height: 960 },
  });
  const response = await page.goto(`${BASE_URL}/`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  const payload = await page.evaluate(() => {
    const stylesheetLinks = Array.from(
      document.querySelectorAll('link[rel="stylesheet"]')
    ).map((node) => node.getAttribute("href") || "");
    const bodyBg = window.getComputedStyle(document.body).backgroundImage;
    const hero = document.querySelector("h1");
    const heroFamily = hero ? window.getComputedStyle(hero).fontFamily : "";
    return {
      stylesheetCount: stylesheetLinks.length,
      stylesheetLinks,
      bodyBackgroundImage: bodyBg,
      heroFontFamily: heroFamily,
      styleLoaded:
        stylesheetLinks.length > 0 &&
        Boolean(bodyBg) &&
        bodyBg !== "none" &&
        Boolean(heroFamily),
    };
  });
  await browser.close();

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    status: response?.status() ?? 0,
    ...payload,
  };
  writeFile("phase1-css-integrity.json", `${JSON.stringify(report, null, 2)}\n`);
  if (!report.styleLoaded) {
    throw new Error("CSS integrity check failed");
  }
};

const browserMatrix = async () => {
  const browserEntries = [
    { name: "chromium", launcher: chromium },
    { name: "firefox", launcher: firefox },
    { name: "webkit", launcher: webkit },
  ];
  const viewports = [
    { name: "desktop-wide", width: 1536, height: 960 },
    { name: "laptop", width: 1280, height: 800 },
    { name: "tablet", width: 834, height: 1112 },
    { name: "mobile", width: 390, height: 844 },
  ];
  const rows = [
    [
      "browser",
      "viewport",
      "route",
      "status",
      "main_count",
      "plans_link_count",
      "faq_link_count",
      "pass",
    ].join(","),
  ];

  for (const b of browserEntries) {
    let browser = null;
    try {
      browser = await b.launcher.launch({ headless: true });
    } catch (err) {
      rows.push([b.name, "all", "/", "launch_failed", 0, 0, 0, "false"].join(","));
      continue;
    }

    for (const vp of viewports) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
      });
      const page = await context.newPage();
      const response = await page.goto(`${BASE_URL}/`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      const status = response?.status() ?? 0;
      const mainCount = await page.locator("main").count();
      const plansLinkCount = await page.getByRole("link", { name: "Plans" }).count();
      const faqLinkCount = await page.getByRole("link", { name: "FAQ" }).count();
      const pass = status < 400 && mainCount === 1 && plansLinkCount >= 1 && faqLinkCount >= 1;
      rows.push(
        [
          b.name,
          vp.name,
          "/",
          status,
          mainCount,
          plansLinkCount,
          faqLinkCount,
          pass ? "true" : "false",
        ].join(",")
      );
      await context.close();
    }
    await browser.close();
  }

  writeFile("phase1-browser-device-matrix.csv", `${rows.join("\n")}\n`);
};

const visualParity = async () => {
  fs.mkdirSync(visualDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const targets = ["/", "/reviews", "/tools", "/booking", "/payment"];
  const viewports = [
    { name: "desktop", width: 1536, height: 960 },
    { name: "mobile", width: 390, height: 844 },
  ];

  const captures = [];
  for (const vp of viewports) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
    });
    const page = await context.newPage();
    for (const route of targets) {
      await page.goto(`${BASE_URL}${route}`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForTimeout(250);
      const name = `${vp.name}-${route.replace(/\//g, "_") || "home"}.png`;
      const shotPath = path.join(visualDir, name);
      await page.screenshot({ path: shotPath, fullPage: true });
      captures.push({ viewport: vp.name, route, file: shotPath });
    }
    await context.close();
  }
  await browser.close();

  const lines = [
    "# Phase 1 Visual Parity Report",
    "",
    `- Generated: ${new Date().toISOString()}`,
    "- Baseline diff mode: visual captures generated (no prior baseline snapshots configured).",
    "",
    "## Captures",
    "",
  ];
  captures.forEach((item) =>
    lines.push(`- ${item.viewport} ${item.route}: ${item.file}`)
  );

  writeFile("phase1-visual-parity-report.md", `${lines.join("\n")}\n`);
};

const stressResults = async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1536, height: 960 },
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  const scenarios = [
    { name: "normal", cpuRate: 1, download: -1, upload: -1, latency: 0 },
    {
      name: "constrained",
      cpuRate: 4,
      download: (1.6 * 1024 * 1024) / 8,
      upload: (750 * 1024) / 8,
      latency: 120,
    },
  ];
  const origins = ["/benchmarks", "/reviews", "/meet-the-team"];
  const rows = [];

  for (const scenario of scenarios) {
    await cdp.send("Emulation.setCPUThrottlingRate", {
      rate: scenario.cpuRate,
    });
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      downloadThroughput: scenario.download,
      uploadThroughput: scenario.upload,
      latency: scenario.latency,
      connectionType: scenario.name === "normal" ? "wifi" : "cellular3g",
    });

    for (const origin of origins) {
      await page.goto(`${BASE_URL}${origin}`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      const started = Date.now();
      await page.getByRole("link", { name: "Plans" }).first().click();

      let settled = false;
      while (Date.now() - started <= 4500) {
        const hash = new URL(page.url()).hash;
        const top = await page.evaluate(() => {
          const el = document.querySelector("#packages");
          if (!el) return null;
          return Math.abs(Math.round(el.getBoundingClientRect().top));
        });
        if (hash === "#packages" && top !== null && top <= 160) {
          settled = true;
          break;
        }
        await page.waitForTimeout(50);
      }

      rows.push({
        scenario: scenario.name,
        origin,
        settled,
        durationMs: Date.now() - started,
      });
    }
  }

  await context.close();
  await browser.close();

  const lines = [
    "# Phase 1 Stress Results",
    "",
    `- Generated: ${new Date().toISOString()}`,
    "",
    "| Scenario | Origin | Settled | Duration (ms) |",
    "|---|---|---|---|",
    ...rows.map(
      (r) => `| ${r.scenario} | ${r.origin} | ${r.settled} | ${r.durationMs} |`
    ),
  ];

  writeFile("phase1-stress-results.md", `${lines.join("\n")}\n`);
};

const a11yCritical = async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1536, height: 960 },
  });
  const page = await context.newPage();

  const checks = [];
  await page.goto(`${BASE_URL}/benchmarks`, { waitUntil: "domcontentloaded" });
  const benefitsLink = page.getByRole("link", { name: "Benefits" }).first();
  await benefitsLink.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  checks.push({
    check: "keyboard_enter_on_benefits",
    pass: new URL(page.url()).hash === "#services",
  });

  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  const h1Count = await page.locator("h1").count();
  checks.push({
    check: "home_single_h1",
    pass: h1Count === 1,
  });

  const focusVisible = await page.evaluate(() => {
    const navLink = document.querySelector(
      '[data-nav-surface="desktop"][data-nav-target="benefits"]'
    );
    if (!navLink) return false;
    navLink.focus();
    const styles = window.getComputedStyle(navLink);
    return styles.outlineStyle !== "none" || styles.boxShadow !== "none";
  });
  checks.push({
    check: "focus_visible_after_keyboard_nav",
    pass: focusVisible,
  });

  await context.close();
  await browser.close();

  const lines = [
    "# Phase 1 A11y Critical Path",
    "",
    `- Generated: ${new Date().toISOString()}`,
    "",
    ...checks.map((c) => `- ${c.check}: ${c.pass ? "PASS" : "FAIL"}`),
  ];

  writeFile("phase1-a11y-critical.md", `${lines.join("\n")}\n`);
  if (checks.some((c) => !c.pass)) {
    throw new Error("A11y critical checks failed");
  }
};

const businessSmoke = async () => {
  const browser = await chromium.launch({ headless: true });
  const checks = [];

  const waitForMarker = async (locator, timeout = 3000) => {
    try {
      await locator.first().waitFor({ state: "visible", timeout });
    } catch {}
  };

  const bookingPage = await browser.newPage({
    viewport: { width: 1536, height: 960 },
  });
  await bookingPage.goto(`${BASE_URL}/booking`, {
    waitUntil: "domcontentloaded",
  });
  await waitForMarker(
    bookingPage.getByRole("heading", { name: "Schedule Your Session" }),
    5000
  );
  checks.push({
    check: "booking_renders_schedule_title",
    pass:
      (await bookingPage
        .getByRole("heading", { name: "Schedule Your Session" })
        .count()) >= 1,
  });
  await bookingPage.close();

  const paymentPage = await browser.newPage({
    viewport: { width: 1536, height: 960 },
  });
  await paymentPage.goto(`${BASE_URL}/payment`, {
    waitUntil: "domcontentloaded",
  });
  await waitForMarker(
    paymentPage.getByRole("heading", { name: "Payment Method" }),
    5000
  );
  const providerConfig = await paymentPage.evaluate(async () => {
    try {
      const response = await fetch("/api/payment/providers", {
        headers: { Accept: "application/json" },
      });
      const body = await response.json().catch(() => null);
      return {
        status: response.status,
        ok: !!body?.ok,
        razorpayEnabled: !!body?.providers?.razorpay?.enabled,
        paypalEnabled: !!body?.providers?.paypal?.enabled,
      };
    } catch (error) {
      return {
        status: 0,
        ok: false,
        razorpayEnabled: false,
        paypalEnabled: false,
      };
    }
  });
  checks.push({
    check: "payment_renders_method_block",
    pass:
      (await paymentPage
        .getByRole("heading", { name: "Payment Method" })
        .count()) >= 1,
  });
  checks.push({
    check: "payment_provider_config_loads",
    pass: providerConfig.ok && providerConfig.status === 200,
  });
  checks.push({
    check: "razorpay_option_present_when_provider_enabled",
    pass:
      !providerConfig.razorpayEnabled ||
      (await paymentPage.locator("text=RazorPay Secure Checkout").count()) >= 1,
  });
  await paymentPage.close();

  const referralPage = await browser.newPage({
    viewport: { width: 1536, height: 960 },
  });
  await referralPage.goto(`${BASE_URL}/referrals/login`, {
    waitUntil: "domcontentloaded",
  });
  checks.push({
    check: "referral_login_renders",
    pass: (await referralPage.locator("text=Referral").count()) >= 1,
  });
  await referralPage.close();

  await browser.close();

  const lines = [
    "# Phase 1 Business Smoke",
    "",
    `- Generated: ${new Date().toISOString()}`,
    "",
    ...checks.map((c) => `- ${c.check}: ${c.pass ? "PASS" : "FAIL"}`),
  ];
  writeFile("phase1-business-smoke.md", `${lines.join("\n")}\n`);
  if (checks.some((c) => !c.pass)) {
    throw new Error("Business smoke checks failed");
  }
};

async function runAll() {
  fs.mkdirSync(auditDir, { recursive: true });
  captureSeoReport();
  await captureCssIntegrity();
  await browserMatrix();
  await visualParity();
  await stressResults();
  await a11yCritical();
  await businessSmoke();
}

runAll().catch((err) => {
  console.error("[phase1-runtime-audits] failed:", err);
  process.exit(1);
});
