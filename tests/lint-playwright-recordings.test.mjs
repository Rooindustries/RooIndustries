import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve("eslint/package.json")), "bin/eslint.js");
const valid = [
  'test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });',
  'const video = page.video(); const { trace, ...purge } = payload;',
];
const invalid = [
  'test.use({ trace: "off" });',
  'test.use({ video: "off" });',
  'test["use"]({ ["trace"]: "off" });',
  'const use = test.use; use({ [`video`]: "on" });',
  'const options = { trace: "off" }; test.use({ ...options });',
  'const key = "trace"; const options = { [key]: "off" }; test.use(options);',
  'const options = {}; options.video = "off"; test.use(options);',
  'const key = "video"; options[key] = "off"; test.use(options);',
];

test("repository lint keeps Playwright recordings in the shared config", () => {
  for (const [code, status] of [...valid.map(code => [code, 0]), ...invalid.map(code => [code, 1])]) {
    const args = [cli, "--stdin", "--stdin-filename", "tests/recordings.spec.js", "--format=json"];
    const result = spawnSync(process.execPath, args, {
      input: code, encoding: "utf8",
    });
    assert.equal(result.status, status, `${code}\n${result.stdout}\n${result.stderr}`);
    const [report] = JSON.parse(result.stdout);
    assert.equal(report.errorCount, status, code);
    if (status) assert.equal(report.messages[0].ruleId, "roo/no-playwright-recording-overrides", code);
  }
});
