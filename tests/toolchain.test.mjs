import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
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
  const restore = installNetworkGuard([origin]);
  try {
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
    restore();
    await server.close();
  }
});
