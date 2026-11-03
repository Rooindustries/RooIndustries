const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce", actionTimeout: 10000, navigationTimeout: 30000, trace: "off", video: "off" });

const dialogSelector = '[role="dialog"].ri-booking';
const fields = [
  ["discord", "Discord username"],
  ["email", "Booking email"],
  ["specs", "PC specifications"],
  ["mainGame", "Main game or application"],
  ["notes", "Extra booking requirements (optional)"],
];
const allDaySlots = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
const withAllDaySlots = (flow, open) => {
  flow.state.slots[0].times = allDaySlots;
  return open();
};
const steps = [
  ["slot", "Next", flow => withAllDaySlots(flow, flow.booking)],
  ["details", "Review before payment", flow => withAllDaySlots(flow, flow.reserve)],
  ["review", "Continue to payment", flow => withAllDaySlots(flow, flow.review)],
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__dialogShifts = [];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__dialogShifts.push({ value: entry.value, time: entry.startTime, hadRecentInput: entry.hadRecentInput });
    }).observe({ type: "layout-shift", buffered: true });
  });
});

async function save(page, testInfo, name, value) {
  const artifact = testInfo.outputPath(`${name}.json`);
  await fs.writeFile(artifact, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path: artifact, contentType: "application/json" });
  await testInfo.attach(`${name}-screen`, { body: await page.screenshot(), contentType: "image/png" });
}

async function ready(page) {
  await expect(page.locator(dialogSelector).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
}

async function measure(page, primaryName) {
  return page.locator(dialogSelector).first().evaluate((dialog, primaryName) => {
    const box = node => {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    };
    const scrollers = [dialog, ...dialog.querySelectorAll("*")]
      .filter(node => /(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1)
      .map(node => ({ className: String(node.className).slice(0, 80), clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }));
    const stage = dialog.closest(".booking-dialog-stage") || document.scrollingElement;
    const primary = primaryName
      ? [...dialog.querySelectorAll("button")].find(node => node.textContent.trim() === primaryName && node.checkVisibility())
      : null;
    const transform = new DOMMatrixReadOnly(getComputedStyle(dialog.querySelector("[data-booking-scaler]")).transform);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      frame: box(dialog),
      scale: transform.a,
      scrollers,
      stage: { clientHeight: stage.clientHeight, scrollHeight: stage.scrollHeight },
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      primary: primary ? box(primary) : null,
    };
  }, primaryName);
}

function expectFits(metrics, label) {
  expect.soft(metrics.scrollers, `${label} inner scroll`).toEqual([]);
  expect.soft(metrics.stage.scrollHeight, `${label} page scroll`).toBeLessThanOrEqual(metrics.stage.clientHeight + 1);
  expect.soft(metrics.frame.top, `${label} frame top`).toBeGreaterThanOrEqual(0);
  expect.soft(metrics.frame.bottom, `${label} frame bottom`).toBeLessThanOrEqual(metrics.viewport.height);
  expect.soft(metrics.frame.left, `${label} frame left`).toBeGreaterThanOrEqual(0);
  expect.soft(metrics.frame.right, `${label} frame right`).toBeLessThanOrEqual(metrics.viewport.width);
  expect.soft(metrics.primary, `${label} primary action`).not.toBeNull();
  if (!metrics.primary) return;
  expect.soft(metrics.primary.top, `${label} primary top`).toBeGreaterThanOrEqual(0);
  expect.soft(metrics.primary.bottom, `${label} primary bottom`).toBeLessThanOrEqual(metrics.viewport.height);
}

function sessionCls(shifts) {
  let cls = 0, session = 0, start = 0, last = 0;
  for (const shift of shifts.filter(shift => !shift.hadRecentInput)) {
    if (shift.time - last > 1000 || shift.time - start > 5000) { session = 0; start = shift.time; }
    session += shift.value;
    cls = Math.max(cls, session);
    last = shift.time;
  }
  return cls;
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    for (const [name, primary, open] of steps) {
      test(`the ${name} step fits the screen without scrolling`, async ({ page, flow }, testInfo) => {
        await open(flow);
        await ready(page);
        const metrics = await measure(page, primary);
        await save(page, testInfo, `${name}-fit`, metrics);
        expectFits(metrics, name);
        expect.soft(metrics.scale).toBeGreaterThan(0.5);
        expect.soft(metrics.scale).toBeLessThanOrEqual(1.2);
      });
    }

    test("the details step refits when an error appears and when the window resizes", async ({ page, flow }, testInfo) => {
      await flow.reserve();
      await ready(page);
      const before = await measure(page, "Review before payment");
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      await expect(page.locator("#booking-details-error")).toBeVisible();
      await page.waitForTimeout(450);
      const withError = await measure(page, "Review before payment");
      await page.setViewportSize({ width: viewport.width, height: viewport.height - 120 });
      await page.waitForTimeout(450);
      const resized = await measure(page, "Review before payment");
      await save(page, testInfo, "details-refit", { before, withError, resized });
      expectFits(withError, "with error");
      expectFits(resized, "resized");
      expect.soft(withError.scale).toBeLessThanOrEqual(before.scale);
      expect.soft(resized.scale).toBeLessThan(withError.scale);
    });
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true });

    for (const [name, primary, open] of steps) {
      test(`the ${name} step is scaled to fit the phone width`, async ({ page, flow }, testInfo) => {
        await open(flow);
        await ready(page);
        const metrics = await measure(page, primary);
        await save(page, testInfo, `${name}-phone`, metrics);
        expect.soft(metrics.scale).toBeCloseTo(viewport.width / 550, 2);
        expect.soft(metrics.frame.width).toBeCloseTo(viewport.width, 0);
        expect.soft(metrics.horizontalOverflow).toBe(0);
        expect.soft(metrics.scrollers).toEqual([]);
        expect.soft(metrics.primary).not.toBeNull();
      });
    }

    test("a missing detail keeps the focused field and its error on screen", async ({ page, flow }, testInfo) => {
      await flow.reserve();
      await ready(page);
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      const discord = page.getByRole("textbox", { name: "Discord username", exact: true });
      await expect(discord).toBeFocused();
      await page.waitForTimeout(300);
      const placement = await discord.evaluate(node => {
        const rects = [node, document.getElementById("booking-details-error")].map(element => element.getBoundingClientRect());
        return { rects: rects.map(rect => ({ top: rect.top, bottom: rect.bottom })), height: innerHeight };
      });
      await save(page, testInfo, "missing-detail-focus", placement);
      for (const rect of placement.rects) {
        expect.soft(rect.top).toBeGreaterThanOrEqual(0);
        expect.soft(rect.bottom).toBeLessThanOrEqual(placement.height);
      }
    });
  });
}

