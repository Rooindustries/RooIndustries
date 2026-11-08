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
  "move-copy.js": "// Keeps layout stable.\nexport const copy = true;\n",
  "adjacent.js": "// Existing line.\nexport const retained = true;\n",
  "partial.js": "/* Existing block\n * retains its shape.\n */\nexport const value = 1;\n",
  "credit.js": "/* codex legacy reference\n * retains its shape.\n */\nexport const legacy = 1;\n",
  "wrap.js": "export const first = 1;\nexport const second = 2;\n",
  "cli.js": "#!/usr/bin/env node\nexport const cli = true;\n",
  "readme.md": "Existing codex credit.\nKeep this line.\n",
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
      ["global sentence", "new.js", "// global cache shared across requests\nexport const value = 1;\n", 1],
      ["globals sentence", "new.js", "// globals are reset between tests\nexport const value = 1;\n", 1],
      ["exported sentence", "new.js", "// exported helpers\nexport const value = 1;\n", 1],
      ["type directive", "new.ts", "// @ts-expect-error\nexport const value: number = 'one';\n", 0],
      ["adjacent directives", "new.js", "// @ts-check\n// eslint-disable-next-line no-console\nconsole.log(1);\n", 0],
      ["bundler directive", "new.js", "export const value = /* @__PURE__ */ makeValue();\n", 0],
      ["directive justification", "new.js",
        "// eslint-disable-next-line no-console -- Explains logging.\nconsole.log(1);\n", 0],
      ["directive justification with reserved names", "new.js",
        "// eslint-disable-next-line no-console -- Generated by codex\nconsole.log(1);\n", 0],
      ["type directive description", "new.js", "// @ts-expect-error Explains a choice.\nexport const value = 1;\n", 0],
      ["type directive after code", "new.js", "export const value = 1;\n// @ts-check\n", 1],
      ["ESLint rule config", "new.js", '/* eslint "no-console": "off" */\nexport const value = 1;\n', 0],
      ["invalid ESLint rule config", "new.js", '/* eslint "no-console": ??? */\nexport const value = 1;\n', 1],
      ["multiline disable-line", "new.js", "/* eslint-disable-line\nno-console */\nexport const value = 1;\n", 1],
      ["disable bypass", "new.js", "/* eslint-disable */\n// Explains value.\nexport const value = 1;\n", 1],
      ["license at top", "new.js", "/* SPDX-License-Identifier: MIT */\nexport const value = 1;\n", 0],
      ["full MIT license", "new.js", mitHeader, 0],
      ["line license header", "new.js",
        "// Copyright (c) 2026 Example\n// SPDX-License-Identifier: MIT\nexport const value = 1;\n", 0],
      ["license after shebang", "new.js", "#!/usr/bin/env node\n/* Copyright (c) 2026 Example */\nrun();\n", 0],
      ["retained shebang", "cli.js", "#!/usr/bin/env node\nexport const cli = false;\n", 0],
      ["retained shebang copied as comment", "cli.js",
        "#!/usr/bin/env node\n// /usr/bin/env node\nexport const cli = true;\n", 1],
      ["retained shebang copied across files", "new.js", "// /usr/bin/env node\nexport const value = 1;\n", 1,
        {}, undefined, { "cli.js": "#!/usr/bin/env node\nexport const cli = false;\n" }],
      ["removed shebang copied as comment", "new.js", "// /usr/bin/env node\nexport const value = 1;\n", 1,
        {}, undefined, { "cli.js": "export const cli = true;\n" }],
      ["license after code", "new.js", "export const value = 1;\n/* SPDX-License-Identifier: MIT */\n", 1],
      ["license plus prose", "new.js",
        "/* SPDX-License-Identifier: MIT\n * Explains a choice.\n */\nexport const value = 1;\n", 1],
      ["license notice without text", "new.js", "/* Licensed under the MIT license. */\nexport const value = 1;\n", 1],
      ["new adjacent comment", "adjacent.js", "// Existing line.\n// Explains value.\nexport const retained = true;\n", 1],
      ["unchanged comment", "adjacent.js", "// Existing line.\nexport const retained = false;\n", 0],
      ["partially retained block", "partial.js",
        "/* Existing block\n * keeps its shape.\n */\nexport const value = 1;\n", 1],
      ["existing reserved name", "credit.js",
        "/* codex legacy reference\n * keeps its shape.\n */\nexport const legacy = 1;\n", 1],
      ["unchanged block", "partial.js",
        "/* Existing block\n * retains its shape.\n */\nexport const value = 2;\n", 0],
      ["unchanged reserved name", "credit.js",
        "/* codex legacy reference\n * retains its shape.\n */\nexport const legacy = 2;\n", 0],
      ["wrapped unchanged code", "wrap.js", "/*\nexport const first = 1;\n*/\nexport const second = 2;\n", 1],
      ["wrapped unchanged file", "wrap.js", "/*\nexport const first = 1;\nexport const second = 2;\n*/\n", 1],
      ["duplicated retained comment", "adjacent.js",
        "// Existing line.\nexport const retained = true;\n// Existing line.\nexport const duplicate = true;\n", 1],
      ["moved within file", "adjacent.js", "export const retained = true;\n// Existing line.\n", 0],
      ["reserved names in metadata", "new.js", "export const label = 'cursor gemini opus sonnet copilot devin';\n", 1,
        { PR_TITLE: "fix: cursor position", PR_BODY: "The sonnet now wraps normally." }],
      ["ordinary names in code strings", "new.js", "export const label = 'cursor gemini opus sonnet copilot devin';\n", 0],
      ["plain markdown", "new.md", "The booking form now keeps your selection.\n", 0],
      ["credit in markdown", "new.md", "Generated by a helper.\n", 1],
      ["reserved name in text", "new.txt", "Written with Gemini.\n", 1],
      ["reserved name in rich text", "new.rst", "Created with Cursor.\n", 1],
      ["unchanged prose credit", "readme.md", "Existing codex credit.\nKeep this line.\nAdd plain text.\n", 0],
      ["new prose credit", "readme.md", "Existing codex credit.\nKeep this line.\nGenerated by a helper.\n", 1],
      ["removed prose credit", "readme.md", "Keep this line.\n", 0],
      ["unsupported formats", "new.sql", "-- Explains query.\nselect 1;\n", 0],
      ["shell out of scope", "new.sh", "# Explains shell.\necho ok\n", 0],
      ["YAML out of scope", "new.yml", "# Explains config.\nvalue: true\n", 0],
      ["Python out of scope", "new.py", '"""Explains function."""\nvalue = 1\n', 0],
      ["HTML out of scope", "new.html", "<!-- Explains page. -->\n<p>Hello</p>\n", 0],
      ["invalid JavaScript", "new.js", "export const value = ;\n", 1],
    ];
    for (const directive of ["global", "globals"]) {
      cases.push(
        [`${directive} modifiers on every name`, "new.js",
          `/* ${directive} first:writable, second:readonly */\nexport const value = 1;\n`, 0],
        [`${directive} spaced modifiers`, "new.js",
          `/* ${directive} first : writable, second : readonly */\nexport const value = 1;\n`, 0],
        [`${directive} whitespace separator`, "new.js",
          `/* ${directive} first:writable second:readonly */\nexport const value = 1;\n`, 0],
        [`${directive} mixed separators`, "new.js",
          `/* ${directive} first : writable, second:readonly\tthird:off */\nexport const value = 1;\n`, 0],
        [`${directive} bare names`, "new.js",
          `/* ${directive} first second, third */\nexport const value = 1;\n`, 0],
        [`${directive} invalid modifier`, "new.js",
          `/* ${directive} first:invalid second:readonly */\nexport const value = 1;\n`, 1],
        [`${directive} legacy modifiers`, "new.js",
          `/* ${directive} first:true, second:false, third:readable, fourth:writeable, fifth:off */\n` +
          "export const value = 1;\n", 0],
        [`${directive} trailing prose`, "new.js",
          `/* ${directive} first:writable, second:readonly Explains a choice. */\nexport const value = 1;\n`, 1],
      );
    }
    cases.push(["exported names", "new.js", "/* exported first, second */\nexport const value = 1;\n", 0]);
    for (const directive of ["disable", "enable", "disable-next-line", "disable-line"]) {
      cases.push(
        [`eslint-${directive} rule list`, "new.js",
          `/* eslint-${directive} no-console, @scope/example/rule */\nexport const value = 1;\n`, 0],
        [`eslint-${directive} trailing prose`, "new.js",
          `/* eslint-${directive} no-console, no-alert Explains a choice. */\nexport const value = 1;\n`, 1],
        [`eslint-${directive} line comment`, "new.js",
          `// eslint-${directive} no-console\nexport const value = 1;\n`,
          ["disable-next-line", "disable-line"].includes(directive) ? 0 : 1],
      );
    }
    for (const directive of ["global first:writable", "globals first:readonly", "exported first, second",
      "eslint-enable-line no-console", "eslint-enable-next-line no-console"]) {
      cases.push([`unsupported line directive ${directive}`, "new.js",
        `// ${directive}\nexport const value = 1;\n`, 1]);
    }
    for (const directive of ["eslint-enable-line", "eslint-enable-next-line"]) {
      cases.push([`unsupported block directive ${directive}`, "new.js",
        `/* ${directive} no-console */\nexport const value = 1;\n`, 1]);
    }
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
      ["human coauthor", "new.js", "export const value = 1;\n", 1, {},
        "fix: value\n\nCo-authored-by: Alex <alex@example.invalid>"],
      ["reserved coauthor name within human name", "new.js", "export const value = 1;\n", 1, {},
        "fix: value\n\nCo-authored-by: Devin Patel <devin@example.invalid>"],
      ["human coauthor with ambiguous email", "new.js", "export const value = 1;\n", 1, {},
        "fix: value\n\nCo-authored-by: Alex <alex@ai.example.invalid>"],
      ["bot attribution in title", "new.js", "export const value = 1;\n", 1,
        { PR_TITLE: "Generated by helper[bot]" }],
      ["ordinary bot reference in body", "new.js", "export const value = 1;\n", 0,
        { PR_BODY: "Written with helper[bot]" }],
      ["ordinary bot reference in commit", "new.js", "export const value = 1;\n", 0, {},
        "fix: value\n\nCreated by helper[bot]"],
      ["bot attribution in retained comment", "partial.js",
        "/* Existing block\n * Authored by helper[bot]\n */\nexport const value = 1;\n", 1],
      ["bot attribution in license", "new.js",
        "/* Copyright (c) 2026 Example, assisted by helper[bot] */\nexport const value = 1;\n", 0],
      ["bot name in ordinary prose", "new.js", "export const value = 1;\n", 0,
        { PR_BODY: "The helper[bot] account handles notifications." }],
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
      ["duplicated move in one file", "destination.js",
        "/* Keeps layout stable. */\nexport const first = true;\n" +
        "/* Keeps layout stable. */\nexport const second = true;\n", 1, {}, undefined,
        { "move.js": "export const stable = true;\n" }],
      ["duplicated move across files", "destination.js",
        "/* Keeps layout stable. */\nexport const first = true;\n", 1, {}, undefined,
        {
          "move.js": "export const stable = true;\n",
          "second.js": "/* Keeps layout stable. */\nexport const second = true;\n",
        }],
      ["two removed copies can move twice", "destination.js",
        "/* Keeps layout stable. */\nexport const first = true;\n", 0, {}, undefined,
        {
          "move.js": "export const stable = true;\n",
          "move-copy.js": "export const copy = true;\n",
          "second.js": "/* Keeps layout stable. */\nexport const second = true;\n",
        }],
      ["trusted checker", "new.js", "// Explains value.\nthrow new Error('Must never execute');\n", 1, {}, undefined,
        {
          ".github/no-new-comments.mjs": "process.exit(0);\n",
          "eslint.config.mjs": "throw new Error('Must never load');\n",
        }],
    );
    for (const identity of [
      "Gemini Code Assist <gemini-code-assist@google.com>",
      "Cursor <cursoragent@cursor.com>",
      "Cursor Agent <cursoragent@cursor.com>",
      "Aider <aider@aider.chat>",
      "Aider AI <aider@aider.chat>",
      "Gemini Code Assist <helper@example.invalid>",
      "Cursor <helper@example.invalid>",
      "Aider <helper@example.invalid>",
      "Helper <gemini-code-assist@google.com>",
      "Helper <cursoragent@cursor.com>",
      "Helper <helper@cursor.sh>",
      "Helper <helper@aider.chat>",
      "Helper <helper[bot]@users.noreply.github.com>",
      "@Copilot",
      "helper[bot] (automation)",
      "Helper <helper@example.invalid> (automation)",
      "Helper Bot <helper@example.invalid>",
      "Helpful Assistant <helper@example.invalid>",
      "GitHub Copilot (automation) <helper@example.invalid>",
      "Helper <helper-bot@users.noreply.github.com>",
      "Helper <helper_bot@example.invalid>",
      "Helper <noreply-bot@example.invalid>",
      "Helper <123+helper[bot]@users.noreply.github.com>",
      "Helper <person@cursor.com>",
      "Helper <person@sub.cursor.sh>",
      "Helper <person@aider.chat>",
      "Helper <person@openai.com>",
      "Helper <person@anthropic.com>",
      "Gemini Rivera <person@example.invalid>",
      "Cursor Smith <person@example.invalid>",
      "Aider Hassan <person@example.invalid>",
      "Sonnet Jones <person@example.invalid>",
      "Alex",
      "Alex <alex@example.invalid> extra",
      "Alex <alex@example.invalid> <second@example.invalid>",
      "Alex <alex@>",
      "Alex <alex@example.invalid",
      "<alex@example.invalid>",
      "Alex\n<alex@example.invalid>",
    ]) {
      cases.push([`assistant coauthor ${identity}`, "new.js", "export const value = 1;\n", 1, {},
        `fix: value\n\nCo-authored-by: ${identity}`]);
    }
    for (const name of ["Alex Rivera", "Sam O'Neil", "María Fernández", "Anne-Marie Jones"]) {
      cases.push([`human coauthor ${name}`, "new.js", "export const value = 1;\n", 1, {},
        `fix: value\n\nCo-authored-by: ${name} <person@example.invalid>`]);
    }
    for (const field of ["PR_TITLE", "PR_BODY"]) {
      for (const identity of ["@Copilot", "Helper <helper@example.invalid> (automation)",
        "Helper <helper-bot@example.invalid>"]) {
        cases.push([`invalid coauthor in ${field}: ${identity}`, "new.js", "export const value = 1;\n", 1,
          { [field]: `Co-authored-by: ${identity}` }]);
      }
      cases.push([`human coauthor in ${field}`, "new.js", "export const value = 1;\n", 1,
        { [field]: "Co-authored-by: Alex Rivera <123+alex@users.noreply.github.com>" }]);
    }
    cases.push(["mixed human and bot coauthors", "new.js", "export const value = 1;\n", 1, {},
      "fix: value\n\nCo-authored-by: Alex <alex@example.invalid>\nCo-authored-by: @Copilot"]);
    for (const text of ["Fable", "Astra", "Haiku", "SWE-2", "CodeRabbit AI", "GPT6", "LLM", "large language model",
      "AI-generated", "AI assisted", "AI agent", "review round", "council", "9/9/9/9", "reviewed by sol", "sol-loop",
      "full-send", "unslop", "Sol", "Use this — now.", "Written by an assistant", "Generated with a helper"]) {
      cases.push([`public metadata ${text}`, "new.js", "export const value = 1;\n", 1, { PR_BODY: text }]);
    }
    cases.push(
      ["public title process wording", "new.js", "export const value = 1;\n", 1, { PR_TITLE: "review round complete" }],
      ["public commit process wording", "new.js", "export const value = 1;\n", 1, {}, "fix: review round complete"],
      ["public markdown process wording", "new.md", "A review round is complete.\n", 1],
      ["public markdown punctuation", "new.md", "Keep this — now.\n", 1],
      ["case-sensitive human name", "new.js", "export const value = 1;\n", 0, { PR_BODY: "The sol field is optional." }],
      ["moved reserved comment", "destination.js", "/* codex legacy reference\n * retains its shape.\n */\n", 0,
        {}, undefined, { "credit.js": "export const legacy = 1;\n" }],
    );
    for (const role of ["AUTHOR", "COMMITTER"]) {
      for (const [name, email, status] of [
        ["Cursor Agent", "cursoragent@cursor.com", 1],
        ["Helper", "person@cursor.com", 1],
        ["Helper", "helper-bot@example.invalid", 1],
        ["Helpful Assistant", "helper@example.invalid", 1],
        ["Alex Rivera", "alex@example.invalid", 0],
        ["Sam O'Neil", "123+sam@users.noreply.github.com", 0],
        ["María Fernández", "person@ai.example.invalid", 0],
      ]) {
        cases.push([`commit ${role.toLowerCase()} ${name} ${email}`, "new.js", "export const value = 1;\n", status,
          {}, "test: change fixture", {}, { [`GIT_${role}_NAME`]: name, [`GIT_${role}_EMAIL`]: email }]);
      }
      cases.push([`earlier commit ${role.toLowerCase()}`, "new.js", "export const value = 1;\n", 1,
        {}, "test: change fixture", {},
        { [`GIT_${role}_NAME`]: "Cursor Agent", [`GIT_${role}_EMAIL`]: "cursoragent@cursor.com" }, true]);
    }
    for (const [name, path, text, status, metadata = {}, message = "test: change fixture", extra = {}, identity = {},
      followup = false] of cases) {
      await t.test(name, () => {
        git("reset", "--hard", base);
        git("clean", "-fd");
        write(path, text);
        for (const [extraPath, extraText] of Object.entries(extra)) write(extraPath, extraText);
        git("add", ".");
        execFileSync("git", ["commit", "-m", message], {
          cwd: root, env: { ...env, ...identity }, encoding: "utf8", stdio: "pipe",
        });
        if (followup) git("commit", "--allow-empty", "-m", "test: follow-up fixture");
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
