const { test: bookingTest, expect, productionHostFixtures } = require("./fixtures/booking-flow.cjs");
const { inspectChunks } = require("./fixtures/held-routes.cjs");
const { version: speedInsightsVersion } = require("@vercel/speed-insights/package.json");

const speedInsightsScript = "/_vercel/speed-insights/script.js";
const speedInsightsElement = {
  src: speedInsightsScript,
  defer: "",
  "data-sdkn": "@vercel/speed-insights/react",
  "data-sdkv": speedInsightsVersion,
};
const chunkPath = "/_next/static/chunks/";
const publicPage = "/packages";
const nextPublicPage = "/tools";
const bookingPage = "/booking?package=overhaul";

const recordScripts = () => {
  const added = (window.__scriptsAdded = []);
  let duringIdle = false;
  const record = (mutations) => {
    for (const node of mutations.flatMap(({ addedNodes }) => [...addedNodes])) {
      if (node.nodeName !== "SCRIPT" || !node.src) continue;
      added.push({
        url: node.src,
        path: window.location.pathname,
        duringIdle,
        attributes: Object.fromEntries([...node.attributes].map(({ name, value }) => [name, value])),
      });
    }
  };
  const observer = new MutationObserver(record);
  observer.observe(document, { childList: true, subtree: true });
  const requestIdle = window.requestIdleCallback.bind(window);
  window.requestIdleCallback = (callback, options) => requestIdle((deadline) => {
    duringIdle = true;
    try {
      callback(deadline);
    } finally {
      record(observer.takeRecords());
      duringIdle = false;
    }
  }, options);
};

const test = bookingTest.extend({
  speedInsightsCodeFailures: [0, { option: true }],
  ...productionHostFixtures,
  speedInsights: [async ({ page, context, flow, baseURL, productionHost, speedInsightsCodeFailures }, use) => {
    const seen = { inspected: [], asksForItsCode: [] };
    await context.addInitScript(recordScripts);
    await context.route(`**${speedInsightsScript}`, (route) =>
      route.fulfill({ contentType: "application/javascript", body: "" }));
    await inspectChunks(page, { origin: baseURL, fetchOrigin: productionHost.loopback }, () => undefined,
      (route, response, body) => {
        const url = route.request().url();
        seen.inspected.push(url);
        if (!body.includes(speedInsightsScript)) return route.fulfill({ response, body });
        seen.asksForItsCode.push(url);
        return seen.asksForItsCode.length > speedInsightsCodeFailures
          ? route.fulfill({ response, body }) : route.abort("failed");
      });
    await use(seen);
  }, { auto: true }],
});

test.use({
  javaScriptEnabled: true, timezoneId: "Asia/Kolkata", viewport: { width: 1280, height: 900 }, reducedMotion: "reduce",
});

const scriptsAdded = (page) => page.evaluate(() => window.__scriptsAdded);
const elementsAdded = async (page) => (await scriptsAdded(page))
  .filter(({ attributes }) => attributes.src === speedInsightsScript)
  .map(({ path, attributes }) => ({ path, attributes }));
const browserIdle = (page) => page.evaluate(() => new Promise((resolve) => window.requestIdleCallback(resolve)));
const everyAddedChunkInspected = async (page, speedInsights) => {
  const chunks = (await scriptsAdded(page))
    .filter(({ url, attributes }) => new URL(url).pathname.startsWith(chunkPath) && !("nomodule" in attributes))
    .map(({ url }) => url);
  await expect.poll(() => chunks.filter((url) => !speedInsights.inspected.includes(url))).toEqual([]);
};
const expectNoSpeedInsights = async (page, speedInsights) => {
  await expect(page.getByRole("button", { name: "Pay your way", exact: true })).toBeEnabled();
  await browserIdle(page);
  await everyAddedChunkInspected(page, speedInsights);
  expect(speedInsights.asksForItsCode).toEqual([]);
  expect(await elementsAdded(page)).toEqual([]);
};

test("a public page loads Speed Insights once, from an idle callback", async ({ page, speedInsights }) => {
  await page.goto(publicPage);
  await expect.poll(() => elementsAdded(page)).toEqual([{ path: publicPage, attributes: speedInsightsElement }]);
  expect(speedInsights.asksForItsCode).toHaveLength(1);
  const itsCode = (await scriptsAdded(page)).filter(({ url }) => speedInsights.asksForItsCode.includes(url));
  expect(itsCode.map(({ path, duringIdle }) => ({ path, duringIdle }))).toEqual([{ path: publicPage, duringIdle: true }]);
});

test("the booking and payment pages never load Speed Insights", async ({ page, flow, speedInsights }) => {
  await flow.review(bookingPage);
  await flow.payment();
  await expect(page).toHaveURL((url) => url.pathname === "/payment");
  await expectNoSpeedInsights(page, speedInsights);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
  await expectNoSpeedInsights(page, speedInsights);
});

test.describe("when the Speed Insights code fails to load once", () => {
  test.use({ speedInsightsCodeFailures: 1 });

  test("the page still works and the next public page loads it", async ({ page, speedInsights }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(publicPage);
    await expect.poll(() => speedInsights.asksForItsCode).toHaveLength(1);
    await page.getByRole("button", { name: "See What's Included" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await elementsAdded(page)).toEqual([]);

    await page.locator("footer").getByRole("link", { name: "Tools", exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === nextPublicPage);
    await expect.poll(() => elementsAdded(page)).toEqual([{ path: nextPublicPage, attributes: speedInsightsElement }]);
    expect(speedInsights.asksForItsCode).toHaveLength(2);
    expect(errors).toEqual([]);
  });
});
