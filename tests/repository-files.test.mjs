import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const script = path.resolve("scripts/check-repository-files.mjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "repository-files-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const check = (cwd) => spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
const write = (cwd, file, content = "") => {
  const target = path.join(cwd, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};
const repository = () => {
  const cwd = fs.mkdtempSync(path.join(scratch, "repo-"));
  git(cwd, "init", "--quiet");
  return cwd;
};

test("rejects the instruction files and skill links previously tracked on main", () => {
  const cwd = repository();
  const files = ["AGENTS.md", ".agents/skills/roo-integrations-ops/SKILL.md"];
  for (const file of files) write(cwd, file);
  fs.symlinkSync("AGENTS.md", path.join(cwd, "CLAUDE.md"));
  fs.mkdirSync(path.join(cwd, ".claude/skills"), { recursive: true });
  fs.symlinkSync("../../.agents/skills/roo-integrations-ops", path.join(cwd, ".claude/skills/roo-integrations-ops"));
  git(cwd, "add", ".");
  const result = check(cwd);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const file of [...files, "CLAUDE.md", ".claude/skills/roo-integrations-ops"]) {
    assert.ok(result.stderr.includes(JSON.stringify(file)), result.stderr);
  }
});

test("rejects forced additions under ignored paths and nested instruction files", () => {
  const cwd = repository();
  fs.copyFileSync(".gitignore", path.join(cwd, ".gitignore"));
  const files = [
    "AGENTS.md", "CLAUDE.md", "GEMINI.md", "SKILL.md",
    ".agents/settings.json", ".claude/settings.json", ".codex/config.toml", ".cursor/rules/local.mdc",
    "nested/AGENTS.md", "nested/CLAUDE.md", "nested/GEMINI.md", "nested/skills/local/SKILL.md",
    "nested/.agents/settings.json", "nested/.claude/settings.json",
    "nested/.codex/config.toml", "nested/.cursor/rules/local.mdc",
  ];
  for (const file of files) write(cwd, file);
  const ignored = git(cwd, "check-ignore", "--", ...files).trim().split("\n");
  assert.deepEqual(ignored, files);
  git(cwd, "add", "--force", ".");
  const result = check(cwd);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const file of files) assert.ok(result.stderr.includes(JSON.stringify(file)), result.stderr);
  git(cwd, "rm", "--force", "--", ...files);
  assert.equal(check(cwd).status, 0);
});

test("handles case variants, whitespace and directory symlinks", () => {
  const cwd = repository();
  const files = ["nested folder/agents.MD", ".CODEX/config.toml", "nested\nfolder/SKILL.md"];
  for (const file of files) write(cwd, file);
  fs.symlinkSync("missing", path.join(cwd, ".cursor"));
  git(cwd, "add", ".");
  const result = check(cwd);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const file of [...files, ".cursor"]) assert.ok(result.stderr.includes(JSON.stringify(file)), result.stderr);
});

test("allows ignored local files and unrelated product files", () => {
  const cwd = repository();
  fs.copyFileSync(".gitignore", path.join(cwd, ".gitignore"));
  for (const file of ["AGENTS.md", ".claude/settings.json"]) write(cwd, file);
  const files = ["src/agentPublicPages.jsx", "public/llms.txt", "skills/pricing.js", ".coderabbit.yaml"];
  for (const file of files) write(cwd, file);
  git(cwd, "add", ".");
  const result = check(cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No tracked local instruction files/);
});

test("fails when it cannot read the repository index", () => {
  const cwd = fs.mkdtempSync(path.join(scratch, "outside-"));
  const result = check(cwd);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /No tracked local instruction files/);
});
