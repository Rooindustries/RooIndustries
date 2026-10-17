const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: true });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  test.describe(name, () => {
    test.use({ viewport });

    test("brand link is named by its visible text", async ({ page }, testInfo) => {
      const records = [];
      for (const route of ["/", "/reviews", "/tools", "/packages", "/faq", "/about", "/tourney"]) {
        await page.goto(route, { waitUntil: "networkidle" });
        const brand = page.locator('header a[href="/"]:visible').filter({
          has: page.locator('img[src="/favicon-96x96.png"]'),
        });
        const expected = route === "/tourney"
          ? "Roo Industries 6v6 Legacy Series"
          : "Roo Industries Precision Performance Engineering";
        await expect(brand, route).toHaveCount(1);
        records.push({ route, viewport, snapshot: await brand.ariaSnapshot() });
        await expect.soft(brand, route).toHaveAccessibleName(expected, { timeout: 1000 });
        await expect(brand, route).toHaveAttribute("href", "/");
        await expect(brand.locator("img").first(), route).toBeVisible();
        expect(await brand.locator("img").first().evaluate(image => image.complete && image.naturalWidth > 0), route).toBe(true);
        if (route === "/" || route === "/tourney") {
          await testInfo.attach(`brand-${route === "/" ? "home" : "tourney"}`, {
            body: await brand.screenshot(), contentType: "image/png",
          });
        }
      }
      await testInfo.attach("brand-names", { body: JSON.stringify(records, null, 2), contentType: "application/json" });
    });

    test("interactive aria-labels contain their visible text", async ({ page }, testInfo) => {
      const violations = [];
      for (const route of ["/", "/reviews", "/tools", "/packages", "/faq", "/about", "/tourney"]) {
        await page.goto(route, { waitUntil: "networkidle" });
        const flagged = await page.locator('a[aria-label], button[aria-label], [role="button"][aria-label], [role="link"][aria-label]').evaluateAll(elements => {
          const normalize = value => value.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N}]/gu, "");
          return elements.filter(element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).flatMap(element => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            const text = [];
            while (walker.nextNode()) {
              const node = walker.currentNode;
              if (!node.parentElement.closest(".sr-only, [hidden]") && node.parentElement.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
                text.push(node.textContent);
              }
            }
            const visibleText = text.join(" ").replace(/\s+/g, " ").trim();
            const label = element.getAttribute("aria-label");
            if (!/[\p{L}\p{N}]/u.test(visibleText) || normalize(label).includes(normalize(visibleText))) return [];
            return [{ label, visibleText, html: element.outerHTML }];
          });
        });
        violations.push(...flagged.map(element => ({ route, viewport, ...element })));
      }
      await testInfo.attach("label-mismatches", { body: JSON.stringify(violations, null, 2), contentType: "application/json" });
      expect(violations).toEqual([]);
    });

    test("package prices expose current and previous prices as text", async ({ page }, testInfo) => {
      await page.goto("/packages", { waitUntil: "networkidle" });
      const prices = page.locator(".ri-package-card .ri-price-current");
      await expect(prices).toHaveCount(2);

      for (const [index, text] of [
        [0, "Price $84.99"],
        [1, "Price $99.95, previous price $149.95"],
      ]) {
        const price = prices.nth(index).locator("..");
        await expect(price).not.toHaveAttribute("aria-label");
        await expect(price).toMatchAriaSnapshot(`- text: ${text}`);
        await expect(price.locator(".ri-price-current")).toHaveAttribute("aria-hidden", "true");
      }

      await page.screenshot({ path: testInfo.outputPath("package-prices.png"), fullPage: true });
    });

    test("the reviews region is reachable by keyboard", async ({ page }, testInfo) => {
      await page.goto("/", { waitUntil: "networkidle" });
      const reviews = page.getByRole("region", { name: "Player reviews", exact: true });
      await expect(reviews).toHaveAttribute("tabindex", "0");
      await reviews.scrollIntoViewIfNeeded();
      await reviews.focus();
      await expect(reviews).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(reviews).not.toBeFocused();
      await page.keyboard.press("Tab");
      await expect(reviews).toBeFocused();

      await reviews.screenshot({ path: testInfo.outputPath("keyboard-reviews.png") });
    });

    test("the reviews region stops auto-scrolling while focused", async ({ page }) => {
      await page.goto("/", { waitUntil: "networkidle" });
      const reviews = page.getByRole("region", { name: "Player reviews", exact: true });
      await reviews.scrollIntoViewIfNeeded();
      const position = () => reviews.evaluate((element) => element.scrollLeft);
      await expect.poll(async () => {
        const start = await position();
        await page.waitForTimeout(600);
        return (await position()) - start;
      }, { timeout: 15000 }).toBeGreaterThan(0);

      await reviews.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(reviews).toBeFocused();
      await page.waitForTimeout(200);
      const focusedStart = await position();
      await page.waitForTimeout(3000);
      expect(Math.abs((await position()) - focusedStart)).toBeLessThanOrEqual(1);
    });

    test("footer navigation has a distinct landmark name", async ({ page }, testInfo) => {
      await page.goto("/packages", { waitUntil: "networkidle" });
      const footer = page.locator("footer").last();
      const navigation = footer.getByRole("navigation", { name: "Footer", exact: true });
      await expect(navigation).toBeVisible();
      await expect(navigation.getByRole("link", { name: "Packages", exact: true })).toHaveAttribute("href", "/packages");
      await expect(page.getByRole("navigation", { name: "Footer", exact: true })).toHaveCount(1);

      await footer.screenshot({ path: testInfo.outputPath("footer-landmark.png") });
    });

    test("referral action text meets contrast in Roo Blue", async ({ page }, testInfo) => {
      await page.addInitScript(() => localStorage.setItem("roo-theme", "default"));
      await page.goto("/referrals/login", { waitUntil: "networkidle" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "default");

      for (const name of ["Login", "Create an account"]) {
        const button = page.getByRole("button", { name, exact: true });
        await page.mouse.move(0, 0);
        await expect(button).toHaveCSS("background-color", "rgb(2, 132, 199)");
        await expect(button).toHaveCSS("color", "rgb(0, 0, 0)");

        for (const hovered of [false, true]) {
          if (hovered) {
            await button.hover();
            await expect(button).toHaveCSS("background-color", "rgb(34, 211, 238)");
          }
          const contrast = await button.evaluate((element) => {
            const luminance = (color) => {
              const channels = color.match(/[\d.]+/g).slice(0, 3).map((value) => {
                const channel = Number(value) / 255;
                return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
              });
              return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
            };
            const style = getComputedStyle(element);
            const foreground = luminance(style.color);
            const background = luminance(style.backgroundColor);
            return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
          });
          expect(contrast).toBeGreaterThanOrEqual(4.5);
        }
      }

      await page.screenshot({ path: testInfo.outputPath("referral-button-contrast.png"), fullPage: true });
    });
  });
}
