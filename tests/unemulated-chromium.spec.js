const fs = require("node:fs");
const http = require("node:http");
const { test, expect } = require("@playwright/test");
const { launchUnemulatedChromium } = require("./fixtures/unemulated-chromium.cjs");

const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const writeFakeChromium = (testInfo, name, body) => {
  const file = testInfo.outputPath(`${name}.cjs`);
  fs.mkdirSync(testInfo.outputDir, { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return file;
};

const launchOptions = (testInfo, baseURL, overrides = {}) => ({
  baseURL,
  userDataDir: testInfo.outputPath(`profile-${Date.now()}`),
  width: 1280,
  height: 800,
  chromiumSandbox: testInfo.project.use.launchOptions?.chromiumSandbox,
  ...overrides,
});

for (const [name, body] of [
  [
    "endpoint-timeout",
    `require("node:fs").writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));\nsetInterval(() => {}, 1000);`,
  ],
  [
    "socket-error",
    `const http = require("node:http");\nrequire("node:fs").writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));\nconst port = Number(process.argv.find((arg) => arg.startsWith("--remote-debugging-port=")).split("=")[1]);\nhttp.createServer((request, response) => {\n  response.setHeader("content-type", "application/json");\n  response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/browser/missing" }));\n}).listen(port, "127.0.0.1");`,
  ],
]) {
  test(`a launch that fails with ${name} leaves no browser process`, async ({ baseURL }, testInfo) => {
    const pidFile = testInfo.outputPath(`${name}.pid`);
    process.env.FAKE_PID_FILE = pidFile;
    try {
      await expect(
        launchUnemulatedChromium(
          launchOptions(testInfo, baseURL, {
            executablePath: writeFakeChromium(testInfo, name, body),
            startupTimeoutMs: 1500,
          })
        )
      ).rejects.toThrow();
    } finally {
      delete process.env.FAKE_PID_FILE;
    }
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await expect.poll(() => isRunning(pid), { timeout: 2000 }).toBe(false);
  });
}

test("losing the browser mid-request rejects the request and cleanup finishes", async ({ baseURL }, testInfo) => {
  const browser = await launchUnemulatedChromium(launchOptions(testInfo, baseURL));
  const tab = await browser.openTab(`${baseURL}/contact`);
  const stuck = tab.evaluate(() => new Promise(() => {}));
  process.kill(-browser.pid, "SIGKILL");
  await expect(stuck).rejects.toThrow("Chromium connection");
  const started = Date.now();
  await browser.close();
  expect(Date.now() - started).toBeLessThan(6000);
  expect(isRunning(browser.pid)).toBe(false);
});

test("popups and workers cannot reach any other local port", async ({ baseURL }, testInfo) => {
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url);
    response.end("reached");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const otherOrigin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchUnemulatedChromium(launchOptions(testInfo, baseURL));
  try {
    const tab = await browser.openTab(`${baseURL}/contact`);
    await tab.evaluate((target) => Boolean(window.open(`${target}/popup`, "_blank")), otherOrigin, { userGesture: true });
    const blankTab = await browser.openTab("about:blank");
    const workerResult = await blankTab.evaluate((target) => {
      const source = `fetch(${JSON.stringify(`${target}/worker`)}).then(() => postMessage("reached"), () => postMessage("blocked"));`;
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
      return new Promise((resolve) => {
        worker.onmessage = (event) => resolve(event.data);
      });
    }, otherOrigin);
    await expect
      .poll(() => browser.blockedRequests.filter((request) => request.includes(otherOrigin)).length)
      .toBeGreaterThanOrEqual(2);
    expect(workerResult).toBe("blocked");
    expect(hits).toEqual([]);
    expect(browser.unguardedTargets).toEqual([]);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
