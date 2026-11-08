import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();
const files = ["providerClients.js", "dodoProvider.js", "otherProvider.mjs", "providers/new.js"]
  .map(name => `src/server/api/payment/${name}`);
const transports = [
  "fetch(url, { signal: AbortSignal.timeout(8000) });",
  "const send = fetch; send(url);",
  'globalThis["fetch"](url);',
  "const root = globalThis; root[name](url);",
  "const { fetch: send } = global; send(url);",
  'import { fetch as send } from "undici"; send(url);',
  'const { fetch: send } = require("undici"); send(url);',
  'import send from "node-fetch"; send(url);',
  'import DodoPayments from "dodopayments"; new DodoPayments();',
  'import send from "cross-fetch"; send(url);',
  'import send from "./local-fetch.js"; send(url);',
  'import { request } from "node:https"; request(url);',
  'const { default: send } = await import("node-fetch"); send(url);',
  'const load = require; const send = load("node-fetch"); send(url);',
];

test("provider modules keep every transport behind the shared request module", async () => {
  for (const filePath of files) {
    for (const code of transports) {
      const [result] = await eslint.lintText(code, { filePath });
      assert.ok(result.messages.some(message => message.ruleId?.startsWith("no-restricted-")), `${filePath}: ${code}`);
    }
    const [result] = await eslint.lintText(
      'import { requestProvider } from "./providerRequest.js"; requestProvider(url);', { filePath },
    );
    assert.equal(result.errorCount, 0, filePath);
  }
});

test("transport restrictions leave non-provider modules alone", async () => {
  for (const filePath of ["src/server/api/payment/flow.js", "src/server/api/payment/providerRequest.js"]) {
    for (const code of transports) {
      const [result] = await eslint.lintText(code, { filePath });
      assert.equal(result.errorCount, 0, `${filePath}: ${code}`);
    }
  }
});
