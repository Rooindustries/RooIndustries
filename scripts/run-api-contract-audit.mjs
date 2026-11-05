import { installNetworkGuard, localOrigin, refuseEnvFiles, validateDistDir } from "./lib/test-target-safety.mjs";
import { portFromEnv } from "./lib/free-tcp-port.mjs";
import { spawnContained, startChildOnPorts, stopChild } from "./lib/start-on-port.mjs";
import { signalGroup } from "./lib/process-group.mjs";

refuseEnvFiles();
const host = process.env.ROO_TEST_HOST || "127.0.0.1";
const pwPort = portFromEnv("PW_PORT");
const target = (process.env.BASE_URL || pwPort) && new URL(localOrigin(process.env.BASE_URL || `http://${host}:${pwPort}`));
if (target && target.hostname !== host) throw new Error("API audit host must match ROO_TEST_HOST.");
const distBase = validateDistDir(`${process.env.NEXT_DIST_DIR || `.next-e2e-${process.env.PW_SERVER_ID || process.pid}`}-api`, { isolated: true });
let env, restoreGuard;
const configure = ([port, contentPort]) => {
  const baseURL = localOrigin(`http://${host}:${port}`);
  const contentURL = localOrigin(`http://${host}:${contentPort}`);
  restoreGuard?.();
  restoreGuard = installNetworkGuard([baseURL, contentURL]);
  env = {
    ...process.env,
    BASE_URL: baseURL,
    ROO_TEST_HOST: host,
    PW_PORT: String(port),
    NEXT_DIST_DIR: validateDistDir(`${distBase}-${port}`, { isolated: true }),
    TOOLING_API_ROUTES: "1",
    TOOLING_CONTENT_PORT: String(contentPort),
    TOOLING_CONTENT_ARTIFACT: "audit/phase1-api-fixture.json",
    ALLOW_LIVE_PAYMENTS: "0",
  };
};
const children = new Map();
let stopping = false;

const launch = (args, stdio = "inherit", start = spawnContained) => {
  if (stopping) throw new Error("API audit was stopped.");
  const child = start(process.execPath, args, { env, stdio });
  const closed = new Promise(resolve => {
    child.once("error", error => resolve({ error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  children.set(child, closed);
  closed.then(() => children.delete(child));
  return { child, closed };
};

const stopChildren = async () => {
  stopping = true;
  await Promise.all([...children].map(async ([child, closed]) => {
    await stopChild(child, 15000);
    await closed;
  }));
  children.clear();
};

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  process.exitCode = 1;
  stopping = true;
  for (const child of children.keys()) signalGroup(child, signal);
});

try {
  let server;
  const output = [];
  await startChildOnPorts({
    host,
    requested: [0, 0],
    passHeld: true,
    timeout: 180000,
    output: () => output.join(""),
    isReady: () => /\bReady in\b/.test(output.join("")),
    spawnChild: (ports, held) => {
      output.length = 0;
      configure(ports);
      server = launch(["scripts/test-tooling-sweep-server.mjs"], ["ignore", "pipe", "pipe"], held.spawn);
      server.child.stdout.on("data", chunk => { output.push(String(chunk)); process.stdout.write(chunk); });
      server.child.stderr.on("data", chunk => { output.push(String(chunk)); process.stderr.write(chunk); });
      return server.child;
    },
  });

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
