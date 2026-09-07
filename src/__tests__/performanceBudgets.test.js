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
const chunk = (name, bytes = 16) => {
  const data = Buffer.concat(Array.from({ length: Math.ceil(bytes / 32) }, (_, index) =>
    createHash("sha256").update(`${name}:${index}`).digest()
  )).subarray(0, bytes).toString("base64");
  const file = `static/chunks/${name}.js`;
  write(`.next/${file}`, `const data = "${data}";`);
  return file;
};
const build = (pages, lazy = {}) => {
  const main = chunk("main-app");
  write(".next/BUILD_ID", "fixture-production-build");
  write(".next/build-manifest.json", { rootMainFiles: [main] });
  write(".next/app-build-manifest.json", { pages });
  write(".next/react-loadable-manifest.json", lazy);
};
const run = () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: directory,
    env: { ...process.env, NEXT_DIST_DIR: ".next" },
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
  const result = run();
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/initial.*\/page.*gzip.*budget/i);
});

test.each(["/error", "/tools/error"])("counts ancestor error boundary JavaScript from %s", (entry) => {
  const error = chunk("error-boundary", 150 * 1024);
  const page = chunk("tools-page", 150 * 1024);
  build({ [entry]: [error], "/tools/page": [page] });
  const result = run();
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/initial.*\/tools\/page.*gzip.*budget/i);
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
  const result = run();
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/initial.*\/page.*gzip/i);
});

test("checks all files needed by a lazy import, including shared chunks", () => {
  const first = chunk("lazy-shared", 150 * 1024);
  const second = chunk("lazy-page", 150 * 1024);
  build({ "/page": [] }, { "App -> DeferredPage": { files: [first, second, first] } });
  const result = run();
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/lazy.*DeferredPage.*gzip.*budget/i);
});

test("fails when a manifest points to an unavailable chunk", () => {
  build({ "/page": ["static/chunks/missing.js"] });
  const result = run();
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/missing\.js/);
});
