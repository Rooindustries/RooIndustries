const { test, expect } = require("@playwright/test");
const sharp = require("sharp");
const { fixturePort } = require("./fixtures/fixture-ports.cjs");

test.skip(process.env.TOOLING_IMAGE_SIZES !== "1", "Needs fixture content with stored image sizes: npm run test:image-sizes.");

const SCREENS = [
  { width: 390, height: 844, deviceScaleFactor: 3 },
  { width: 1440, height: 900, deviceScaleFactor: 1 },
];
const PAGES = ["/", "/reviews", "/benchmarks"];
const OVERSIZE_FACTOR = 1.5;
const STORAGE_PATH = "/storage/v1/";
const RESIZE_PATH = "/storage/v1/render/image/";

const shownImages = (page, loadedOnly) => page.evaluate(({ storagePath, loadedOnly }) => [...document.images]
  .filter(image => (image.getAttribute("src") || "").includes(storagePath))
  .map(image => ({ image, box: image.getBoundingClientRect() }))
  .filter(({ box }) => box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth)
  .filter(({ image }) => !loadedOnly || image.currentSrc)
  .map(({ image, box }) => ({ address: image.currentSrc, loaded: image.complete && image.naturalWidth > 0, boxWidth: box.width })),
{ storagePath: STORAGE_PATH, loadedOnly });
const waitForShownImages = page => expect.poll(async () => (await shownImages(page, false)).every(image => image.loaded)).toBe(true);

for (const screen of SCREENS) {
  test.describe(`${screen.width} wide`, () => {
    test.use({ viewport: { width: screen.width, height: screen.height }, deviceScaleFactor: screen.deviceScaleFactor, javaScriptEnabled: true });
    for (const path of PAGES) {
      test(`${path} loads stored image sizes that fit their boxes`, async ({ page, request, baseURL }) => {
        const contentOrigin = new URL(baseURL);
        contentOrigin.port = String(fixturePort("TOOLING_CONTENT_PORT"));
        const assets = await (await request.get(new URL("/__image-sizes", contentOrigin).href)).json();
        const assetOf = address => assets.find(asset => address.includes(asset.sha1));
        const unfilled = assets.find(asset => asset.sizes === null);
        const vector = assets.find(asset => asset.storagePath.endsWith(".svg"));
        const responses = new Map();
        page.on("response", response => {
          if (new URL(response.url()).pathname.startsWith(STORAGE_PATH)) responses.set(response.url(), response);
        });

        await page.goto(path);
        await waitForShownImages(page);
        const firstScreen = [...new Set((await shownImages(page, true)).map(image => image.address))];
        let firstScreenBytes = 0;
        for (const address of firstScreen) firstScreenBytes += (await responses.get(address).body()).length;

        const seen = new Map();
        const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        for (let top = 0; top < pageHeight; top += screen.height) {
          await page.evaluate(top => scrollTo({ top, behavior: "instant" }), top);
          await waitForShownImages(page);
          for (const image of await shownImages(page, true)) seen.set(`${image.address} in ${image.boxWidth}`, image);
        }
        const images = [...seen.values()];
        expect(images.length).toBeGreaterThan(0);
        for (const image of images) image.fileWidth = (await sharp(await responses.get(image.address).body()).metadata()).width;

        const resizeRequests = [...responses.keys()].filter(address => address.includes(RESIZE_PATH) && assetOf(address) !== unfilled);
        const originalRequests = [...responses.keys()].filter(address => !address.includes(RESIZE_PATH) && assetOf(address)?.sizes?.length && address.endsWith(assetOf(address).storagePath));
        const oversized = images.filter(image => {
          const sizes = assetOf(image.address)?.sizes;
          if (!sizes?.length) return false;
          const needed = image.boxWidth * screen.deviceScaleFactor;
          return image.fileWidth > Math.max(OVERSIZE_FACTOR * needed, sizes.find(size => size >= needed) ?? sizes.at(-1));
        }).map(image => `${assetOf(image.address).name}: ${image.fileWidth} wide file in a ${Math.round(image.boxWidth)} wide box`);

        console.log(`${path} at ${screen.width}: ${resizeRequests.length} resize requests, ${oversized.length} oversized images, ${originalRequests.length} original files, first screen ${firstScreenBytes} image bytes in ${firstScreen.length} files`);
        for (const line of oversized) console.log(`  oversized ${line}`);

        if (path === "/reviews") {
          const shown = address => images.find(image => assetOf(image.address) === assetOf(address) && image.address.includes(address));
          expect(images.find(image => assetOf(image.address) === unfilled && image.address.includes(RESIZE_PATH))).toMatchObject({ loaded: true });
          expect(shown(`/object/public/site-content-public/${vector.storagePath}`)).toMatchObject({ loaded: true });
        }
        expect(resizeRequests).toEqual([]);
        expect(originalRequests).toEqual([]);
        expect(oversized).toEqual([]);
      });
    }
  });
}
