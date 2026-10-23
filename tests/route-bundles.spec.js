const { test, expect } = require("@playwright/test");
const fs = require("node:fs");

test.use({ javaScriptEnabled: true, viewport: { width: 1440, height: 900 }, serviceWorkers: "block", trace: process.env.CI ? "retain-on-failure" : "off", video: "off" });

const vendorMarkers = ["formspree.io", "Could not find Elements context", "[@portabletext/react]"];

const attachJson = async (testInfo, name, value) => {
  const file = testInfo.outputPath(`${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path: file, contentType: "application/json" });
};

const captureScripts = (page) => {
  const scripts = [];
  const pending = [];
  page.on("response", (response) => {
    if (response.request().resourceType() !== "script") return;
    pending.push(response.text().then(body => scripts.push({ url: response.url(), body })).catch(() => {}));
  });
  return async () => { await Promise.all(pending); return scripts; };
};

const watchLayout = async (context) => context.addInitScript(() => {
  window.__routeShifts = [];
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) window.__routeShifts.push({ value: entry.value, time: entry.startTime });
    }
  }).observe({ type: "layout-shift", buffered: true });
});

const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
};

const attachLayout = async (page, testInfo) => {
  const shifts = await page.evaluate(() => window.__routeShifts);
  await attachJson(testInfo, "layout-shifts", shifts);
  expect(shifts.reduce((total, entry) => total + entry.value, 0)).toBeLessThan(0.1);
};

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  await watchLayout(context);
});

test("cold homepage excludes Contact and PortableText scripts", async ({ page }, testInfo) => {
  const scripts = captureScripts(page);
  await page.goto("/");
  await settle(page);
  const loaded = await scripts();
  await attachJson(testInfo, "requested-scripts", loaded.map(({ url }) => url));
  for (const marker of vendorMarkers) {
    expect(loaded.filter(({ body }) => body.includes(marker)).map(({ url }) => url), marker).toEqual([]);
  }
});

for (const route of ["/reviews", "/tools", "/packages"]) {
  test(`cold ${route} excludes booking confirmation scripts`, async ({ page }, testInfo) => {
    const scripts = captureScripts(page);
    await page.goto(route);
    await settle(page);
    const loaded = await scripts();
    const confirmationScripts = loaded.filter(({ body }) => body.includes("Looking for your booking?"));
    await attachJson(testInfo, "requested-scripts", loaded.map(({ url }) => url));
    expect(confirmationScripts.map(({ url }) => url)).toEqual([]);
  });
}

for (const [route, title] of [["/contact", "Get In Touch"], ["/privacy", "Privacy Policy"]]) {
  for (let run = 1; run <= 3; run++) {
    test(`${route} direct entry is complete and stable, load ${run}`, async ({ page }, testInfo) => {
      const response = await page.goto(route);
      expect(response.status()).toBe(200);
      expect(await response.text()).toContain(title);
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expect(page.locator("footer")).toBeAttached();
      await settle(page);
      await attachLayout(page, testInfo);
      if (run === 1) await page.screenshot({ path: testInfo.outputPath("direct-entry.png"), fullPage: true, animations: "disabled" });
    });
  }

  test(`${route} supports client entry and browser history`, async ({ page }, testInfo) => {
    await page.goto("/about");
    await settle(page);
    await page.evaluate(() => { window.__entryMarker = "same-document"; window.__routeShifts = []; });
    await page.locator(`nav[aria-label="About Roo Industries"] a[href="${route}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${route}$`));
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__entryMarker)).toBe("same-document");
    await page.goBack();
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.locator("main h1").first()).toBeVisible();
    await page.goForward();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__entryMarker)).toBe("same-document");
    await settle(page);
    await attachLayout(page, testInfo);
  });

  const marker = route === "/contact" ? "formspree.io" : "[@portabletext/react]";
  for (const state of ["delayed", "failed"]) {
    test(`${route} handles a ${state} route chunk`, async ({ page, baseURL }, testInfo) => {
      const chunks = [];
      await page.goto("/about");
      await settle(page);
      const previousHeading = await page.locator("main h1").first().textContent();
      let delayedContentRequests = 0;
      if (route === "/privacy" && state === "delayed") {
        await page.route("**/api/content/privacy-policy", async entry => {
          delayedContentRequests += 1;
          const response = await entry.fetch();
          await new Promise(resolve => setTimeout(resolve, 1100));
          await entry.fulfill({ response });
        });
      }
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      let intercepted = 0;
      await page.route("**/_next/static/chunks/**", async entry => {
        expect(new URL(entry.request().url()).origin).toBe(new URL(baseURL).origin);
        const response = await entry.fetch();
        const body = await response.text();
        if (!body.includes(marker)) return entry.fulfill({ response, body });
        chunks.push(entry.request().url());
        intercepted += 1;
        if (state === "failed") {
          if (intercepted === 1) return entry.abort("failed");
        } else {
          await gate;
        }
        await entry.fulfill({ response, body });
      });
      await page.evaluate(() => {
        window.__entryMarker = "same-document";
        window.__routeShifts = [];
        window.__blankFrames = 0;
        window.__watchFrames = true;
        const frame = () => {
          if (!window.__watchFrames) return;
          if (!document.querySelector("main h1")) window.__blankFrames += 1;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      try {
        await page.locator(`nav[aria-label="About Roo Industries"] a[href="${route}"]`).click();
        await expect.poll(() => intercepted).toBeGreaterThan(0);
        if (state === "delayed") {
          await page.waitForTimeout(800);
          await expect(page.locator("main h1").first()).toHaveText(previousHeading);
          expect(await page.evaluate(() => window.__blankFrames)).toBe(0);
          release();
          await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
          await settle(page);
          await page.evaluate(() => { window.__watchFrames = false; });
          expect(await page.evaluate(() => window.__blankFrames)).toBe(0);
          await attachLayout(page, testInfo);
          if (route === "/privacy") expect(delayedContentRequests).toBeGreaterThan(0);
        } else {
          await expect(page.getByRole("heading", { name: "We couldn’t load this page." })).toBeVisible();
          expect(await page.evaluate(() => window.__entryMarker)).toBe("same-document");
          await page.screenshot({ path: testInfo.outputPath("chunk-failure.png"), fullPage: true });
          await page.unrouteAll({ behavior: "wait" });
          await page.getByRole("button", { name: "Reload page", exact: true }).click();
          await expect(page.locator("main h1").first()).toBeVisible();
          await expect(page.getByRole("heading", { name: "We couldn’t load this page." })).toHaveCount(0);
          expect(await page.evaluate(() => window.__entryMarker)).toBeUndefined();
        }
        await page.unrouteAll({ behavior: "wait" });
        await attachJson(testInfo, "chunk-load", { route, state, chunks, intercepted, delayedContentRequests });
      } finally {
        release();
      }
    });
  }

  test(`${route} ignores a failed chunk after another navigation`, async ({ page }, testInfo) => {
    await page.goto("/about");
    await settle(page);
    await page.evaluate(() => { window.__entryMarker = "same-document"; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let intercepted = 0;
    let aborted = false;
    await page.route("**/_next/static/chunks/**", async entry => {
      const response = await entry.fetch();
      const body = await response.text();
      if (!body.includes(marker) || intercepted++) return entry.fulfill({ response, body });
      await gate;
      await entry.abort("failed");
      aborted = true;
    });
    try {
      await page.locator(`nav[aria-label="About Roo Industries"] a[href="${route}"]`).click();
      await expect.poll(() => intercepted).toBeGreaterThan(0);
      await page.locator('nav[aria-label="About Roo Industries"] a[href="/packages"]').click();
      await expect(page).toHaveURL(/\/packages$/);
      expect(await page.evaluate(() => window.__entryMarker)).toBe("same-document");
      release();
      await expect.poll(() => aborted).toBe(true);
      await settle(page);
      await expect(page).toHaveURL(/\/packages$/);
      expect(await page.evaluate(() => window.__entryMarker)).toBe("same-document");
      await attachJson(testInfo, "cancelled-chunk", { route, intercepted, aborted });
    } finally {
      release();
    }
  });
}

for (const result of ["success", "error"]) {
  test(`Contact form handles ${result} and copies its email`, async ({ page, context, baseURL }, testInfo) => {
    const submissions = [];
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async value => { window.__copiedEmail = value; } } });
    });
    await page.route("https://formspree.io/**", async route => {
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: { "access-control-allow-origin": baseURL, "access-control-allow-headers": "*", "access-control-allow-methods": "POST" } });
      }
      expect(route.request().method()).toBe("POST");
      submissions.push(route.request().postData());
      await route.fulfill({
        status: result === "success" ? 200 : 422,
        headers: { "access-control-allow-origin": baseURL },
        contentType: "application/json",
        body: JSON.stringify(result === "success" ? { next: "/contact" } : { errors: [{ field: "email", code: "TYPE_EMAIL", message: "Synthetic email error" }] }),
      });
    });
    await page.goto("/contact");
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copied!", exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__copiedEmail)).toBe("serviroo@rooindustries.com");
    await page.getByPlaceholder("Your name", { exact: true }).fill("Fixture Person");
    await page.getByPlaceholder("your.email@example.com", { exact: true }).fill("person@fixture.invalid");
    await page.getByPlaceholder("Tell me about your PC and what you'd like to optimize...", { exact: true }).fill("Synthetic contact form check.");
    await page.getByRole("button", { name: "Send Message", exact: true }).click();
    if (result === "success") await expect(page.getByText("Thank you! Your message has been sent.")).toBeVisible();
    else {
      await expect(page.getByText("Synthetic email error", { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: "Send Message", exact: true })).toBeEnabled();
    }
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toContain("person@fixture.invalid");
    await attachJson(testInfo, "submission", { result, submissions });
  });
}

