const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: true });

const routes = [
  "/",
  "/packages",
  "/reviews",
  "/tools",
  "/faq",
  "/benchmarks",
  "/booking",
  "/payment",
  "/upgrade-xoc",
  "/downloads/optimizer-pack-v1",
  "/tourney",
  "/tourney/bracket",
  "/tourney/roster",
  "/tourney/register",
  "/tourney/login",
  "/tourney/forgot",
  "/tourney/reset",
  "/tourney/manage",
  "/referrals/login",
  "/referrals/register",
  "/referrals/forgot",
  "/referrals/reset",
];

const paymentSmokeData = encodeURIComponent(
  JSON.stringify({
    packageTitle: "Performance Vertex Overhaul",
    packagePrice: "$84.99",
    startTimeUTC: "2099-01-05T04:30:00.000Z",
    displayDate: "Monday, January 5, 2099",
    displayTime: "10:00 AM",
    localTimeZone: "Asia/Kolkata",
    slotHoldId: "hold_smoke_test",
    slotHoldToken: "hold_token_smoke_test",
    slotHoldExpiresAt: "2099-01-05T05:30:00.000Z",
  })
);

const waitForPerformanceProfile = async (page) => {
  await page.waitForFunction(
    () => document.documentElement.classList.contains("low-performance-mode"),
    { timeout: 10000 }
  );
};

