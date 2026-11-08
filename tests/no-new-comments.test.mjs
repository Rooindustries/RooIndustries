import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const checker = fileURLToPath(new URL("../.github/no-new-comments.mjs", import.meta.url));
const baseFiles = {
  "move.js": "// Keeps layout stable.\nexport const stable = true;\n",
  "adjacent.js": "// Existing line.\nexport const retained = true;\n",
  "partial.js": "/* Existing block\n * retains its shape.\n */\nexport const value = 1;\n",
  "credit.js": "/* codex legacy reference\n * retains its shape.\n */\nexport const legacy = 1;\n",
};
const mitHeader = `/*
 * Copyright (c) 2026 Example
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export const value = 1;
`;

test("comment policy checks committed Git changes without executing them", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "comment-policy-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  try {
    git("init", "--initial-branch=main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    for (const [path, text] of Object.entries(baseFiles)) write(path, text);
    git("add", ".");
    git("commit", "-m", "test: seed comment cases");
    const base = git("rev-parse", "HEAD");
    const cases = [
      ["line comment", "new.js", "export const value = 1; // Explains value.\n", 1],
      ["block comment", "new.mjs", "/* Explains value. */\nexport const value = 1;\n", 1],
      ["commonjs", "new.cjs", "module.exports = 1; // Explains value.\n", 1],
      ["JSX apostrophe", "new.jsx", "export const View = () => <p>Don't wait {/* Explains state. */}</p>;\n", 1],
      ["JSX text", "new.jsx", "export const View = () => <p>Don't wait // ordinary prose</p>;\n", 0],
      ["template payload", "new.js", "export const text = `\n/*\nnot a comment\n`;\n", 0],
      ["interpolated code", "new.js", "export const text = `${/* Explains value. */ 1}`;\n", 1],
      ["strings and regex", "new.js",
        "export const text = '/* ordinary string */'; export const re = /https?:\\/\\//;\n", 0],
      ["reserved names in strings", "new.js", "export const text = 'claude codex chatgpt openai anthropic gpt-6 🤖';\n", 0],
      ["TypeScript", "new.ts", "export const value: number = 1; // Explains value.\n", 1],
      ["TypeScript without comments", "new.ts", "export const value: number = 1;\n", 0],
      ["TSX", "new.tsx", "export const View = (): unknown => <p>{/* Explains state. */}</p>;\n", 1],
      ["TSX without comments", "new.tsx", "export const View = (): unknown => <p>Don't wait</p>;\n", 0],
      ["module TypeScript", "new.mts", "export const value: number = 1; // Explains value.\n", 1],
      ["commonjs TypeScript", "new.cts", "const value: number = 1; // Explains value.\nexport = value;\n", 1],
      ["directive", "new.js", "// eslint-disable-next-line no-console\nconsole.log(1);\n", 0],
      ["type directive", "new.ts", "// @ts-expect-error\nexport const value: number = 'one';\n", 0],
      ["adjacent directives", "new.js", "// @ts-check\n// eslint-disable-next-line no-console\nconsole.log(1);\n", 0],
      ["bundler directive", "new.js", "export const value = /* @__PURE__ */ makeValue();\n", 0],
      ["directive prose", "new.js", "// eslint-disable-next-line no-console -- Explains logging.\nconsole.log(1);\n", 1],
      ["lookalike directive", "new.js", "// @ts-expect-error Explains a choice.\nexport const value = 1;\n", 1],
      ["disable bypass", "new.js", "/* eslint-disable */\n// Explains value.\nexport const value = 1;\n", 1],
      ["license at top", "new.js", "/* SPDX-License-Identifier: MIT */\nexport const value = 1;\n", 0],
      ["full MIT license", "new.js", mitHeader, 0],
      ["line license header", "new.js",
        "// Copyright (c) 2026 Example\n// SPDX-License-Identifier: MIT\nexport const value = 1;\n", 0],
      ["license after shebang", "new.js", "#!/usr/bin/env node\n/* Copyright (c) 2026 Example */\nrun();\n", 0],
      ["license after code", "new.js", "export const value = 1;\n/* SPDX-License-Identifier: MIT */\n", 1],
      ["license plus prose", "new.js",
        "/* SPDX-License-Identifier: MIT\n * Explains a choice.\n */\nexport const value = 1;\n", 1],
      ["new adjacent comment", "adjacent.js", "// Existing line.\n// Explains value.\nexport const retained = true;\n", 1],
      ["unchanged comment", "adjacent.js", "// Existing line.\nexport const retained = false;\n", 0],
      ["partially retained block", "partial.js",
        "/* Existing block\n * keeps its shape.\n */\nexport const value = 1;\n", 0],
      ["existing reserved name", "credit.js",
        "/* codex legacy reference\n * keeps its shape.\n */\nexport const legacy = 1;\n", 0],
      ["ambiguous names in prose", "new.js", "export const label = 'cursor gemini opus sonnet copilot devin';\n", 0,
        { PR_TITLE: "fix: cursor position", PR_BODY: "The sonnet now wraps normally." }],
      ["unsupported formats", "new.sql", "-- Explains query.\nselect 1;\n", 0],
      ["shell out of scope", "new.sh", "# Explains shell.\necho ok\n", 0],
      ["YAML out of scope", "new.yml", "# Explains config.\nvalue: true\n", 0],
      ["Python out of scope", "new.py", '"""Explains function."""\nvalue = 1\n', 0],
      ["HTML out of scope", "new.html", "<!-- Explains page. -->\n<p>Hello</p>\n", 0],
      ["invalid JavaScript", "new.js", "export const value = ;\n", 1],
    ];
    for (const name of ["codex", "claude", "chatgpt", "openai", "anthropic", "gpt-6"]) {
      cases.push([`reserved metadata ${name}`, "new.js", "export const value = 1;\n", 1, { PR_BODY: name }]);
    }
    for (const name of ["cursor", "gemini", "opus", "sonnet", "copilot", "devin"]) {
      cases.push([`attribution ${name}`, "new.js", "export const value = 1;\n", 1,
        { PR_TITLE: `created with ${name}` }]);
    }
    cases.push(
      ["coauthor bot", "new.js", "export const value = 1;\n", 1, {},
        "fix: value\n\nCo-authored-by: helper[bot] <bot@example.invalid>"],
      ["human coauthor", "new.js", "export const value = 1;\n", 0, {},
        "fix: value\n\nCo-authored-by: Alex <alex@example.invalid>"],
      ["reserved commit", "new.js", "export const value = 1;\n", 1, {}, "fix: generated with Claude"],
      ["robot metadata", "new.js", "export const value = 1;\n", 1, { PR_BODY: "🤖" }],
      ["added credit in existing comment", "partial.js",
        "/* Existing block\n * written by Codex\n */\nexport const value = 1;\n", 1],
      ["moved rewrapped comment", "destination.js",
        "/* Keeps layout\n * stable. */\nexport const moved = true;\n", 0, {}, undefined,
        { "move.js": "export const stable = true;\n" }],
      ["moved line comments", "destination.js",
        "// Keeps layout\n// stable.\nexport const moved = true;\n", 0, {}, undefined,
        { "move.js": "export const stable = true;\n" }],
      ["rewrapped removed lines", "destination.js", "/* Existing line. */\nexport const moved = true;\n", 0, {}, undefined,
        { "adjacent.js": "export const retained = true;\n" }],
      ["trusted checker", "new.js", "// Explains value.\nthrow new Error('Must never execute');\n", 1, {}, undefined,
        {
          ".github/no-new-comments.mjs": "process.exit(0);\n",
          "eslint.config.mjs": "throw new Error('Must never load');\n",
        }],
    );
    for (const [name, path, text, status, metadata = {}, message = "test: change fixture", extra = {}] of cases) {
      await t.test(name, () => {
        git("reset", "--hard", base);
        git("clean", "-fd");
        write(path, text);
        for (const [extraPath, extraText] of Object.entries(extra)) write(extraPath, extraText);
        git("add", ".");
        git("commit", "-m", message);
        const result = spawnSync(process.execPath, [checker], {
          cwd: root, encoding: "utf8",
          env: { ...env, BASE_SHA: base, HEAD_SHA: "HEAD", PR_TITLE: "", PR_BODY: "", ...metadata },
        });
        assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Must never (?:execute|load)/);
        if (name !== "invalid JavaScript") {
          assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Parsing error|No matching configuration/);
        }
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
