const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { installNetworkGuard, localOrigin, refuseEnvFiles, validateDistDir } from "./lib/test-target-safety.mjs";
import { lockBuildDirectory } from "./lib/build-lock.mjs";
import { withNodeOption } from "./lib/node-options.mjs";
import { createToolingContentFixture } from "../tests/fixtures/tooling-content.mjs";
import { apiRouteSecrets } from "../tests/fixtures/api-routes.mjs";
import { adoptHeldTcpPorts, portFromEnv, releaseTcpPorts, reserveTcpPorts } from "./lib/free-tcp-port.mjs";
import fixturePorts from "../tests/fixtures/fixture-ports.cjs";

await adoptHeldTcpPorts();
if (process.env.ROO_ADMIN_FIXTURE === "1") {
  await import("./test-admin-server.mjs");
} else {
refuseEnvFiles();
const dist = validateDistDir(process.env.NEXT_DIST_DIR, { isolated: true });
const lock = lockBuildDirectory(dist);
const baseURL = localOrigin(process.env.BASE_URL);
const target = new URL(baseURL);
if (target.hostname !== testHost || target.port !== process.env.PW_PORT) throw new Error("Invalid Tailscale test server target.");
const manifestPath = path.join(dist, "tooling-build.json");
const builtContentPort = fs.existsSync(path.join(dist, "BUILD_ID")) && fs.existsSync(manifestPath) ? Number(new URL(JSON.parse(fs.readFileSync(manifestPath, "utf8")).contentURL).port) : 0;
const requestedContentPort = portFromEnv("TOOLING_CONTENT_PORT");
const reserveContentPort = port => reserveTcpPorts(testHost, [Number(target.port), port]);
const [, contentPort] = requestedContentPort || !builtContentPort
  ? await reserveContentPort(requestedContentPort)
  : await reserveContentPort(builtContentPort).catch(error => {
    if (error.code !== "EADDRINUSE") throw error;
    return reserveContentPort(0);
  });
const contentURL = localOrigin(`http://${testHost}:${contentPort}`);
installNetworkGuard([baseURL, contentURL]);
const apiRoutes = process.env.TOOLING_API_ROUTES === "1";
const monitoringStartup = process.env.TOOLING_MONITORING_STARTUP === "1";
if (monitoringStartup && (process.env.NEXT_PUBLIC_SENTRY_DSN !== "false" || process.env.TOOLING_DEV_SERVER === "1")) {
  throw new Error("Production monitoring startup requires the malformed DSN fixture and next start.");
}
const clockFile = apiRoutes ? path.resolve(`${dist}-clock.json`) : undefined;
if (clockFile) fs.writeFileSync(clockFile, "null");
const env = withNodeOption({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CI: "true",
  VERCEL_ENV: "preview",
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
  SALES_PREVIEW_READ_ONLY: apiRoutes ? "0" : "1",
  ...(apiRoutes ? {
    ...apiRouteSecrets,
    RESEND_API_KEY: "fixture-only-referral-email-key",
    RESEND_BASE_URL: contentURL,
    FROM_EMAIL: "reset@fixture.invalid",
    NEXT_PUBLIC_BASE_URL: baseURL,
  } : {}),
  NEXT_TELEMETRY_DISABLED: "1",
  SENTRY_CLI_NO_TELEMETRY: "1",
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN || "",
  BASE_URL: baseURL,
  ROO_TEST_HOST: testHost,
  NEXT_DIST_DIR: dist,
  TOOLING_NETWORK_GUARD: "1",
  ...(clockFile ? { TOOLING_CLOCK_FILE: clockFile } : {}),
}, "--import", fileURLToPath(new URL("./lib/test-target-safety.mjs", import.meta.url)), ...(apiRoutes ? [fileURLToPath(new URL("../tests/fixtures/server-clock.mjs", import.meta.url))] : []));
if (monitoringStartup) Object.assign(env, { NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production", NEXT_PUBLIC_SENTRY_DSN: "false" });
const next = path.resolve("node_modules/next/dist/bin/next");
const development = process.env.TOOLING_DEV_SERVER === "1";
const fingerprint = createHash("sha256");
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
for (const file of tracked.filter(file => /^(?:src\/|app\/|scripts\/|public\/.*\.js$|tests\/fixtures\/|package(?:-lock)?\.json$|next\.config\.mjs$|instrumentation(?:-client)?\.js$|middleware\.js$|jsconfig\.json$|(?:tailwind|postcss)\.config)/.test(file)).sort()) {
  if (!fs.existsSync(file)) continue;
  fingerprint.update(file);
  fingerprint.update(fs.readFileSync(file));
}
fingerprint.update(fs.readFileSync(fileURLToPath(import.meta.url)));
fingerprint.update(fs.readFileSync(fileURLToPath(new URL("./lib/test-target-safety.mjs", import.meta.url))));
fingerprint.update(env.NEXT_PUBLIC_SENTRY_DSN);
fingerprint.update(String(monitoringStartup));
const sourceHash = fingerprint.digest("hex");
let active;
let stopping = false;
const execute = (args, executionEnv = env) => new Promise((resolve, reject) => {
  const stdio = ["inherit", "inherit", "inherit", lock.fd];
  active = spawn(process.execPath, args, { env: lock.childEnv(executionEnv), stdio });
  active.once("error", reject);
  active.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Test server exited ${signal || code}.`)));
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  stopping = true;
  active?.kill(signal);
});
if (development) {
  if (fs.existsSync(path.join(dist, "BUILD_ID"))) throw new Error("Development server cannot reuse a production build.");
} else if (fs.existsSync(path.join(dist, "BUILD_ID"))) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1 || manifest.sourceHash !== sourceHash || manifest.baseURL !== baseURL) throw new Error("Isolated build ownership or source fingerprint differs; choose a fresh NEXT_DIST_DIR.");
} else {
  if (fs.existsSync(dist) && fs.readdirSync(dist).some(entry => entry !== "cache")) throw new Error("Incomplete isolated build exists; choose a fresh NEXT_DIST_DIR.");
}
const instance = fixturePorts.fixtureInstance();
const fixture = await createToolingContentFixture({ origin: contentURL, artifact: process.env.TOOLING_CONTENT_ARTIFACT, apiRoutes, clockFile, instance });
fixturePorts.writeFixturePorts(baseURL, instance, { TOOLING_CONTENT_PORT: contentPort });
try {
  await execute(["scripts/generate-sitemap.js"]);
  await execute(["scripts/generate-robots.js"], { ...env, VERCEL_ENV: "production" });
  if (development) {
    await releaseTcpPorts(testHost, [Number(target.port)]);
    await execute([next, "dev", "--hostname", testHost, "--port", target.port]);
  } else {
    const content = { contentSha256: fixture.evidence.contentSha256, contentResponse: process.env.TOOLING_CLS_RESPONSE || "success" };
    const built = fs.existsSync(path.join(dist, "BUILD_ID")) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
    if (!built || built.contentURL !== contentURL || built.contentSha256 !== content.contentSha256 || built.contentResponse !== content.contentResponse) {
      if (built) console.log(built.contentURL === contentURL ? "Fixture content differs from the reused build; rebuilding." : "The reused build's content port is taken; rebuilding.");
      const buildEnv = { ...env, VERCEL_ENV: "development" };
      await execute(["scripts/validate-runtime-env.js"], buildEnv);
      await execute([next, "build"], monitoringStartup ? env : buildEnv);
      fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, sourceHash, baseURL, contentURL, ...content }));
    }
    await releaseTcpPorts(testHost, [Number(target.port)]);
    await execute([next, "start", "--hostname", testHost, "--port", target.port]);
  }
} catch (error) {
  if (!stopping) throw error;
} finally {
  await fixture.close();
  if (clockFile) fs.rmSync(clockFile, { force: true });
}

}
