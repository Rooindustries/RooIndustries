const path = require("path");
// Use a bundled Chromium binary so react-snap can run in Vercel builds without libnss3.
const reactSnap = require("react-snap");
const chromium = require("@sparticuz/chromium");

const pkg = require(path.join(process.cwd(), "package.json"));
const rawOptions = pkg.reactSnap || {};
const routes = rawOptions.routes || rawOptions.include || ["/"];

const normalizeList = (list) =>
  Array.isArray(list) ? list.filter(Boolean) : [];

const buildArgs = () => {
  const baseArgs = normalizeList(rawOptions.puppeteerArgs);
  const chromiumArgs = normalizeList(chromium.args);
  return Array.from(new Set([...baseArgs, ...chromiumArgs]));
};

const run = async () => {
  const executablePath = await chromium.executablePath();

  const options = {
    ...rawOptions,
    // react-snap expects `include` (not `routes`), so map when needed.
    include: rawOptions.include || routes,
    puppeteerExecutablePath: rawOptions.puppeteerExecutablePath || executablePath,
    puppeteerArgs: buildArgs(),
    headless:
      typeof rawOptions.headless === "boolean"
        ? rawOptions.headless
        : chromium.headless,
  };

  await reactSnap.run(options);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
