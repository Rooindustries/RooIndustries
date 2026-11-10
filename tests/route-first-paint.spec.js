const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");

const routes = ["/booking", "/payment", "/payment-success", "/thank-you", "/referrals/login"];

for (const javaScriptEnabled of [false, true]) {
  for (const width of [360, 390, 1280]) {
    test.describe(`${width}px with scripts ${javaScriptEnabled ? "on" : "off"}`, () => {
      test.use({ javaScriptEnabled, viewport: { width, height: width === 1280 ? 800 : 844 } });

      for (const route of routes) {
        test(`${route} keeps its direct-load content outside hidden server segments`, async ({ page, context, flow }, testInfo) => {
          let release;
          const scripts = new Promise(resolve => { release = resolve; });
          if (javaScriptEnabled) await context.route("**/_next/static/**/*.js", async request => {
            await scripts;
            await request.fallback();
          });
          const errors = [];
          page.on("pageerror", error => errors.push(error.message));
          page.on("console", message => {
            if (message.type() === "error" && /hydration|didn't match|server rendered/i.test(message.text())) {
              errors.push(message.text());
            }
          });
          const content = page.locator(route === "/referrals/login"
            ? "#ref-login-identifier" : '[role="dialog"].ri-booking');
          try {
            const response = await page.goto(route, { waitUntil: javaScriptEnabled ? "commit" : "load" });
            const hiddenSegments = await page.evaluate(html =>
              new DOMParser().parseFromString(html, "text/html").querySelectorAll('[hidden][id^="S:"]').length,
              await response.text()
            );
            expect(hiddenSegments).toBe(0);
            await expect(content).toHaveCount(1);
            await page.waitForFunction(() => {
              const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
              return links.length > 0 && links.every(link => link.sheet);
            });
            const initial = await content.evaluate(element => ({
              hiddenSegment: element.closest('[hidden][id^="S:"]')?.id || null,
              visible: element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
            }));
            const name = `${route.slice(1).replaceAll("/", "-")}-${width}-js-${javaScriptEnabled ? "on" : "off"}`;
            const shots = process.env.FIRST_PAINT_SHOTS || testInfo.outputPath("shots");
            await fs.mkdir(shots, { recursive: true });
            await page.screenshot({ path: path.join(shots, `${name}-first.png`) });
            release();
            if (javaScriptEnabled) {
              await page.waitForLoadState("load");
              await expect(content).toBeVisible();
              await expect.poll(() => content.evaluate(element =>
                element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
              )).toBe(true);
              await page.screenshot({ path: path.join(shots, `${name}-ready.png`) });
            }
            expect(initial.hiddenSegment).toBeNull();
            if (!javaScriptEnabled) {
              expect(initial.visible).toBe(true);
              if (route === "/referrals/login") {
                await expect(page.getByRole("region", { name: "No-JS SEO fallback" })).toHaveCount(0);
              }
            }
            expect(errors).toEqual([]);
          } finally {
            release();
            await context.unrouteAll({ behavior: "wait" });
          }
        });
      }
    });
  }
}
