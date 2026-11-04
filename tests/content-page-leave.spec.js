const { test, expect } = require("@playwright/test");
const http = require("node:http");
const zlib = require("node:zlib");

test.use({ javaScriptEnabled: true, viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

for (const route of ["/", "/benchmarks", "/reviews", "/tools", "/meet-the-team", "/terms", "/privacy"]) {
  test(`leaving ${route} while its content is loading reports no error`, async ({ page }) => {
    const held = [];
    let holding = true;
    await page.route("**/api/content/**", async (request) => {
      if (!holding) return request.fallback();
      held.push(request);
    });
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`${message.text()} @ ${page.url()}`);
    });
    page.on("pageerror", (error) => errors.push(`${error.message} @ ${page.url()}`));

    await page.goto(route);
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.goto("/contact");
    await expect(page.locator("main h1").first()).toBeVisible();
    holding = false;
    await Promise.all(held.map((request) => request.fallback().catch(() => {})));

    expect(errors).toEqual([]);
  });
}

test("a content failure while the visitor stays on the page is still reported", async ({ page }) => {
  await page.route("**/api/content/terms", (request) => request.abort("failed"));
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/terms");

  await expect.poll(() => errors.some((text) => text.startsWith("TypeError: Failed to fetch"))).toBe(true);
});

const startTermsServer = async (respond) => {
  const sockets = new Set();
  const server = http.createServer((request, response) => respond(response));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/api/content/terms`,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    },
  };
};

const collectConsoleErrors = (page) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
};

const leaveTermsMidBody = async (page, respond) => {
  const server = await startTermsServer(respond);
  try {
    await page.route("**/api/content/terms", (request) => request.continue({ url: server.url }));
    const errors = collectConsoleErrors(page);
    const headersReceived = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/content/terms");
    await page.goto("/terms");
    await headersReceived;
    await page.goto("/contact");
    await expect(page.locator("main h1").first()).toBeVisible();
    return errors;
  } finally {
    await server.close();
  }
};

test("an error response cut off by leaving the page is still reported", async ({ page }) => {
  const errors = await leaveTermsMidBody(page, (response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.write('{"ok":false,');
  });

  await expect.poll(() => errors.some((text) => text.includes("Public content could not be loaded."))).toBe(true);
});

test("a successful response cut off by leaving the page reports no error", async ({ page }) => {
  const errors = await leaveTermsMidBody(page, (response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":true,"data":');
  });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));

  expect(errors).toEqual([]);
});

const withBackForwardCache = async ({ playwright, browserName, launchOptions, headless, baseURL }, run) => {
  const browser = await playwright[browserName].launch({
    ...launchOptions,
    headless,
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
  });
  try {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: true, viewport: { width: 1440, height: 900 } });
    const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
    await guardBrowserContext(context, [baseURL]);
    await context.addInitScript(() => {
      window.addEventListener("pageshow", (event) => {
        if (event.persisted) window.restoredFromCache = true;
      });
    });
    await run(await context.newPage());
  } finally {
    await browser.close();
  }
};

const leaveTermsAndComeBack = async (page, respond, { disconnectWhileAway = false } = {}) => {
  const server = await startTermsServer(respond);
  try {
    await page.route("**/api/content/terms", (request) => request.continue({ url: server.url }));
    const errors = collectConsoleErrors(page);
    const headersReceived = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/content/terms");
    await page.goto("/terms");
    await headersReceived;
    await page.goto("/contact");
    await expect(page.locator("main h1").first()).toBeVisible();
    if (disconnectWhileAway) await server.close();
    await page.goBack({ waitUntil: "commit" });
    await expect.poll(() => page.evaluate(() => window.restoredFromCache === true)).toBe(true);
    return errors;
  } finally {
    await server.close();
  }
};

for (const [status, body, disconnectWhileAway] of [
  [200, '{"ok":true,"data":', false],
  [503, '{"ok":false,', false],
  [503, '{"ok":false,', true],
]) {
  const when = disconnectWhileAway ? "while the page sits in" : "after the page is restored from";
  test(`a ${status} response cut off ${when} the back/forward cache is reported`, async ({
    playwright,
    browserName,
    launchOptions,
    headless,
    baseURL,
  }) => {
    await withBackForwardCache({ playwright, browserName, launchOptions, headless, baseURL }, async (page) => {
      const errors = await leaveTermsAndComeBack(
        page,
        (response) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.write(body);
        },
        { disconnectWhileAway }
      );
      const appReports = () => errors.filter((text) => !text.startsWith("Failed to load resource"));

      await expect.poll(() => appReports().length).toBeGreaterThan(0);
    });
  });
}

test("a malformed successful response is reported while the visitor stays", async ({ page }) => {
  const server = await startTermsServer((response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true,"data":');
  });
  try {
    await page.route("**/api/content/terms", (request) => request.continue({ url: server.url }));
    const errors = collectConsoleErrors(page);
    await page.goto("/terms");

    await expect.poll(() => errors.some((text) => text.includes("Public content could not be loaded."))).toBe(true);
  } finally {
    await server.close();
  }
});

test("a corrupt compressed body is reported even when the visitor leaves right after", async ({ page }) => {
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true, data: { title: "Terms" } })));
  const server = await startTermsServer((response) => {
    response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    response.write(compressed.subarray(0, 12));
    setTimeout(() => response.end(Buffer.from("this is not gzip data")), 300);
  });
  try {
    await page.route("**/api/content/terms", (request) => request.continue({ url: server.url }));
    const errors = collectConsoleErrors(page);
    const appReports = () => errors.filter((text) => !text.startsWith("Failed to load resource"));
    await page.goto("/terms");
    await expect.poll(() => appReports().length).toBe(1);
    await page.goto("/contact");
    await expect(page.locator("main h1").first()).toBeVisible();

    expect(appReports()).toHaveLength(1);
  } finally {
    await server.close();
  }
});
