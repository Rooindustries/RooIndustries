import { test } from "node:test";
import assert from "node:assert/strict";
import { ESLint } from "eslint";

const eslint = new ESLint();
const filePath = "src/components/Hero.jsx";

test("public copy cannot bypass the shared content cache", async () => {
  for (const code of [
    'import { getPublicContent } from "../lib/publicContentClient";',
    'import { getPublicContent as load } from "../lib/publicContentClient.js";',
    'import * as content from "../lib/publicContentClient"; const { getPublicContent: load } = content;',
  ]) {
    const [result] = await eslint.lintText(code, { filePath });
    assert.equal(result.messages.filter(({ ruleId }) => ruleId === "no-restricted-imports").length, 1);
  }
  const [result] = await eslint.lintText('import { useContent } from "../lib/useContent";', { filePath });
  assert.equal(result.errorCount, 0);
});

test("sections cannot normalize cached package or FAQ content again", async () => {
  for (const filePath of ["src/components/Packages.jsx", "src/components/Faq.jsx"]) {
    for (const code of [
      'import content from "../lib/packageContent";',
      'import * as content from "../lib/packageContent.js";',
    ]) {
      const [result] = await eslint.lintText(code, { filePath });
      assert.equal(result.messages.filter(({ ruleId }) => ruleId === "no-restricted-imports").length, 1);
    }
  }
});

test("tools cannot normalize cached content again", async () => {
  const [result] = await eslint.lintText('import content from "../lib/toolContent";', {
    filePath: "src/components/Tools.jsx",
  });
  assert.equal(result.messages.filter(({ ruleId }) => ruleId === "no-restricted-imports").length, 1);
});
