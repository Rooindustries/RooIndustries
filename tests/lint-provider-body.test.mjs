import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();
const filePath = "src/server/api/payment/providerClients.js";

test("provider requests keep body cancellation in the shared request module", async () => {
  for (const code of [
    "fetch(url, { signal: AbortSignal.timeout(8000) });",
    "const send = fetch; send(url);",
    'globalThis["fetch"](url);',
    "const root = globalThis; root[name](url);",
    "const { fetch: send } = global; send(url);",
    'import { fetch as send } from "undici"; send(url);',
    'const { fetch: send } = require("undici"); send(url);',
  ]) {
    const [result] = await eslint.lintText(code, { filePath });
    assert.ok(result.errorCount, code);
  }
  const [result] = await eslint.lintText("requestProvider(url);", { filePath });
  assert.equal(result.errorCount, 0);
});
