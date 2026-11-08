import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

test("the configured linter confines payment session storage to its booking helper", () => {
  const lint = source => spawnSync(process.execPath, ["node_modules/eslint/bin/eslint.js", "--no-ignore", "--stdin",
    "--stdin-filename", resolve("src/components/Checkout.jsx")], { input: source, encoding: "utf8" });
  for (const source of [
    'const key = "payment_session_state"; sessionStorage.getItem(key);',
    'const { getItem: read } = sessionStorage; read("payment_session_state");',
    'sessionStorage["getItem"](`payment_session_state`);',
  ]) {
    const result = lint(source);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /roo\/no-unscoped-payment-storage/);
  }
  assert.equal(lint('import { readCheckoutPaymentSession } from "../lib/paymentSessionStorage";').status, 0);
  execFileSync(process.execPath, ["node_modules/eslint/bin/eslint.js", "src/lib/paymentSessionStorage.js"]);
});
