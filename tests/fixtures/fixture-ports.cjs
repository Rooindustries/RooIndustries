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

const reportPath = dist => `${path.resolve(dist)}-ports.json`;

const writeFixturePorts = (dist, baseURL, ports) =>
  fs.writeFileSync(reportPath(dist), JSON.stringify({ baseURL: new URL(baseURL).origin, pid: process.pid, ports }));

const removeFixturePorts = dist => fs.rmSync(reportPath(dist), { force: true });

const loadFixturePorts = (dist, baseURL) => {
  let report;
  try { report = JSON.parse(fs.readFileSync(reportPath(dist), "utf8")); } catch { return null; }
  if (report.baseURL !== new URL(baseURL).origin) return null;
  try { process.kill(report.pid, 0); } catch { return null; }
  for (const [name, port] of Object.entries(report.ports)) {
    if (!FIXTURE_PORT_NAMES.includes(name) || !validPort(port)) throw new Error(`Invalid fixture port report for ${name}.`);
    process.env[name] = String(port);
  }
  return report.ports;
};

module.exports = { FIXTURE_PORT_NAMES, fixturePort, fixtureOrigin, writeFixturePorts, removeFixturePorts, loadFixturePorts };
