const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: true, serviceWorkers: "block" });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

const GLYPHS_MISSING_FROM_GUIDE_FONTS = ["✗"];

test("/BIOSGuide loads its fonts as cached woff2 files instead of embedding them", async ({ request }, testInfo) => {
  const response = await request.get("/BIOSGuide", { headers: { accept: "text/html" } });
  const assetCacheControl = (await request.get("/favicon-96x96.png")).headers()["cache-control"] ?? null;
  const html = await response.text();
  const urls = [...new Set([...html.matchAll(/url\('([^']+\.woff2)'\) format\('woff2'\)/g)].map(match => match[1]))];
  const files = [];
  for (const url of urls) {
    const font = await request.get(url);
    files.push({
      url,
      status: font.status(),
      contentType: font.headers()["content-type"] ?? null,
      cacheControl: font.headers()["cache-control"] ?? null,
      bytes: (await font.body()).length,
    });
  }
  await testInfo.attach("bios-guide-fonts", { body: JSON.stringify({ htmlBytes: html.length, assetCacheControl, files }, null, 2), contentType: "application/json" });
  expect(response.status()).toBe(200);
  expect(html).not.toContain("data:font");
  expect(html.length).toBeLessThan(200000);
  expect(urls).toHaveLength(4);
  expect(assetCacheControl).toMatch(/max-age=31536000|no-store/);
  for (const file of files) {
    expect(file.status, file.url).toBe(200);
    expect(file.contentType, file.url).toContain("font/woff2");
    expect(file.cacheControl, file.url).toBe(assetCacheControl);
  }
});

test("every character on /BIOSGuide renders with the guide's own fonts", async ({ page }, testInfo) => {
  await page.goto("/BIOSGuide");
  const faces = await page.evaluate(() => Promise.all([...document.fonts].map(async face => {
    await face.load().catch(() => {});
    return { family: face.family, weight: face.weight, status: face.status };
  })));
  const session = await page.context().newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const { root } = await session.send("DOM.getDocument", { depth: -1 });
  const textElements = [];
  const walk = node => {
    if (node.nodeType === 1 && node.children?.some(child => child.nodeType === 3 && child.nodeValue.trim())) textElements.push(node.nodeId);
    node.children?.forEach(walk);
  };
  walk(root);
  const fallbackGlyphs = {};
  for (const nodeId of textElements) {
    const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    for (const font of fonts.filter(entry => !entry.isCustomFont)) {
      fallbackGlyphs[font.familyName] = (fallbackGlyphs[font.familyName] ?? 0) + font.glyphCount;
    }
  }
  const text = await page.locator("body").innerText();
  const expectedFallback = [...text].filter(char => GLYPHS_MISSING_FROM_GUIDE_FONTS.includes(char)).length;
  await testInfo.attach("bios-guide-glyphs", { body: JSON.stringify({ faces, textElements: textElements.length, fallbackGlyphs, expectedFallback }, null, 2), contentType: "application/json" });
  expect(faces).toHaveLength(4);
  for (const face of faces) expect(face.status, `${face.family} ${face.weight}`).toBe("loaded");
  expect(textElements.length).toBeGreaterThan(100);
  expect(Object.values(fallbackGlyphs).reduce((total, count) => total + count, 0)).toBe(expectedFallback);
});
