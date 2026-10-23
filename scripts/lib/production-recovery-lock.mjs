import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { fstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export let recoveryLock;

export const withRecoveryLock = async (domain, run) => {
  const api = new URL(process.env.VERCEL_API_URL || "https://api.vercel.com").origin;
  const key = createHash("sha256").update(`${api}/${domain.toLowerCase().replace(/\.$/, "")}`).digest("hex");
  const directory = path.join(os.homedir(), ".cache", "roo-production-locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `${key}.lock`);
  if (process.env.ROO_RECOVERY_LOCK === key) {
    const inherited = await open(filename, "a", 0o600);
    try {
      const held = fstatSync(3);
      const expected = await inherited.stat();
      if (held.ino !== expected.ino || held.dev !== expected.dev) throw new Error("Invalid production recovery lock.");
      recoveryLock = 3;
      return await run();
    } finally {
      await inherited.close();
    }
  }
  const file = await open(filename, "a", 0o600);
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn("flock", ["--exclusive", "--timeout", "600", "3"], {
        stdio: ["ignore", "ignore", "ignore", file.fd],
      });
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (code !== 0) throw new Error("Could not acquire the production recovery lock; nothing changed.");
    recoveryLock = file.fd;
    process.env.ROO_RECOVERY_LOCK = key;
    return await run();
  } finally {
    recoveryLock = undefined;
    delete process.env.ROO_RECOVERY_LOCK;
    await file.close();
  }
};