test.describe("details labels and reservation", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("details fields keep their accessible names with visually hidden labels", async ({ page, flow }, testInfo) => {
    await flow.reserve();
    await ready(page);
    const labels = [];
    for (const [name, text] of fields) {
      const input = page.locator(`#booking-${name}`);
      const label = page.locator(`label[for="booking-${name}"]`);
      const box = await label.boundingBox();
      labels.push({ name, expected: text, box });
      await expect.soft(input).toHaveAccessibleName(text);
      await expect.soft(input).not.toHaveAttribute("aria-label");
      expect.soft(box.width * box.height, `${name} label is visually hidden`).toBeLessThanOrEqual(1);
      await expect.soft(page.getByRole("textbox", { name: text, exact: true })).toHaveCount(1);
    }
    await save(page, testInfo, "hidden-accessible-labels", labels);
  });

  test("clearing a settled hold preserves checkout geometry until the route changes", async ({ page, flow }, testInfo) => {
    await flow.review();
    await flow.payment();
    await ready(page);
    const heading = page.getByRole("heading", { name: "Complete Payment", exact: true });
    const before = await heading.boundingBox();
    await page.waitForTimeout(700);
    await expect(page.locator(dialogSelector).getByRole("button", { name: "Release", exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.__dialogShifts = [];
      window.dispatchEvent(new CustomEvent("hold-state", { detail: null }));
    });
    await page.waitForTimeout(200);
    const after = await heading.boundingBox();
    const shifts = await page.evaluate(() => window.__dialogShifts);
    await save(page, testInfo, "settled-hold-layout", { before, after, cls: sessionCls(shifts), shifts });
    await expect(page).toHaveURL(/\/payment$/);
    await expect(page.locator(dialogSelector).getByRole("button", { name: "Release", exact: true })).toHaveCount(0);
    expect.soft(after).toEqual(before);
    expect.soft(sessionCls(shifts)).toBeLessThanOrEqual(0.000001);
  });

  test("closing a reopened reservation restores focus to the replacement Continue button", async ({ page, flow }, testInfo) => {
    await flow.reserve();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const resume = page.getByRole("button", { name: "Continue booking", exact: true });
    await expect(resume).toBeVisible();
    await resume.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(resume).toBeVisible();
    await save(page, testInfo, "reservation-return-focus", await page.evaluate(() => ({ tag: document.activeElement.tagName, text: document.activeElement.textContent.slice(0, 200) })));
    await expect(resume).toBeFocused();
  });

  test("the close button keeps a 44 pixel target on the unscaled dialog", async ({ page, flow }) => {
    await flow.booking();
    await ready(page);
    const close = await page.locator(dialogSelector).evaluate(dialog => {
      const button = dialog.querySelector("#booking-modal-close");
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height, inScaler: Boolean(button.closest("[data-booking-scaler]")) };
    });
    expect(close).toEqual({ width: 44, height: 44, inScaler: false });
  });
});
