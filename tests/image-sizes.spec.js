const { test, expect } = require("@playwright/test");
const sharp = require("sharp");
const { fixturePort } = require("./fixtures/fixture-ports.cjs");

test.skip(process.env.TOOLING_IMAGE_SIZES !== "1", "Needs fixture content with stored image sizes: npm run test:image-sizes.");

const SCREENS = [
  { width: 390, height: 844, deviceScaleFactor: 3 },
  { width: 390, height: 844, deviceScaleFactor: 2 },
  { width: 1440, height: 900, deviceScaleFactor: 1 },
];
const PAGES = ["/", "/reviews", "/benchmarks"];
const STORAGE_PATH = "/storage/v1/";
const RESIZE_PATH = "/storage/v1/render/image/";
const SHAPE_TOLERANCE = 1 / 32;

const shownImages = (page, loadedOnly) => page.evaluate(({ storagePath, loadedOnly }) => [...document.images]
  .filter(image => (image.getAttribute("src") || "").includes(storagePath))
  .map(image => ({ image, box: image.getBoundingClientRect() }))
  .filter(({ box }) => box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth)
  .filter(({ image }) => !loadedOnly || image.currentSrc)
  .map(({ image, box }) => {
    const edge = getComputedStyle(image);
    return {
      address: image.currentSrc,
      loaded: image.complete && image.naturalWidth > 0,
      boxWidth: box.width,
      pictureWidth: box.width - parseFloat(edge.borderLeftWidth) - parseFloat(edge.borderRightWidth),
      pictureHeight: box.height - parseFloat(edge.borderTopWidth) - parseFloat(edge.borderBottomWidth),
      declaredWidth: Number(image.getAttribute("width")),
      declaredHeight: Number(image.getAttribute("height")),
      alt: image.alt,
    };
  }),
{ storagePath: STORAGE_PATH, loadedOnly });
const waitForShownImages = page => expect.poll(async () => (await shownImages(page, false)).every(image => image.loaded)).toBe(true);

for (const screen of SCREENS) {
  test.describe(`${screen.width} wide at ${screen.deviceScaleFactor}x`, () => {
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
        const sized = images.filter(image => assetOf(image.address)?.sizes?.length).map(image => {
          const { name, sizes } = assetOf(image.address);
          const need = Math.ceil(image.boxWidth * screen.deviceScaleFactor);
          return { ...image, need, fitting: sizes.find(size => size >= need) ?? sizes.at(-1), widest: sizes.at(-1), label: `${name}: ${image.fileWidth} wide file for ${need} needed` };
        });
        const oversized = sized.filter(image => image.fileWidth > image.fitting).map(image => image.label);
        const blurry = sized.filter(image => image.fileWidth < image.need && image.fileWidth !== image.widest).map(image => image.label);

        console.log(`${path} at ${screen.width} (${screen.deviceScaleFactor}x): ${resizeRequests.length} resize requests, ${oversized.length} oversized images, ${blurry.length} blurry images, ${originalRequests.length} original files, first screen ${firstScreenBytes} image bytes in ${firstScreen.length} files`);
        for (const line of oversized) console.log(`  oversized ${line}`);
        for (const line of blurry) console.log(`  blurry ${line}`);

        const reshaped = images.filter(image => image.declaredWidth && Math.abs(image.pictureHeight - (image.pictureWidth * image.declaredHeight) / image.declaredWidth) > SHAPE_TOLERANCE)
          .map(image => `${image.alt}: ${image.pictureWidth} by ${image.pictureHeight} picture for a ${image.declaredWidth} by ${image.declaredHeight} image`);
        for (const line of reshaped) console.log(`  reshaped ${line}`);
        expect(reshaped).toEqual([]);
        if (path === "/reviews") {
          const shown = address => images.find(image => assetOf(image.address) === assetOf(address) && image.address.includes(address));
          expect(images.find(image => assetOf(image.address) === unfilled && image.address.includes(RESIZE_PATH))).toMatchObject({ loaded: true });
          expect(shown(`/object/public/site-content-public/${vector.storagePath}`)).toMatchObject({ loaded: true });
        }
        expect(resizeRequests).toEqual([]);
        expect(originalRequests).toEqual([]);
        expect(oversized).toEqual([]);
        expect(blurry).toEqual([]);
      });
    }
  });
}

test.describe("zoom view", () => {
  test.use({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: true });
  test("opening a benchmark image shows the original file", async ({ page, request, baseURL }) => {
    const contentOrigin = new URL(baseURL);
    contentOrigin.port = String(fixturePort("TOOLING_CONTENT_PORT"));
    const assets = await (await request.get(new URL("/__image-sizes", contentOrigin).href)).json();
    const original = assets.find(asset => asset.name === "benchmark-before");
    await page.goto("/benchmarks");
    await page.getByRole("button", { name: "Open Fixture Benchmark Gamma benchmark before optimization", exact: true }).click();
    const zoomed = page.getByRole("dialog").getByRole("img");
    await expect(zoomed).toHaveAttribute("src", new URL(`/storage/v1/object/public/site-content-public/${original.storagePath}`, contentOrigin).href);
    await expect.poll(() => zoomed.evaluate(image => image.naturalWidth)).toBe(original.width);
  });
});
