const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { INDEXABLE_ROUTES } = require("../src/lib/routes");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "test-results", "public-route-sweep");
const privateRoutes = new Set([
  "/referrals/dashboard",
  "/referrals/change-password",
]);
// The fixture guard blocks payment-provider logos; serve only these exact image GETs locally.
const fixtureStaticAssets = new Map([
  ["https://razorpay.com/assets/razorpay-logo.svg", { contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="none"/></svg>' }],
  ["https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-100px.png", { contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") }],
]);
// SALES_PREVIEW_READ_ONLY in middleware.js denies these reads before the real API runs.
// Exclude only GET 503s with the exact preview-policy JSON, including their browser resource errors.
const fixtureDeniedReads = new Set([
  "/api/payment/providers",
  "/api/ref/sessionStatus",
  "/api/auth/identities?flow=referral",
  "/api/ref/getData",
  "/api/admin/content/session",
  "/api/admin/content/documents",
  "/api/admin/referral-creators",
]);
const fixtureDenialBody = { ok: false, error: "This preview does not create bookings or accept payments." };
const metadataFields = {
  title: "title",
  description: 'meta[name="description"]',
  canonical: 'link[rel="canonical"]',
  ogTitle: 'meta[property="og:title"]',
  ogImage: 'meta[property="og:image"]',
};

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

function routeInventory() {
  const routes = new Map();
  const add = (value, source) => {
    const route = new URL(value, "http://fixture.invalid").pathname.replace(/\/$/, "") || "/";
    if (!routes.has(route)) routes.set(route, { route, sources: [] });
    routes.get(route).sources.push(source);
  };
  const fixtureFiles = filesIn(path.join(root, "tests", "fixtures"));
  const fixtureRoutes = new Set(fixtureFiles.flatMap(file =>
    [...fs.readFileSync(file, "utf8").matchAll(/\/(?:upgrade|downloads)\/[a-zA-Z0-9_-]+/g)].map(match => match[0])
  ));
  const smoke = fs.readFileSync(path.join(root, "tests", "routes-smoke.spec.js"), "utf8");
  for (const match of smoke.matchAll(/\/downloads\/[a-zA-Z0-9_-]+/g)) fixtureRoutes.add(match[0]);
  const unresolvedDynamicRoutes = [];
  for (const file of filesIn(path.join(root, "app")).filter(file => /[\\/]page\.(?:jsx?|tsx?)$/.test(file))) {
    const source = path.relative(root, file);
    const route = `/${path.relative(path.join(root, "app"), path.dirname(file)).split(path.sep).filter(segment => !/^\(.+\)$/.test(segment)).join("/")}`;
    if (route.includes("[")) {
      const prefix = route.slice(0, route.indexOf("["));
      const matches = [...fixtureRoutes].filter(value => value.startsWith(prefix));
      if (!matches.length) unresolvedDynamicRoutes.push({ route, source });
      for (const value of matches) add(value, `${source}; fixture slug from tests`);
    } else add(route, source);
  }
  for (const route of INDEXABLE_ROUTES) add(route, "scripts/generate-sitemap.js via src/lib/routes.js");
  const sitemapScript = fs.readFileSync(path.join(root, "scripts", "generate-sitemap.js"), "utf8");
  const extra = sitemapScript.match(/EXTRA_INDEXABLE_ROUTES\s*=\s*\[([^\]]*)\]/)?.[1] || "";
  for (const match of extra.matchAll(/["'](\/[^"']*)["']/g)) add(match[1], "scripts/generate-sitemap.js extra route");
  const sitemap = fs.readFileSync(path.join(root, "public", "sitemap.xml"), "utf8");
  for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) add(new URL(match[1]).pathname, "public/sitemap.xml");
  for (const source of ["src/components/Navbar.jsx", "src/components/Footer.jsx", "app/tourney/TourneyShared.jsx", "app/tourney/TourneyFooter.jsx"]) {
    const text = fs.readFileSync(path.join(root, source), "utf8");
    for (const match of text.matchAll(/(?:href|to)=["'](\/[^"']*)["']/g)) add(match[1], source);
    for (const match of text.matchAll(/\[["'](\/[^"']*)["'],\s*["'][^"']+["']\]/g)) add(match[1], source);
  }
  return { routes: [...routes.values()].sort((a, b) => a.route.localeCompare(b.route)), unresolvedDynamicRoutes };
}

const inventory = routeInventory();

function internalURL(value, baseURL) {
  let url;
  try { url = new URL(value, baseURL); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  if (url.origin !== new URL(baseURL).origin && !["rooindustries.com", "www.rooindustries.com"].includes(url.hostname)) return null;
  return new URL(`${url.pathname}${url.search}`, baseURL).href;
}

async function inspectLink(request, url, baseURL) {
  const chain = [];
  for (let hop = 0; hop < 6; hop++) {
    const response = await request.get(url, { maxRedirects: 0, timeout: 10000 });
    const status = response.status();
    const location = response.headers().location;
    chain.push({ url, status, ...(location ? { location } : {}) });
    await response.dispose();
    if (status < 300 || status >= 400 || !location) return { status, chain };
    const next = internalURL(new URL(location, url).href, baseURL);
    if (!next) return { status, chain, externalRedirect: location, externalRedirectFollowed: false };
    if (chain.some(entry => entry.url === next)) return { status, chain, error: "Redirect loop" };
    url = next;
  }
  return { chain, error: "Too many redirects" };
}

async function inspectDocument(page, viewport) {
  const document = await page.evaluate(({ viewport, metadataFields }) => {
    const selector = node => {
      if (node.id) return `#${CSS.escape(node.id)}`;
      const parts = [];
      for (let current = node; current?.nodeType === Node.ELEMENT_NODE && parts.length < 5; current = current.parentElement) {
        const siblings = [...(current.parentElement?.children || [])].filter(sibling => sibling.tagName === current.tagName);
        parts.unshift(`${current.tagName.toLowerCase()}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ""}`);
        if (current.parentElement?.id) { parts.unshift(`#${CSS.escape(current.parentElement.id)}`); break; }
      }
      return parts.join(" > ");
    };
    const visible = node => {
      const box = node.getBoundingClientRect();
      if (box.width < 2 || box.height < 2 || node.closest("[hidden], [inert], .sr-only, .skip-to-content")) return false;
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0 || style.clipPath === "inset(50%)") return false;
      }
      return true;
    };
    const identify = node => ({ selector: selector(node), text: (node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160) });
    const metadata = Object.fromEntries(Object.entries(metadataFields).map(([field, query]) => [field,
      [...window.document.querySelectorAll(query)].map(node => field === "title" ? node.textContent.trim() : node.getAttribute(field === "canonical" ? "href" : "content") || "")
    ]));
    const idGroups = new Map();
    for (const node of window.document.querySelectorAll("[id]")) {
      if (!idGroups.has(node.id)) idGroups.set(node.id, []);
      idGroups.get(node.id).push(identify(node));
    }
    const unlabelledControls = [...window.document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea')]
      .filter(visible).filter(node => ![...(node.labels || [])].some(label => label.textContent.trim()) && !node.getAttribute("aria-label")?.trim() &&
        !node.getAttribute("aria-labelledby")?.split(/\s+/).some(id => window.document.getElementById(id)?.textContent.trim()))
      .map(node => ({ ...identify(node), type: node.type, placeholder: node.getAttribute("placeholder") }));
    const targets = [...window.document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="switch"]')]
      .filter(visible).filter(node => !node.disabled).map(node => ({ node, box: node.getBoundingClientRect() }));
    const smallTargets = viewport.width < 600 ? targets.filter(({ box }) => box.width < 24 || box.height < 24).map(({ node, box }) => {
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      const neighbours = targets.filter(other => other.node !== node && !other.node.contains(node) && !node.contains(other.node)).filter(other => {
        const otherSmall = other.box.width < 24 || other.box.height < 24;
        if (otherSmall) return Math.hypot(x - other.box.left - other.box.width / 2, y - other.box.top - other.box.height / 2) < 24;
        const dx = Math.max(other.box.left - x, 0, x - other.box.right), dy = Math.max(other.box.top - y, 0, y - other.box.bottom);
        return Math.hypot(dx, dy) < 12;
      }).map(other => identify(other.node));
      return { ...identify(node), width: box.width, height: box.height, inlineException: node.tagName === "A" && Boolean(node.closest("p, li")) && getComputedStyle(node).display === "inline", spacingException: neighbours.length === 0, neighbours };
    }) : [];
    const parseColor = value => {
      const match = value.match(/^rgba?\(([^)]+)\)$/);
      if (!match) return null;
      const numbers = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return numbers.length >= 3 ? [...numbers.slice(0, 3), numbers[3] ?? 1] : null;
    };
    const over = (foreground, background) => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      return [0, 1, 2].map(index => (foreground[index] * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / (alpha || 1)).concat(alpha);
    };
    const luminance = color => color.slice(0, 3).map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = [], contrastSkipped = {}, seenText = new Set();
    const skip = reason => { contrastSkipped[reason] = (contrastSkipped[reason] || 0) + 1; };
    const walker = window.document.createTreeWalker(window.document.body, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const node = text.parentElement;
      if (!text.textContent.trim() || !node || seenText.has(node) || !visible(node) || node.closest("script, style, noscript, [disabled], [aria-disabled='true']")) continue;
      seenText.add(node);
      const style = getComputedStyle(node), foreground = parseColor(style.color);
      if (!foreground || foreground[3] === 0) { skip("unsupported or transparent text color"); continue; }
      const layers = [];
      let reason;
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor), color = parseColor(ancestorStyle.backgroundColor);
        if (Number(ancestorStyle.opacity) < 1) { reason = "opacity"; break; }
        if (ancestorStyle.backgroundImage !== "none") { reason = "gradient or image background"; break; }
        if (ancestorStyle.backdropFilter !== "none") { reason = "backdrop filter"; break; }
        for (const pseudo of ["::before", "::after"]) {
          const pseudoStyle = getComputedStyle(ancestor, pseudo), pseudoColor = parseColor(pseudoStyle.backgroundColor);
          if (!["none", "normal"].includes(pseudoStyle.content) && (pseudoStyle.backgroundImage !== "none" || pseudoColor?.[3] > 0)) reason = "pseudo-element background";
        }
        if (reason) break;
        if (color) layers.push(color);
        if (color?.[3] === 1) break;
      }
      if (reason) { skip(reason); continue; }
      let background = [255, 255, 255, 1];
      for (const layer of layers.reverse()) background = over(layer, background);
      const renderedText = over(foreground, background);
      const first = luminance(renderedText), second = luminance(background);
      const ratio = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      const fontSize = parseFloat(style.fontSize), weight = parseFloat(style.fontWeight);
      const required = fontSize >= 24 || fontSize >= 18.66 && weight >= 700 ? 3 : 4.5;
      if (ratio < required) contrast.push({ ...identify(node), foreground, background, ratio: Number(ratio.toFixed(3)), required, fontSize, weight, text: text.textContent.trim().slice(0, 160) });
    }
    const documentWidth = window.document.documentElement.scrollWidth;
    return {
      url: location.href, metadata, robots: window.document.querySelector('meta[name="robots"]')?.content || "",
      h1: [...window.document.querySelectorAll("h1")].map(identify),
      imagesWithoutAlt: [...window.document.querySelectorAll("img:not([alt])")].map(node => ({ ...identify(node), src: node.currentSrc || node.src })),
      brokenImages: [...window.document.images].filter(node => visible(node) && node.complete && node.naturalWidth === 0).map(node => ({ ...identify(node), src: node.currentSrc || node.src })),
      unlabelledControls, duplicateIds: [...idGroups.entries()].filter(([, nodes]) => nodes.length > 1).map(([id, nodes]) => ({ id, nodes })),
      links: [...window.document.querySelectorAll("a[href]")].map(node => ({ href: node.getAttribute("href"), ...identify(node) })),
      documentWidth, viewportWidth: viewport.width, overflowElements: documentWidth > viewport.width ? [...window.document.querySelectorAll("body *")].filter(visible).filter(node => node.getBoundingClientRect().right > viewport.width + 1).slice(0, 30).map(identify) : [],
      tapTargetsUnder24: smallTargets, contrastFailures: contrast, contrastSkipped,
    };
  }, { viewport, metadataFields });
  const session = await page.context().newCDPSession(page);
  try {
    const tree = await session.send("Accessibility.getFullAXTree");
    document.unnamedActions = [];
    for (const node of tree.nodes.filter(node => !node.ignored && ["button", "link", "switch"].includes(node.role?.value) && !node.name?.value?.trim())) {
      const described = node.backendDOMNodeId ? await session.send("DOM.describeNode", { backendNodeId: node.backendDOMNodeId }) : null;
      document.unnamedActions.push({ role: node.role.value, backendDOMNodeId: node.backendDOMNodeId, tag: described?.node.nodeName, attributes: described?.node.attributes || [] });
    }
  } finally { await session.detach(); }
  return document;
}

