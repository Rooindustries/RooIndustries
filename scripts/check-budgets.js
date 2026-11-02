const fs = require("fs");
const path = require("path");

const { gzipSync } = require("zlib");

// Compressed modern JS per initial route or lazy import, with each shared file
// counted once per group. Legacy nomodule polyfills are excluded. These are
// build-byte budgets, not measured page-load timings.
const maxLazyJsGzipBytes = 250 * 1024;
const maxMediaBytes = 25 * 1024 * 1024;
const routeBudgetMarginBytes = 1024;
const routeBudgetStep = 1024;
const errors = [];
const buildDir = path.resolve(process.env.NEXT_DIST_DIR || ".next");
const routeBudgetsFile = path.resolve(
  process.env.ROUTE_BUDGETS_FILE || path.join(__dirname, "route-budgets.json")
);
const updateRouteBudgets = process.argv.includes("--update");
const fileSizes = new Map();

const measure = (files, extension) => {
  let rawBytes = 0;
  let gzipBytes = 0;
  const uniqueFiles = [...new Set(files.filter((file) => file.endsWith(extension)))];
  for (const file of uniqueFiles) {
    if (!fileSizes.has(file)) {
      const contents = fs.readFileSync(path.join(buildDir, file));
      fileSizes.set(file, {
        rawBytes: contents.length,
        gzipBytes: gzipSync(contents).length,
      });
    }
    const size = fileSizes.get(file);
    rawBytes += size.rawBytes;
    gzipBytes += size.gzipBytes;
  }
  return { rawBytes, gzipBytes, fileCount: uniqueFiles.length };
};

const routeFromManifestName = (name) =>
  name === "/not-found" ? name : name.replace(/\/page$/, "") || "/";

const budgetFor = (gzipBytes) =>
  Math.ceil((gzipBytes + routeBudgetMarginBytes) / routeBudgetStep) * routeBudgetStep;

const readRouteBudgets = () => {
  if (!fs.existsSync(routeBudgetsFile)) {
    throw new Error(`Route budgets file ${path.relative(process.cwd(), routeBudgetsFile)} is missing.`);
  }
  return JSON.parse(fs.readFileSync(routeBudgetsFile, "utf8"));
};

const checkRoute = (route, files, budgets, measured) => {
  const js = measure(files, ".js");
  const css = measure(files, ".css");
  measured[route] = { js: budgetFor(js.gzipBytes), css: budgetFor(css.gzipBytes) };
  console.log(
    `First load ${route}: ${js.gzipBytes} gzip bytes of JS in ${js.fileCount} files, ${css.gzipBytes} gzip bytes of CSS in ${css.fileCount} files.`
  );
  if (updateRouteBudgets) return;
  const budget = budgets[route];
  if (!budget) {
    errors.push(`${route} has no first-load budget. Add it to ${path.basename(routeBudgetsFile)}.`);
    return;
  }
  for (const [kind, size] of [["JS", js], ["CSS", css]]) {
    const limit = budget[kind.toLowerCase()];
    if (!Number.isInteger(limit) || limit < 0) {
      errors.push(`${route} has no valid first-load ${kind} budget.`);
    } else if (size.gzipBytes > limit) {
      errors.push(
        `${route} first-load ${kind} is ${size.gzipBytes} gzip bytes, ${size.gzipBytes - limit} over its budget of ${limit}.`
      );
    }
  }
};

const checkLazyGroup = (label, files) => {
  const { rawBytes, gzipBytes, fileCount } = measure(files, ".js");
  console.log(`Lazy ${label}: ${gzipBytes} gzip bytes, ${rawBytes} raw bytes, ${fileCount} JS files.`);
  if (gzipBytes > maxLazyJsGzipBytes) {
    errors.push(`Lazy ${label} is ${gzipBytes} gzip bytes (budget ${maxLazyJsGzipBytes}).`);
  }
};

try {
  if (!fs.existsSync(path.join(buildDir, "BUILD_ID"))) {
    throw new Error("A production build is required. Run npm run build before checking release budgets.");
  }
  const readManifest = (name) => JSON.parse(fs.readFileSync(path.join(buildDir, name), "utf8"));
  const buildManifest = readManifest("build-manifest.json");
  const appManifest = readManifest("app-build-manifest.json");
  const lazyManifest = readManifest("react-loadable-manifest.json");
  const pages = Object.entries(appManifest.pages).filter(([name]) =>
    name.endsWith("/page") || name === "/not-found"
  );
  if (!pages.length) throw new Error("Production app manifest contains no pages.");
  const budgets = updateRouteBudgets ? {} : readRouteBudgets();
  const measured = {};

  for (const [name, files] of pages) {
    const ancestors = name.split("/").slice(0, -1);
    const ancestorFiles = ancestors.flatMap((_, index) =>
      ["layout", "error"].flatMap((entry) =>
        appManifest.pages[`${ancestors.slice(0, index + 1).join("/")}/${entry}`] || []
      )
    );
    checkRoute(
      routeFromManifestName(name),
      [...buildManifest.rootMainFiles, ...ancestorFiles, ...files],
      budgets,
      measured
    );
  }
  for (const route of Object.keys(budgets)) {
    if (!measured[route]) {
      errors.push(`${route} has a first-load budget but is no longer in the build. Remove it from ${path.basename(routeBudgetsFile)}.`);
    }
  }
  for (const [name, entry] of Object.entries(lazyManifest)) {
    checkLazyGroup(name, entry.files);
  }
  if (updateRouteBudgets) {
    const sorted = Object.fromEntries(Object.entries(measured).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(routeBudgetsFile, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`Wrote first-load budgets for ${Object.keys(sorted).length} routes.`);
  }
} catch (error) {
  errors.push(`Cannot verify production build size: ${error.message}`);
}

const publicDir = path.join(process.cwd(), "public");
const walk = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs);
      continue;
    }

    if (!/\.(mp4|webm|png|jpg|jpeg|webp|avif)$/i.test(entry.name)) continue;
    const rel = path.relative(process.cwd(), abs).replace(/\\/g, "/");
    const size = fs.statSync(abs).size;

    if (size > maxMediaBytes) {
      errors.push(`${rel} is ${size} bytes (budget ${maxMediaBytes}).`);
    }
  }
};

if (fs.existsSync(publicDir)) {
  walk(publicDir);
}

if (errors.length) {
  console.error("Performance budget checks failed:\n");
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log("Performance budgets passed.");