test("Privacy preserves rich-text links and lists, and Terms still loads", async ({ page }) => {
  await page.route("**/api/content/privacy-policy", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.sections.push({ heading: "Synthetic rich text", content: [
      { _type: "block", _key: "links", style: "normal", markDefs: [{ _type: "link", _key: "external", href: "https://example.invalid/policy" }, { _type: "link", _key: "email", href: "mailto:policy@fixture.invalid" }], children: [{ _type: "span", _key: "external", text: "Policy details", marks: ["external"] }, { _type: "span", _key: "email", text: "Email policy", marks: ["email"] }] },
      { _type: "block", _key: "bullet", style: "normal", listItem: "bullet", level: 1, markDefs: [], children: [{ _type: "span", _key: "bullet-text", text: "Synthetic policy item", marks: [] }] },
    ] });
    await route.fulfill({ response, json: body });
  });
  await page.goto("/privacy");
  const link = page.getByRole("link", { name: "Policy details", exact: true });
  await expect(link).toHaveAttribute("href", "https://example.invalid/policy");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByRole("link", { name: "Email policy", exact: true })).toHaveAttribute("href", "mailto:policy@fixture.invalid");
  await expect(page.locator("main ul li").filter({ hasText: "Synthetic policy item" })).toBeVisible();
  await page.locator('footer a[href="/terms"]').click();
  await expect(page.getByRole("heading", { name: "Terms of Service", exact: true })).toBeVisible();
});

test("Privacy refreshes content after a client-side revisit", async ({ page }) => {
  await page.goto("/about");
  await settle(page);
  await page.locator('nav[aria-label="About Roo Industries"] a[href="/privacy"]').click();
  await expect(page.getByRole("heading", { name: "Privacy Policy", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/about$/);
  await page.route("**/api/content/privacy-policy", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.sections[0].heading = "Refreshed policy content";
    await route.fulfill({ response, json: body });
  });
  await page.locator('nav[aria-label="About Roo Industries"] a[href="/privacy"]').click();
  await expect(page.getByRole("heading", { name: "Refreshed policy content", exact: true })).toBeVisible();
});
