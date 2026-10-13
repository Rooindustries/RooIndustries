const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");

test.use({
  javaScriptEnabled: true,
  timezoneId: "Asia/Kolkata",
  reducedMotion: "reduce",
  actionTimeout: 10000,
  navigationTimeout: 30000,
  trace: "off",
  video: "off",
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const layout = window.__bookingDialogLayout = { shifts: [], sizes: [] };
    const selector = '[role="dialog"].ri-booking';
    const watched = new WeakSet();
    const sizeObserver = new ResizeObserver(entries => {
      for (const { target, contentRect } of entries) {
        if (!target.isConnected) continue;
        layout.sizes.push({
          time: performance.now(),
          width: Math.round(contentRect.width),
          height: Math.round(contentRect.height),
          visible: target.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
        });
      }
    });
    new MutationObserver(() => {
      const dialog = document.querySelector(selector);
      if (!dialog || watched.has(dialog)) return;
      watched.add(dialog);
      sizeObserver.observe(dialog);
    }).observe(document, { childList: true, subtree: true });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        layout.shifts.push({
          value: entry.value,
          time: entry.startTime,
          hadRecentInput: entry.hadRecentInput,
          sources: entry.sources.map(source => {
            const node = source.node?.nodeType === Node.TEXT_NODE ? source.node.parentElement : source.node;
            return {
              dialog: Boolean(node?.closest(selector)),
              node: node ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}` : null,
              text: node?.textContent.slice(0, 60),
              previous: source.previousRect.toJSON(),
              current: source.currentRect.toJSON(),
            };
          }),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
});

function sessionCls(shifts) {
  let cls = 0;
  let session = 0;
  let sessionStart = 0;
  let lastShift = 0;
  for (const shift of shifts) {
    if (shift.hadRecentInput) continue;
    if (shift.time - lastShift > 1000 || shift.time - sessionStart > 5000) {
      session = 0;
      sessionStart = shift.time;
    }
    session += shift.value;
    lastShift = shift.time;
    cls = Math.max(cls, session);
  }
  return cls;
}

function sizesWhileGrowingOpen(layout) {
  const settled = layout.sizes.at(-1);
  return layout.sizes.filter(size => size.visible &&
    size.width < settled.width - 1 && size.height < settled.height - 1);
}

async function settledDialogLayout(page, testInfo, name) {
  await page.waitForFunction(() => {
    const { sizes } = window.__bookingDialogLayout;
    return sizes.length > 0 && performance.now() - sizes.at(-1).time >= 1000;
  }, null, { polling: 100 });
  const layout = await page.evaluate(() => window.__bookingDialogLayout);
  layout.cls = sessionCls(layout.shifts);
  layout.dialogShifts = layout.shifts.filter(shift => shift.sources.some(source => source.dialog));
  const artifact = testInfo.outputPath(`${name}.json`);
  await fs.writeFile(artifact, JSON.stringify(layout, null, 2));
  await testInfo.attach(name, { path: artifact, contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  return layout;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("direct load of /booking does not grow the dialog open from nothing", async ({ page, flow }, testInfo) => {
      await page.goto("/booking");
      await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
      const layout = await settledDialogLayout(page, testInfo, "booking-load");
      expect(sizesWhileGrowingOpen(layout)).toEqual([]);
    });

    test("direct load of a pending payment does not grow the dialog open from nothing", async ({ page, flow }, testInfo) => {
      let finalizeRoute;
      await page.route("**/api/payment/finalize", route => {
        finalizeRoute = route;
      });
      await flow.review();
      await flow.payment();
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
      await page.goto("/payment?dodo_return=1", { waitUntil: "domcontentloaded" });
      await expect.poll(() => Boolean(finalizeRoute)).toBe(true);
      await expect(page.getByRole("heading", { level: 2, name: "Complete Payment", exact: true })).toBeVisible();
      const layout = await settledDialogLayout(page, testInfo, "payment-load");
      expect(sizesWhileGrowingOpen(layout)).toEqual([]);
      if (viewport.width === 390) expect(layout.dialogShifts).toEqual([]);
    });

    test("opening booking from the home page still animates the dialog open", async ({ page, flow }, testInfo) => {
      await page.goto("/");
      await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
      await page.locator('a[href="/booking"]').first().click();
      await expect(page).toHaveURL(/\/booking$/);
      await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
      const layout = await settledDialogLayout(page, testInfo, "click-open");
      expect(sizesWhileGrowingOpen(layout)).not.toEqual([]);
    });

    test("reopening booking after a direct load animates the dialog open again", async ({ page, flow }, testInfo) => {
      await page.goto("/booking");
      await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.evaluate(() => Object.assign(window.__bookingDialogLayout, { shifts: [], sizes: [] }));
      await page.locator('a[href="/booking"]').first().click();
      await expect(page).toHaveURL(/\/booking$/);
      await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
      const layout = await settledDialogLayout(page, testInfo, "reopen");
      expect(sizesWhileGrowingOpen(layout)).not.toEqual([]);
    });
  });
}
