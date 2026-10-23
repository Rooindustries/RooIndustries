import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { installNetworkGuard } from "../scripts/lib/test-target-safety.mjs";

const require = createRequire(import.meta.url);
const exec = promisify(execFile);
const artifactDir = path.resolve("test-results/toolchain");

test("the installed Tailwind CLI builds the website stylesheet", async () => {
  await fs.mkdir(artifactDir, { recursive: true });
  const output = path.join(artifactDir, "website.css");
  const { stdout, stderr } = await exec(process.execPath, [
    require.resolve("tailwindcss/lib/cli.js"), "--input", "src/index.css",
    "--output", output, "--config", "tailwind.config.js", "--minify",
  ], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const css = await fs.readFile(output, "utf8");
  assert.match(css, /\.flex\{/);
  assert.match(css, /\.ri-discord-guide-banner/);
  assert.doesNotMatch(css, /@tailwind\s/);
  await fs.writeFile(path.join(artifactDir, "tailwind.json"), JSON.stringify({
    bytes: Buffer.byteLength(css), sha256: createHash("sha256").update(css).digest("hex"), stdout, stderr,
  }, null, 2));
});

test("Lighthouse's HTTP fixture serves the site through the patched dependencies", async () => {
  await fs.mkdir(artifactDir, { recursive: true });
  const FallbackServer = require("@lhci/cli/src/collect/fallback-server.js");
  const lighthouseFetch = require("@lhci/cli/src/fetch.js");
  await fs.writeFile(path.join(artifactDir, "index.html"), "<!doctype html><title>Toolchain fixture</title><h1>Fixture ready</h1>");
  const server = new FallbackServer(artifactDir, false);
  await server.listen();
  const origin = `http://127.0.0.1:${server.port}`;
  let restore;
  try {
    restore = installNetworkGuard([origin]);
    const response = await lighthouseFetch(`${origin}/index.html?items[0]=first&items[1]=second`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<h1>Fixture ready<\/h1>/);
    await fs.writeFile(path.join(artifactDir, "lighthouse.json"), JSON.stringify({
      status: response.status,
      express: require("express/package.json").version,
      qs: require("qs/package.json").version,
      ipAddress: require("ip-address/package.json").version,
      selectorParser: require("postcss-selector-parser/package.json").version,
    }, null, 2));
  } finally {
    restore?.();
    await server.close();
  }
});

test("Lighthouse fixture exits when a proxy prevents guard installation", async () => {
  await fs.mkdir(artifactDir, { recursive: true });
  let failure;
  try {
    await exec(process.execPath, [
      "--test", "--experimental-test-isolation=none", "--test-name-pattern=^Lighthouse's HTTP fixture",
      "tests/toolchain.test.mjs",
    ], { env: { ...process.env, HTTP_PROXY: "http://127.0.0.1:9" }, timeout: 30_000 });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 1, "The refused fixture must exit without timing out");
  assert.equal(failure.killed, false);
  assert.match(`${failure.stdout}${failure.stderr}`, /Proxy transports are refused/);
  await fs.writeFile(path.join(artifactDir, "proxy-refusal.json"), JSON.stringify({
    exitCode: failure.code, killed: failure.killed, signal: failure.signal,
  }, null, 2));
});

for (const [scenario, title] of [
  ["interrupted", "rejects stale evidence after child interruption"],
  ["missing", "rejects success without audit evidence"],
  ["complete", "preserves five sets of fresh evidence"],
]) {
  test("navigation proof runner " + title, async () => {
    const fixture = await fs.mkdtemp(path.join(tmpdir(), "roo-nav-runner-"));
    const artifacts = ["phase1-nav-reliability", "phase1-client-crash-log", "phase1-hydration-log"];
    const env = { ...process.env, BASE_URL: "http://127.0.0.1:41791", NAV_RUNNER_FIXTURE: scenario };
    for (const key of Object.keys(env)) if (/^GIT_|sentry.*dsn/i.test(key)) delete env[key];
    try {
      await fs.mkdir(path.join(fixture, "node_modules/@playwright/test"), { recursive: true });
      await fs.copyFile("tests/fixtures/section-nav-runner-cli.cjs", path.join(fixture, "node_modules/@playwright/test/cli.js"));
      await fs.writeFile(path.join(fixture, ".gitignore"), "node_modules/\naudit/\ntest-results/\nrun-count\n");
      await exec("git", ["init", "--quiet", "--initial-branch=servi/roo-637-fixture"], { cwd: fixture, env });
      await exec("git", ["add", ".gitignore"], { cwd: fixture, env });
      await exec("git", ["-c", "user.name=serviroo", "-c", "user.email=serviroo@rooindustries.com", "commit", "--quiet", "-m", "test: record navigation proof fixture"], { cwd: fixture, env });
      await fs.mkdir(path.join(fixture, "audit"));
      for (const artifact of artifacts) await fs.writeFile(path.join(fixture, "audit", artifact + ".json"), JSON.stringify({ previous: true }));
      let exitCode = 0, stdout = "", stderr = "", killed = false;
      try {
        ({ stdout, stderr } = await exec(process.execPath, [path.resolve("scripts/test-section-nav-repeated.mjs")], { cwd: fixture, env, timeout: 120_000 }));
      } catch (error) {
        ({ code: exitCode, stdout, stderr, killed } = error);
      }
      const parent = path.join(fixture, "test-results/section-nav-consecutive");
      const directories = await fs.readdir(parent);
      assert.equal(directories.length, 1);
      const directory = path.join(parent, directories[0]);
      const proof = JSON.parse(await fs.readFile(path.join(directory, "summary.json"), "utf8"));
      const copied = (await fs.readdir(directory)).filter(name => name.includes("-phase1-"));
      const evidence = {};
      for (const name of copied) evidence[name] = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.writeFile(path.join(artifactDir, "navigation-runner-" + scenario + ".json"), JSON.stringify({ scenario, exitCode, killed, stdout, stderr, proof, evidence }, null, 2));
      assert.equal(killed, false);
      if (scenario === "complete") {
        assert.equal(exitCode, 0);
        assert.equal(proof.runs.length, 5);
        assert.equal(copied.length, 15);
        for (let run = 1; run <= 5; run++) {
          for (const artifact of artifacts) assert.deepEqual(evidence["run-" + run + "-" + artifact + ".json"], { run });
        }
      } else {
        assert.equal(exitCode, 1);
        assert.equal(proof.runs.length, 1);
        assert.equal(copied.length, 0);
      }
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });
}