function routeProblems(record) {
  const problems = [];
  const add = (kind, count, details) => { if (count) problems.push({ route: record.route, kind, count, details }); };
  add("navigation", record.navigationError || record.status >= 400 ? 1 : 0, record.navigationError || record.status);
  if (record.redirect || record.privateGate || !record.document) return problems;
  const doc = record.document;
  const isFixtureResourceError = entry => entry.text === "Failed to load resource: the server responded with a status of 503 (Service Unavailable)" &&
    record.fixtureDenials.some(denial => denial.url === entry.location.url);
  add("consoleErrors", record.console.filter(entry => entry.type === "error" && !isFixtureResourceError(entry)).length);
  add("consoleWarnings", record.console.filter(entry => entry.type === "warning").length);
  add("pageErrors", record.pageErrors.length);
  add("failedRequests", record.failedRequests.filter(entry => entry.error !== "net::ERR_ABORTED").length);
  add("httpErrors", record.httpErrors.filter(entry => !record.fixtureDenials.some(denial => denial.url === entry.url && denial.method === entry.method)).length);
  add("unexpectedExternalRequests", record.blockedExternalRequests.length);
  add("behaviour", record.behaviourErrors.length, record.behaviourErrors);
  for (const [field, values] of Object.entries(doc.metadata)) add(`metadata:${field}`, values.length !== 1 || !values[0]?.trim() ? 1 : 0, values);
  const canonical = doc.metadata.canonical[0];
  const actualPath = new URL(doc.url).pathname.replace(/\/$/, "") || "/";
  if (canonical) add("canonicalPath", (new URL(canonical, doc.url).pathname.replace(/\/$/, "") || "/") !== actualPath ? 1 : 0, { canonical, actualPath });
  add("h1Count", doc.h1.length !== 1 ? 1 : 0, doc.h1);
  for (const kind of ["imagesWithoutAlt", "brokenImages", "unlabelledControls", "unnamedActions", "duplicateIds", "contrastFailures"]) add(kind, doc[kind].length);
  add("mobileOverflow", record.viewport.width < 600 && doc.documentWidth > record.viewport.width ? 1 : 0, doc.documentWidth);
  add("tapTargetCandidates", doc.tapTargetsUnder24.filter(entry => !entry.inlineException && !entry.spacingException).length);
  add("brokenInternalLinks", record.brokenInternalLinks.length, record.brokenInternalLinks);
  return problems;
}

