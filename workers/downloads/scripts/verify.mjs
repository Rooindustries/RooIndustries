import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { contentTypeFor } from "../src/keys.js";
import { fileIdentity, parseFilePairs, runCli, streamIdentity } from "./files.mjs";

const USAGE = "Usage: node scripts/verify.mjs --url <worker origin> <key>=<file>...";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const RANGE_PROBE_BYTES = 1024;

const workerOrigin = (value) => {
  const url = new URL(value ?? "");
  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== "https:" && !loopbackHttp) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--url must be the Worker's https origin, for example https://roo-downloads.example.workers.dev");
  }
  return url.origin;
};

const fileUrl = (origin, key) => `${origin}/${key.split("/").map(encodeURIComponent).join("/")}`;

const readSlice = async (file, offset, length) => {
  const handle = await open(file);
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const checkHealth = async (origin) => {
  const response = await fetch(`${origin}/health`);
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || body?.status !== "ok") throw new Error(`Health check failed with ${response.status}.`);
};

const checkFile = async (origin, { key, file }) => {
  const expected = await fileIdentity(file);
  const response = await fetch(fileUrl(origin, key));
  if (response.status !== 200) return { ...expected, problems: [`GET answered ${response.status}`] };
  const problems = [];
  if (response.headers.get("Content-Type") !== contentTypeFor(key)) problems.push("content type differs");
  if (Number(response.headers.get("Content-Length")) !== expected.size) problems.push("Content-Length differs");
  const actual = await streamIdentity(response.body);
  if (actual.size !== expected.size) problems.push(`size ${actual.size} differs`);
  if (actual.sha256 !== expected.sha256) problems.push(`SHA-256 ${actual.sha256} differs`);

  const offset = Math.floor(expected.size / 2);
  const last = Math.min(offset + RANGE_PROBE_BYTES, expected.size) - 1;
  const ranged = await fetch(fileUrl(origin, key), { headers: { Range: `bytes=${offset}-${last}` } });
  const slice = await readSlice(file, offset, last - offset + 1);
  if (ranged.status !== 206) problems.push(`range request answered ${ranged.status}`);
  else if (ranged.headers.get("Content-Range") !== `bytes ${offset}-${last}/${expected.size}`) problems.push("Content-Range differs");
  else if (!Buffer.from(await ranged.arrayBuffer()).equals(slice)) problems.push("range bytes differ");
  return { ...expected, problems };
};

runCli(USAGE, async (argv) => {
  const { values, positionals } = parseArgs({ args: argv, options: { url: { type: "string" } }, allowPositionals: true });
  const origin = workerOrigin(values.url);
  const files = parseFilePairs(positionals);
  await checkHealth(origin);
  let failed = false;
  for (const entry of files) {
    const { size, sha256, problems } = await checkFile(origin, entry);
    failed ||= problems.length > 0;
    const verdict = problems.length ? `FAIL (${problems.join("; ")})` : "match";
    console.log(`${entry.key}  ${size} bytes  sha256 ${sha256}  ${verdict}`);
  }
  if (failed) throw new Error("At least one file differs from its original.");
});
