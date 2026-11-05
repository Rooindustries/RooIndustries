const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const FIXTURE_PORT_NAMES = ["TOOLING_CONTENT_PORT", "TOOLING_ADMIN_CONTROL_PORT"];
const INSTANCE_PATH = "/__instance";

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

const fixtureInstance = () => randomUUID();

const writeFixturePorts = (baseURL, instance, ports) => {
  const file = reportPath(baseURL);
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify({ baseURL: new URL(baseURL).origin, instance, ports }));
  fs.renameSync(temporary, file);
};

const answersInstance = async (baseURL, port, instance) => {
  const url = new URL(INSTANCE_PATH, baseURL);
  url.port = String(port);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return response.ok && await response.text() === instance;
  } catch {
    return false;
  }
};

const loadFixturePorts = async baseURL => {
  const origin = new URL(baseURL).origin;
  const missing = new Error(`No running fixture server reported its ports for ${origin}; start scripts/test-tooling-sweep-server.mjs with BASE_URL=${origin}.`);
  const report = readReport(baseURL);
  if (report?.baseURL !== origin || typeof report.instance !== "string" || !report.instance || !report.ports || typeof report.ports !== "object") throw missing;
  const entries = Object.entries(report.ports);
  for (const [name, port] of entries) {
    if (!FIXTURE_PORT_NAMES.includes(name) || !validPort(port)) throw new Error(`Invalid fixture port report for ${name}.`);
  }
  const live = await Promise.all(entries.map(([, port]) => answersInstance(origin, port, report.instance)));
  if (!entries.length || live.includes(false)) throw missing;
  for (const [name, port] of entries) process.env[name] = String(port);
  return report.ports;
};

const loadGivenOrReportedPorts = async baseURL => {
  if (!process.env.TOOLING_CONTENT_PORT) await loadFixturePorts(baseURL);
};

module.exports = { FIXTURE_PORT_NAMES, INSTANCE_PATH, fixturePort, fixtureOrigin, fixtureInstance, writeFixturePorts, loadFixturePorts, loadGivenOrReportedPorts };
