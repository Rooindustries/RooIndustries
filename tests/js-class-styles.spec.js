const { test, expect } = require("@playwright/test");

const viewports = [
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
      ctaNotes: [...document.querySelectorAll("#top .ri-hero-cta-note p:not([aria-hidden=true])")].map(wrapStyle),
    };
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
  expect.soft(styles.ctaNotes.length).toBeGreaterThan(0);
  for (const line of [...styles.headingLines, ...styles.ctaNotes]) {
    expect.soft(line).toEqual({ whiteSpace: "normal", textWrapStyle: "balance", fits: true });
  }
}

test.describe("Home styles without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  for (const viewport of viewports) {
    test(`deferred sections show in full and hero text wraps at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/", { waitUntil: "load" });
      expectNoScriptStyles(await readHomeStyles(page));
    });

    test(`no-JS styles hold where the scripting media feature is unsupported at ${viewport.width}px`, async ({ page }) => {
      let rewrittenSheets = 0;
      await page.route(/\.css(?:\?|$)/, async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace(/\(\s*scripting\s*:/g, "(-roo-unsupported-scripting:");
        rewrittenSheets += 1;
        await route.fulfill({ response, body });
      });
      await page.setViewportSize(viewport);
      await page.goto("/", { waitUntil: "load" });
      expect(rewrittenSheets).toBeGreaterThan(0);
      expectNoScriptStyles(await readHomeStyles(page));
    });
  }
});

test.describe("Home styles with JavaScript", () => {
  test.use({ javaScriptEnabled: true });

  for (const viewport of viewports) {
    test(`deferred sections defer and hero text stays on one line at ${viewport.width}px`, async ({ page }) => {
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
      expect(styles.ctaNotes.length).toBeGreaterThan(0);
      for (const line of [...styles.headingLines, ...styles.ctaNotes]) {
        expect(line.whiteSpace).toBe("nowrap");
        expect(line.fits).toBe(true);
      }
    });
  }
});
