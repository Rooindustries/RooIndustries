const { test, expect } = require("@playwright/test");
const { INDEXABLE_ROUTES } = require("../src/lib/routes");

const meta = (html, attr, name) => {
  const tag = html.match(new RegExp(`<meta[^>]*${attr}="${name}"[^>]*>`, "i"))?.[0] || "";
  return tag.match(/content="([^"]*)"/i)?.[1] ?? null;
};

const pngSize = buffer => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });

for (const route of [...INDEXABLE_ROUTES, "/BIOSGuide/"]) {
  test(`${route} shares as a square summary card`, async ({ request }) => {
    const response = await request.get(route);
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(meta(html, "name", "twitter:card")).toBe("summary");
    const image = meta(html, "property", "og:image");
    expect(image).toBeTruthy();
    const width = meta(html, "property", "og:image:width");
    const height = meta(html, "property", "og:image:height");
    if (width || height) expect(width).toBe(height);
    const asset = await request.get(new URL(image).pathname);
    expect(asset.status()).toBe(200);
    const size = pngSize(await asset.body());
    expect(size.width).toBe(size.height);
  });
}
