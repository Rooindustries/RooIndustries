import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const states = process.argv.includes("--states");
const suite = states ? "states" : "layout";
const serverId = process.env.PW_SERVER_ID || `cls-${process.pid}`;
const dist = process.env.NEXT_DIST_DIR || `.next-e2e-${serverId}`;
const modes = [
  { name: "populated", content: "1", response: "success" },
  { name: "empty", content: "0", response: "success" },
  { name: "delayed", content: "1", response: "delayed" },
  ...(states ? [{ name: "failed", content: "0", response: "failed" }] : []),
];
let active;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => active?.kill(signal));
}

for (const mode of modes) {
  const artifactDir = path.join("audit", "content-cls", serverId, suite, mode.name);
  fs.mkdirSync(artifactDir, { recursive: true });
  const env = {
    ...process.env,
    PW_SERVER_ID: `${serverId}-${mode.name}`,
    NEXT_DIST_DIR: dist,
    TOOLING_CLS_CONTENT: mode.content,
    TOOLING_CLS_RESPONSE: mode.response,
    TOOLING_CONTENT_ARTIFACT: path.join(artifactDir, "fixture.json"),
    PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(artifactDir, "results.json"),
  };
  delete env.BASE_URL;
  console.log(`Content CLS ${suite}: ${mode.name}`);
  const code = await new Promise((resolve, reject) => {
    active = spawn(process.execPath, [
      "node_modules/@playwright/test/cli.js", "test",
      states ? "tests/content-entry-states.spec.js" : "tests/content-layout-shift.spec.js",
      "--project=chromium", "--reporter=line,json",
      `--output=test-results/content-cls/${serverId}/${suite}/${mode.name}`,
    ], { env, stdio: "inherit" });
    active.once("error", reject);
    active.once("exit", (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
  });
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
