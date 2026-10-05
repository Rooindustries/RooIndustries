const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const records = new WeakMap();
const root = path.resolve(__dirname, "../..");
const hashes = () => Object.fromEntries([
  "src/components/Navbar.jsx",
  "src/lib/scrollCoordinator.js",
  "src/lib/useHomeSectionLinkHandler.js",
  "src/components/Hero.jsx",
  "tests/home-cta-mobile.spec.js",
  "tests/home-cta-links.spec.js",
].map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")]));

const persist = page => {
  const entry = records.get(page);
  fs.mkdirSync(path.dirname(entry.artifact), { recursive: true });
  fs.writeFileSync(entry.artifact, JSON.stringify(entry, null, 2) + "\n");
};

exports.begin = async (page, testInfo, options) => {
  const phase = process.env.CTA_PHASE || "baseline";
  const scenario = testInfo.file.endsWith("home-cta-mobile.spec.js") ? "mobile" : "desktop";
  const artifact = path.join(root, "test-results", `cta-${phase}-${scenario}.json`);
  const entry = { phase, scenario, artifact, title: testInfo.title, options, sourceHashes: hashes(), measurements: [], errors: [], hydrationWarnings: [], requestFailures: [], nonlocalRequests: [], complete: false };
  records.set(page, entry);
  const local = new URL(options.baseURL).origin;
  page.on("pageerror", error => entry.errors.push(String(error.message)));
  page.on("console", message => {
    if (/hydrat/i.test(message.text())) entry.hydrationWarnings.push(message.text().slice(0, 8000));
  });
  page.on("requestfailed", request => entry.requestFailures.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on("request", request => {
    if (new URL(request.url()).origin !== local) entry.nonlocalRequests.push({ url: request.url(), method: request.method() });
  });
  if (options.javaScriptEnabled) {
    await page.addInitScript(() => {
      window.__ctaDiagnostics = { clicks: [], settled: [], frames: [], longtasks: [], mutations: [], scriptExecuted: true };
      let clickedAt = 0;
      let frame;
      document.addEventListener("click", event => {
        const link = event.target.closest?.("a.book-optimization-button, a.fps-boosts-button");
        if (!link) return;
        clickedAt = performance.now();
        window.__ctaDiagnostics.clicks.push({ name: link.textContent.trim(), hash: link.hash, at: clickedAt, trusted: event.isTrusted });
        cancelAnimationFrame(frame);
        const sample = timestamp => {
          window.__ctaDiagnostics.frames.push({ click: window.__ctaDiagnostics.clicks.length, ms: Math.round(timestamp - clickedAt), y: Math.round(scrollY) });
          frame = requestAnimationFrame(sample);
        };
        frame = requestAnimationFrame(sample);
      }, true);
      window.addEventListener("roo:section-align-settled", event => {
        window.__ctaDiagnostics.settled.push({ hash: event.detail?.hash, at: performance.now(), fromClickMs: Math.round(performance.now() - clickedAt) });
        cancelAnimationFrame(frame);
      });
      if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
        new PerformanceObserver(list => window.__ctaDiagnostics.longtasks.push(...list.getEntries().map(entry => ({ at: entry.startTime, duration: entry.duration })))).observe({ type: "longtask" });
      }
      document.addEventListener("DOMContentLoaded", () => {
        new MutationObserver(changes => {
          if (clickedAt) window.__ctaDiagnostics.mutations.push({ fromClickMs: Math.round(performance.now() - clickedAt), count: changes.length });
        }).observe(document.body, { childList: true, subtree: true });
      }, { once: true });
    });
  }
  persist(page);
};

exports.record = async (page, state, selector) => {
  const entry = records.get(page);
  const actual = await page.evaluate(target => ({
    hash: location.hash,
    top: Math.round(document.querySelector(target)?.getBoundingClientRect().top ?? 9999),
    scrollY: Math.round(scrollY),
    ua: navigator.userAgent,
    touchPoints: navigator.maxTouchPoints,
    width: innerWidth,
    height: innerHeight,
    coarsePointer: matchMedia("(pointer: coarse)").matches,
    hidden: document.hidden,
    visibility: document.visibilityState,
    placeholders: [...document.querySelectorAll("[data-section-placeholder]")].map(node => node.id || node.tagName),
    diagnostics: window.__ctaDiagnostics || null,
  }), selector);
  entry.measurements.push({ ...state, actual });
  persist(page);
};

exports.finish = async (page, testInfo) => {
  const entry = records.get(page);
  if (!entry) return;
  entry.status = testInfo.status;
  entry.expectedStatus = testInfo.expectedStatus;
  entry.complete = entry.measurements.length === 3;
  entry.failure = testInfo.errors.map(error => error.message);
  entry.screenshot = entry.artifact.replace(/\.json$/, ".png");
  try { await page.screenshot({ path: entry.screenshot }); }
  catch (error) { entry.screenshotError = String(error.message); }
  persist(page);
  await testInfo.attach("CTA evidence", { path: entry.artifact, contentType: "application/json" });
};
