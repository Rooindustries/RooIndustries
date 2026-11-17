const { test: bookingTest, expect, settleIdle, productionHostFixtures } = require("./fixtures/booking-flow.cjs");
const { inspectChunks } = require("./fixtures/held-routes.cjs");
const { waitForRouteCommitted } = require("./fixtures/react-hydration.cjs");

const speedInsightsScript = "/_vercel/speed-insights/script.js";
const publicPage = "/packages";
const bookingPage = "/booking?package=overhaul";

const test = bookingTest.extend({
  speedInsightsCodeFails: [false, { option: true }],
  ...productionHostFixtures,
  speedInsights: [async ({ page, context, flow, baseURL, productionHost, speedInsightsCodeFails }, use) => {
    const seen = { requested: [], chunksWithItsCode: [] };
    await context.route(`**${speedInsightsScript}`, (route) => {
      seen.requested.push(route.request().url());
      return route.fulfill({ contentType: "application/javascript", body: "" });
    });
    await inspectChunks(page, { origin: baseURL, fetchOrigin: productionHost.loopback }, () => undefined,
      (route, response, body) => {
        if (!body.includes(speedInsightsScript)) return route.fulfill({ response, body });
        seen.chunksWithItsCode.push(route.request().url());
        return speedInsightsCodeFails ? route.abort("failed") : route.fulfill({ response, body });
      });
    await use(seen);
  }, { auto: true }],
});

test.use({
  javaScriptEnabled: true, timezoneId: "Asia/Kolkata", viewport: { width: 1280, height: 900 },
  reducedMotion: "reduce", actionTimeout: 10000,
});

const holdIdle = (context) => context.addInitScript(() => {
  const browser = { requestIdleCallback: window.requestIdleCallback, cancelIdleCallback: window.cancelIdleCallback };
  const held = new Map();
  let lastId = 0;
  window.requestIdleCallback = (callback, options) => {
    lastId += 1;
    held.set(lastId, [callback, options]);
    return lastId;
  };
  window.cancelIdleCallback = (id) => held.delete(id);
  window.__releaseIdle = () => {
    Object.assign(window, browser);
    for (const [callback, options] of held.values()) window.requestIdleCallback(callback, options);
  };
});

test("a public page loads Speed Insights only once the browser is idle", async ({
  page, context, speedInsights, baseURL,
}) => {
  await holdIdle(context);
  await page.goto(publicPage);
  await waitForRouteCommitted(page);
  expect(speedInsights.requested).toEqual([]);
  expect(speedInsights.chunksWithItsCode).toEqual([]);

  await page.evaluate(() => window.__releaseIdle());
  await expect.poll(() => speedInsights.requested).toEqual([`${baseURL}${speedInsightsScript}`]);
  expect(speedInsights.chunksWithItsCode).toHaveLength(1);
  await settleIdle(page);
  expect(speedInsights.requested).toHaveLength(1);
});

test("the booking and payment pages never load Speed Insights", async ({ page, flow, speedInsights }) => {
  await flow.review(bookingPage);
  await flow.payment();
  await expect(page).toHaveURL((url) => url.pathname === "/payment");
  await settleIdle(page);
  expect(speedInsights).toEqual({ requested: [], chunksWithItsCode: [] });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
  await settleIdle(page);
  expect(speedInsights).toEqual({ requested: [], chunksWithItsCode: [] });
});

test.describe("when the Speed Insights code cannot be loaded", () => {
  test.use({ speedInsightsCodeFails: true });

  test("the page still works", async ({ page, speedInsights }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(publicPage);
    await expect.poll(() => speedInsights.chunksWithItsCode).toHaveLength(1);
    await settleIdle(page);
    await page.getByRole("button", { name: "See What's Included" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(errors).toEqual([]);
    expect(speedInsights.requested).toEqual([]);
  });
});