test.describe("Route smoke", () => {
  for (const route of routes) {
    test(`loads ${route}`, async ({ page }) => {
      const consoleErrors = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          consoleErrors.push(msg.text());
        }
      });

      const routeUrl =
        route === "/payment" ? `/payment?data=${paymentSmokeData}` : route;
      const response = await page.goto(routeUrl, {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status()).toBeLessThan(400);

      await expect(page.locator("main")).toBeVisible();
      const title = await page.title();
      expect(title.length).toBeGreaterThan(8);

      if (route === "/packages" || route === "/upgrade-xoc") {
        await expect(page.locator("h1")).toHaveCount(1);
      }

      if (route === "/") {
        await expect(
          page.getByRole("heading", {
            name: "Overwatch Creator Tournament signups are open.",
          })
        ).toBeVisible();
        await expect(
          page.getByText(
            "We're running the Overwatch 6v6 Legacy Series on August 15-16."
          )
        ).toBeVisible();
        await expect(page.getByText("approved creators")).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Go to the tournament page" })
        ).toHaveAttribute("href", "/tourney");
      }

      if (route === "/booking") {
        await expect(
          page.getByText("Select a Date and Time for Your Session")
        ).toBeVisible();
      }

      if (route === "/payment") {
        await expect(
          page.getByRole("heading", { name: /complete payment/i })
        ).toBeVisible();
      }

      if (route === "/tourney") {
        await expect(
          page.getByRole("heading", { name: /6v6 Legacy Series/i })
        ).toBeVisible();
        await expect(
          page.getByText("Overwatch Creator Tournament", { exact: true })
        ).toBeVisible();
        await expect(page.getByText("Tournament access locked")).toHaveCount(0);
        await expect(
          page.getByRole("heading", { name: "Important Dates" })
        ).toBeVisible();
        await expect(page.getByText("Match windows")).toBeVisible();
        await expect(page.getByRole("heading", { name: "Bracket" })).toBeVisible();
        await expect(page.getByText("Bracket access", { exact: true })).toBeVisible();
        await expect(page.getByText("$2,000 USD for 1st and 2nd place")).toBeVisible();
        await expect(
          page
            .getByText("100% of Roo Industries website revenue from August 1-16, 2026")
            .first()
        ).toBeVisible();
        await expect(
          page.getByText("3 Logitech G PRO X2 SUPERSTRIKE wireless gaming mice")
        ).toBeVisible();
        await expect(page.getByText("32 GB of RAM")).toBeVisible();
        await expect(
          page.getByText("July 25, 2026", { exact: true })
        ).toBeVisible();
        await expect(
          page.getByText("By August 30, 2026")
        ).toBeVisible();
        await expect(page.getByText("By October 31, 2026")).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Giveaway Details" })
        ).toBeVisible();
        await expect(
          page.getByText("A qualifying Roo Industries purchase is required")
        ).toBeVisible();
        await expect(
          page.getByRole("img", { name: "GAWS - Geelong Animal Welfare Society" })
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Sign in", exact: true })
        ).toBeVisible();
        await expect(
          page
            .locator(".tourney-hero")
            .getByRole("link", { name: "Register", exact: true })
        ).toBeVisible();
        await expect(page.getByRole("switch")).toBeVisible();
      }

      if (route === "/tourney/login") {
        await expect(page.getByRole("heading", { name: "Sign in." })).toBeVisible();
        await expect(
          page.getByLabel("Discord username or email")
        ).toBeVisible();
        await expect(page.getByLabel("Password")).toBeVisible();
        await expect(page.getByLabel("Remember me")).toBeVisible();
        await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      }

      if (route === "/tourney/register") {
        await expect(
          page.getByRole("heading", { name: "Creator Registration" })
        ).toBeVisible();
        await expect(
          page.getByText("This Overwatch tournament is for creators")
        ).toBeVisible();
        await expect(page.getByLabel("Discord Username")).toBeVisible();
        await expect(page.getByLabel("Display Name")).toBeVisible();
        await expect(page.getByLabel("Timezone")).toBeVisible();
        await expect(page.getByLabel("Extra notes")).toBeVisible();
        await expect(
          page.getByRole("textbox", { name: "Twitch Username" })
        ).toBeVisible();
        await expect(
          page.getByLabel(
            "I understand this is a creator tournament and my Twitch username will be used for eligibility review."
          )
        ).toBeVisible();
        await expect(page.getByText("twitch.tv/")).toBeVisible();
        await expect(page.getByLabel("Username", { exact: true })).toHaveCount(0);
        await page.getByLabel("Primary Role").selectOption("Support");
        await expect(
          page.getByRole("dialog", { name: "Support signups are crowded" })
        ).toBeVisible();
        await page.getByRole("button", { name: "Change role" }).click();
        await expect(page.getByLabel("Primary Role")).toHaveValue("");
      }

      if (route === "/booking" || route === "/payment") {
        await page.waitForTimeout(750);
        expect(
          consoleErrors.filter((entry) =>
            /hydration|getServerSnapshot|react error #418/i.test(entry)
          )
        ).toEqual([]);
      }
    });
  }

  test("unknown route renders not found", async ({ page }) => {
    const response = await page.goto("/definitely-not-a-real-route", {
      waitUntil: "domcontentloaded",
    });

    expect(response?.status()).toBe(404);
    await expect(page.locator("body")).toContainText(/not found|404/i);
  });

  test("tourney mobile navbar uses dropdown", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const response = await page.goto("/tourney", {
      waitUntil: "domcontentloaded",
    });

    expect(response?.status()).toBeLessThan(400);
    await waitForPerformanceProfile(page);

    const nav = page.locator(".tourney-nav");
    await expect(nav.locator(".tourney-brand-copy")).toBeHidden();
    await expect(nav.locator(".tourney-links")).toBeHidden();
    await expect(nav.locator(".tourney-mobile-menu")).toBeVisible();
    await expect(nav.getByRole("switch")).toBeVisible();
    await expect(
      nav.getByRole("link", { name: "Sign in", exact: true })
    ).toBeVisible();
    await expect(nav.locator(".tourney-mobile-panel")).toBeHidden();

    const signInBox = await nav
      .getByRole("link", { name: "Sign in", exact: true })
      .boundingBox();
    const triggerBox = await nav.locator(".tourney-mobile-trigger").boundingBox();
    expect(signInBox?.x ?? 0).toBeLessThan(triggerBox?.x ?? 0);

    await nav.locator(".tourney-mobile-trigger").click();
    await expect(
      nav
        .locator(".tourney-mobile-panel")
        .getByRole("link", { name: "Register", exact: true })
    ).toHaveCount(0);
    await expect(
      nav
        .locator(".tourney-mobile-panel")
        .getByRole("link", { name: "Event Information" })
    ).toBeVisible();
    await expect(
      page
        .locator(".tourney-hero")
        .getByRole("link", { name: "Register", exact: true })
    ).toBeVisible();

    const navBox = await nav.boundingBox();
    const panelBox = await nav.locator(".tourney-mobile-panel").boundingBox();
    const navBottom = (navBox?.y ?? 0) + (navBox?.height ?? 0);
    expect(panelBox?.x ?? -1).toBeLessThanOrEqual(1);
    expect(panelBox?.width ?? 0).toBeGreaterThanOrEqual(390);
    expect(panelBox?.y ?? 0).toBeLessThanOrEqual(navBottom + 1);
    expect(panelBox?.y ?? 0).toBeGreaterThanOrEqual(navBottom - 6);

    const backdropFilter = await nav
      .locator(".tourney-mobile-panel")
      .evaluate(
        (element) =>
          getComputedStyle(element).backdropFilter ||
          getComputedStyle(element).webkitBackdropFilter
      );
    expect(String(backdropFilter).toLowerCase()).toBe("none");
  });

  test("home mobile navbar tagline fits narrow phones", async ({ page }) => {
    for (const width of [320, 340, 360, 375, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const response = await page.goto("/", {
        waitUntil: "domcontentloaded",
      });

      expect(response?.status()).toBeLessThan(400);
      await waitForPerformanceProfile(page);

      const metrics = await page.evaluate(() => {
        const nav = document.querySelector(".site-nav");
        const tagline = Array.from(nav?.querySelectorAll("div") || []).find(
          (element) =>
            element.textContent?.trim() === "Precision Performance Engineering"
        );
        const controls = nav?.querySelector(".nav-cta")?.parentElement;
        const taglineRect = tagline?.getBoundingClientRect();
        const controlsRect = controls?.getBoundingClientRect();

        return {
          width: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          taglineOverflow:
            tagline && tagline.scrollWidth > tagline.clientWidth + 1,
          taglineRight: taglineRect?.right || 0,
          controlsRight: controlsRect?.right || 0,
        };
      });

      expect(metrics.taglineOverflow, `${width}px tagline overflow`).toBe(
        false
      );
      expect(metrics.taglineRight, `${width}px tagline right edge`).toBeLessThan(
        metrics.controlsRight
      );
      expect(metrics.controlsRight, `${width}px controls right edge`).toBeLessThanOrEqual(
        width + 1
      );
      expect(metrics.documentWidth, `${width}px document overflow`).toBeLessThanOrEqual(
        width + 1
      );
    }
  });

  test("tourney roster rows stretch cleanly on mobile", async ({ page }) => {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const response = await page.goto("/tourney/roster", {
        waitUntil: "domcontentloaded",
      });

      expect(response?.status()).toBeLessThan(400);
      await waitForPerformanceProfile(page);

      const metrics = await page.evaluate(() => {
        const sectionBody = document.querySelector(
          "#hosts .tourney-section-body"
        );
        const list = sectionBody?.querySelector(".tourney-roster-list");
        const row = list?.querySelector(".tourney-roster-player");
        const identity = row?.querySelector(".tourney-roster-identity");
        const detail = row?.querySelector(".tourney-roster-detail");
        const cta = row?.querySelector(".tourney-roster-cta");
        const bodyRect = sectionBody?.getBoundingClientRect();
        const listRect = list?.getBoundingClientRect();
        const rowRect = row?.getBoundingClientRect();
        const identityRect = identity?.getBoundingClientRect();
        const detailRect = detail?.getBoundingClientRect();
        const ctaRect = cta?.getBoundingClientRect();
        const listStyle = list ? getComputedStyle(list) : null;
        const rowStyle = row ? getComputedStyle(row) : null;
        const identityStyle = identity ? getComputedStyle(identity) : null;
        const detailStyle = detail ? getComputedStyle(detail) : null;
        const ctaStyle = cta ? getComputedStyle(cta) : null;

        return {
          width: window.innerWidth,
          listPaddingLeft: listStyle?.paddingLeft || "",
          listPaddingInlineStart: listStyle?.paddingInlineStart || "",
          bodyWidth: bodyRect?.width || 0,
          listWidth: listRect?.width || 0,
          rowWidth: rowRect?.width || 0,
          rowLeft: rowRect?.left || 0,
          bodyLeft: bodyRect?.left || 0,
          rowRight: rowRect?.right || 0,
          bodyRight: bodyRect?.right || 0,
          identityWidth: identityRect?.width || 0,
          identityCenter:
            identityRect ? identityRect.left + identityRect.width / 2 : 0,
          detailWidth: detailRect?.width || 0,
          detailCenter: detailRect ? detailRect.left + detailRect.width / 2 : 0,
          ctaWidth: ctaRect?.width || 0,
          ctaCenter: ctaRect ? ctaRect.left + ctaRect.width / 2 : 0,
          rowCenter: rowRect ? rowRect.left + rowRect.width / 2 : 0,
          rowJustifyItems: rowStyle?.justifyItems || "",
          identityTextAlign: identityStyle?.textAlign || "",
          detailTextAlign: detailStyle?.textAlign || "",
          detailJustifyItems: detailStyle?.justifyItems || "",
          ctaJustifySelf: ctaStyle?.justifySelf || "",
        };
      });

      expect(metrics.listPaddingLeft).toBe("0px");
      expect(metrics.listPaddingInlineStart).toBe("0px");
      expect(Math.abs(metrics.listWidth - metrics.bodyWidth)).toBeLessThanOrEqual(
        1
      );
      expect(Math.abs(metrics.rowWidth - metrics.bodyWidth)).toBeLessThanOrEqual(
        1
      );
      expect(Math.abs(metrics.rowLeft - metrics.bodyLeft)).toBeLessThanOrEqual(
        1
      );
      expect(Math.abs(metrics.rowRight - metrics.bodyRight)).toBeLessThanOrEqual(
        1
      );
      expect(metrics.identityWidth).toBeGreaterThan(0);
      expect(metrics.detailWidth).toBeGreaterThan(0);
      expect(metrics.ctaWidth).toBeGreaterThan(0);
      expect(metrics.rowJustifyItems).toBe("center");
      expect(metrics.identityTextAlign).toBe("center");
      expect(metrics.detailTextAlign).toBe("center");
      expect(metrics.detailJustifyItems).toBe("center");
      expect(metrics.ctaJustifySelf).toBe("center");
      expect(Math.abs(metrics.identityCenter - metrics.rowCenter)).toBeLessThanOrEqual(
        1
      );
      expect(Math.abs(metrics.detailCenter - metrics.rowCenter)).toBeLessThanOrEqual(
        1
      );
      expect(Math.abs(metrics.ctaCenter - metrics.rowCenter)).toBeLessThanOrEqual(
        1
      );
    }
  });

  test("tourney theme switch toggles Blackout", async ({ page }) => {
    const response = await page.goto("/tourney", {
      waitUntil: "domcontentloaded",
    });

    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator(".tourney-page")).toBeVisible();

    const themeSwitch = page.getByRole("switch");
    await expect(themeSwitch).toBeVisible();
    await expect(themeSwitch).toHaveAttribute("aria-checked", "false");

    await themeSwitch.click();
    await expect(themeSwitch).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    const accent = await page
      .locator(".tourney-page")
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--tourney-accent").trim()
      );
    expect(accent.toLowerCase()).toBe("#e8b94a");
  });
});
