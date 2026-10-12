import { spawn } from "node:child_process";
import { installNetworkGuard, localOrigin, refuseEnvFiles, validateDistDir } from "./lib/test-target-safety.mjs";

refuseEnvFiles();
const host = process.env.ROO_TEST_HOST || "127.0.0.1";
const target = new URL(localOrigin(process.env.BASE_URL || `http://${host}:${process.env.PW_PORT || 3001}`));
if (target.hostname !== host) throw new Error("API audit host must match ROO_TEST_HOST.");
const port = Number(target.port) + 2;
if (port > 65534) throw new Error("API audit requires two available fixture ports.");
const baseURL = localOrigin(`http://${host}:${port}`);
const contentURL = localOrigin(`http://${host}:${port + 1}`);
const dist = validateDistDir(`${process.env.NEXT_DIST_DIR || `.next-e2e-${process.env.PW_SERVER_ID || process.pid}`}-api`, { isolated: true });
installNetworkGuard([baseURL, contentURL]);

const env = {
  ...process.env,
  BASE_URL: baseURL,
  ROO_TEST_HOST: host,
  PW_PORT: String(port),
  NEXT_DIST_DIR: dist,
  TOOLING_API_ROUTES: "1",
  TOOLING_CONTENT_PORT: String(port + 1),
  TOOLING_CONTENT_ARTIFACT: "audit/phase1-api-fixture.json",
  ALLOW_LIVE_PAYMENTS: "0",
};
const children = new Map();
let stopping = false;

const launch = (args, stdio = "inherit") => {
  if (stopping) throw new Error("API audit was stopped.");
  const child = spawn(process.execPath, args, { env, stdio, detached: process.platform !== "win32" });
  const closed = new Promise(resolve => {
    child.once("error", error => resolve({ error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  children.set(child, closed);
  closed.then(() => children.delete(child));
  return { child, closed };
};

const signalChild = (child, signal) => {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};

const stopChildren = async () => {
  stopping = true;
  await Promise.all([...children].map(async ([child, closed]) => {
    signalChild(child, "SIGTERM");
    const timer = setTimeout(() => signalChild(child, "SIGKILL"), 15000);
    try { await closed; } finally { clearTimeout(timer); }
  }));
  children.clear();
};

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  process.exitCode = 1;
  stopping = true;
  for (const child of children.keys()) signalChild(child, signal);
});

try {
  const server = launch(["scripts/test-tooling-sweep-server.mjs"], ["ignore", "pipe", "inherit"]);
  let timer;
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("API fixture startup timed out.")), 180000);
    let output = "";
    server.child.stdout.on("data", chunk => {
      process.stdout.write(chunk);
      output = (output + chunk.toString()).slice(-2048);
      if (/\bReady in\b/.test(output)) resolve();
    });
  });
  try {
    await Promise.race([
      ready,
      server.closed.then(({ error, code, signal }) => {
        throw error || new Error(`API fixture exited before readiness: ${signal || code}.`);
      }),
    ]);
  } finally { clearTimeout(timer); }

  const audit = launch(["scripts/phase1-api-contract.js"]);
  const result = await Promise.race([
    audit.closed,
    server.closed.then(({ error, code, signal }) => {
      throw error || new Error(`API fixture exited during audit: ${signal || code}.`);
    }),
  ]);
  if (result.error) throw result.error;
  if (result.code !== 0) process.exitCode = 1;
} catch (error) {
  console.error(`[api-contract-audit] ${error.message}`);
  process.exitCode = 1;
} finally {
  await stopChildren();
}
