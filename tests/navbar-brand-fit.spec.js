const { test, expect } = require("@playwright/test");

const WIDTHS = [320, 360, 390, 640, 700, 767, 768, 800, 820, 900, 1023, 1024, 1280, 1440];
const PAGES = ["/", "/benchmarks"];
const MIN_GAP = 4;

async function measureTopBar(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const header = document.querySelector("header");
    const row = [...header.querySelectorAll("div")].find((el) => el.className.includes("h-20"));
    const brand = [...header.querySelectorAll("a div")]
      .filter((el) => el.textContent.trim() === "Roo Industries" && el.children.length === 0)
      .find(visible);
    const tagline = brand.parentElement.lastElementChild;
    const taglineStyle = getComputedStyle(tagline);
    const brandLink = brand.closest("a");
    const rowRect = row.getBoundingClientRect();
    const controls = [...row.querySelectorAll("a, button")]
      .filter((el) => el !== brandLink && !brandLink.contains(el) && visible(el) && !el.closest("[hidden]"))
      .map((el) => ({ label: el.textContent.trim() || el.getAttribute("aria-label"), rect: el.getBoundingClientRect() }));
    const brandRect = brandLink.getBoundingClientRect();
    const box = (r) => ({ left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) });
    return {
      viewport: document.documentElement.clientWidth,
      pageScroll: document.documentElement.scrollWidth,
      brandClipped: brand.scrollWidth > brand.clientWidth,
      taglineClipped: taglineStyle.textOverflow === "ellipsis" && tagline.scrollWidth > tagline.clientWidth,
      textRight: Math.round(Math.max(brand.scrollWidth, tagline.scrollWidth) + brand.getBoundingClientRect().left),
      row: box(rowRect),
      controls: controls.map((c) => ({ label: c.label, ...box(c.rect), bottom: Math.round(c.rect.bottom) })),
      nextControlLeft: Math.round(Math.min(...controls.map((c) => c.rect.left).filter((left) => left >= brandRect.left))),
      overlaps: controls
        .filter((c) => c.rect.left < brandRect.right - 0.5 && c.rect.right > brandRect.left + 0.5)
        .map((c) => c.label),
      rowTop: Math.round(rowRect.top),
      rowBottom: Math.round(rowRect.bottom),
    };
  });
}

for (const path of PAGES) {
  test(`top bar keeps the full brand name on ${path} from 320 to 1440 px`, async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      const bar = await measureTopBar(page);
      const where = `${path} at ${width}px: ${JSON.stringify(bar)}`;
      expect.soft(bar.brandClipped, where).toBe(false);
      expect.soft(bar.taglineClipped, where).toBe(false);
      expect.soft(bar.overlaps, where).toEqual([]);
      expect.soft(bar.textRight + MIN_GAP, where).toBeLessThanOrEqual(bar.nextControlLeft);
      expect.soft(bar.pageScroll, where).toBeLessThanOrEqual(bar.viewport);
      for (const control of bar.controls) {
        expect.soft(control.left, where).toBeGreaterThanOrEqual(bar.row.left);
        expect.soft(control.right, where).toBeLessThanOrEqual(bar.viewport);
        expect.soft(control.top, where).toBeGreaterThanOrEqual(bar.rowTop);
        expect.soft(control.bottom, where).toBeLessThanOrEqual(bar.rowBottom);
      }
    }
  });
}
