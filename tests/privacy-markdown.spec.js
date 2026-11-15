const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: false });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

test("privacy Markdown preserves PortableText line breaks", async ({ page, request }) => {
  const response = await request.get("/markdown?path=/privacy");
  expect(response.status()).toBe(200);
  const markdown = await response.text();
  expect(markdown).toContain([
    "## Synthetic line breaks",
    "",
    "Synthetic first line\\:\\",
    "\\",
    "\\- Synthetic item one\\",
    "\\- Synthetic item two\\",
    "\\",
    "Synthetic closing line \\&copy\\;\\.",
    "",
    "- List line one\\",
    "  List line two",
    "",
    "\\",
    "Leading break\\",
    "\\",
    "\\",
    "Three breaks carriage return<br><br>",
  ].join("\n"));

  await page.goto("/privacy");
  const section = page.locator("main section").filter({
    has: page.getByRole("heading", { name: "Synthetic line breaks", exact: true }),
  });
  await expect(section.getByRole("heading", { name: "Synthetic line breaks", exact: true })).toBeVisible();
  await expect(section.locator("p")).toHaveCount(2);
  await expect(section.locator("p").nth(0).locator("br")).toHaveCount(5);
  await expect(section.locator("p").nth(1).locator("br")).toHaveCount(6);
  await expect(section.locator("li br")).toHaveCount(1);
  await expect(section.locator("br")).toHaveCount(12);
  expect(await section.locator("p").nth(0).textContent()).toBe(
    "Synthetic first line:- Synthetic item one- Synthetic item twoSynthetic closing line &copy;."
  );
  await expect(section.locator("p").nth(1)).toHaveText("Leading breakThree breaks carriage return");
  expect(await section.locator("li").textContent()).toBe("List line oneList line two");
  await test.info().attach("privacy-markdown", { body: markdown, contentType: "text/markdown" });
  await test.info().attach("privacy-line-breaks-html", {
    body: await section.innerHTML(),
    contentType: "text/html",
  });
  await section.screenshot({ path: "test-results/privacy-markdown/line-breaks.png" });
});

test("privacy HTML and Markdown share the same cookie notice", async ({ page, request }) => {
  const { COOKIE_NOTICE } = require("../src/lib/cookieNotice.js");
  const markdown = await (await request.get("/markdown?path=/privacy")).text();
  const unescape = (text) => text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
  const markdownSection = markdown.split("## Cookies and browser storage\n\n")[1].split("\n\nLast updated")[0]
    .split("\n\n[Contact")[0].split("\n\n").map(unescape);
  expect(markdownSection).toEqual(COOKIE_NOTICE.paragraphs);
  expect(markdown.split(`## ${COOKIE_NOTICE.heading}\n`)).toHaveLength(2);

  await page.goto("/privacy");
  const sections = page.locator("main section");
  await expect(page.getByRole("heading", { name: COOKIE_NOTICE.heading, exact: true })).toHaveCount(1);
  const cookieSection = sections.last();
  await expect(cookieSection.getByRole("heading", { level: 2 })).toHaveText(COOKIE_NOTICE.heading);
  expect(await cookieSection.locator("p").allTextContents()).toEqual(markdownSection);
  await expect(sections.filter({ has: page.getByRole("heading", { name: "Synthetic line breaks" }) })).toHaveCount(1);
});
