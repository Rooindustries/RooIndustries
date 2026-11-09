import { execFileSync } from "node:child_process";
import { Linter } from "eslint";
import { builtinRules } from "eslint/use-at-your-own-risk";
import config from "../eslint.config.mjs";
import tsParser from "@typescript-eslint/parser";
import rule, {
  consumeComment, inRanges, normalizeComment, whollyChanged,
} from "../eslint-rules/no-new-comments.mjs";

const git = (...args) => execFileSync("git", ["--literal-pathspecs", ...args], {
  encoding: "utf8", maxBuffer: 100 * 1024 * 1024,
});
const publicNames = "codex|fable|claude|astra|chatgpt|openai|anthropic|gemini|opus|sonnet|haiku|" +
  "copilot|cursor|devin|aider|swe-2|coderabbit ai|gpt-?[0-9][a-z0-9.]*|llm|large language model|" +
  "ai[- ]generated|ai[- ]assisted|ai agent";
const names = new RegExp(`(^|[^a-z0-9])(?:${publicNames})([^a-z0-9]|$)`, "i");
const processWords = /review round|council|9\/9\/9\/9|reviewed by (sol|opus|sonnet|swe-2)|sol-loop|full-send|unslop/i;
const credits = /co-authored-by:|generated (with|by)|🤖|written by (an )?(ai|assistant|model)/i;
const publicTextViolation = (text) => text.split(/\r?\n/).some((line) =>
  names.test(line) || credits.test(line) || processWords.test(line) ||
  /(^|[^A-Za-z])Sol([^A-Za-z]|$)/.test(line) || line.includes("—"));
const linter = new Linter();
const ruleNames = [...new Set([...builtinRules.keys(), ...config.flatMap((entry) => [
  ...Object.keys(entry.rules || {}),
  ...Object.entries(entry.plugins || {}).flatMap(([name, plugin]) =>
    Object.keys(plugin.rules || {}).map((rule) => name + "/" + rule)),
])])];
function inspect(text, path, {
  retainedComments, removedComments = [], copyrightLines = [],
} = {}) {
  let comments = [];
  const capture = {
    create: (context) => ({ Program() { comments = context.sourceCode.getAllComments(); } }),
  };
  const extension = path.match(/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/)?.[0] || ".js";
  const messages = linter.verify(text, [{
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    languageOptions: {
      ecmaVersion: "latest", sourceType: /\.(?:cjs|cts)$/.test(path) ? "commonjs" : "module",
      ...(/\.(?:ts|tsx|mts|cts)$/.test(path) ? { parser: tsParser } : {}),
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { roo: { rules: { "no-new-comments": rule, capture } } },
    rules: {
      "roo/capture": "error",
      "roo/no-new-comments": retainedComments ?
        ["error", { retainedComments, removedComments, copyrightLines, ruleNames }] : "off",
    },
  }], { filename: `file${extension}`, allowInlineConfig: false });
  return { comments, messages };
}

try {
  const head = git("rev-parse", "--verify", `${process.env.HEAD_SHA || "HEAD"}^{commit}`).trim();
  const base = git("merge-base", process.env.BASE_SHA || "origin/main", head).trim();
  const paths = git("diff", "--name-status", "--no-renames", "-z", base, head).split("\0");
  let copyrightMatches = "";
  try {
    copyrightMatches = git("grep", "-I", "-h", "-i", "-E", "Copyright|©", base, "--", ".");
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const copyrightLines = copyrightMatches.split("\n").map((line) =>
    line.match(/^\s*(?:\/\/|\/\*|\*)\s*((?:Copyright|©) .+?)(?:\s*\*\/)?\s*$/i)?.[1])
    .filter(Boolean);
  const changes = [];
  const removedComments = [];
  const problems = [];
  for (let index = 0; index + 1 < paths.length; index += 2) {
    const [status, path] = paths.slice(index, index + 2);
    const prose = /\.(?:md|mdx|markdown|txt|text|rst|adoc)$/i.test(path);
    const jsExtension = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(path);
    const oldText = status === "A" ? "" : git("show", `${base}:${path}`);
    const newText = status === "D" ? "" : git("show", `${head}:${path}`);
    const nodeScript = (text) => /^#![^\n]*\bnode(?:js)?(?:\s|$)/.test(text);
    if (!prose && !jsExtension && !nodeScript(oldText) && !nodeScript(newText)) continue;
    const addedRanges = [];
    const deletedRanges = [];
    const retainedComments = [];
    const diff = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", base, head, "--", path);
    for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      deletedRanges.push([Number(match[1]), Number(match[2] ?? 1)]);
      addedRanges.push([Number(match[3]), Number(match[4] ?? 1)]);
    }
    if (prose) {
      if (status !== "D") {
        const addedText = git("show", `${head}:${path}`).split("\n")
          .filter((_, line) => inRanges(line + 1, addedRanges)).join("\n");
        if (publicTextViolation(addedText)) problems.push(`${JSON.stringify(path)}: Contains disallowed public text.`);
      }
      continue;
    }
    if (status !== "A") {
      const previous = inspect(oldText, path);
      for (const message of previous.messages) problems.push(`${JSON.stringify(path)} (base): ${message.message}`);
      for (const comment of previous.comments) {
        if (comment.type === "Shebang") continue;
        const pool = whollyChanged(comment, deletedRanges) ? removedComments : retainedComments;
        pool.push(normalizeComment(comment.value));
      }
    }
    if (status !== "D") changes.push({ path, retainedComments, text: newText });
  }
  for (const { path, text, retainedComments } of changes) {
    const { comments, messages } = inspect(text, path, { retainedComments, removedComments, copyrightLines });
    for (const message of messages) problems.push(`${JSON.stringify(path)}:${message.line}: ${message.message}`);
    for (const comment of comments) {
      if (!consumeComment(comment.value, retainedComments) && comment.type !== "Shebang") {
        consumeComment(comment.value, removedComments);
      }
    }
  }
  const commits = process.env.MERGE_GROUP === "true" ? [head] :
    git("rev-list", `${base}..${head}`).trim().split("\n").filter(Boolean);
  const texts = [];
  const authors = new Set();
  for (const sha of commits) {
    const label = `Commit ${sha.slice(0, 9)}`;
    const [author, committer, ...message] = git("log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%B", sha).split("\n");
    for (const [role, identity] of [["author", author], ["committer", committer]]) {
      if (publicTextViolation(identity)) problems.push(`${label} ${role}: Contains an invalid authorship identity.`);
    }
    if (author !== "GitHub <noreply@github.com>") authors.add(author);
    texts.push([label, message.join("\n")]);
  }
  if (authors.size > 1) problems.push("Rewrite commit authors to use one identity before squashing.");
  if (process.env.MERGE_GROUP !== "true") {
    texts.push(["PR title", process.env.PR_TITLE || ""], ["PR body", process.env.PR_BODY || ""]);
  }
  for (const [label, text] of texts) {
    if (publicTextViolation(text)) problems.push(`${label}: Contains disallowed public text.`);
  }
  for (const problem of problems) console.error(problem);
  if (!problems.length) console.log("No new comments or authorship credits.");
  process.exitCode = problems.length ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
