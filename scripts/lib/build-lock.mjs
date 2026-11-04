import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";

const lockName = (dir) => `\0roo-build-lock-${createHash("sha256").update(path.resolve(dir)).digest("hex")}`;

const tryLock = (dir) => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", (error) => (error.code === "EADDRINUSE" ? resolve(null) : reject(error)));
  server.listen(lockName(dir), () => {
    server.unref();
    resolve(server);
  });
});

export const lockBuildDirectory = async (dir, { slots = 1 } = {}) => {
  for (let slot = 1; slot <= slots; slot += 1) {
    const candidate = slot === 1 ? dir : `${dir}-${slot}`;
    const lock = await tryLock(candidate);
    if (lock) return { dir: candidate, release: () => new Promise((resolve) => lock.close(resolve)) };
  }
  throw Object.assign(new Error(`${dir} is in use by another run.`), { code: "ELOCKED" });
};
