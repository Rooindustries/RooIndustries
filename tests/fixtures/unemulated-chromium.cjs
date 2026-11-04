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

const contentAssetOrigin = (baseURL) => {
  const url = new URL(baseURL);
  url.port = process.env.TOOLING_CONTENT_PORT || String(Number(url.port) + 1);
  return url.origin;
};

const killGroup = (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

const stopChild = (child, graceMs) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => killGroup(child), graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      killGroup(child);
      resolve();
    });
  });

const waitForEndpoint = async (port, child, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
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

const connect = (endpoint) => {
  const socket = new WebSocket(endpoint);
  let nextId = 0;
  let closedError = null;
  const pending = new Map();
  const listeners = new Set();
  const failPending = (error) => {
    closedError = closedError || error;
    pending.forEach(({ reject }) => reject(closedError));
    pending.clear();
  };
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
  socket.addEventListener("close", () => failPending(new Error("Chromium connection closed.")));
  socket.addEventListener("error", () => failPending(new Error("Chromium connection failed.")));
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("close", () => reject(closedError || new Error("Chromium connection closed.")), { once: true });
  });
  const send = (method, params = {}, sessionId) => {
    if (closedError) return Promise.reject(closedError);
    return new Promise((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve, reject });
      socket.send(JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };
  return { socket, opened, send, listeners };
};

async function launchUnemulatedChromium({
  baseURL,
  userDataDir,
  width,
  height,
  chromiumSandbox = false,
  executablePath = chromium.executablePath(),
  startupTimeoutMs = 20000,
}) {
  const origin = new URL(baseURL).origin;
  const assetOrigin = contentAssetOrigin(baseURL);
  const allowedHosts = [origin, assetOrigin].map((value) => new URL(value).host);
  const port = await freePort();
  fs.mkdirSync(userDataDir, { recursive: true });
  const child = spawn(
    executablePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${width},${height}`,
      `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${new URL(baseURL).hostname}`,
      "--proxy-server=127.0.0.1:9",
      `--proxy-bypass-list=<-loopback>;${allowedHosts.join(";")}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(chromiumSandbox === true ? [] : ["--no-sandbox"]),
      ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []),
      "about:blank",
    ],
    { stdio: "ignore", detached: process.platform !== "win32" }
  );
  const killOnExit = () => killGroup(child);
  process.once("exit", killOnExit);

  let connection;
  try {
    connection = connect(await waitForEndpoint(port, child, startupTimeoutMs));
    await connection.opened;
  } catch (error) {
    connection?.socket.close();
    await stopChild(child, 0);
    process.off("exit", killOnExit);
    throw error;
  }
  const { socket, send, listeners } = connection;

  const blockedRequests = [];
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

  const close = async () => {
    process.off("exit", killOnExit);
    const stopped = stopChild(child, 5000);
    send("Browser.close").catch(() => {});
    await stopped;
    socket.close();
  };

  const guardedTargets = new Map();
  const targetWaiters = new Map();
  const unguardedTargets = [];
  const observedSessions = new Set();
  const guardTarget = async ({ sessionId, targetInfo, waitingForDebugger }) => {
    try {
      await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
    } catch {
      try {
        await send("Network.enable", {}, sessionId);
        observedSessions.add(sessionId);
      } catch (error) {
        unguardedTargets.push(`${targetInfo.type} ${targetInfo.url}: ${error.message}`);
      }
    }
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
    if (waitingForDebugger) await send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    guardedTargets.set(targetInfo.targetId, sessionId);
    targetWaiters.get(targetInfo.targetId)?.(sessionId);
  };
  listeners.add((message) => {
    if (message.method === "Target.attachedToTarget") guardTarget(message.params);
    if (message.method === "Network.requestWillBeSent" && observedSessions.has(message.sessionId)) {
      const { request } = message.params;
      if (!request.url.startsWith(`${origin}/`)) blockedRequests.push(`${request.method} ${request.url}`);
    }
  });
  const guardedSession = (targetId) =>
    guardedTargets.has(targetId)
      ? Promise.resolve(guardedTargets.get(targetId))
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            targetWaiters.delete(targetId);
            reject(new Error(`Chromium never attached target ${targetId}.`));
          }, 10000);
          targetWaiters.set(targetId, (sessionId) => {
            clearTimeout(timer);
            targetWaiters.delete(targetId);
            resolve(sessionId);
          });
        });

  try {
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  } catch (error) {
    await close();
    throw error;
  }

  const openTab = async (url) => {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const sessionId = await guardedSession(targetId);
    await send("Runtime.enable", {}, sessionId);
    const evaluate = async (fn, arg, options = {}) => {
      const result = await send(
        "Runtime.evaluate",
        { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true, ...options },
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

  return { pid: child.pid, openTab, blockedRequests, unguardedTargets, close };
}

module.exports = { launchUnemulatedChromium };
