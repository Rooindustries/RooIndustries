const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: true, serviceWorkers: "block" });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`/terms hydrates the server-rendered terms once at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const messages = [];
    page.on("console", message => messages.push(`${message.type()}: ${message.text()}`));
    page.on("pageerror", error => messages.push(`pageerror: ${error.message}`));
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        window.__termsHeadingAtLoad = document.querySelector("main h1");
      });
    });
    const response = await page.goto("/terms", { waitUntil: "networkidle" });
    const main = page.locator("main#main-content");
    const state = await page.evaluate(() => ({
      headingAtLoad: window.__termsHeadingAtLoad?.textContent ?? null,
      sameHeading: window.__termsHeadingAtLoad === document.querySelector("main h1"),
    }));
    await testInfo.attach("terms-hydration", {
      body: JSON.stringify({ viewport, ...state, messages }, null, 2),
      contentType: "application/json",
    });
    expect(await response.text()).toContain("Terms of Service");
    expect(state.headingAtLoad).toBe("Terms of Service");
    expect(state.sameHeading).toBe(true);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(main.locator("h1")).toHaveText("Terms of Service");
    await expect(main.getByRole("heading", { name: "Synthetic local information", exact: true })).toHaveCount(1);
    await expect(main).toContainText("This is synthetic privacy content for an isolated local Roo Industries application test.");
    expect(messages.filter(message => /hydrat|did not match|server rendered|server HTML|#418|#423|#425/i.test(message))).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("terms-hydrated.png"), fullPage: true, animations: "disabled" });
  });
}

const POLICY_LINKS = [
  { href: "/faq", outside: false },
  { href: "https://www.rooindustries.com/reviews", outside: false },
  { href: "https://rooindustries.com/tools", outside: false },
  { href: "https://example.com/elsewhere", outside: true },
  { href: "//example.org/elsewhere", outside: true },
  { href: "mailto:help@example.com", outside: false },
];

const policyWithLinks = {
  title: "Synthetic policy",
  sections: [{
    heading: "Links",
    content: [{
      _type: "block",
      _key: "links",
      style: "normal",
      markDefs: POLICY_LINKS.map(({ href }, index) => ({ _type: "link", _key: `link${index}`, href })),
      children: POLICY_LINKS.map((_, index) => ({ _type: "span", _key: `span${index}`, text: `policy-link-${index} `, marks: [`link${index}`] })),
    }],
  }],
};

for (const [route, resource] of [["/terms", "terms"], ["/privacy", "privacy-policy"]]) {
  test(`${route} opens outside links in a new tab and site links in the same tab`, async ({ page }) => {
    await page.route(`**/api/content/${resource}**`, (request) => request.fulfill({ json: { ok: true, data: policyWithLinks } }));
    await page.goto(route, { waitUntil: "networkidle" });
    for (const [index, { href, outside }] of POLICY_LINKS.entries()) {
      const link = page.locator("main a", { hasText: `policy-link-${index}` });
      await expect(link, href).toHaveAttribute("href", href);
      if (outside) {
        await expect(link, href).toHaveAttribute("target", "_blank");
        await expect(link, href).toHaveAttribute("rel", /noopener/);
      } else {
        await expect(link, href).not.toHaveAttribute("target", /.+/);
      }
    }
  });
}
