const { test, expect } = require("@playwright/test");
const { MARKDOWN_PATHS, MARKDOWN_VARY } = require("../src/lib/markdownContent");

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext, localOrigin, refuseEnvFiles } = await import("../scripts/lib/test-target-safety.mjs");
  refuseEnvFiles();
  localOrigin(baseURL);
  await guardBrowserContext(context, [baseURL]);
});

test.describe("canonical Markdown", () => {
  for (const pathname of MARKDOWN_PATHS) {
    test(`${pathname} matches the direct endpoint and ignores a conflicting path`, async ({ request }, testInfo) => {
      const direct = await request.get(`/markdown?path=${encodeURIComponent(pathname)}`);
      const expected = await direct.text();
      expect(direct.status()).toBe(200);
      const conflictingPath = pathname === "/about" ? "/contact" : "/about";
      for (const url of [pathname, `${pathname}?path=${encodeURIComponent(conflictingPath)}`]) {
        const response = await request.get(url, { headers: { Accept: "text/markdown" } });
        const body = await response.text();
        await testInfo.attach(`markdown-${encodeURIComponent(url)}`, {
          body: JSON.stringify({ url, status: response.status(), headers: response.headers(), body }, null, 2),
          contentType: "application/json",
        });
        expect(response.status()).toBe(200);
        expect(response.headers()["content-type"]).toContain("text/markdown");
        expect(response.headers().vary).toBe(direct.headers().vary);
        expect(response.headers().vary).toContain(MARKDOWN_VARY);
        expect(response.headers()["cache-control"]).toContain("no-store");
        expect(response.headers()["cdn-cache-control"]).toBe("no-store");
        expect(response.headers()["vercel-cdn-cache-control"]).toBe("no-store");
        expect(body).toBe(expected);
      }
      const head = await request.head(pathname, { headers: { Accept: "text/markdown" } });
      expect(head.status()).toBe(200);
      expect(await head.text()).toBe("");
    });
  }

  test("preserves missing-page and unacceptable-format responses", async ({ request }) => {
    const direct = await request.get("/markdown?path=/unpublished-page");
    const missing = await request.get("/unpublished-page", { headers: { Accept: "text/markdown" } });
    expect(direct.status()).toBe(404);
    expect(missing.status()).toBe(404);
    expect(await missing.text()).toBe(await direct.text());
    for (const pathname of MARKDOWN_PATHS) {
      const response = await request.get(pathname, { headers: { Accept: "application/xml" } });
      expect(response.status()).toBe(406);
      expect(response.headers().vary).toBe(MARKDOWN_VARY);
      expect(response.headers()["cache-control"]).toContain("no-store");
    }
  });
});
