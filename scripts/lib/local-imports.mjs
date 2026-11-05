import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const recorder = `
import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const loaded = [];
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:")) loaded.push(url);
    return nextLoad(url, context);
  },
});
await import(process.argv[1]);
writeFileSync(process.argv[2], JSON.stringify(loaded));
process.exit(0);
`;

const insideProject = (file) =>
  Boolean(file) && !isAbsolute(file) && file !== ".." && !file.startsWith(`..${sep}`) &&
  !file.split(sep).includes("node_modules");

export const localImportsOf = (entry, root) => {
  const scratch = mkdtempSync(join(tmpdir(), "roo-local-imports-"));
  const output = join(scratch, "imports.json");
  const entryUrl = pathToFileURL(entry).href;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", recorder, entryUrl, output], {
      cwd: root, env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "ignore", "inherit"], timeout: 60000,
    });
    const loaded = JSON.parse(readFileSync(output, "utf8"));
    if (!loaded.includes(entryUrl)) {
      throw new Error(`${relative(root, entry)} was loaded before its imports could be recorded.`);
    }
    return [...new Set(loaded.filter((url) => url !== entryUrl).map((url) => relative(root, fileURLToPath(url))))]
      .filter(insideProject)
      .sort();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
