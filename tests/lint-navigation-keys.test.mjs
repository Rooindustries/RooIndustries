import { describe, it } from "node:test";
import { RuleTester } from "eslint";
import rule from "../eslint-rules/no-secure-context-navigation-keys.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester().run("no-secure-context-navigation-keys", rule, {
  valid: ["let nextTripKey = 0; const key = `section-${++nextTripKey}`;"],
  invalid: [
    { code: "const key = window.crypto.randomUUID();", errors: [{ messageId: "key" }] },
    { code: "const key = crypto.randomUUID();", errors: [{ messageId: "key" }] },
  ],
});
