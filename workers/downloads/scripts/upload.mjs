import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { contentTypeFor } from "../src/keys.js";
import { fileIdentity, parseFilePairs, runCli } from "./files.mjs";

const USAGE = "Usage: node scripts/upload.mjs [--local [--persist-to <dir>]] <key>=<file>...";
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));
const config = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"));
const bucket = config.env.r2.r2_buckets[0].bucket_name;

const targetFlags = ({ local, "persist-to": persistTo }) => {
  if (!local) {
    if (persistTo) throw new Error("--persist-to only works with --local.");
    return ["--remote"];
  }
  return persistTo ? ["--local", "--persist-to", persistTo] : ["--local"];
};

runCli(USAGE, async (argv) => {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { local: { type: "boolean" }, "persist-to": { type: "string" } },
    allowPositionals: true,
  });
  const target = targetFlags(values);
  const files = parseFilePairs(positionals);
  for (const { key, file } of files) {
    const { size, sha256 } = await fileIdentity(file);
    const put = spawnSync(
      wrangler,
      ["r2", "object", "put", `${bucket}/${key}`, "--file", file, "--content-type", contentTypeFor(key), ...target],
      { cwd: packageDir, stdio: ["ignore", 2, 2] },
    );
    if (put.status !== 0) throw new Error(`Upload failed for ${key}.`);
    console.log(JSON.stringify({ key, size, sha256 }));
  }
});
