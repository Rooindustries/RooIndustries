const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: false });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

test("privacy Markdown preserves PortableText paragraphs and line breaks", async ({ page, request }) => {
  const response = await request.get("/markdown?path=/privacy");
  expect(response.status()).toBe(200);
  const markdown = await response.text();
  expect(markdown).toContain([
    "## Synthetic line breaks",
    "",
    "Synthetic first line\\:",
    "",
    "\\- Synthetic item one\\",
    "\\- Synthetic item two",
    "",
    "Synthetic closing line \\&copy\\;\\.",
    "",
    "- List line one\\",
    "  List line two",
  ].join("\n"));

  await page.goto("/privacy");
  const section = page.locator("div").filter({
    has: page.getByRole("heading", { name: "Synthetic line breaks", exact: true }),
  }).last();
  await expect(section.getByRole("heading", { name: "Synthetic line breaks", exact: true })).toBeVisible();
  await expect(section.locator("p br")).toHaveCount(5);
  await expect(section.locator("li br")).toHaveCount(1);
  await expect(section.locator("br")).toHaveCount(6);
  expect(await section.locator("p").textContent()).toBe(
    "Synthetic first line:- Synthetic item one- Synthetic item twoSynthetic closing line &copy;."
  );
  expect(await section.locator("li").textContent()).toBe("List line oneList line two");
  await test.info().attach("privacy-markdown", { body: markdown, contentType: "text/markdown" });
  await test.info().attach("privacy-line-breaks-html", {
    body: await section.innerHTML(),
    contentType: "text/html",
  });
  await section.screenshot({ path: "test-results/privacy-markdown/line-breaks.png" });
});
