const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { installNetworkGuard, localOrigin, refuseEnvFiles, validateDistDir } from "./lib/test-target-safety.mjs";
import { createToolingContentFixture } from "../tests/fixtures/tooling-content.mjs";

refuseEnvFiles();
const dist = validateDistDir(process.env.NEXT_DIST_DIR, { isolated: true });
const baseURL = localOrigin(process.env.BASE_URL);
const target = new URL(baseURL);
if (target.hostname !== testHost || target.port !== process.env.PW_PORT) throw new Error("Invalid Tailscale test server target.");
const contentPort = Number(process.env.TOOLING_CONTENT_PORT || Number(target.port) + 1);
if (!Number.isInteger(contentPort) || contentPort < 1024 || contentPort > 65535 || contentPort === Number(target.port)) throw new Error("Invalid local content fixture port.");
const contentURL = localOrigin(`http://${testHost}:${contentPort}`);
installNetworkGuard([baseURL, contentURL]);
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CI: "true",
  TZ: "UTC",
  TOURNEY_DATABASE_MODE: "memory",
  DATA_PRIMARY_BACKEND: "supabase",
  COMMERCE_PRIMARY_BACKEND: "supabase",
  SUPABASE_CUTOVER_ENABLED: "1",
  COMMERCE_CUTOVER_ENABLED: "1",
  SUPABASE_URL: contentURL,
  NEXT_PUBLIC_SUPABASE_URL: contentURL,
  NEXT_PUBLIC_SUPABASE_ASSET_URL: contentURL,
  SUPABASE_SECRET_KEY: "fixture-only-tooling-server-secret-key",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fixture-only-tooling-browser-publishable-key",
  ALLOW_LIVE_PAYMENTS: "0",
  SALES_PREVIEW_READ_ONLY: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  BASE_URL: baseURL,
  ROO_TEST_HOST: testHost,
  NEXT_DIST_DIR: dist,
  TOOLING_NETWORK_GUARD: "1",
  NODE_OPTIONS: `--import=${fileURLToPath(new URL("./lib/test-target-safety.mjs", import.meta.url))}`,
};
const next = path.resolve("node_modules/next/dist/bin/next");
const fingerprint = createHash("sha256");
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
for (const file of tracked.filter(file => /^(?:src\/|app\/|scripts\/|tests\/fixtures\/|package(?:-lock)?\.json$|next\.config\.mjs$|(?:tailwind|postcss)\.config)/.test(file)).sort()) {
  fingerprint.update(file);
  fingerprint.update(fs.readFileSync(file));
}
fingerprint.update(fs.readFileSync(fileURLToPath(import.meta.url)));
fingerprint.update(fs.readFileSync(fileURLToPath(new URL("./lib/test-target-safety.mjs", import.meta.url))));
const sourceHash = fingerprint.digest("hex");
const manifestPath = path.join(dist, "tooling-build.json");
let active;
const execute = args => new Promise((resolve, reject) => {
  active = spawn(process.execPath, args, { env, stdio: "inherit" });
  active.once("error", reject);
  active.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Test server exited ${signal || code}.`)));
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  active?.kill(signal);
  process.exitCode = 1;
});
if (fs.existsSync(path.join(dist, "BUILD_ID"))) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1 || manifest.sourceHash !== sourceHash || manifest.baseURL !== baseURL || manifest.contentURL !== contentURL) throw new Error("Isolated build ownership or source fingerprint differs; choose a fresh NEXT_DIST_DIR.");
} else {
  if (fs.existsSync(dist)) throw new Error("Incomplete isolated build exists; choose a fresh NEXT_DIST_DIR.");
}
const fixture = await createToolingContentFixture({ origin: contentURL, artifact: process.env.TOOLING_CONTENT_ARTIFACT });
try {
if (!fs.existsSync(path.join(dist, "BUILD_ID"))) {
  await execute(["scripts/validate-runtime-env.js"]);
  await execute([next, "build"]);
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, sourceHash, baseURL, contentURL, contentSha256: fixture.evidence.contentSha256 }));
}
await execute([next, "start", "--hostname", testHost, "--port", target.port]);
} finally { await fixture.close(); }
