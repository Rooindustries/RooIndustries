import { describe, it } from "node:test";
import { RuleTester } from "eslint";
import { rules } from "../eslint-rules/index.mjs";

const rule = rules["no-secure-context-navigation-keys"];

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester().run("no-secure-context-navigation-keys", rule, {
  valid: [
    "let count = 0; const page = Math.random().toString(36).slice(2); const key = `section-${page}-${++count}`;",
  ],
  invalid: [
    { code: "const key = window.crypto.randomUUID();", errors: [{ messageId: "key" }] },
    { code: "const key = crypto.randomUUID();", errors: [{ messageId: "key" }] },
  ],
});
