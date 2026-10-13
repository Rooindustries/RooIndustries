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
    const layout = window.__bookingDialogLayout = { shifts: [], sizes: [], visibility: [], mountedAt: null };
    const selector = '[role="dialog"].ri-booking';
    let visible = false;
    const sampleVisibility = () => {
      const dialog = document.querySelector(selector);
      const nowVisible = Boolean(dialog?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
      if (nowVisible !== visible) {
        visible = nowVisible;
        layout.visibility.push({ time: performance.now(), visible });
      }
      if (layout.mountedAt === null && document.body?.style.overflow === "hidden") layout.mountedAt = performance.now();
      requestAnimationFrame(sampleVisibility);
    };
    requestAnimationFrame(sampleVisibility);
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

const readyMaxWaitMs = 1500;

function watchErrors(page) {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" || /hydrat|server html|getServerSnapshot|#418/i.test(message.text())) errors.push(message.text());
  });
  return errors;
}

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

function grewOpenFromNothing(layout) {
  const first = layout.sizes.find(size => size.width > 0 && size.height > 0);
  return Boolean(first) && layout.sizes.some(size =>
    size.width > first.width + 10 && size.height > first.height + 10);
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

const focusIsInDialog = page => page.evaluate(() =>
  Boolean(document.activeElement?.closest('[role="dialog"].ri-booking')));

async function dialogShownAfterMount(page) {
  await page.waitForFunction(() => {
    const { visibility, mountedAt } = window.__bookingDialogLayout;
    return mountedAt !== null && visibility.some(entry => entry.visible);
  }, null, { polling: 50 });
  const { visibility, mountedAt } = await page.evaluate(() => window.__bookingDialogLayout);
  const shownAt = visibility.find(entry => entry.visible)?.time;
  return { shownAt, mountedAt, afterMountMs: shownAt - mountedAt };
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    for (const delay of [0, 400]) {
      test(`direct load of /booking${delay ? " with slower availability" : ""} does not shift the page`, async ({ page, flow }, testInfo) => {
        const errors = watchErrors(page);
        if (delay) await page.route("**/api/bookingAvailability", async route => {
          await new Promise(resolve => setTimeout(resolve, delay));
          await route.fallback();
        });
        await page.goto("/booking");
        await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
        const layout = await settledDialogLayout(page, testInfo, "booking-load");
        expect(grewOpenFromNothing(layout)).toBe(false);
        expect(layout.dialogShifts).toEqual([]);
        expect(layout.cls).toBeLessThan(0.1);
        expect(await focusIsInDialog(page)).toBe(true);
        expect(errors).toEqual([]);
      });
    }

    for (const delay of [0, 400]) {
      test(`direct load of a pending payment${delay ? " with slower checkout requests" : ""} does not shift the page`, async ({ page, flow }, testInfo) => {
        const errors = watchErrors(page);
        let finalizeRoute;
        await page.route("**/api/payment/finalize", route => {
          finalizeRoute = route;
        });
        await flow.review();
        await flow.payment();
        await page.getByRole("button", { name: "Pay your way", exact: true }).click();
        await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
        if (delay) await page.route(/\/api\/payment\/(quote|providers)$/, async route => {
          await new Promise(resolve => setTimeout(resolve, delay));
          await route.fallback();
        });
        await page.goto("/payment?dodo_return=1", { waitUntil: "domcontentloaded" });
        await expect.poll(() => Boolean(finalizeRoute)).toBe(true);
        await expect(page.getByRole("heading", { level: 2, name: "Complete Payment", exact: true })).toBeVisible();
        await expect(page.getByText("Price confirmed for this session.", { exact: true })).toBeVisible();
        const layout = await settledDialogLayout(page, testInfo, "payment-load");
        expect(grewOpenFromNothing(layout)).toBe(false);
        expect(layout.dialogShifts).toEqual([]);
        expect(layout.cls).toBeLessThan(0.1);
        expect(await focusIsInDialog(page)).toBe(true);
        expect(errors).toEqual([]);
      });
    }

    for (const route of ["/payment-success", "/thank-you"]) {
      test(`direct load of ${route} does not shift the page`, async ({ page, flow }, testInfo) => {
        const errors = watchErrors(page);
        await page.goto(route);
        await expect(page.getByRole("heading", { level: 1, name: "Looking for your booking?", exact: true })).toBeVisible();
        const layout = await settledDialogLayout(page, testInfo, "confirmation-load");
        expect(layout.dialogShifts).toEqual([]);
        expect(layout.cls).toBeLessThan(0.1);
        expect(await focusIsInDialog(page)).toBe(true);
        expect(errors).toEqual([]);
      });
    }

    test("slow availability shows the booking dialog in its loading state", async ({ page, flow }, testInfo) => {
      const errors = watchErrors(page);
      await page.route("**/api/bookingAvailability", async route => {
        await new Promise(resolve => setTimeout(resolve, 3000));
        await route.fallback();
      });
      await page.goto("/booking");
      await expect(page.getByRole("dialog").getByText("Loading...", { exact: true })).toBeVisible();
      const shown = await dialogShownAfterMount(page);
      expect(shown.afterMountMs).toBeLessThanOrEqual(readyMaxWaitMs + 250);
      await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
      await settledDialogLayout(page, testInfo, "slow-availability");
      await testInfo.attach("dialog-shown", { body: JSON.stringify(shown), contentType: "application/json" });
      await page.goto("/");
      await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
      await page.locator('a[href="/booking"]').first().click();
      await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
      await settledDialogLayout(page, testInfo, "slow-availability-click-open");
      expect(errors).toEqual([]);
    });

    test("the booking dialog appears when availability never arrives", async ({ page, flow }, testInfo) => {
      const errors = watchErrors(page);
      flow.state.failures["/api/bookingAvailability"] = "timeout";
      await page.goto("/booking");
      await expect(page.getByRole("dialog").getByText("Loading...", { exact: true })).toBeVisible();
      const shown = await dialogShownAfterMount(page);
      expect(shown.afterMountMs).toBeLessThanOrEqual(readyMaxWaitMs + 250);
      expect(await focusIsInDialog(page)).toBe(true);
      await testInfo.attach("dialog-shown", { body: JSON.stringify(shown), contentType: "application/json" });
      expect(errors).toEqual([]);
    });

    test("the booking dialog stays hidden in a background tab until the tab is shown", async ({ page, flow }, testInfo) => {
      const errors = watchErrors(page);
      await page.addInitScript(() => {
        let visibility = "hidden";
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
        window.__showTab = () => {
          visibility = "visible";
          document.dispatchEvent(new Event("visibilitychange"));
          return performance.now();
        };
      });
      flow.state.failures["/api/bookingAvailability"] = "timeout";
      await page.goto("/booking");
      await page.waitForFunction(() => window.__bookingDialogLayout.mountedAt !== null);
      await page.waitForTimeout(2500);
      await expect(page.locator('[role="dialog"].ri-booking')).toHaveClass(/\binvisible\b/);
      const tabShownAt = await page.evaluate(() => window.__showTab());
      await page.waitForFunction(() => window.__bookingDialogLayout.visibility.some(entry => entry.visible), null, { polling: 50 });
      const dialogShownAt = await page.evaluate(() => window.__bookingDialogLayout.visibility.find(entry => entry.visible).time);
      expect(dialogShownAt).toBeGreaterThan(tabShownAt);
      expect(dialogShownAt - tabShownAt).toBeLessThanOrEqual(readyMaxWaitMs + 250);
      expect(await focusIsInDialog(page)).toBe(true);
      await testInfo.attach("dialog-shown", { body: JSON.stringify({ tabShownAt, dialogShownAt, afterTabShownMs: dialogShownAt - tabShownAt }), contentType: "application/json" });
      expect(errors).toEqual([]);
    });

    test("opening booking from the home page still animates the dialog open", async ({ page, flow }, testInfo) => {
      await page.goto("/");
      await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
      await page.locator('a[href="/booking"]').first().click();
      await expect(page).toHaveURL(/\/booking$/);
      await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
      const layout = await settledDialogLayout(page, testInfo, "click-open");
      expect(grewOpenFromNothing(layout)).toBe(true);
    });

    test("reopening booking after a direct load animates the dialog open again", async ({ page, flow }, testInfo) => {
      const errors = watchErrors(page);
      await page.goto("/booking");
      await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.evaluate(() => Object.assign(window.__bookingDialogLayout, { shifts: [], sizes: [] }));
      await page.locator('a[href="/booking"]').first().click();
      await expect(page).toHaveURL(/\/booking$/);
      await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
      const layout = await settledDialogLayout(page, testInfo, "reopen");
      expect(grewOpenFromNothing(layout)).toBe(true);
      expect(errors).toEqual([]);
    });

    test("focus stays in the dialog when booking continues to payment", async ({ page, flow }) => {
      const errors = watchErrors(page);
      await flow.review();
      await flow.payment();
      await expect.poll(() => focusIsInDialog(page)).toBe(true);
      expect(errors).toEqual([]);
    });

    test("clicking plain text in the dialog does not move focus to the close button", async ({ page, flow }) => {
      const errors = watchErrors(page);
      const focusedElement = () => page.evaluate(() =>
        document.activeElement === document.body ? "body" : document.activeElement?.id || document.activeElement?.tagName);
      await flow.reserve();
      const dialog = page.locator('[role="dialog"].ri-booking');
      await page.getByRole("textbox", { name: "Booking email", exact: true }).focus();
      expect(await focusIsInDialog(page)).toBe(true);
      await dialog.getByRole("heading", { name: "Schedule Your Session", exact: true }).click();
      expect(await focusedElement()).toBe("body");
      const sizeBeforeResize = await dialog.boundingBox();
      await page.setViewportSize({ width: viewport.width - 10, height: viewport.height - 40 });
      await expect.poll(async () => {
        const size = await dialog.boundingBox();
        return size.width !== sizeBeforeResize.width || size.height !== sizeBeforeResize.height;
      }).toBe(true);
      await page.waitForTimeout(2500);
      expect(await focusedElement()).toBe("body");
      expect(errors).toEqual([]);
    });
  });
}
