import fs from "node:fs";
import path from "node:path";
import { reserveTcpPorts } from "./free-tcp-port.mjs";

const builtPorts = (host, dist) => {
  const manifestPath = path.join(dist, "tooling-build.json");
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const urls = [new URL(manifest.baseURL), new URL(manifest.contentURL)];
  return urls.every((url) => url.hostname === host) ? urls.map((url) => Number(url.port)) : null;
};

export const reserveToolingBuildPorts = async (host, dist, first) => {
  const built = builtPorts(host, dist);
  const requested = first ? [Number(first), Number(first) + 1] : built;
  const preferred = requested && await reserveTcpPorts(host, requested).catch((error) => {
    if (first || error.code !== "EADDRINUSE") throw error;
    return null;
  });
  const ports = preferred || await reserveTcpPorts(host, [0, 0]);
  if (built && (built[0] !== ports[0] || built[1] !== ports[1])) {
    for (const entry of fs.readdirSync(dist)) if (entry !== "cache") fs.rmSync(path.join(dist, entry), { recursive: true, force: true });
  }
  return ports;
};
