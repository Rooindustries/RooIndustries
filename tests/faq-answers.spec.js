const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: true, serviceWorkers: "block" });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

const answer = number => `This synthetic answer verifies that question ${number} appears in the server-rendered FAQ without requiring a browser content request.`;

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const route of ["/faq", "/"]) {
    test(`${route} keeps collapsed FAQ answers in the page at ${viewport.width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto(route, { waitUntil: "networkidle" });
      const regions = page.locator('[id$="-answer"]');
      if (route === "/faq") {
        await expect(page.getByText(/^Page \d+ of \d+$/)).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Synthetic local question 12", exact: true })).toHaveCount(1);
        await expect(regions).toHaveCount(13);
      } else {
        await expect(regions).toHaveCount(10);
      }
      const collapsed = await regions.evaluateAll(items => items.map(item => ({
        id: item.id,
        text: item.textContent.trim(),
        controlledBy: document.querySelectorAll(`button[aria-controls="${item.id}"][aria-expanded="false"]`).length,
        visible: item.checkVisibility(),
      })));
      await testInfo.attach("faq-collapsed-answers", { body: JSON.stringify({ route, viewport, collapsed }, null, 2), contentType: "application/json" });
      for (const item of collapsed) {
        expect(item.text, item.id).not.toBe("");
        expect(item.controlledBy, item.id).toBe(1);
      }

      const button = page.getByRole("button", { name: /Synthetic local question 1$/ });
      const region = page.locator(`[id="${await button.getAttribute("aria-controls")}"]`);
      const text = region.getByText(answer(1), { exact: true });
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await expect(text).toHaveCount(1);
      await expect(text).toBeHidden();

      await button.scrollIntoViewIfNeeded();
      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await expect(text).toHaveCount(1);
      await expect(text).toBeVisible();

      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await expect(text).toHaveCount(1);
      await expect(text).toBeHidden();
    });
  }
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`/faq keeps the question column steady beside its heading at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/faq", { waitUntil: "networkidle" });
    await expect(page.locator("#faq a")).toHaveCount(0);
    const firstQuestion = page.getByRole("button", { name: /Synthetic local question 1$/ });
    const heading = await page.locator(".ri-faq-heading").boundingBox();
    const column = page.locator(".ri-faq-questions");
    const before = await column.boundingBox();
    if (viewport.width >= 1024) {
      expect(heading.x + heading.width).toBeLessThan(before.x);
      expect(Math.abs(heading.y - before.y)).toBeLessThanOrEqual(heading.height);
    } else {
      expect(heading.y + heading.height).toBeLessThan(before.y);
    }
    await firstQuestion.click();
    await expect(firstQuestion).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(answer(1), { exact: true })).toBeVisible();
    const after = await column.boundingBox();
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
  });
}

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("/faq serves its answers in the page markup", async ({ page }) => {
    await page.goto("/faq", { waitUntil: "domcontentloaded" });
    const region = page.locator('main [id="synthetic-local-question-1-answer"]');
    await expect(region).toHaveCount(1);
    await expect(region).toContainText(answer(1));
    await expect(page.locator('button[aria-controls="synthetic-local-question-1-answer"]')).toHaveAttribute("aria-expanded", "false");
  });
});
