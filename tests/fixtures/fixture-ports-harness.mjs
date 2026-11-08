import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { spawnContained, stopChild } from "../../scripts/lib/start-on-port.mjs";
import { passTcpPortReservations, releaseTcpPorts } from "../../scripts/lib/free-tcp-port.mjs";

export const host = "127.0.0.1";
const inherited = /SENTRY_DSN$|^BASE_URL$|^NEXT_DIST_DIR$|^PW_PORT$|^PW_SERVER_ID$|^TOOLING_|^BOOKING_ROUTE_PORT$|^NODE_OPTIONS$|^NODE_TEST_CONTEXT$/;
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !inherited.test(name)));
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export const run = (args, env, { detached = false, command = process.execPath } = {}) => {
  let output = "";
  const start = detached ? spawnContained : spawn;
  const ports = [env.PW_PORT, env.UI_NEXT_PORT, env.BOOKING_ROUTE_PORT].map(Number).filter(Boolean);
  const options = passTcpPortReservations(host, ports, {
    stdio: ["ignore", "pipe", "pipe"], env: { ...cleanEnv(), ROO_TEST_HOST: host, ...env },
  });
  const child = start(command, args, options);
  child.once("close", async () => {
    if (detached) await stopChild(child);
    await releaseTcpPorts(host, ports);
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
  return { child, output: () => output };
};

export const waitFor = async (server, check, timeout, what) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error(`The server exited before ${what}:\n${server.output()}`);
    const value = await check();
    if (value) return value;
    await pause(250);
  }
  throw new Error(`The server never ${what}:\n${server.output()}`);
};

export const startTooling = async (dist, port, env = {}, { ready = "page" } = {}) => {
  const server = run(["scripts/test-tooling-sweep-server.mjs"], {
    BASE_URL: `http://${host}:${port}`, PW_PORT: String(port), NEXT_DIST_DIR: dist,
    ROO_ADMIN_FIXTURE: "0", TOOLING_DEV_SERVER: "0", TOOLING_API_ROUTES: "0", ...env,
  }, { detached: true });
  try {
    if (ready === "page") await waitFor(server, () => fetch(`http://${host}:${port}/`).then(response => response.ok, () => false), 420000, "served its home page");
    else await waitFor(server, () => readReport(port), 120000, "reported its ports");
    return server;
  } catch (error) {
    await stopChild(server.child);
    throw error;
  }
};

export const reportDir = path.resolve(".next-fixture-ports");
export const reportFile = port => path.join(reportDir, `${host}_${port}.json`);
export const readReport = port => {
  try { return JSON.parse(fs.readFileSync(reportFile(port), "utf8")); } catch { return null; }
};
export const writeReport = (port, report) => {
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportFile(port), JSON.stringify(report));
};
export const playwright = (args, env) => run(["-a", ...args], env, { command: "xvfb-run" });
