import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
const movedKey = "builds/1111111111111111111111111111111111111111.zip";
const shortKey = "builds/2222222222222222222222222222222222222222.zip";
const loopKey = "builds/3333333333333333333333333333333333333333.zip";
const truncatedKey = "builds/4444444444444444444444444444444444444444.zip";
const signedPath = (key) => `/storage/v1/object/sign/optimization-builds-private/${key}?token=fixture`;

const writeFixture = (name, bytes) => {
  const file = path.join(workDir, "files", name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
};

const pairs = Object.entries(files).map(([key, bytes]) => `${key}=${writeFixture(key, bytes)}`);
const tamperedPair = `${zipKey}=${writeFixture("tampered.zip", randomBytes(zip.length))}`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const runScript = (script, args) =>
  promisify(execFile)(process.execPath, [path.join(packageDir, "scripts", script), ...args], {
    cwd: packageDir,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  }).then(
    ({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
    (error) => ({ status: error.code, stdout: error.stdout, stderr: error.stderr }),
  );

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

const sourceBytes = {
  ...files,
  [movedKey]: randomBytes(200),
  [shortKey]: randomBytes(100),
  [truncatedKey]: randomBytes(100),
};
const streamedWithoutRanges = new Set([exeKey, truncatedKey]);
const workerOrigins = {};

const source = createHttpServer((req, res) => {
  const { pathname } = new URL(req.url, "http://source");
  const redirects = {
    "/api/tools/zip/download": signedPath(zipKey),
    "/api/tools/moved/download": signedPath("builds/other.zip"),
    "/api/tools/loop/download": `${workerOrigins.origin}/${loopKey}`,
  };
  if (redirects[pathname]) {
    res.writeHead(302, { Location: redirects[pathname] }).end();
    return;
  }
  const key = Object.keys(sourceBytes).find((candidate) => pathname.endsWith(`/${candidate}`));
  if (!key) {
    res.writeHead(404).end();
    return;
  }
  const bytes = sourceBytes[key];
  if (streamedWithoutRanges.has(key)) {
    res.writeHead(200);
    res.write(bytes.subarray(0, 1000));
    res.end(bytes.subarray(1000));
    return;
  }
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
  if (!range) {
    res.writeHead(200, { "Content-Length": bytes.length }).end(bytes);
    return;
  }
  const [first, last] = [Number(range[1]), Math.min(Number(range[2]), bytes.length - 1)];
  res
    .writeHead(206, { "Content-Length": last - first + 1, "Content-Range": `bytes ${first}-${last}/${bytes.length}` })
    .end(bytes.subarray(first, last + 1));
});

const originConfig = (sourceOrigin) => {
  const entry = (bytes, from, size = bytes.length) => ({
    source: `${sourceOrigin}${from}`,
    size,
    sha256: sha256(bytes),
    lastModified: "2026-10-31T07:02:00Z",
  });
  const config = {
    name: "roo-downloads-origin-test",
    main: path.join(packageDir, "src/index.js"),
    compatibility_date: "2026-10-01",
    vars: {
      ORIGIN_FILES: {
        [zipKey]: entry(zip, "/api/tools/zip/download"),
        [exeKey]: entry(files[exeKey], `/${exeKey}`),
        [movedKey]: entry(sourceBytes[movedKey], "/api/tools/moved/download"),
        [shortKey]: entry(sourceBytes[shortKey], `/${shortKey}`, 200),
        [loopKey]: entry(sourceBytes[movedKey], "/api/tools/loop/download"),
        [truncatedKey]: entry(sourceBytes[truncatedKey], `/${truncatedKey}`, 200),
      },
    },
  };
  const file = path.join(workDir, "origin.wrangler.json");
  writeFileSync(file, JSON.stringify(config));
  return file;
};

const workers = [];

const startWorker = async (args) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    wrangler,
    ["dev", "--ip", "127.0.0.1", "--port", String(port), "--show-interactive-dev-session=false", ...args],
    { cwd: packageDir, detached: true, stdio: "ignore", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  workers.push(child);
  return origin;
};

const waitHealthy = async (origin) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const healthy = await fetch(`${origin}/health`).then((response) => response.ok, () => false);
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`wrangler dev at ${origin} did not become healthy within 60 seconds`);
};

before(async () => {
  const upload = await runScript("upload.mjs", ["--local", "--persist-to", stateDir, ...pairs]);
  assert.equal(upload.status, 0, upload.stderr);
  assert.deepEqual(
    upload.stdout.trim().split("\n").map((line) => JSON.parse(line)),
    Object.entries(files).map(([key, bytes]) => ({ key, size: bytes.length, sha256: sha256(bytes) })),
  );

  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  const sourceOrigin = `http://127.0.0.1:${source.address().port}`;
  workerOrigins.r2 = await startWorker(["--env", "r2", "--persist-to", stateDir]);
  await waitHealthy(workerOrigins.r2);
  workerOrigins.origin = await startWorker(["--config", originConfig(sourceOrigin)]);
  await waitHealthy(workerOrigins.origin);
});

after(async () => {
  await Promise.all(
    workers
      .filter((child) => child.exitCode === null)
      .map((child) => {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        process.kill(-child.pid, "SIGTERM");
        return exited;
      }),
  );
  source.close();
  rmSync(workDir, { recursive: true, force: true });
});

for (const mode of ["r2", "origin"]) {
  describe(`${mode} storage`, () => {
    const request = (pathname, init) => fetch(`${workerOrigins[mode]}${pathname}`, init);

    test("verify script matches every file and catches a different file", async () => {
      const verified = await runScript("verify.mjs", ["--url", workerOrigins[mode], ...pairs]);
      assert.equal(verified.status, 0, verified.stderr);
      assert.equal(verified.stdout.trim().split("\n").filter((line) => line.endsWith("match")).length, pairs.length);

      const tampered = await runScript("verify.mjs", ["--url", workerOrigins[mode], tamperedPair]);
      assert.equal(tampered.status, 1);
      assert.match(tampered.stdout, /FAIL \(.*SHA-256/);
    });

    test("health answers ok without caching", async () => {
      const response = await request("/health");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok", storage: mode });
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
      assert.equal((await ranged("bytes=0-9", { "If-Range": `W/${headers.get("ETag")}` })).status, 200);

      for (const range of ["bytes=0-9", `bytes=${size}-`]) {
        const head = await request(`/${zipKey}`, { method: "HEAD", headers: { Range: range } });
        assert.equal(head.status, 200, range);
        assert.equal(head.headers.get("Content-Length"), String(size));
        assert.equal(head.headers.get("Content-Range"), null);
      }
    });

    test("conditional requests answer 304 and 412", async () => {
      const { headers } = await request(`/${zipKey}`, { method: "HEAD" });
      const etag = headers.get("ETag");
      const lastModified = headers.get("Last-Modified");
      const status = async (conditions) => (await request(`/${zipKey}`, { headers: conditions })).status;
      const secondEarlier = new Date(Date.parse(lastModified) - 1000).toUTCString();

      const notModified = await request(`/${zipKey}`, { headers: { "If-None-Match": etag } });
      assert.equal(notModified.status, 304);
      assert.equal(notModified.headers.get("ETag"), etag);
      assert.equal(await status({ "If-None-Match": `"other", W/${etag}` }), 304);
      assert.equal(await status({ "If-None-Match": '"other"' }), 200);
      assert.equal(await status({ "If-Modified-Since": lastModified }), 304);
      assert.equal(await status({ "If-None-Match": '"other"', "If-Modified-Since": lastModified }), 200);
      assert.equal(await status({ "If-Modified-Since": secondEarlier }), 200);
      assert.equal(await status({ "If-Match": etag }), 200);
      assert.equal(await status({ "If-Match": '"other"' }), 412);
      assert.equal(await status({ "If-Unmodified-Since": secondEarlier }), 412);
      assert.equal(await status({ "If-Unmodified-Since": lastModified }), 200);
      assert.equal(await status({ "If-Unmodified-Since": "0" }), 200);
      assert.equal(await status({ "If-Modified-Since": "9999" }), 200);
      assert.equal(await status({ "If-Modified-Since": lastModified.replace("GMT", "UTC") }), 200);
      assert.equal(await status({ "If-Modified-Since": "Sun, 31 Feb 2099 00:00:00 GMT" }), 200);

      const [weekday, day, month, year, time] = lastModified.split(/,? /);
      const longWeekday = new Date(lastModified).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
      const rfc850 = `${longWeekday}, ${day}-${month}-${year.slice(2)} ${time} GMT`;
      const asctime = `${weekday} ${month} ${day.replace(/^0/, " ")} ${time} ${year}`;
      assert.equal(await status({ "If-Modified-Since": rfc850 }), 304);
      assert.equal(await status({ "If-Modified-Since": asctime }), 304);
      const earlier = new Date(Date.parse(lastModified) - 86_400_000).toUTCString().split(/,? /);
      const earlierAsctime = `${earlier[0]} ${earlier[2]} ${earlier[1]} ${earlier[4]} ${earlier[3]}`;
      assert.equal(await status({ "If-Unmodified-Since": earlierAsctime }), 412);
    });

    test("unknown, unsafe and unsupported requests are refused", async () => {
      const paths = ["/", "/builds/missing.zip", "/.env", "/notes.txt", "/builds/%2e%2e/secret.zip", "/%E0%A4%A.zip"];
      for (const pathname of paths) {
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
  });
}

test("origin storage refuses a source that moved, came up short or points back at the Worker", async () => {
  for (const key of [movedKey, shortKey, loopKey]) {
    const response = await fetch(`${workerOrigins.origin}/${key}`);
    assert.equal(response.status, 503, key);
    assert.deepEqual(await response.json(), { error: "file_unavailable" });
  }
});

test("origin storage serves ranges from a source that ignores them and aborts a short stream", async () => {
  const exe = files[exeKey];
  const part = await fetch(`${workerOrigins.origin}/${exeKey}`, { headers: { Range: "bytes=900-1999" } });
  assert.equal(part.status, 206);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(exe.subarray(900, 2000)));

  const truncated = await fetch(`${workerOrigins.origin}/${truncatedKey}`);
  assert.equal(truncated.headers.get("Content-Length"), "200");
  await assert.rejects(truncated.arrayBuffer());
});
