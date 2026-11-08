import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";

test("production smoke transport cannot bypass GET-only requests", async () => {
  const eslint = new ESLint();
  for (const source of [
    'fetch(url, { method: "POST" });',
    'const send = fetch; send(url);',
    'globalThis.fetch(url);',
    'const { fetch: send } = globalThis; send(url);',
    'const network = globalThis; network["fe" + "tch"](url);',
    'const network = window; network[key](url);',
    'const network = global; network[key](url);',
    'const network = self; network[key](url);',
  ]) {
    const [result] = await eslint.lintText(source, { filePath: "scripts/production-smoke.mjs" });
    assert.ok(result.errorCount > 0, source);
  }
  const [result] = await eslint.lintFiles(["scripts/production-smoke.mjs"]);
  assert.equal(result.errorCount, 0, JSON.stringify(result.messages));
});

test("production smoke cannot silently swallow response handling errors", async () => {
  const eslint = new ESLint();
  for (const source of ['try { handle(); } catch {}', 'response.catch(() => {});']) {
    for (const filePath of ["scripts/production-smoke.mjs", "scripts/lib/production-smoke-request.mjs"]) {
      const [result] = await eslint.lintText(source, { filePath });
      assert.ok(result.errorCount > 0, source);
    }
  }
});
