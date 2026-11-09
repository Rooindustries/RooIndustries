const { test, expect } = require("@playwright/test");
const { holdRoutes, routePage, removePageRoutes } = require("./fixtures/held-routes.cjs");

test.use({ javaScriptEnabled: true });

test.beforeEach(async ({ context, page, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  await page.goto("/contact");
});

test("held requests keep one owner through repeated releases and the next route", async ({ page, context }) => {
  const pattern = "**/__held-route/**";
  const forwarded = [];
  await context.route(pattern, route => {
    const path = new URL(route.request().url()).pathname;
    forwarded.push(path);
    return route.fulfill({ json: path });
  });
  for (let round = 0; round < 12; round++) {
    const held = await holdRoutes(page, pattern);
    try {
      await page.evaluate(round => {
        window.__heldRequests = Promise.all([0, 1, 2].map(index =>
          fetch(`/__held-route/${round}/${index}`).then(response => response.json())
        ));
      }, round);
      await expect.poll(() => held.requests.length).toBe(3);
      expect(forwarded).toHaveLength(round * 4);
    } finally {
      await Promise.all([held.release(), held.release()]);
    }
    expect(await page.evaluate(() => window.__heldRequests)).toEqual(
      [0, 1, 2].map(index => `/__held-route/${round}/${index}`)
    );
    expect(await page.evaluate(round =>
      fetch(`/__held-route/${round}/next`).then(response => response.json()), round
    )).toBe(`/__held-route/${round}/next`);
  }
  expect(forwarded).toHaveLength(48);
  expect(new Set(forwarded).size).toBe(48);
});

test("releasing waits for an asynchronous decision while other requests finish", async ({ page, context }) => {
  let decide, entered;
  const decision = new Promise(resolve => { decide = resolve; });
  const deciding = new Promise(resolve => { entered = resolve; });
  const forwarded = [];
  const pattern = "**/__held-route/**";
  await context.route(pattern, route => {
    const path = new URL(route.request().url()).pathname;
    forwarded.push(path);
    return route.fulfill({ json: path });
  });
  const held = await holdRoutes(page, pattern, request => {
    if (!request.url().endsWith("/delayed")) return false;
    entered();
    return decision;
  });
  let finished = false;
  try {
    await page.evaluate(() => {
      window.__heldRequests = Promise.all(["delayed", "immediate"].map(name =>
        fetch(`/__held-route/${name}`).then(response => response.json())
      ));
    });
    await deciding;
    const releasing = held.release().then(() => { finished = true; });
    await expect.poll(() => forwarded).toEqual(["/__held-route/immediate"]);
    expect(finished).toBe(false);
    decide(true);
    await releasing;
    expect(await page.evaluate(() => window.__heldRequests)).toEqual([
      "/__held-route/delayed", "/__held-route/immediate",
    ]);
  } finally {
    decide(true);
    await held.release();
  }
});

test("holding one page leaves a second tab free to finish its request", async ({ page, context, baseURL }) => {
  const pattern = "**/__held-route/**";
  await context.route(pattern, route => route.fulfill({ json: "finished" }));
  const held = await holdRoutes(page, pattern);
  const other = await context.newPage();
  try {
    await page.evaluate(() => {
      window.__heldRequest = fetch("/__held-route/first").then(response => response.json());
    });
    await held.wait();
    await other.goto(`${baseURL}/contact`);
    expect(await other.evaluate(() =>
      fetch("/__held-route/second").then(response => response.json())
    )).toBe("finished");
    expect(held.requests).toHaveLength(1);
  } finally {
    await held.release();
    await other.close();
  }
  expect(await page.evaluate(() => window.__heldRequest)).toBe("finished");
});

for (const removal of ["handler", "all"]) {
  test(`${removal} removal drains a request burst and preserves downstream routes`, async ({ page, context }) => {
    const pattern = "**/__held-route/**";
    await context.route(pattern, route => route.fulfill({ json: "context" }));
    await routePage(page, pattern, route => route.fulfill({ json: "page" }));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const received = [];
    const handler = async route => {
      received.push(route.request().url());
      await gate;
      await route.fallback();
    };
    await routePage(page, pattern, handler);
    try {
      await page.evaluate(() => {
        window.__heldRequests = Promise.all(Array.from({ length: 12 }, (_, index) =>
          fetch(`/__held-route/${index}`).then(response => response.json())
        ));
      });
      await expect.poll(() => received.length).toBe(12);
      let removed = false;
      const removing = (removal === "handler" ? removePageRoutes(page, pattern, handler) : removePageRoutes(page))
        .then(() => { removed = true; });
      const expected = removal === "handler" ? "page" : "context";
      expect(await page.evaluate(() => fetch("/__held-route/probe").then(response => response.json()))).toBe(expected);
      expect(removed).toBe(false);
      release();
      await removing;
      expect(await page.evaluate(() => window.__heldRequests)).toEqual(Array(12).fill(expected));
      expect(await page.evaluate(() => fetch("/__held-route/next").then(response => response.json()))).toBe(expected);
      await removePageRoutes(page, pattern, handler);
    } finally {
      release();
      await removePageRoutes(page);
    }
  });
}

test("removing the last route waits for a saved reply", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let saved;
  try {
    await page.goto(`${baseURL}/contact`);
    await routePage(page, "**/__held-route/last", route => { saved = route; });
    await page.evaluate(() => {
      window.__lastRequest = fetch("/__held-route/last").then(response => response.json());
    });
    await expect.poll(() => Boolean(saved)).toBe(true);
    let removed = false;
    const removing = removePageRoutes(page).then(() => { removed = true; });
    expect(await page.evaluate(() => fetch("/__held-route/last").then(response => response.status))).toBe(404);
    expect(removed).toBe(false);
    await saved.fulfill({ json: "saved" });
    await removing;
    expect(await page.evaluate(() => window.__lastRequest)).toBe("saved");
  } finally {
    await context.close();
  }
});

test("a popup can navigate while another page has a matching route", async ({ page, context, baseURL }) => {
  await routePage(page, "**/contact?popup=1", route => route.fulfill({ body: "wrong page" }));
  try {
    const opened = context.waitForEvent("page");
    await page.evaluate(() => window.open("/contact?popup=1"));
    const popup = await opened;
    await popup.waitForLoadState("domcontentloaded");
    expect(popup.url()).toBe(`${baseURL}/contact?popup=1`);
    await popup.close();
  } finally {
    await removePageRoutes(page);
  }
});
