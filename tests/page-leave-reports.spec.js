const { evaluateBrowserTask } = require("./fixtures/browser-task.cjs");
const { test, expect } = require("@playwright/test");
const { navLink } = require("./fixtures/nav-link.cjs");
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
  await evaluateBrowserTask(page, () => new Promise((resolve) => setTimeout(resolve, 500)));

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

const holdContent = async (page, resources) => {
  const held = [];
  let holding = true;
  await page.route("**/api/content/**", async (request) => {
    const resource = new URL(request.request().url()).pathname.split("/").pop();
    if (!holding || !resources.includes(resource)) return request.fallback();
    held.push(request);
  });
  return {
    held,
    release: async () => {
      holding = false;
      await Promise.all(held.map((request) => request.fallback().catch(() => {})));
    },
  };
};

const appReports = (errors) => errors.filter((text) => !text.startsWith("Failed to load resource"));
const settle = (page) => evaluateBrowserTask(page, () => new Promise((resolve) => setTimeout(resolve, 500)));

test("leaving while the packages section loads its packages reports no error", async ({ page }) => {
  const content = await holdContent(page, ["packages-list", "packages-settings"]);
  const errors = collectConsoleErrors(page);
  await page.goto("/contact");
  await page.locator(navLink("plans")).click();
  await expect(page.locator("#packages")).toBeAttached();
  await expect.poll(() => content.held.some((route) => route.request().url().includes("/packages-list"))).toBe(true);
  await page.goto("/terms");
  await expect(page.locator("main h1").first()).toBeVisible();
  await content.release();
  await settle(page);

  expect(appReports(errors)).toEqual([]);
});

test("leaving the booking page while its package details load reports no error", async ({ page }) => {
  const content = await holdContent(page, ["package"]);
  const errors = collectConsoleErrors(page);
  await page.goto("/booking");
  await expect.poll(() => content.held.length).toBeGreaterThan(0);
  await page.goto("/contact");
  await expect(page.locator("main h1").first()).toBeVisible();
  await content.release();
  await settle(page);

  expect(appReports(errors)).toEqual([]);
});

test("moving away in the app while an upgrade link loads reports no error", async ({ page }) => {
  const content = await holdContent(page, ["upgrade-link"]);
  const errors = collectConsoleErrors(page);
  await page.goto("/upgrade/max");
  await expect(page.getByText("Loading upgrade link...", { exact: true })).toBeVisible();
  await expect.poll(() => content.held.length).toBe(1);
  await page.getByRole("link", { name: "Roo Industries Precision Performance Engineering", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await settle(page);

  expect(appReports(errors)).toEqual([]);
  await content.release();
});

test("an upgrade link that times out is reported once", async ({ page }) => {
  const content = await holdContent(page, ["upgrade-link"]);
  const errors = collectConsoleErrors(page);
  await page.goto("/upgrade/max");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 20000 });
  await settle(page);

  expect(appReports(errors)).toHaveLength(1);
  expect(appReports(errors)[0]).toContain("Request timed out.");
  await content.release();
});

const availabilityFailed = "Booking availability took too long to load.";

const unavailable = { status: 503, json: { ok: false, error: "Booking availability unavailable." } };

test("leaving the booking page during its last availability retry reports no error", async ({ page }) => {
  const held = [];
  let failures = 0;
  await page.route("**/api/bookingAvailability", (request) => {
    if (failures++ < 3) return request.fulfill(unavailable);
    held.push(request);
  });
  const errors = collectConsoleErrors(page);
  await page.goto("/booking");
  await expect.poll(() => held.length).toBe(1);
  await page.goto("/contact");
  await expect(page.locator("main h1").first()).toBeVisible();
  await Promise.all(held.map((request) => request.fallback().catch(() => {})));
  await settle(page);

  expect(appReports(errors)).toEqual([]);
});

