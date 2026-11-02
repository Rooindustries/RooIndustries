const fs = require("fs");
const path = require("path");

const { gzipSync } = require("zlib");

// Compressed modern JS per initial route or lazy import, with each shared file
// counted once per group. Legacy nomodule polyfills are excluded. These are
// build-byte budgets, not measured page-load timings.
const maxMediaBytes = 25 * 1024 * 1024;
const budgetMarginBytes = 1024;
const budgetStep = 1024;
const boundaryEntries = ["layout", "template", "error", "loading", "not-found"];
const errors = [];
const buildDir = path.resolve(process.env.NEXT_DIST_DIR || ".next");
const budgetsFile = path.resolve(
  process.env.ROUTE_BUDGETS_FILE || path.join(__dirname, "route-budgets.json")
);
const updateBudgets = process.argv.includes("--update");
const fileSizes = new Map();

const measure = (files, extension) => {
  let gzipBytes = 0;
  const uniqueFiles = [...new Set(files.filter((file) => file.endsWith(extension)))];
  for (const file of uniqueFiles) {
    if (!fileSizes.has(file)) {
      fileSizes.set(file, gzipSync(fs.readFileSync(path.join(buildDir, file))).length);
    }
    gzipBytes += fileSizes.get(file);
  }
  return { gzipBytes, fileCount: uniqueFiles.length };
};

const routeFromManifestName = (name) =>
  name === "/not-found" ? name : name.replace(/\/page$/, "") || "/";

const budgetFor = (gzipBytes) =>
  Math.ceil((gzipBytes + budgetMarginBytes) / budgetStep) * budgetStep;

const readBudgets = () => {
  if (!fs.existsSync(budgetsFile)) {
    throw new Error(`Budgets file ${path.relative(process.cwd(), budgetsFile)} is missing.`);
  }
  const budgets = JSON.parse(fs.readFileSync(budgetsFile, "utf8"));
  return { routes: budgets.routes || {}, lazy: budgets.lazy || {} };
};

const checkGroup = ({ kind, name, label, files, budgets, measured }) => {
  const js = measure(files, ".js");
  const css = measure(files, ".css");
  measured[kind][name] = { js: budgetFor(js.gzipBytes), css: budgetFor(css.gzipBytes) };
  console.log(
    `${label}: ${js.gzipBytes} gzip bytes of JS in ${js.fileCount} files, ${css.gzipBytes} gzip bytes of CSS in ${css.fileCount} files.`
  );
  if (updateBudgets) return;
  const budget = budgets[kind][name];
  if (!budget) {
    errors.push(`${label} has no budget. Add it to ${path.basename(budgetsFile)}.`);
    return;
  }
  for (const [type, size] of [["JS", js], ["CSS", css]]) {
    const limit = budget[type.toLowerCase()];
    if (!Number.isInteger(limit) || limit < 0) {
      errors.push(`${label} has no valid ${type} budget.`);
    } else if (size.gzipBytes > limit) {
      errors.push(
        `${label} ${type} is ${size.gzipBytes} gzip bytes, ${size.gzipBytes - limit} over its budget of ${limit}.`
      );
    }
  }
};

const prerenderedAssets = (route) => {
  const html = path.join(buildDir, "server", "app", `${route === "/" ? "/index" : route}.html`);
  if (!fs.existsSync(html)) return null;
  const assets = new Set();
  for (const match of fs.readFileSync(html, "utf8").matchAll(/\/_next\/(static\/[^"'?\s]+\.(?:js|css))/g)) {
    assets.add(match[1]);
  }
  return assets;
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
  const budgets = updateBudgets ? { routes: {}, lazy: {} } : readBudgets();
  const measured = { routes: {}, lazy: {} };
  const polyfills = new Set(buildManifest.polyfillFiles || []);

  for (const [name, files] of pages) {
    const route = routeFromManifestName(name);
    const segments = name.split("/").slice(0, -1);
    const boundaryFiles = [
      ...(appManifest.pages["/global-error"] || []),
      ...segments.flatMap((_, index) =>
        boundaryEntries.flatMap((entry) =>
          appManifest.pages[`${segments.slice(0, index + 1).join("/")}/${entry}`] || []
        )
      ),
    ];
    const counted = [...buildManifest.rootMainFiles, ...boundaryFiles, ...files];
    checkGroup({ kind: "routes", name: route, label: `First load ${route}`, files: counted, budgets, measured });
    const loaded = prerenderedAssets(route);
    if (loaded) {
      const countedSet = new Set(counted);
      for (const asset of loaded) {
        if (!countedSet.has(asset) && !polyfills.has(asset)) {
          errors.push(`${route} loads ${asset} before first paint but the budget does not count it.`);
        }
      }
    }
  }
  for (const [name, entry] of Object.entries(lazyManifest)) {
    checkGroup({ kind: "lazy", name, label: `Lazy ${name}`, files: entry.files, budgets, measured });
  }
  for (const kind of ["routes", "lazy"]) {
    for (const name of Object.keys(budgets[kind])) {
      if (!measured[kind][name]) {
        errors.push(`${name} has a budget but is no longer in the build. Remove it from ${path.basename(budgetsFile)}.`);
      }
    }
  }
  if (updateBudgets) {
    const sorted = (group) => Object.fromEntries(Object.entries(group).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(
      budgetsFile,
      `${JSON.stringify({ routes: sorted(measured.routes), lazy: sorted(measured.lazy) }, null, 2)}\n`
    );
    console.log(
      `Wrote budgets for ${Object.keys(measured.routes).length} routes and ${Object.keys(measured.lazy).length} lazy imports.`
    );
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
