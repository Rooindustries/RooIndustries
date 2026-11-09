import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { RuleTester } from "eslint";
import rule from "../eslint-rules/no-raw-payment-session.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
new RuleTester().run("no-raw-payment-session", rule, {
  valid: [
    'writeStoredPaymentSession(session);',
    { filename: fileURLToPath(new URL("../src/lib/checkoutRecovery.js", import.meta.url)),
      code: 'const key = "payment_session_state"; sessionStorage.setItem(key, data);' },
  ],
  invalid: [
    'sessionStorage.setItem("payment_session_state", JSON.stringify(session));',
    'const storage = sessionStorage; storage["setItem"]("payment_session_state", data);',
    'const { setItem: save } = sessionStorage; save(`payment_session_state`, data);',
    'const key = "payment_session_state"; save(key, data);',
  ].map(code => ({ code, errors: [{ messageId: "cache" }] })),
});
