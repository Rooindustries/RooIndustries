const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

module.exports = async function checkLegalBuilds({ request, baseURL, control, testInfo, expect }) {
  const source = path.resolve(testInfo.config.metadata.toolingDistDir);
  const dist = `.next-e2e-cms-legal-${process.pid}`;
  const contentURL = new URL(baseURL);
  contentURL.port = process.env.TOOLING_CONTENT_PORT || String(Number(contentURL.port) + 1);
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    CI: "true", NODE_ENV: "production", VERCEL_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: dist,
    TOURNEY_DATABASE_MODE: "memory", DATA_PRIMARY_BACKEND: "supabase", COMMERCE_PRIMARY_BACKEND: "supabase",
    SUPABASE_CUTOVER_ENABLED: "1", COMMERCE_CUTOVER_ENABLED: "1",
    SUPABASE_URL: contentURL.origin, NEXT_PUBLIC_SUPABASE_URL: contentURL.origin,
    NEXT_PUBLIC_SUPABASE_ASSET_URL: contentURL.origin,
    SUPABASE_SECRET_KEY: "fixture-only-tooling-server-secret-key",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fixture-only-tooling-browser-publishable-key",
    ALLOW_LIVE_PAYMENTS: "0", SALES_PREVIEW_READ_ONLY: "1",
    ROO_TEST_HOST: new URL(baseURL).hostname, BASE_URL: baseURL,
    TOOLING_NETWORK_GUARD: "1", ROO_TEST_NETWORK_ORIGINS: JSON.stringify([baseURL, contentURL.origin]),
    NODE_OPTIONS: `--import=${path.resolve("scripts/lib/test-target-safety.mjs")}`,
  };
  const cases = [
    { name: "healthy", state: { reset: true }, succeeds: true },
    { name: "missing-privacy", state: { missing: ["privacyPolicy"] } },
    { name: "missing-terms", state: { missing: ["terms"] } },
    { name: "empty-privacy", state: { patch: { _id: "tooling-privacyPolicy", sections: [] } } },
    { name: "empty-terms", state: { patch: { _id: "tooling-terms", sections: [] } } },
    { name: "malformed", state: { failure: "malformed" } },
    { name: "5xx", state: { outage: true } },
    { name: "timeout", state: { failure: "timeout" } },
  ];
  const results = [];
  try {
    await fs.cp(source, dist, { recursive: true, errorOnExist: true, force: false, filter: entry => !path.relative(source, entry).startsWith("cache") });
    for (const item of cases) {
      await control(request, baseURL, { reset: true });
      await control(request, baseURL, item.state);
      const fixtureUrl = new URL("/__content", contentURL).href;
      const before = (await (await request.get(fixtureUrl)).json()).requests.length;
      const output = testInfo.outputPath(`build-${item.name}.log`);
      const file = await fs.open(output, "w");
      let child;
      let timer;
      const start = Date.now();
      try {
        const result = await new Promise((resolve, reject) => {
          child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "build", "--experimental-build-mode", "generate"], { env, stdio: ["ignore", file.fd, file.fd] });
          timer = setTimeout(() => { child.kill("SIGTERM"); }, 90000);
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal }));
        });
        const reads = (await (await request.get(fixtureUrl)).json()).requests.slice(before).filter(call => call.path === "/rest/v1/rpc/roo_fetch_shadow_documents_targeted").length;
        results.push({ name: item.name, ...result, reads, elapsedMs: Date.now() - start });
        expect.soft(reads, `${item.name}: generation consults the CMS`).toBeGreaterThan(0);
        expect.soft(result.signal, `${item.name}: generation finishes within its bound`).toBeNull();
        expect.soft(result.code === 0, `${item.name}: legal page build acceptance`).toBe(Boolean(item.succeeds));
        if (!item.succeeds) expect.soft(await fs.readFile(output, "utf8")).toMatch(/Error occurred prerendering page "\/(privacy|terms)"/);
      } finally {
        clearTimeout(timer);
        await file.close();
      }
    }
  } finally {
    await control(request, baseURL, { reset: true });
    await fs.writeFile(testInfo.outputPath("build-results.json"), JSON.stringify(results, null, 2));
    await fs.rm(dist, { recursive: true, force: true });
  }
};
