const { test, expect } = require("@playwright/test");
const fs = require("node:fs");

test.use({
  javaScriptEnabled: true,
  viewport: { width: 1440, height: 900 },
  serviceWorkers: "block",
  trace: process.env.CI ? "retain-on-failure" : "off",
  video: "off",
});

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  await context.addInitScript(() => {
    window.__contactCspViolations = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      window.__contactCspViolations.push({
        blockedURI: event.blockedURI,
        directive: event.effectiveDirective,
        disposition: event.disposition,
      });
    });
  });
});

for (const outcome of ["success", "error", "form-error", "offline"]) {
  test(`contact submission reaches Formspree and shows ${outcome}`, async ({ page, baseURL }, testInfo) => {
    const submissions = [];
    const fields = {
      name: "Fixture Person",
      email: "person@fixture.invalid",
      message: "Synthetic contact submission.",
    };

    await page.route("https://formspree.io/f/*", async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": new URL(baseURL).origin,
            "access-control-allow-headers": "*",
            "access-control-allow-methods": "POST",
          },
        });
        return;
      }
      expect(request.method()).toBe("POST");
      submissions.push({ url: request.url(), body: request.postData() });
      if (outcome === "offline") {
        await route.abort("internetdisconnected");
        return;
      }
      await route.fulfill({
        status: outcome === "success" ? 200 : outcome === "form-error" ? 403 : 422,
        contentType: "application/json",
        headers: { "access-control-allow-origin": new URL(baseURL).origin },
        body: JSON.stringify(outcome === "success"
          ? { next: "/contact", ok: true }
          : outcome === "form-error"
            ? { errors: [{ code: "FORM_DISABLED", message: "Synthetic form error" }] }
            : { errors: [{ field: "email", code: "TYPE_EMAIL", message: "Synthetic email error" }] }),
      });
    });

    try {
      await page.goto("/contact");
      await page.getByPlaceholder("Your name", { exact: true }).fill(fields.name);
      await page.getByPlaceholder("your.email@example.com", { exact: true }).fill(fields.email);
      await page.getByPlaceholder("Tell me about your PC and what you'd like to optimize...", { exact: true }).fill(fields.message);
      await page.getByRole("button", { name: "Send Message", exact: true }).click();
      await expect.poll(async () => submissions.length + await page.evaluate(() => window.__contactCspViolations.length)).toBeGreaterThan(0);
      expect(await page.evaluate(() => window.__contactCspViolations)).toEqual([]);
      expect(submissions).toHaveLength(1);
      for (const [name, value] of Object.entries(fields)) {
        expect(submissions[0].body).toContain(`name="${name}"`);
        expect(submissions[0].body).toContain(value);
      }
      if (outcome === "success") {
        await expect(page.getByText("Thank you! Your message has been sent.")).toBeVisible();
      } else if (outcome === "error") {
        await expect(page.getByText("Synthetic email error", { exact: false })).toBeVisible();
        await expect(page.locator("form").getByRole("alert")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Send Message", exact: true })).toBeEnabled();
      } else {
        await expect(page.locator("form").getByRole("alert")).toContainText("Your message didn't send");
        await expect(page.locator("form").getByRole("alert")).toContainText("serviroo@rooindustries.com");
        await expect(page.getByPlaceholder("Tell me about your PC and what you'd like to optimize...", { exact: true })).toHaveValue(fields.message);
        await expect(page.getByRole("button", { name: "Send Message", exact: true })).toBeEnabled();
      }
      expect(await page.evaluate(() => window.__contactCspViolations)).toEqual([]);
    } finally {
      const evidencePath = testInfo.outputPath("contact-csp.json");
      fs.writeFileSync(evidencePath, JSON.stringify({
        outcome,
        submissions,
        violations: await page.evaluate(() => window.__contactCspViolations),
      }, null, 2));
      await testInfo.attach("contact-csp", {
        contentType: "application/json",
        path: evidencePath,
      });
      await page.screenshot({ path: testInfo.outputPath("contact-result.png"), fullPage: true, animations: "disabled" });
    }
  });
}
