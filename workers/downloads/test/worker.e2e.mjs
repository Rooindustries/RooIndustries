import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const wrangler = path.join(packageDir, "node_modules/.bin/wrangler");
const workDir = mkdtempSync(path.join(tmpdir(), "roo-downloads-"));
const stateDir = path.join(workDir, "state");

const files = {
  "builds/0123456789abcdef0123456789abcdef01234567.zip": randomBytes(3 * 1024 * 1024 + 17),
  "b/Fixture123/Roo-Fixture-1.0.0-setup.exe": randomBytes(4099),
};
const zipKey = Object.keys(files)[0];
const zip = files[zipKey];
const exeKey = Object.keys(files)[1];

const writeFixture = (name, bytes) => {
  const file = path.join(workDir, "files", name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
};

const pairs = Object.entries(files).map(([key, bytes]) => `${key}=${writeFixture(key, bytes)}`);
const tamperedPair = `${zipKey}=${writeFixture("tampered.zip", randomBytes(zip.length))}`;

const runScript = (script, args) =>
  spawnSync(process.execPath, [path.join(packageDir, "scripts", script), ...args], {
    cwd: packageDir,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

let worker;
let origin;

const request = (pathname, init) => fetch(`${origin}${pathname}`, init);

before(async () => {
  const upload = runScript("upload.mjs", ["--local", "--persist-to", stateDir, ...pairs]);
  assert.equal(upload.status, 0, upload.stderr);
  const uploaded = upload.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    uploaded,
    Object.entries(files).map(([key, bytes]) => ({
      key,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  );

  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  worker = spawn(
    wrangler,
    ["dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", stateDir, "--show-interactive-dev-session=false"],
    { cwd: packageDir, detached: true, stdio: "ignore", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const healthy = await request("/health").then((response) => response.ok, () => false);
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("wrangler dev did not become healthy within 60 seconds");
});

after(async () => {
  if (worker?.exitCode === null) {
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    process.kill(-worker.pid, "SIGTERM");
    await exited;
  }
  rmSync(workDir, { recursive: true, force: true });
});

test("verify script matches every uploaded file and catches a different file", () => {
  const verified = runScript("verify.mjs", ["--url", origin, ...pairs]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stdout.trim().split("\n").filter((line) => line.endsWith("match")).length, pairs.length);

  const tampered = runScript("verify.mjs", ["--url", origin, tamperedPair]);
  assert.equal(tampered.status, 1);
  assert.match(tampered.stdout, /FAIL \(.*SHA-256/);
});

test("health answers ok without caching", async () => {
  const response = await request("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("a file download carries its type, caching and validators", async () => {
  const response = await request(`/${zipKey}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/zip");
  assert.equal(response.headers.get("Content-Length"), String(zip.length));
  assert.equal(response.headers.get("Content-Disposition"), `attachment; filename="${path.basename(zipKey)}"`);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=86400");
  assert.equal(response.headers.get("Accept-Ranges"), "bytes");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(response.headers.get("ETag"), /^"[^"]+"$/);
  assert.ok(Date.parse(response.headers.get("Last-Modified")));
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(zip));

  const exe = await request(`/${exeKey}`, { method: "HEAD" });
  assert.equal(exe.status, 200);
  assert.equal(exe.headers.get("Content-Type"), "application/vnd.microsoft.portable-executable");
  assert.equal(exe.headers.get("Content-Length"), String(files[exeKey].length));
  assert.equal((await exe.arrayBuffer()).byteLength, 0);
});

test("byte ranges follow RFC 9110", async () => {
  const ranged = async (range, extra = {}) => request(`/${zipKey}`, { headers: { Range: range, ...extra } });
  const expectPart = async (response, first, last) => {
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), `bytes ${first}-${last}/${zip.length}`);
    assert.equal(response.headers.get("Content-Length"), String(last - first + 1));
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(zip.subarray(first, last + 1)));
  };
  const size = zip.length;
  await expectPart(await ranged("bytes=0-0"), 0, 0);
  await expectPart(await ranged("bytes=-100"), size - 100, size - 1);
  await expectPart(await ranged(`bytes=${size - 10}-`), size - 10, size - 1);
  await expectPart(await ranged(`bytes=1000-${size * 2}`), 1000, size - 1);
  await expectPart(await ranged(`bytes=-${size * 2}`), 0, size - 1);

  const beyond = await ranged(`bytes=${size}-`);
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get("Content-Range"), `bytes */${size}`);
  assert.equal((await ranged("bytes=-0")).status, 416);

  for (const ignored of ["bytes=0-1,5-9", "bytes=10-5", "items=0-1", "bytes=-"]) {
    const response = await ranged(ignored);
    assert.equal(response.status, 200, ignored);
    assert.equal((await response.arrayBuffer()).byteLength, size);
  }

  const { headers } = await request(`/${zipKey}`, { method: "HEAD" });
  await expectPart(await ranged("bytes=0-9", { "If-Range": headers.get("ETag") }), 0, 9);
  assert.equal((await ranged("bytes=0-9", { "If-Range": headers.get("Last-Modified") })).status, 200);
  assert.equal((await ranged("bytes=0-9", { "If-Range": '"another"' })).status, 200);

  for (const range of ["bytes=0-9", `bytes=${size}-`]) {
    const head = await request(`/${zipKey}`, { method: "HEAD", headers: { Range: range } });
    assert.equal(head.status, 200, range);
    assert.equal(head.headers.get("Content-Length"), String(size));
    assert.equal(head.headers.get("Content-Range"), null);
  }
  assert.equal((await ranged("bytes=0-9", { "If-Range": `W/${headers.get("ETag")}` })).status, 200);
});

test("conditional requests answer 304 and 412", async () => {
  const { headers } = await request(`/${zipKey}`, { method: "HEAD" });
  const etag = headers.get("ETag");
  const lastModified = headers.get("Last-Modified");
  const status = async (conditions) => (await request(`/${zipKey}`, { headers: conditions })).status;

  const notModified = await request(`/${zipKey}`, { headers: { "If-None-Match": etag } });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("ETag"), etag);
  assert.equal(await status({ "If-None-Match": `"other", W/${etag}` }), 304);
  assert.equal(await status({ "If-None-Match": '"other"' }), 200);
  assert.equal(await status({ "If-Modified-Since": lastModified }), 304);
  assert.equal(await status({ "If-None-Match": '"other"', "If-Modified-Since": lastModified }), 200);
  assert.equal(await status({ "If-Modified-Since": new Date(Date.parse(lastModified) - 1000).toUTCString() }), 200);
  assert.equal(await status({ "If-Match": etag }), 200);
  assert.equal(await status({ "If-Match": '"other"' }), 412);
  assert.equal(await status({ "If-Unmodified-Since": new Date(Date.parse(lastModified) - 1000).toUTCString() }), 412);
  assert.equal(await status({ "If-Unmodified-Since": lastModified }), 200);
  assert.equal(await status({ "If-Unmodified-Since": "0" }), 200);
  assert.equal(await status({ "If-Modified-Since": "9999" }), 200);
  assert.equal(await status({ "If-Modified-Since": lastModified.replace("GMT", "UTC") }), 200);
  assert.equal(await status({ "If-Modified-Since": "Sun, 31 Feb 2099 00:00:00 GMT" }), 200);

  const modified = new Date(lastModified);
  const [weekday, day, month, year, time] = lastModified.split(/,? /);
  const longWeekday = modified.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  assert.equal(await status({ "If-Modified-Since": `${longWeekday}, ${day}-${month}-${year.slice(2)} ${time} GMT` }), 304);
  assert.equal(await status({ "If-Modified-Since": `${weekday} ${month} ${day.replace(/^0/, " ")} ${time} ${year}` }), 304);
  const earlier = new Date(modified.getTime() - 86_400_000).toUTCString().split(/,? /);
  assert.equal(await status({ "If-Unmodified-Since": `${earlier[0]} ${earlier[2]} ${earlier[1]} ${earlier[4]} ${earlier[3]}` }), 412);
});

test("unknown, unsafe and unsupported requests are refused", async () => {
  for (const pathname of ["/", "/builds/missing.zip", "/.env", "/notes.txt", "/builds/%2e%2e/secret.zip", "/%E0%A4%A.zip"]) {
    const response = await request(pathname);
    assert.equal(response.status, 404, pathname);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await request(`/${zipKey}`, { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("Allow"), "GET, HEAD");
  }
});
