import path from "node:path";
import { spawnSync, startChildOnPorts } from "./fixture-tools.mjs";

export const startPostgres = async (pgBin, dataDir, host, port) => {
  const output = [];
  const { child } = await startChildOnPorts({
    host,
    requested: [port],
    output: () => output.join(""),
    isReady: () => spawnSync(path.join(pgBin, "pg_isready"),
      ["-h", host, "-p", String(port)], { stdio: "ignore" }).status === 0,
    spawnChild: ([picked], launch) => {
      const child = launch.spawn(path.join(pgBin, "postgres"),
        ["-D", dataDir, "-p", String(picked), "-h", host, "-k", ""], {
          env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"],
        });
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => output.push(String(chunk)));
      return child;
    },
  });
  return child;
};
