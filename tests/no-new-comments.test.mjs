import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { load } from "js-yaml";

const checker = fileURLToPath(new URL("../.github/no-new-comments.mjs", import.meta.url));
const baseFiles = {
  "vendor.js": "// Copyright (c) 2020 Example Vendor\nexport const vendor = true;\n",
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
 * Copyright (c) 2026 Roo Industries
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

test("comment policy checks committed Git changes without executing them", { concurrency: 4 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "comment-policy-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
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
      ["reserved names in strings", "new.js",
        "export const text = 'claude codex chatgpt openai anthropic gpt-6 🤖';\n", 0],
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
        "// eslint-disable-next-line no-console -- Explains logging.\nconsole.log(1);\n", 1],
      ["directive justification with reserved names", "new.js",
        "// eslint-disable-next-line no-console -- Generated by codex\nconsole.log(1);\n", 1],
      ["type directive description", "new.js", "// @ts-expect-error Explains a choice.\nexport const value = 1;\n", 1],
      ["type directive after code", "new.js", "export const value = 1;\n// @ts-check\n", 1],
      ["ESLint rule config", "new.js", '/* eslint "no-console": "off" */\nexport const value = 1;\n', 0],
      ["invalid ESLint rule config", "new.js", '/* eslint "no-console": ??? */\nexport const value = 1;\n', 1],
      ["multiline disable-line", "new.js", "/* eslint-disable-line\nno-console */\nexport const value = 1;\n", 1],
      ["disable bypass", "new.js", "/* eslint-disable */\n// Explains value.\nexport const value = 1;\n", 1],
      ["unknown rule", "new.js", "// eslint-disable-next-line fake-rule\nrun();\n", 1],
      ["unknown rule config", "new.js", '/* eslint "fake-rule": "off" */\nrun();\n', 1],
      ["builtin global", "new.js", "/* global console */\nconsole.log(1);\n", 0],
      ["copyright prose", "new.js", "// Copyright (c) 2026 Roo Industries explains behavior\nrun();\n", 1],
      ["existing vendor copyright", "new.js", "// Copyright (c) 2020 Example Vendor\nrun();\n", 0],
      ["unknown copyright holder", "new.js", "// Copyright (c) 2026 Another Holder\nrun();\n", 1],
      ["valid SPDX expression", "new.js", "// SPDX-License-Identifier: (MIT OR Apache-2.0)\nrun();\n", 0],
      ["bad SPDX expression", "new.js", "// SPDX-License-Identifier: (MIT OR Apache-2.0\nrun();\n", 1],
      ["node executable", "bin/tool", "#!/usr/bin/env node\n// Explains behavior.\nrun();\n", 1],
      ["queue uses commit metadata", "new.js", "run();\n", 0,
        { MERGE_GROUP: "true", PR_BODY: "Generated by a helper." }],
      ["queue rejects commit metadata", "new.js", "run();\n", 1,
        { MERGE_GROUP: "true" }, "fix: value\n\nGenerated by a helper."],
      ["license at top", "new.js", "/* SPDX-License-Identifier: MIT */\nexport const value = 1;\n", 0],
      ["full MIT license", "new.js", mitHeader, 0],
      ["line MIT license", "new.js", mitHeader.replace(/^\/\*\n/, "").replace(/^ \*\/\n/m, "").replace(/^ \* ?/gm, "// "), 0],
      ["line license header", "new.js",
        "// Copyright (c) 2026 Roo Industries\n// SPDX-License-Identifier: MIT\nexport const value = 1;\n", 0],
      ["license after shebang", "new.js", "#!/usr/bin/env node\n/* Copyright (c) 2026 Roo Industries */\nrun();\n", 0],
      ["retained shebang", "cli.js", "#!/usr/bin/env node\nexport const cli = false;\n", 0],
      ["retained shebang copied as comment", "cli.js",
        "#!/usr/bin/env node\n// /usr/bin/env node\nexport const cli = true;\n", 1],
      ["retained shebang copied across files", "new.js", "// /usr/bin/env node\nexport const value = 1;\n", 1,
        {}, undefined, { "cli.js": "#!/usr/bin/env node\nexport const cli = false;\n" }],
      ["removed shebang copied as comment", "new.js", "// /usr/bin/env node\nexport const value = 1;\n", 1,
        {}, undefined, { "cli.js": "export const cli = true;\n" }],
      ["license after code", "new.js", "export const value = 1;\n/* SPDX-License-Identifier: MIT */\n", 0],
      ["license plus prose", "new.js",
        "/* SPDX-License-Identifier: MIT\n * Explains a choice.\n */\nexport const value = 1;\n", 1],
      ["license notice without text", "new.js", "/* Licensed under the MIT license. */\nexport const value = 1;\n", 1],
      ["new adjacent comment", "adjacent.js",
        "// Existing line.\n// Explains value.\nexport const retained = true;\n", 1],
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
      ["ordinary names in code strings", "new.js",
        "export const label = 'cursor gemini opus sonnet copilot devin';\n", 0],
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
          `/* ${directive} first:writable, second:readonly */\nexport const value = first + second;\n`, 0],
        [`${directive} spaced modifiers`, "new.js",
          `/* ${directive} first : writable, second : readonly */\nexport const value = first + second;\n`, 0],
        [`${directive} whitespace separator`, "new.js",
          `/* ${directive} first:writable second:readonly */\nexport const value = first + second;\n`, 0],
        [`${directive} mixed separators`, "new.js",
          `/* ${directive} first : writable, second:readonly\tthird:off */\n` +
          "export const value = first + second + third;\n", 0],
        [`${directive} bare names`, "new.js",
          `/* ${directive} first second, third */\nexport const value = first + second + third;\n`, 0],
        [`${directive} invalid modifier`, "new.js",
          `/* ${directive} first:invalid second:readonly */\nexport const value = 1;\n`, 1],
        [`${directive} legacy modifiers`, "new.js",
          `/* ${directive} first:true, second:false, third:readable, fourth:writeable, fifth:off */\n` +
          "export const value = first + second + third + fourth + fifth;\n", 0],
        [`${directive} trailing prose`, "new.js",
          `/* ${directive} first:writable, second:readonly Explains-a-choice. */\nexport const value = 1;\n`, 1],
      );
    }
    cases.push(["exported names", "new.js", "/* exported first, second */\nconst first = 1, second = 2;\n", 0]);
    for (const directive of ["disable", "enable", "disable-next-line", "disable-line"]) {
      cases.push(
        [`eslint-${directive} rule list`, "new.js",
          `/* eslint-${directive} no-console, roo/no-hand-built-node-options */\nexport const value = 1;\n`, 0],
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
        "/* Copyright (c) 2026 Roo Industries, assisted by helper[bot] */\nexport const value = 1;\n", 1],
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
        "// Keeps layout\n// stable.\nexport const moved = true;\n", 1, {}, undefined,
        { "move.js": "export const stable = true;\n" }],
      ["rewrapped removed lines", "destination.js",
        "/* Existing line. */\nexport const moved = true;\n", 0, {}, undefined,
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
      ["case-sensitive human name", "new.js",
        "export const value = 1;\n", 0, { PR_BODY: "The sol field is optional." }],
      ["moved reserved comment", "destination.js", "/* codex legacy reference\n * retains its shape.\n */\n", 0,
        {}, undefined, { "credit.js": "export const legacy = 1;\n" }],
    );
    for (const role of ["AUTHOR", "COMMITTER"]) {
      for (const [name, email, status] of [
        ["Cursor Agent", "cursoragent@cursor.com", 1],
        ["Helper", "person@cursor.com", 1],
        ["Helper", "helper-bot@example.invalid", 0],
        ["Helpful Assistant", "helper@example.invalid", 0],
        ["Alex Rivera", "alex@example.invalid", 0],
        ["serviroo2", "123+serviroo2@users.noreply.github.com", 0],
        ["GitHub", "noreply@github.com", 0],
        ["Helper Bot", "helper[bot]@users.noreply.github.com", 0],
        ["Sol2", "sol2@example.invalid", 1],
        ["Helper", "review-round@example.invalid", 0],
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
    for (const directive of ["@ts-ignore", "@ts-expect-error", "@ts-check", "@ts-nocheck"]) {
      cases.push(
        [directive + " trailing prose", "new.ts",
          "// " + directive + " Explains the choice.\nexport const value = 1;\n", 1],
        [directive + " block prose", "new.ts",
          "/* Explains the choice.\n" + directive + " */\nexport const value = 1;\n", 1],
      );
    }
    for (const directive of ["global", "globals"]) {
      cases.push(
        [directive + " unused name", "new.js",
          "/* " + directive + " first, second */\nexport const value = first;\n", 0],
        [directive + " declared name", "new.js",
          "/* " + directive + " first */\nconst first = 1;\nexport { first };\n", 0],
        [directive + " malformed setting", "new.js",
          "/* " + directive + " first:writable:extra */\nuse(first);\n", 1],
        [directive + " block sentence", "new.js",
          "/* " + directive + " cache shared across requests */\nuse(cache);\n", 0],
      );
    }
    cases.push(
      ["exported missing bindings", "new.js", "/* exported cache, shared, across */\nconst cache = 1;\n", 1],
      ["exported unresolved name", "new.js", "/* exported cache */\nuse(cache);\n", 1],
      ["global unicode identifier", "new.js", "/* global café:readonly */\nuse(café);\n", 0],
      ["exported unicode binding", "new.js", "/* exported café */\nconst café = 1;\n", 0],
      ["ESLint block justification", "new.js", "/* eslint-disable no-console -- needed */\nconsole.log(1);\n", 1],
      ["ESLint config justification", "new.js", "/* eslint no-console: off -- needed */\nconsole.log(1);\n", 1],
      ["pure new expression", "new.js", "export const value = /* #__PURE__ */ new Value();\n", 0],
      ["pure without call", "new.js", "/* @__PURE__ */\nexport const value = 1;\n", 1],
      ["pure before reference", "new.js", "export const value = /* @__PURE__ */ makeValue;\n", 1],
      ["pure separated from call", "new.js", "/* @__PURE__ */\n;makeValue();\n", 1],
      ["pure trailing prose", "new.js", "export const value = /* @__PURE__ needed */ makeValue();\n", 1],
      ["jest environment node", "new.js", "/** @jest-environment node */\nexport const value = 1;\n", 0],
      ["jest environment jsdom", "new.js", "/**\n * @jest-environment jsdom\n */\nexport const value = 1;\n", 0],
      ["jest environment path", "new.js", "/** @jest-environment ./environment.cjs */\nexport const value = 1;\n", 0],
      ["jest environment after code", "new.js", "export const value = 1;\n/** @jest-environment node */\n", 1],
      ["jest environment prose", "new.js", "/** @jest-environment node needed here */\nexport const value = 1;\n", 1],
      ["jest environment block prose", "new.js",
        "/** Explains the choice.\n * @jest-environment node\n */\nexport const value = 1;\n", 1],
      ["copyright without marker", "new.js", "// Copyright 2026 this module caches requests\nrun();\n", 1],
      ["copyright after code", "new.js", "run();\n// Copyright (c) 2026 Roo Industries\n", 0],
      ["copyright year range", "new.js", "// Copyright (c) 2020-2026 Roo Industries\nrun();\n", 0],
      ["unknown copyright symbol", "new.js", "// © 2026 serviroo\nrun();\n", 1],
      ["copyright suffix prose", "new.js", "// Copyright (c) 2026 Roo Industries; this module caches requests\nrun();\n", 1],
      ["adjacent moved tokens", "destination.js",
        "// Existing line.\n// Keeps layout stable.\nrun();\n", 0, {}, undefined,
        { "adjacent.js": "export const retained = true;\n", "move.js": "export const stable = true;\n" }],
      ["split original token", "destination.js", "// Keeps layout\n// stable.\nrun();\n", 1, {}, undefined,
        { "move.js": "export const stable = true;\n" }],
      ["joined original tokens", "destination.js",
        "/* Existing line. Keeps layout stable. */\nrun();\n", 1, {}, undefined,
        { "adjacent.js": "export const retained = true;\n", "move.js": "export const stable = true;\n" }],
      ["multiple human authors", "new.js", "export const value = 1;\n", 1, {}, "test: change fixture", {},
        { GIT_AUTHOR_NAME: "Alex", GIT_AUTHOR_EMAIL: "alex@example.invalid" }, true, /rewrite.*authors/i],
      ["GitHub author excluded", "new.js", "export const value = 1;\n", 0, {}, "test: change fixture", {},
        { GIT_AUTHOR_NAME: "GitHub", GIT_AUTHOR_EMAIL: "noreply@github.com" }, true],
    );
    for (const attributes of ['path="./types.d.ts"', 'types="node"', 'lib="es2022"', 'no-default-lib="true"',
      'types="node" resolution-mode="import" preserve="true"', 'Types="node"']) {
      cases.push(["TS reference " + attributes, "new.ts",
        "/// <reference " + attributes + " />\nexport const value = 1;\n", 0]);
    }
    for (const text of ['/// <reference types="node" /> needed', '/// <reference types="node" reason="needed" />',
      '/// <reference types="node" />\n// needed', '/// <reference />']) {
      cases.push(["invalid TS reference " + text, "new.ts", text + "\nexport const value = 1;\n", 1]);
    }
    cases.push(["TS reference after code", "new.ts", 'export const value = 1;\n/// <reference types="node" />\n', 1]);
    for (const directive of ["c8 ignore next 3", "c8 ignore start", "c8 ignore stop", "v8 ignore next 2"]) {
      cases.push(
        [directive, "new.js", "/* " + directive + " */\nrun();\n", 0],
        [directive + " reason", "new.js",
          "/* " + directive + " needed */\nrun();\n", 1],
        [directive + " line", "new.js",
          "// " + directive + "\nrun();\n", 1],
      );
    }
    for (const options of ['webpackChunkName: "panel"', 'webpackMode: "lazy"', 'webpackPrefetch: true',
      'webpackPreload: 2', 'webpackIgnore: true', 'webpackInclude: /panel/', 'webpackExclude: /old/',
      'webpackExports: ["default", "render"]', 'webpackFetchPriority: "high"',
      'webpackChunkName: "panel", webpackMode: "lazy", webpackPrefetch: 1']) {
      cases.push(["webpack " + options, "new.js",
        "export const value = import(/* " + options + " */ './panel.js');\n", 0]);
    }
    for (const options of ['webpackChunkName: "panel" needed', 'webpackChunkName: "panel", reason: "needed"',
      'webpackChunkName: computeName()', 'webpackIgnore: "yes"', 'webpackMode: "invalid"',
      'webpackPrefetch: true // needed\n']) {
      cases.push(["invalid webpack " + options, "new.js",
        "export const value = import(/* " + options + " */ './panel.js');\n", 1]);
    }
    cases.push(["webpack outside import", "new.js", '/* webpackChunkName: "panel" */\nrun();\n', 1]);
    const pending = [];
    for (const [name, path, text, status, metadata = {}, message = "test: change fixture", extra = {}, identity = {},
      followup = false, diagnostic] of cases) {
      pending.push(t.test(name, async () => {
        const fixture = mkdtempSync(join(root, "case-"));
        git("clone", "--shared", "--quiet", root, fixture);
        const fixtureGit = (...args) => execFileSync("git", args, {
          cwd: fixture, env, encoding: "utf8", stdio: "pipe",
        }).trim();
        const write = (path, text) => {
          mkdirSync(dirname(join(fixture, path)), { recursive: true });
          writeFileSync(join(fixture, path), text);
        };
        try {
          write(path, text);
          for (const [extraPath, extraText] of Object.entries(extra)) write(extraPath, extraText);
          fixtureGit("add", ".");
          execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", message], {
            cwd: fixture, env: { ...env, ...identity }, encoding: "utf8", stdio: "pipe",
          });
          if (followup) fixtureGit("-c", "commit.gpgsign=false", "commit",
            "--allow-empty", "-m", "test: follow-up fixture");
          const result = await new Promise((resolve) => {
            execFile(process.execPath, [checker], {
              cwd: fixture, encoding: "utf8",
              env: { ...env, BASE_SHA: base, HEAD_SHA: "HEAD", PR_TITLE: "", PR_BODY: "", ...metadata },
            }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
          });
          assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
          if (diagnostic) assert.match(result.stderr, diagnostic);
          assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Must never (?:execute|load)/);
          if (name === "invalid TS reference /// <reference />") {
            assert.match(result.stderr, /Invalid 'reference' directive syntax/);
          } else if (name !== "invalid JavaScript") {
            assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Parsing error|No matching configuration/);
          }
        } finally {
          rmSync(fixture, { recursive: true, force: true });
        }
      }));
    }
    await Promise.all(pending);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy status is reset before checkout and title edits, with tokens limited to status and fetch steps", () => {
  const workflow = load(readFileSync(new URL("../.github/workflows/no-new-comments.yml", import.meta.url), "utf8"));
  assert.ok(workflow.on.pull_request_target.types.includes("edited"));
  assert.ok(workflow.on.merge_group.types.includes("checks_requested"));
  assert.match(workflow.jobs.policy.if, /merge_group/);
  assert.match(workflow.jobs.policy.env.HEAD_SHA, /merge_group.head_sha/);
  assert.match(workflow.jobs.policy.env.BASE_SHA, /merge_group.base_sha/);
  assert.match(workflow.jobs.policy.env.MERGE_GROUP, /merge_group/);
  const { policy, fixtures } = workflow.jobs;
  assert.equal(policy.steps[0].id, "pending");
  assert.match(policy.steps[0].run, /state=pending/);
  assert.match(policy.steps[0].run, /context=no-new-comments/);
  assert.equal(policy.env.GH_TOKEN, undefined);
  assert.equal(fixtures.permissions?.statuses, undefined);
  const root = mkdtempSync(join(tmpdir(), "comment-status-"));
  try {
    const gh = join(root, "gh");
    const capture = join(root, "status");
    writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n', { mode: 0o700 });
    for (const [step, outcome, expected] of [
      [policy.steps[0], "", "pending"],
      [policy.steps.at(-1), "success", "success"],
      [policy.steps.at(-1), "failure", "failure"],
      [policy.steps.at(-1), "skipped", "failure"],
    ]) {
      assert.ok(step.env.GH_TOKEN);
      const result = spawnSync("bash", ["-eu", "-c", step.run], { encoding: "utf8", env: {
        ...process.env, PATH: root + ":" + process.env.PATH, CAPTURE: capture,
        GITHUB_REPOSITORY: "example/repository", HEAD_SHA: "fixture-head", GITHUB_SERVER_URL: "https://example.invalid",
        GITHUB_RUN_ID: "fixture-run", POLICY_RESULT: outcome,
      } });
      assert.equal(result.status, 0, result.stderr);
      const args = readFileSync(capture, "utf8");
      assert.match(args, new RegExp("state=" + expected + "\\n"));
      assert.match(args, /repos\/example\/repository\/statuses\/fixture-head\n/);
    }
    for (const step of policy.steps) {
      if (step.env?.GH_TOKEN) assert.ok(["pending", "fetch", "report"].includes(step.id));
      if (step.run?.includes("npm ci") || step.id === "policy") assert.equal(step.env?.GH_TOKEN, undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
