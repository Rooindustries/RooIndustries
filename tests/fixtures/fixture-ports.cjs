const fs = require("node:fs");
const path = require("node:path");

const FIXTURE_PORT_NAMES = ["TOOLING_CONTENT_PORT", "TOOLING_ADMIN_CONTROL_PORT"];

const validPort = port => Number.isInteger(port) && port >= 1024 && port <= 65535;

const fixturePort = name => {
  if (!FIXTURE_PORT_NAMES.includes(name)) throw new Error(`${name} is not a fixture port.`);
  if (!process.env[name]) throw new Error(`${name} is missing; the fixture server reports it when Playwright starts.`);
  const port = Number(process.env[name]);
  if (!validPort(port)) throw new Error(`${name} must name a local fixture port.`);
  return port;
};

const fixtureOrigin = (baseURL, name) => {
  const url = new URL(baseURL);
  url.port = String(fixturePort(name));
  return url.origin;
};

const reportDir = path.resolve(__dirname, "../../.next-fixture-ports");

const reportPath = baseURL => path.join(reportDir, `${new URL(baseURL).host.replace(/[^a-zA-Z0-9.-]/g, "_")}.json`);

const readReport = baseURL => {
  try { return JSON.parse(fs.readFileSync(reportPath(baseURL), "utf8")); } catch { return null; }
};

const running = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};

const writeFixturePorts = (baseURL, ports) => {
  const file = reportPath(baseURL);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(`${file}.${process.pid}`, JSON.stringify({ baseURL: new URL(baseURL).origin, pid: process.pid, ports }));
  fs.renameSync(`${file}.${process.pid}`, file);
};

const removeFixturePorts = baseURL => {
  if (readReport(baseURL)?.pid === process.pid) fs.rmSync(reportPath(baseURL), { force: true });
};

const loadFixturePorts = baseURL => {
  const origin = new URL(baseURL).origin;
  const report = readReport(baseURL);
  if (report?.baseURL !== origin || !Number.isInteger(report.pid) || report.pid <= 0 || !running(report.pid)) {
    throw new Error(`No running fixture server reported its ports for ${origin}; start scripts/test-tooling-sweep-server.mjs with BASE_URL=${origin}.`);
  }
  for (const [name, port] of Object.entries(report.ports)) {
    if (!FIXTURE_PORT_NAMES.includes(name) || !validPort(port)) throw new Error(`Invalid fixture port report for ${name}.`);
    process.env[name] = String(port);
  }
  return report.ports;
};

module.exports = { FIXTURE_PORT_NAMES, fixturePort, fixtureOrigin, writeFixturePorts, removeFixturePorts, loadFixturePorts };
