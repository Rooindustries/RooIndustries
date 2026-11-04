import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { isDownloadKey } from "../src/keys.js";

export const parseFilePairs = (pairs) => {
  if (pairs.length === 0) throw new Error("Pass at least one <key>=<file> pair.");
  return pairs.map((pair) => {
    const separator = pair.indexOf("=");
    const key = pair.slice(0, separator);
    const file = pair.slice(separator + 1);
    if (separator < 1 || !isDownloadKey(key)) throw new Error(`Invalid download key in "${pair}".`);
    const stats = statSync(file, { throwIfNoEntry: false });
    if (!stats?.isFile() || stats.size === 0) throw new Error(`No non-empty file at "${file}".`);
    return { key, file };
  });
};

export const streamIdentity = async (chunks) => {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
};

export const fileIdentity = (file) => streamIdentity(createReadStream(file));

export const runCli = (usage, main) =>
  main(process.argv.slice(2)).catch((error) => {
    console.error(`${error.message}\n${usage}`);
    process.exitCode = 1;
  });
