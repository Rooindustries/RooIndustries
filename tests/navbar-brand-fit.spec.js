const { test, expect } = require("@playwright/test");
const { waitForHydrated } = require("./fixtures/react-hydration.cjs");

const WIDTHS = [320, 360, 390, 640, 700, 767, 768, 800, 820, 900, 1023, 1024, 1280, 1440];
const PAGES = ["/", "/benchmarks"];
const MIN_GAP = 4;
const BRAND_LINK = 'header [data-nav-row] a[href="/"]';

test.use({ javaScriptEnabled: true, reducedMotion: "reduce" });

async function openPage(page, path, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(path, { waitUntil: "networkidle" });
  await waitForHydrated(page, BRAND_LINK);
  await page.evaluate(() => document.fonts.ready);
}

async function measureTopBar(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const lineCount = (el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const tops = new Set();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width > 0) tops.add(Math.round(rect.top));
        }
      }
      return tops.size;
    };
    const row = document.querySelector("header [data-nav-row]");
    const brand = [...row.querySelectorAll("a div")]
      .filter((el) => el.textContent.trim() === "Roo Industries" && el.children.length === 0)
      .find(visible);
    if (!brand) return { brandMissing: true };
    const tagline = brand.parentElement.lastElementChild;
    const brandLink = brand.closest("a");
    const brandRect = brandLink.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const controls = [...row.querySelectorAll("a, button")]
      .filter((el) => !brandLink.contains(el) && visible(el) && !el.closest("[hidden]"))
      .map((el) => ({
        label: el.textContent.trim() || el.getAttribute("aria-label"),
        lines: el.textContent.trim() ? lineCount(el) : 1,
        rect: el.getBoundingClientRect(),
      }));
    const textRight = Math.max(brand.scrollWidth, tagline.scrollWidth) + brand.getBoundingClientRect().left;
    const ellipsis = getComputedStyle(tagline).textOverflow === "ellipsis";
    return {
      brandMissing: false,
      viewport: document.documentElement.clientWidth,
      pageScroll: document.documentElement.scrollWidth,
      brandClipped: brand.scrollWidth > brand.clientWidth,
      taglineClipped: ellipsis && tagline.scrollWidth > tagline.clientWidth,
      textRight: Math.round(textRight),
      nextControlLeft: Math.round(Math.min(
        ...controls.map((c) => c.rect.left).filter((left) => left >= brandRect.left),
      )),
      overlaps: controls
        .filter((c) => c.rect.left < brandRect.right - 0.5 && c.rect.right > brandRect.left + 0.5)
        .map((c) => c.label),
      row: { left: Math.round(rowRect.left), top: Math.round(rowRect.top), bottom: Math.round(rowRect.bottom) },
      controls: controls.map((c) => ({
        label: c.label,
        lines: c.lines,
        left: Math.round(c.rect.left),
        right: Math.round(c.rect.right),
        top: Math.round(c.rect.top),
        bottom: Math.round(c.rect.bottom),
      })),
    };
  });
}

for (const path of PAGES) {
  test(`top bar keeps the full brand name on ${path} from 320 to 1440 px`, async ({ page }) => {
    for (const width of WIDTHS) {
      await openPage(page, path, { width, height: 900 });
      const bar = await measureTopBar(page);
      const where = `${path} at ${width}px: ${JSON.stringify(bar)}`;
      expect.soft(bar.brandMissing, where).toBe(false);
      if (bar.brandMissing) continue;
      expect.soft(bar.brandClipped, where).toBe(false);
      expect.soft(bar.taglineClipped, where).toBe(false);
      expect.soft(bar.overlaps, where).toEqual([]);
      expect.soft(bar.textRight + MIN_GAP, where).toBeLessThanOrEqual(bar.nextControlLeft);
      expect.soft(bar.pageScroll, where).toBeLessThanOrEqual(bar.viewport);
      for (const control of bar.controls) {
        expect.soft(control.lines, where).toBe(1);
        expect.soft(control.left, where).toBeGreaterThanOrEqual(bar.row.left);
        expect.soft(control.right, where).toBeLessThanOrEqual(bar.viewport);
        expect.soft(control.top, where).toBeGreaterThanOrEqual(bar.row.top);
        expect.soft(control.bottom, where).toBeLessThanOrEqual(bar.row.bottom);
      }
    }
  });
}

test("below 1024 px the menu button opens the site menu and Escape closes it", async ({ page }) => {
  await openPage(page, "/", { width: 1023, height: 900 });
  const menuButton = page.getByRole("button", { name: "Open menu" });
  const menu = page.locator("#mobile-site-menu");
  await expect(page.locator('[data-nav-surface="desktop"][data-nav-target="benefits"]')).toBeHidden();
  await menuButton.click();
  await expect(menu).toHaveAttribute("aria-hidden", "false");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-hidden", "true");
  await expect(menuButton).toBeFocused();
});

test("from 1024 px the Proof and Referrals menus open in the bar and close on an outside click", async ({ page }) => {
  await openPage(page, "/", { width: 1024, height: 900 });
  await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
  for (const id of ["desktop-proof-menu", "desktop-referrals-menu"]) {
    const dropdown = page.locator(`#${id}`);
    await page.locator(`button[aria-controls="${id}"]`).click();
    await expect(dropdown).toBeVisible();
    await page.mouse.click(10, 600);
    await expect(dropdown).toBeHidden();
  }
});

for (const viewport of [{ width: 844, height: 390 }, { width: 667, height: 375 }]) {
  test(`site menu scrolls to its last link on a sideways phone at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await openPage(page, "/", viewport);
    await page.getByRole("button", { name: "Open menu" }).click();
    const menu = page.locator("#mobile-site-menu");
    await expect(menu).toHaveAttribute("aria-hidden", "false");
    const menuBox = await menu.boundingBox();
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height + 1);
    const lastLink = menu.locator("a").last();
    await page.mouse.move(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2);
    await expect.poll(async () => {
      await page.mouse.wheel(0, 400);
      const box = await lastLink.boundingBox();
      return box.y + box.height <= viewport.height;
    }).toBe(true);
  });
}
