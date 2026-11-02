/** @jest-environment node */
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const script = path.resolve("scripts/check-budgets.js");
const fixtureRoot = path.resolve("output/audit/frontend");
let directory;

const write = (file, value) => {
  const target = path.join(directory, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
};
const randomText = (name, bytes) => Buffer.concat(Array.from({ length: Math.ceil(bytes / 32) }, (_, index) =>
  createHash("sha256").update(`${name}:${index}`).digest()
)).subarray(0, bytes).toString("base64");
const chunk = (name, bytes = 16) => {
  const file = `static/chunks/${name}.js`;
  write(`.next/${file}`, `const data = "${randomText(name, bytes)}";`);
  return file;
};
const stylesheet = (name, bytes = 16) => {
  const file = `static/css/${name}.css`;
  write(`.next/${file}`, `.${name}{content:"${randomText(name, bytes)}"}`);
  return file;
};
const build = (pages, lazy = {}) => {
  const main = chunk("main-app");
  write(".next/BUILD_ID", "fixture-production-build");
  write(".next/build-manifest.json", { rootMainFiles: [main] });
  write(".next/app-build-manifest.json", { pages });
  write(".next/react-loadable-manifest.json", lazy);
};
const budgets = (value) => write("route-budgets.json", value);
const roomy = { js: 400 * 1024, css: 100 * 1024 };
const run = (...args) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: directory,
    env: { ...process.env, NEXT_DIST_DIR: ".next", ROUTE_BUDGETS_FILE: "route-budgets.json" },
    encoding: "utf8",
  });
  return { status: result.status, output: result.stdout + result.stderr };
};

beforeEach(() => {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  directory = fs.mkdtempSync(path.join(fixtureRoot, "budget-test-"));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

test("refuses to certify a missing production build", () => {
  const result = run();
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/production build/i);
});

test("counts shared route and layout JavaScript instead of only main-app", () => {
  const shared = chunk("shared", 150 * 1024);
  const page = chunk("page", 150 * 1024);
  build({ "/layout": [shared], "/page": [shared, page] });
  budgets({ "/": { js: 200 * 1024, css: 0 } });
  const result = run();
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/^- \/ first-load JS is \d+ gzip bytes, \d+ over its budget of 204800/m);
});

test.each(["/error", "/tools/error"])("counts ancestor error boundary JavaScript from %s", (entry) => {
  const error = chunk("error-boundary", 150 * 1024);
  const page = chunk("tools-page", 150 * 1024);
  build({ [entry]: [error], "/tools/page": [page] });
  budgets({ "/tools": { js: 200 * 1024, css: 0 } });
  const result = run();
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/\/tools first-load JS .* over its budget/);
});

test("deduplicates shared chunks and includes only ancestor layouts and errors", () => {
  const shared = chunk("shared", 180 * 1024);
  const other = chunk("other-layout", 150 * 1024);
  build({
    "/layout": [shared],
    "/error": [shared],
    "/page": [shared],
    "/other/layout": [other],
    "/other/error": [other],
  });
  budgets({ "/": { js: 200 * 1024, css: 0 } });
  const result = run();
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/First load \/: \d+ gzip bytes of JS/);
});

test("fails when a route's first-load CSS grows past its budget", () => {
  const layoutCss = stylesheet("layout", 20 * 1024);
  const pageCss = stylesheet("page", 8 * 1024);
  build({ "/layout": [layoutCss], "/page": [pageCss] });
  budgets({ "/": { js: roomy.js, css: 24 * 1024 } });
  const result = run();
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/^- \/ first-load CSS is \d+ gzip bytes, \d+ over its budget of 24576/m);
});

test("fails when a new route has no budget", () => {
  build({ "/page": [], "/pricing/page": [chunk("pricing")] });
  budgets({ "/": roomy });
  const result = run();
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/\/pricing has no first-load budget/);
});

test("fails when a budget names a route that is gone", () => {
  build({ "/page": [] });
  budgets({ "/": roomy, "/old": roomy });
  const result = run();
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/\/old has a first-load budget but is no longer in the build/);
});

test("update writes budgets from the build with a small margin that then pass", () => {
  const page = chunk("page", 100 * 1024);
  const css = stylesheet("page", 10 * 1024);
  build({ "/page": [page, css], "/not-found": [] });
  expect(run("--update").status).toBe(0);
  const written = JSON.parse(fs.readFileSync(path.join(directory, "route-budgets.json"), "utf8"));
  expect(Object.keys(written)).toEqual(["/", "/not-found"]);
  const measured = Number(run().output.match(/First load \/: (\d+) gzip bytes of JS/)[1]);
  expect(written["/"].js).toBeGreaterThanOrEqual(measured);
  expect(written["/"].js).toBeLessThan(measured + 2048);
  expect(run().status).toBe(0);
  chunk("page", 103 * 1024);
  expect(run().status).toBe(1);
});

test("checks all files needed by a lazy import, including shared chunks", () => {
  const first = chunk("lazy-shared", 150 * 1024);
  const second = chunk("lazy-page", 150 * 1024);
  build({ "/page": [] }, { "App -> DeferredPage": { files: [first, second, first] } });
  budgets({ "/": roomy });
  const result = run();
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/lazy.*DeferredPage.*gzip.*budget/i);
});

test("fails when a manifest points to an unavailable chunk", () => {
  build({ "/page": ["static/chunks/missing.js"] });
  budgets({ "/": roomy });
  const result = run();
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/missing\.js/);
});
