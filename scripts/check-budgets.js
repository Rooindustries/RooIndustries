const fs = require("fs");
const path = require("path");

const { gzipSync } = require("zlib");

// Compressed modern JS per initial route or lazy import, with each shared file
// counted once per group. Legacy nomodule polyfills are excluded. These are
// build-byte budgets, not measured page-load timings.
const maxJsGzipBytes = 250 * 1024;
const maxMediaBytes = 25 * 1024 * 1024;
const errors = [];
const buildDir = path.resolve(process.env.NEXT_DIST_DIR || ".next");
const chunkSizes = new Map();

const measureJs = (files) => {
  let rawBytes = 0;
  let gzipBytes = 0;
  const uniqueFiles = [...new Set(files.filter((file) => file.endsWith(".js")))];
  for (const file of uniqueFiles) {
    if (!chunkSizes.has(file)) {
      const contents = fs.readFileSync(path.join(buildDir, file));
      chunkSizes.set(file, {
        rawBytes: contents.length,
        gzipBytes: gzipSync(contents).length,
      });
    }
    const size = chunkSizes.get(file);
    rawBytes += size.rawBytes;
    gzipBytes += size.gzipBytes;
  }
  return { rawBytes, gzipBytes, fileCount: uniqueFiles.length };
};

const checkJsGroup = (label, files) => {
  const { rawBytes, gzipBytes, fileCount } = measureJs(files);
  console.log(`${label}: ${gzipBytes} gzip bytes, ${rawBytes} raw bytes, ${fileCount} JS files.`);
  if (gzipBytes > maxJsGzipBytes) {
    errors.push(`${label} is ${gzipBytes} gzip bytes (budget ${maxJsGzipBytes}).`);
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

  for (const [name, files] of pages) {
    const ancestors = name.split("/").slice(0, -1);
    const ancestorFiles = ancestors.flatMap((_, index) =>
      ["layout", "error"].flatMap((entry) =>
        appManifest.pages[`${ancestors.slice(0, index + 1).join("/")}/${entry}`] || []
      )
    );
    checkJsGroup(`Modern initial ${name}`, [...buildManifest.rootMainFiles, ...ancestorFiles, ...files]);
  }
  for (const [name, entry] of Object.entries(lazyManifest)) {
    checkJsGroup(`Lazy ${name}`, entry.files);
  }
} catch (error) {
  errors.push(`Cannot verify production build JS: ${error.message}`);
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
