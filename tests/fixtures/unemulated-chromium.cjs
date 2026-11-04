const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const { chromium } = require("@playwright/test");

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const waitForEndpoint = async (port, child) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chromium exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chromium did not open its debugging endpoint.");
};

const contentAssetOrigin = (baseURL) => {
  const url = new URL(baseURL);
  url.port = process.env.TOOLING_CONTENT_PORT || String(Number(url.port) + 1);
  return url.origin;
};

async function launchUnemulatedChromium({ baseURL, userDataDir, width, height }) {
  const origin = new URL(baseURL).origin;
  const assetOrigin = contentAssetOrigin(baseURL);
  const port = await freePort();
  fs.mkdirSync(userDataDir, { recursive: true });
  const child = spawn(
    chromium.executablePath(),
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${width},${height}`,
      `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${new URL(baseURL).hostname}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []),
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  const socket = new WebSocket(await waitForEndpoint(port, child));
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  const blockedRequests = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    listeners.forEach((listener) => listener(message));
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve, reject });
      socket.send(JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  listeners.add((message) => {
    if (message.method !== "Fetch.requestPaused") return;
    const { requestId, request, resourceType } = message.params;
    const url = new URL(request.url);
    const allowed =
      !url.username &&
      !url.password &&
      (url.origin === origin ||
        (url.origin === assetOrigin && request.method === "GET" && resourceType === "Image" && url.pathname.startsWith("/storage/v1/")));
    if (allowed) {
      send("Fetch.continueRequest", { requestId }, message.sessionId).catch(() => {});
      return;
    }
    blockedRequests.push(`${request.method} ${request.url}`);
    send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, message.sessionId).catch(() => {});
  });

  const openTab = async (url) => {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
    await send("Runtime.enable", {}, sessionId);
    const evaluate = async (fn, arg) => {
      const result = await send(
        "Runtime.evaluate",
        { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true },
        sessionId
      );
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Evaluation failed.");
      return result.result.value;
    };
    const waitFor = async (fn, arg, timeoutMs = 10000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await evaluate(fn, arg).catch(() => null);
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    };
    const click = async (selector) => {
      const point = await waitFor((target) => {
        const element = document.querySelector(target);
        if (!element) return null;
        element.scrollIntoView({ block: "center" });
        const rect = element.getBoundingClientRect();
        return rect.width && rect.height ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
      }, selector);
      if (!point) throw new Error(`No clickable element for ${selector}.`);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 }, sessionId);
      }
    };
    await send("Page.enable", {}, sessionId);
    await send("Page.navigate", { url }, sessionId);
    const loaded = await waitFor((expected) => window.location.href === expected && document.readyState !== "loading", new URL(url).href);
    if (!loaded) throw new Error(`Chromium did not load ${url}.`);
    return {
      targetId,
      evaluate,
      waitFor,
      click,
      activate: () => send("Target.activateTarget", { targetId }),
      screenshot: async (file) => {
        const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
        fs.writeFileSync(file, Buffer.from(data, "base64"));
      },
      close: () => send("Target.closeTarget", { targetId }),
    };
  };

  return {
    openTab,
    blockedRequests,
    close: async () => {
      await send("Browser.close").catch(() => {});
      socket.close();
      if (child.exitCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

module.exports = { launchUnemulatedChromium };
