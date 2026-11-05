const { test, expect } = require("@playwright/test");

const viewports = [
  { width: 320, height: 700 },
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

async function readHomeStyles(page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return page.evaluate(() => {
    const root = document.documentElement;
    const deferred = [...document.querySelectorAll(".deferred-section-content")]
      .filter(element => !element.closest("#how-it-works") && !element.style.contentVisibility)
      .map(element => {
        return {
          contentVisibility: getComputedStyle(element).contentVisibility,
          rendered: [...element.children].some(child => child.checkVisibility({ contentVisibilityAuto: true })),
        };
      });
    const fits = element => element.scrollWidth <= element.clientWidth + 1 &&
      element.getBoundingClientRect().right <= root.clientWidth + 1;
    const wrapStyle = element => {
      const style = getComputedStyle(element);
      return { whiteSpace: style.whiteSpace, textWrapStyle: style.textWrapStyle, fits: fits(element) };
    };
    return {
      jsClass: root.classList.contains("js"),
      lowPerformance: root.classList.contains("low-performance-mode") ||
        root.classList.contains("perf-reduced-motion-mode"),
      scrollBehavior: getComputedStyle(root).scrollBehavior,
      deferred,
      headingLines: [...document.querySelectorAll("#top .ri-hero-heading-line")].map(wrapStyle),
      promises: [...document.querySelectorAll("#top .ri-hero-cta-note li")].map(element => ({
        fontSize: parseFloat(getComputedStyle(element).fontSize),
        fits: fits(element),
      })),
    };
  });
}

function expectReadablePromises(promises, check = expect) {
  check(promises.length).toBeGreaterThan(0);
  for (const promise of promises) {
    check(promise.fits).toBe(true);
    check(promise.fontSize).toBeGreaterThanOrEqual(14);
  }
}

function readDeferredHeights(page) {
  return page.evaluate(async () => {
    const sections = [...document.querySelectorAll(".deferred-section-content")];
    const reservedHeight = element => parseFloat(getComputedStyle(element).containIntrinsicHeight.replace("auto", ""));
    const reserved = sections.map(reservedHeight);
    sections.forEach(element => { element.style.contentVisibility = "visible"; });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return sections.map((element, index) => ({
      name: element.closest("section[id]")?.id || `section ${index + 1}`,
      reserved: reserved[index],
      real: element.offsetHeight,
    }));
  });
}

function expectNoScriptStyles(styles) {
  expect.soft(styles.jsClass).toBe(false);
  expect.soft(styles.scrollBehavior).toBe("auto");
  expect.soft(styles.deferred.length).toBeGreaterThan(0);
  for (const section of styles.deferred) {
    expect.soft(section).toEqual({ contentVisibility: "visible", rendered: true });
  }
  expect.soft(styles.headingLines.length).toBeGreaterThan(0);
  for (const line of styles.headingLines) {
    expect.soft(line).toEqual({ whiteSpace: "normal", textWrapStyle: "balance", fits: true });
  }
  expectReadablePromises(styles.promises, expect.soft);
}

test.describe("Home styles without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  for (const viewport of viewports) {
    test(`deferred sections show in full and hero text wraps at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/", { waitUntil: "load" });
      expectNoScriptStyles(await readHomeStyles(page));
    });
  }
});

test.describe("Home styles with JavaScript", () => {
  test.use({ javaScriptEnabled: true });

  for (const width of [320, 390, 768, 1024, 1440]) {
    test(`deferred sections reserve close to their real height at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/", { waitUntil: "networkidle" });
      const sections = await readDeferredHeights(page);
      expect(sections.length).toBeGreaterThan(0);
      for (const { name, reserved, real } of sections) {
        const message = `${name}: reserves ${reserved}px for ${real}px`;
        expect(Math.abs(reserved - real), message).toBeLessThanOrEqual(real * 0.2);
      }
    });
  }

  for (const viewport of viewports) {
    test(`deferred sections defer, the hero heading stays on one line and the promises stay readable at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page.locator("html.js")).toHaveCount(1);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const styles = await readHomeStyles(page);
      expect(styles.scrollBehavior).toBe(styles.lowPerformance ? "auto" : "smooth");
      expect(styles.deferred.length).toBeGreaterThan(0);
      for (const section of styles.deferred) {
        expect(section.contentVisibility).toBe("auto");
      }
      expect(styles.deferred.some(section => !section.rendered)).toBe(true);
      expect(styles.headingLines.length).toBeGreaterThan(0);
      for (const line of styles.headingLines) {
        expect(line.whiteSpace).toBe("nowrap");
        expect(line.fits).toBe(true);
      }
      expectReadablePromises(styles.promises);
    });
  }
});
