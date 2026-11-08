import { execFileSync } from "node:child_process";
import { Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule, {
  commentGroups, consumeComment, normalizeComment, whollyChanged,
} from "../eslint-rules/no-new-comments.mjs";

const git = (...args) => execFileSync("git", ["--literal-pathspecs", ...args], {
  encoding: "utf8", maxBuffer: 100 * 1024 * 1024,
});
const names = /\b(?:codex|claude|chatgpt|openai|anthropic|gpt-\d[\w.-]*)\b/i;
const assistants = "codex|claude|chatgpt|openai|anthropic|gpt-?\\d[\\w.-]*|" +
  "cursor|gemini|opus|sonnet|copilot|devin|aider|haiku|AI|bot";
const attribution = new RegExp(`\\b(?:generated|written|created|authored|assisted)\\s+(?:by|with)\\s+` +
  `(?:(?:the|an?|github)\\s+)*(?:(?:${assistants})\\b|[\\w.-]+\\[bot\\])`, "i");
const coauthorName = new RegExp(`^(?:(?:github|google)\\s+)?(?:${assistants})` +
  `(?:[\\s_-]+(?:code|coding|assist|assistant|agent|bot|ai))*$`, "i");
const coauthorEmail = new RegExp("^(?:gemini-code-assist@google\\.com|cursoragent@cursor\\.com|copilot@github\\.com|" +
  "[^@\\s]+@(?:[\\w-]+\\.)*(?:cursor\\.sh|aider\\.chat))$", "i");
function authored(text) {
  if (names.test(text) || attribution.test(text) || /🤖/.test(text)) return true;
  return [...text.matchAll(/^\s*Co-authored-by:\s*([^<\r\n]+)(?:<([^>\r\n]+)>)?\s*$/gim)]
    .some(([, name, email = ""]) => /\[bot\]/i.test(name + email) ||
      coauthorName.test(name.trim()) || coauthorEmail.test(email.trim()));
}
const linter = new Linter();
function inspect(text, path, {
  addedRanges = [], retainedComments, removedComments = [], captureRanges = addedRanges,
} = {}) {
  let comments = [];
  const capture = {
    create: (context) => ({ Program() { comments = commentGroups(context.sourceCode, captureRanges); } }),
  };
  const extension = path.match(/\.[^.]+$/)[0];
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
      "roo/no-new-comments": retainedComments ? ["error", { addedRanges, retainedComments, removedComments }] : "off",
    },
  }], { filename: `file${extension}`, allowInlineConfig: false });
  return { comments, messages };
}

try {
  const head = git("rev-parse", "--verify", `${process.env.HEAD_SHA || "HEAD"}^{commit}`).trim();
  const base = git("merge-base", process.env.BASE_SHA || "origin/main", head).trim();
  const paths = git("diff", "--name-status", "--no-renames", "-z", base, head).split("\0");
  const changes = [];
  const removedComments = [];
  const problems = [];
  for (let index = 0; index + 1 < paths.length; index += 2) {
    const [status, path] = paths.slice(index, index + 2);
    if (!/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(path)) continue;
    const addedRanges = [];
    const deletedRanges = [];
    const retainedComments = [];
    const diff = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", base, head, "--", path);
    for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      deletedRanges.push([Number(match[1]), Number(match[2] ?? 1)]);
      addedRanges.push([Number(match[3]), Number(match[4] ?? 1)]);
    }
    if (status !== "A") {
      const previous = inspect(git("show", `${base}:${path}`), path, { captureRanges: deletedRanges });
      for (const message of previous.messages) problems.push(`${JSON.stringify(path)} (base): ${message.message}`);
      for (const comment of previous.comments) {
        const pool = whollyChanged(comment, deletedRanges) ? removedComments : retainedComments;
        pool.push(normalizeComment(comment.value));
      }
    }
    if (status !== "D") changes.push({ path, addedRanges, retainedComments, text: git("show", `${head}:${path}`) });
  }
  for (const { path, text, addedRanges, retainedComments } of changes) {
    const { comments, messages } = inspect(text, path, { addedRanges, retainedComments, removedComments });
    for (const message of messages) problems.push(`${JSON.stringify(path)}:${message.line}: ${message.message}`);
    for (const comment of comments) {
      const existing = consumeComment(comment.value, retainedComments) ||
        (comment.type !== "Shebang" && consumeComment(comment.value, removedComments));
      if (!existing && authored(comment.value)) {
        problems.push(`${JSON.stringify(path)}:${comment.loc.start.line}: Contains an authorship credit or reserved name.`);
      }
    }
  }
  const commits = git("rev-list", `${base}..${head}`).trim().split("\n").filter(Boolean);
  const texts = commits.map((sha) => [`Commit ${sha.slice(0, 9)}`, git("log", "-1", "--format=%B", sha)]);
  texts.push(["PR title", process.env.PR_TITLE || ""], ["PR body", process.env.PR_BODY || ""]);
  for (const [label, text] of texts) {
    if (authored(text)) problems.push(`${label}: Contains an authorship credit or reserved name.`);
  }
  for (const problem of problems) console.error(problem);
  if (!problems.length) console.log("No new comments or authorship credits.");
  process.exitCode = problems.length ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
