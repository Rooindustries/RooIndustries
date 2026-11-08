import { execFileSync } from "node:child_process";

const paths = execFileSync("git", ["ls-files", "--cached", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const localDirectory = /^\.(?:agents|claude|codex|cursor)$/i;
const localFile = /^(?:AGENTS|CLAUDE|GEMINI|SKILL)\.md$/i;
const forbidden = paths.filter((file) =>
  file.split("/").some((part) => localDirectory.test(part) || localFile.test(part)),
);

if (forbidden.length) {
  console.error("Keep local instruction files outside the repository:");
  for (const file of forbidden) console.error(JSON.stringify(file));
  process.exit(1);
}
console.log("No tracked local instruction files.");