test("leaving between availability retries suppresses the final network failure", async ({ page }) => {
  await page.addInitScript(() => {
    const schedule = window.setTimeout.bind(window);
    let retryGaps = 0;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 250 && ++retryGaps === 2) {
        window.dispatchEvent(new PageTransitionEvent("pagehide"));
      }
      return schedule(callback, delay, ...args);
    };
  });
  let requests = 0;
  await page.route("**/api/bookingAvailability", (request) => {
    requests += 1;
    return requests < 4 ? request.fulfill(unavailable) : request.abort("failed");
  });
  const errors = collectConsoleErrors(page);
  await page.goto("/booking");
  await expect(page.getByText(availabilityFailed, { exact: true })).toBeVisible();
  await settle(page);

  expect(requests).toBe(4);
  expect(appReports(errors)).toEqual([]);
});

test("booking availability that times out is reported once", async ({ page }) => {
  await page.route("**/api/bookingAvailability", () => {});
  const errors = collectConsoleErrors(page);
  await page.goto("/booking");
  await expect(page.getByText(availabilityFailed, { exact: true })).toBeVisible({ timeout: 40000 });
  await settle(page);

  expect(appReports(errors)).toHaveLength(1);
  expect(appReports(errors)[0]).toContain("Request timed out.");
});

test("booking availability answering 503 is reported once", async ({ page }) => {
  await page.route("**/api/bookingAvailability", (request) => request.fulfill(unavailable));
  const errors = collectConsoleErrors(page);
  await page.goto("/booking");
  await expect(page.getByText(availabilityFailed, { exact: true })).toBeVisible();
  await settle(page);

  expect(appReports(errors)).toHaveLength(1);
  expect(appReports(errors)[0]).toContain("Booking availability unavailable.");
});

const checkFailed = "Something went wrong while checking your order. Try again.";

for (const route of ["/upgrade/max", "/upgrade-xoc"]) {
  const checkOrder = async (page) => {
    await page.route("**/api/content/upgrade-link?*", (request) =>
      request.fulfill({
        json: {
          ok: true,
          data: { title: "Upgrade to Performance Vertex Max", targetPackage: { title: "Performance Vertex Max", price: "$99.95" } },
        },
      })
    );
    await page.goto(route);
    await page.getByPlaceholder("Email used on the original booking").fill("client@example.com");
    await page.getByPlaceholder("e.g. 1a2b3c4d5e6f7g8h9i").fill("order-123");
    await page.getByRole("button", { name: "Check eligibility", exact: true }).click();
  };

  test(`leaving ${route} while its eligibility check runs reports no error`, async ({ page }) => {
    const held = [];
    await page.route("**/api/ref/getUpgradeInfo", (request) => {
      held.push(request);
    });
    const errors = collectConsoleErrors(page);
    await checkOrder(page);
    await expect.poll(() => held.length).toBe(1);
    await page.goto("/contact");
    await expect(page.locator("main h1").first()).toBeVisible();
    await Promise.all(held.map((request) => request.fallback().catch(() => {})));
    await settle(page);

    expect(appReports(errors)).toEqual([]);
  });

  test(`an eligibility check on ${route} that times out is reported once`, async ({ page }) => {
    await page.route("**/api/ref/getUpgradeInfo", () => {});
    const errors = collectConsoleErrors(page);
    await checkOrder(page);
    await expect(page.getByText(checkFailed, { exact: true })).toBeVisible({ timeout: 20000 });
    await settle(page);

    expect(appReports(errors)).toHaveLength(1);
    expect(appReports(errors)[0]).toContain("Request timed out.");
  });

  for (const [status, reports] of [
    [503, 1],
    [403, 1],
    [404, 0],
    [409, 0],
    [429, 0],
  ]) {
    const outcome = reports ? "is reported once" : "is shown without a report";
    test(`an eligibility check on ${route} answering ${status} ${outcome}`, async ({ page }) => {
      const message = `Order lookup answered ${status}.`;
      await page.route("**/api/ref/getUpgradeInfo", (request) =>
        request.fulfill({ status, json: { ok: false, error: message } })
      );
      const errors = collectConsoleErrors(page);
      await checkOrder(page);
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await settle(page);

      expect(appReports(errors)).toHaveLength(reports);
      if (reports) expect(appReports(errors)[0]).toContain(message);
    });
  }
}
