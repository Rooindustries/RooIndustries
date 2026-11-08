import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

test("the configured linter confines checkout choice storage to its shared helper", () => {
  const lint = source => spawnSync(process.execPath, ["node_modules/eslint/bin/eslint.js", "--no-ignore", "--stdin",
    "--stdin-filename", resolve("src/components/Checkout.jsx")], { input: source, encoding: "utf8" });
  for (const key of ["booking_draft", "checkout_booking_state", "payment_session_state", "referral_session"]) {
    for (const source of [
      `const key = "${key}"; sessionStorage.setItem(key, JSON.stringify(draft));`,
      `const { setItem: save } = localStorage; save("${key}", value);`,
      `sessionStorage["removeItem"](\`${key}\`);`,
    ]) {
      const result = lint(source);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /roo\/no-unscoped-payment-storage/);
    }
  }
  assert.equal(lint('import { readCheckoutPaymentSession } from "../lib/paymentSessionStorage";').status, 0);
  execFileSync(process.execPath, ["node_modules/eslint/bin/eslint.js", "src/lib/paymentSessionStorage.js"]);
  execFileSync(process.execPath, ["node_modules/eslint/bin/eslint.js", "public/checkout-state.js"]);
});
