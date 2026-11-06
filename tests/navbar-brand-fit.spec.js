const { test, expect } = require("@playwright/test");
const { waitForHydrated } = require("./fixtures/react-hydration.cjs");
const { navLink } = require("./fixtures/nav-link.cjs");

const WIDTHS = [320, 340, 360, 375, 390, 640, 700, 767, 768, 800, 820, 900, 1023, 1024, 1100, 1180, 1279, 1280, 1440];
const TABLET_WIDTHS = [768, 820, 900, 1023];
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
      rightOfBrand: controls.filter((c) => c.rect.left >= brandRect.left).length,
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
      expect.soft(bar.rightOfBrand, where).toBeGreaterThan(0);
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

for (const width of TABLET_WIDTHS) {
  test(`at ${width} px the bar keeps the back button, the brand and the menu button`, async ({ page }) => {
    await openPage(page, "/benchmarks", { width, height: 900 });
    const row = page.locator("header [data-nav-row]");
    await expect(row.getByRole("button", { name: "Go Back" })).toBeVisible();
    await expect(row.getByText("Roo Industries", { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(row.getByRole("button", { name: "Open menu" })).toBeVisible();
    await expect(row.locator(navLink("plans"))).toBeVisible();
    await expect(row.locator('[role="switch"]')).toBeVisible();
    await expect(page.locator('[data-nav-surface="desktop"][data-nav-target="benefits"]')).toBeHidden();
  });
}

for (const width of [390, 900]) {
  test(`with the menu open at ${width} px there is exactly one theme switch on screen`, async ({ page }) => {
    await openPage(page, "/", { width, height: 900 });
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.locator("#mobile-site-menu")).toHaveAttribute("aria-hidden", "false");
    await expect(page.locator('header [role="switch"]').filter({ visible: true })).toHaveCount(1);
  });
}

test("below 1024 px the menu button opens the site menu and Escape closes it", async ({ page }) => {
  await openPage(page, "/", { width: 1023, height: 900 });
  const menuButton = page.getByRole("button", { name: "Open menu" });
  const menu = page.locator("#mobile-site-menu");
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

test("a menu left open across the 1024 px line closes instead of staying open with no way out", async ({ page }) => {
  await openPage(page, "/", { width: 900, height: 900 });
  const menu = page.locator("#mobile-site-menu");
  const desktopProof = page.locator("#desktop-proof-menu");
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(menu).toHaveAttribute("aria-hidden", "false");
  await page.locator('button[aria-controls="mobile-proof-menu"]').click();
  await expect(page.locator("#mobile-proof-menu")).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(desktopProof).toBeHidden();
  await page.locator('button[aria-controls="desktop-proof-menu"]').click();
  await expect(desktopProof).toBeVisible();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(menu).toHaveAttribute("aria-hidden", "true");
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(desktopProof).toBeHidden();
});

async function waitForHeaderToSettle(page) {
  await expect.poll(() => page.evaluate(() => document.querySelector("header").getAnimations({ subtree: true }).length))
    .toBe(0);
}

async function expectMenuFitsScreen(page, viewport) {
  await waitForHeaderToSettle(page);
  const menu = page.locator("#mobile-site-menu");
  const menuBox = await menu.boundingBox();
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height + 1);
  const lastLink = menu.locator("a").last();
  await page.mouse.move(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2);
  await expect.poll(async () => {
    await page.mouse.wheel(0, 400);
    const box = await lastLink.boundingBox();
    return box.y + box.height <= viewport.height;
  }).toBe(true);
}

for (const viewport of [{ width: 844, height: 390 }, { width: 667, height: 375 }]) {
  test(`site menu scrolls to its last link on a sideways phone at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await openPage(page, "/", viewport);
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.locator("#mobile-site-menu")).toHaveAttribute("aria-hidden", "false");
    await expectMenuFitsScreen(page, viewport);
  });
}

test("site menu refits when the Discord banner slides back in on a sideways phone", async ({ page }) => {
  const viewport = { width: 844, height: 390 };
  const banner = page.locator(".ri-discord-guide-banner");
  await openPage(page, "/", viewport);
  await page.evaluate(() => window.scrollTo(0, 600));
  await expect(banner).toHaveAttribute("aria-hidden", "true");
  await waitForHeaderToSettle(page);
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.locator("#mobile-site-menu")).toHaveAttribute("aria-hidden", "false");
  await waitForHeaderToSettle(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(banner).not.toHaveAttribute("aria-hidden", "true");
  await expect(banner).toBeVisible();
  await expectMenuFitsScreen(page, viewport);
});