function metadataDuplicates(records) {
  return Object.keys(metadataFields).flatMap(field => {
    const groups = new Map();
    for (const record of records.filter(record => record.document && !record.privateGate)) {
      const value = record.document.metadata[field][0];
      if (!value) continue;
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(record);
    }
    return [...groups.entries()].filter(([, group]) => group.length > 1).map(([value, group]) => ({
      field, value, routes: group.map(record => record.route),
      sharedImage: field === "ogImage", noindexOnly: group.every(record => /noindex/.test(record.document.robots)),
      sameDestination: new Set(group.map(record => new URL(record.document.url).pathname)).size === 1,
    }));
  });
}

test.use({ trace: "off", video: "off", screenshot: "off" });
test.describe.configure({ retries: 0 });
test.afterAll(async () => {
  fs.mkdirSync(output, { recursive: true });
  const reports = [1440, 390].map(width => path.join(output, `${width}.json`)).filter(file => fs.existsSync(file)).map(file => JSON.parse(fs.readFileSync(file, "utf8")));
  const summary = reports.map(report => ({ viewport: report.viewport, startedAt: report.startedAt, complete: report.complete, routes: report.records.length, publicPages: report.records.filter(record => record.document && !record.privateGate).length, privateGates: report.records.filter(record => record.privateGate).length, problems: report.problems.length, byKind: report.problems.reduce((counts, problem) => ({ ...counts, [problem.kind]: (counts[problem.kind] || 0) + problem.count }), {}), metadataDuplicates: report.metadataDuplicates }));
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify({ inventory, summary }, null, 2) + "\n");
  console.log(`SWEEP_SUMMARY ${JSON.stringify(summary.map(({ metadataDuplicates, ...summary }) => summary))}`);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ javaScriptEnabled: true, viewport, serviceWorkers: "block" });
    test("public routes and signed-out gates", async ({ browser, baseURL }, testInfo) => {
      test.setTimeout(240000);
      const { localOrigin, refuseEnvFiles } = await import("../scripts/lib/test-target-safety.mjs");
      refuseEnvFiles(root);
      localOrigin(baseURL);
      const dist = process.env.NEXT_DIST_DIR || testInfo.config.webServer?.env?.NEXT_DIST_DIR;
      expect(dist, "Guarded fixture build directory").toBeTruthy();
      const manifest = JSON.parse(fs.readFileSync(path.join(root, dist, "tooling-build.json"), "utf8"));
      expect(manifest.version).toBe(1);
      expect(manifest.baseURL).toBe(baseURL.replace(/\/$/, ""));
      localOrigin(manifest.contentURL);
      expect(inventory.unresolvedDynamicRoutes).toEqual([]);
      fs.mkdirSync(output, { recursive: true });
      const queue = [...inventory.routes];
      const seen = new Set();
      const linkCache = new Map();
      const report = { viewport, baseURL, startedAt: new Date().toISOString(), complete: false, sourceHash: manifest.sourceHash, fixtureContentHash: manifest.contentSha256, records: [], problems: [], metadataDuplicates: [] };
      const save = () => fs.writeFileSync(path.join(output, `${viewport.width}.json`), JSON.stringify(report, null, 2) + "\n");
      for (let index = 0; index < queue.length; index++) {
        const entry = queue[index];
        if (seen.has(entry.route)) continue;
        seen.add(entry.route);
        if (seen.size > 80) throw new Error("Public route discovery exceeded 80 routes.");
        await test.step(entry.route, async () => {
          const record = { ...entry, viewport, console: [], pageErrors: [], failedRequests: [], httpErrors: [], blockedExternalRequests: [], staticFixtureAssets: [], fixtureDenials: [], behaviourErrors: [], brokenInternalLinks: [] };
          report.records.push(record);
          const context = await browser.newContext({ viewport, javaScriptEnabled: true, serviceWorkers: "block", timezoneId: "UTC" });
          const allowed = new Set([baseURL.replace(/\/$/, ""), manifest.contentURL]);
          await context.route("**/*", async route => {
            const request = route.request(), url = new URL(request.url());
            if (allowed.has(url.origin) && !url.username && !url.password) return route.continue();
            const asset = fixtureStaticAssets.get(request.url());
            if (asset && request.method() === "GET" && request.resourceType() === "image") {
              record.staticFixtureAssets.push(request.url());
              return route.fulfill({ status: 200, ...asset });
            }
            record.blockedExternalRequests.push({ url: request.url(), method: request.method(), type: request.resourceType() });
            await route.abort("blockedbyclient");
          });
          await context.routeWebSocket(/.*/, socket => socket.close());
          const page = await context.newPage();
          page.on("console", message => { if (["error", "warning"].includes(message.type())) record.console.push({ type: message.type(), text: message.text(), location: message.location() }); });
          page.on("pageerror", error => record.pageErrors.push({ message: error.message, stack: error.stack }));
          page.on("requestfailed", request => record.failedRequests.push({ url: request.url(), method: request.method(), type: request.resourceType(), error: request.failure()?.errorText }));
          const responseChecks = [];
          page.on("response", response => {
            const request = response.request();
            if (response.status() < 400 || request.resourceType() === "document") return;
            const failure = { url: response.url(), status: response.status(), method: request.method(), type: request.resourceType() };
            record.httpErrors.push(failure);
            const url = new URL(response.url());
            if (url.origin === baseURL && failure.status === 503 && failure.method === "GET" && fixtureDeniedReads.has(url.pathname + url.search)) {
              responseChecks.push(response.json().then(body => {
                if (JSON.stringify(body) === JSON.stringify(fixtureDenialBody)) record.fixtureDenials.push({ ...failure, body });
              }).catch(() => {}));
            }
          });
          try {
            if (entry.route === "/discord") {
              const response = await context.request.get(new URL(entry.route, baseURL).href, { maxRedirects: 0, timeout: 10000 });
              record.status = response.status();
              record.redirect = response.headers().location;
              expect(record.status).toBe(307);
              expect(record.redirect).toBe("https://discord.com/invite/qs5HKNyazD");
              await response.dispose();
              return;
            }
            const response = await page.goto(new URL(entry.route, baseURL).href, { waitUntil: "domcontentloaded", timeout: 20000 });
            record.status = response?.status();
            await page.waitForTimeout(1100);
            await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 2000))]));
            record.hydrationWarnings = record.console.filter(entry => /hydrat|server html|server snapshot|#418|#423|#425/i.test(entry.text));
            if (entry.route.startsWith("/admin") || privateRoutes.has(entry.route)) {
              record.privateGate = true;
              if (entry.route === "/admin/content") {
                await expect(page.locator("#content-admin-password")).toBeVisible();
                await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
              } else if (entry.route === "/admin/referrals") await expect(page.locator("#ref-admin-key")).toBeVisible();
              else {
                await expect(page.getByRole("heading", { name: "Referral Creator Login", exact: true })).toBeVisible();
                record.destination = page.url();
              }
              const endpoint = entry.route === "/admin/content" ? "/api/admin/content/documents" : entry.route === "/admin/referrals" ? "/api/admin/referral-creators" : "/api/ref/getData";
              const denial = await context.request.get(new URL(endpoint, baseURL).href, { maxRedirects: 0, timeout: 10000 });
              record.denial = { endpoint, status: denial.status(), body: await denial.json() };
              expect([401, 403, 503]).toContain(record.denial.status);
              expect(record.denial.body.documents || record.denial.body.creators || record.denial.body.referral).toBeFalsy();
              await denial.dispose();
            } else {
              const height = await page.evaluate(() => document.documentElement.scrollHeight);
              const steps = Math.min(18, Math.ceil(height / viewport.height));
              for (let step = 1; step <= steps; step++) {
                await page.evaluate(y => window.scrollTo(0, y), Math.min(step * viewport.height * 0.85, height));
                await page.waitForTimeout(100);
              }
              await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
              await page.waitForTimeout(400);
              await page.evaluate(() => window.scrollTo(0, 0));
              await page.waitForTimeout(250);
              record.document = await inspectDocument(page, viewport);
              const check = async (name, assertion) => {
                try { await assertion(); } catch (error) { record.behaviourErrors.push({ name, message: error.message }); }
              };
              if (entry.route === "/") {
                await check("home headings", async () => {
                  await expect(page.locator("#top h1")).toHaveCount(1);
                  await expect(page.locator(".ri-faq-heading")).toHaveJSProperty("tagName", "H2");
                });
              }
              if (entry.route === "/faq") await check("standalone FAQ heading", () => expect(page.locator(".ri-faq-heading")).toHaveJSProperty("tagName", "H1"));
              if (["/payment-success", "/thank-you"].includes(entry.route)) await check("confirmation hero heading", () => expect(page.locator("#top h2")).toHaveCount(1));
              if (entry.route === "/referrals/verify") await check("verification robots", () => expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow, nocache"));
              if (entry.route === "/BIOSGuide") {
                await check("checklist text toggles every checkbox", async () => {
                  const inputs = page.locator('input[type="checkbox"]');
                  await expect(inputs).toHaveCount(6);
                  for (const input of await inputs.all()) {
                    const labelled = await input.evaluate(node => [...node.labels].some(label => label.textContent.trim()));
                    expect(labelled).toBe(true);
                    const label = input.locator("xpath=ancestor::p[1]//label");
                    await label.click({ position: { x: 40, y: 8 } });
                    await expect(input).toBeChecked();
                    await label.click({ position: { x: 40, y: 8 } });
                    await expect(input).not.toBeChecked();
                  }
                  await page.evaluate(() => window.scrollTo(0, 0));
                });
              }
              record.hydrationWarnings = record.console.filter(entry => /hydrat|server html|server snapshot|#418|#423|#425/i.test(entry.text));
              for (const link of record.document.links) {
                const target = internalURL(link.href, baseURL);
                if (!target) continue;
                if (!linkCache.has(target)) linkCache.set(target, await inspectLink(context.request, target, baseURL).catch(error => ({ error: error.message })));
                const checked = linkCache.get(target);
                if (checked.status >= 400 || checked.error) record.brokenInternalLinks.push({ ...link, ...checked });
                const pathname = new URL(target).pathname.replace(/\/$/, "") || "/";
                if (!seen.has(pathname) && !queue.some(entry => entry.route === pathname) && !pathname.startsWith("/api/") && !/\.(?:png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|mp4|webm|woff2?)$/i.test(pathname) && !checked.error && checked.status < 400) queue.push({ route: pathname, sources: [`link on ${entry.route}`] });
              }
            }
            record.screenshot = path.relative(root, path.join(output, `${viewport.width}-${entry.route === "/" ? "home" : entry.route.slice(1).replace(/[^a-zA-Z0-9_-]/g, "-")}.png`));
            await page.screenshot({ path: path.join(root, record.screenshot), fullPage: true, animations: "disabled", timeout: 10000 });
          } catch (error) {
            record.navigationError = error.message;
          } finally {
            await Promise.all(responseChecks);
            report.problems.push(...routeProblems(record));
            save();
            await context.close();
          }
        });
      }
      report.linkChecks = [...linkCache].map(([url, result]) => ({ url, ...result }));
      report.metadataDuplicates = metadataDuplicates(report.records);
      for (const duplicate of report.metadataDuplicates.filter(entry => !entry.sharedImage && !entry.noindexOnly && !entry.sameDestination)) report.problems.push({ kind: `duplicateMetadata:${duplicate.field}`, count: 1, details: duplicate });
      report.complete = true;
      save();
      await testInfo.attach(`sweep-${viewport.width}`, { path: path.join(output, `${viewport.width}.json`), contentType: "application/json" });
      expect(report.problems.length, `Full report: test-results/public-route-sweep/${viewport.width}.json`).toBe(0);
    });
  });
}
