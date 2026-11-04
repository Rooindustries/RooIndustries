import fs from "node:fs";
import path from "node:path";
import { scriptingAtRules, scriptingMessage } from "./lib/scripting-media.mjs";

const cssFiles = (target, skip = new Set()) => {
  if (!fs.existsSync(target)) return [];
  if (fs.statSync(target).isFile()) return target.endsWith(".css") ? [target] : [];
  return fs
    .readdirSync(target, { withFileTypes: true })
    .filter((entry) => !skip.has(entry.name))
    .flatMap((entry) => cssFiles(path.join(target, entry.name)));
};

const targets = process.argv.slice(2);
const buildDir = path.resolve(process.env.NEXT_DIST_DIR || ".next");
const built = targets.length ? [] : cssFiles(buildDir, new Set(["cache"]));
if (!targets.length && !built.length) {
  console.error(`No built CSS in ${path.relative(process.cwd(), buildDir)}. Run the Next build first.`);
  process.exit(1);
}
const files = targets.length
  ? targets.flatMap((target) => cssFiles(path.resolve(target)))
  : [...built, ...cssFiles(path.resolve("public"))];

const found = files.flatMap((file) => {
  const from = path.relative(process.cwd(), file);
  return scriptingAtRules(fs.readFileSync(file, "utf8"), from).map(
    (rule) => `${from}:${rule.source.start.line} @${rule.name} ${rule.params}`,
  );
});

if (found.length) {
  console.error(found.join("\n"));
  console.error(scriptingMessage);
  process.exit(1);
}
console.log(`No scripting media feature in ${files.length} CSS files.`);
