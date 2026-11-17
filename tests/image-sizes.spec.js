const { test, expect } = require("@playwright/test");
const sharp = require("sharp");
const { fixturePort } = require("./fixtures/fixture-ports.cjs");

test.skip(process.env.TOOLING_IMAGE_SIZES !== "1", "Needs fixture content with stored image sizes: npm run test:image-sizes.");

const SCREENS = [
  { width: 390, height: 844, deviceScaleFactor: 3 },
  { width: 390, height: 844, deviceScaleFactor: 2 },
  { width: 1440, height: 900, deviceScaleFactor: 1 },
];
const HOME_ONLY_SCREENS = [
  { width: 644, height: 900, deviceScaleFactor: 1 },
  { width: 644, height: 900, deviceScaleFactor: 2 },
];
const PAGES = ["/", "/reviews", "/benchmarks", "/meet-the-team"];
const CROPPED_IMAGES = {
  "/": ["avatar-wide", "cover-0", "cover-1", "cover-2", "cover-3", "cover-4", "cover-5", "cover-6", "cover-7", "cover-wide", "cover-strip", "cover-tall"],
  "/reviews": [],
  "/benchmarks": [],
  "/meet-the-team": ["team-founder", "team-alpha", "team-beta"],
};
const STORAGE_PATH = "/storage/v1/";
const RESIZE_PATH = "/storage/v1/render/image/";
const SHAPE_TOLERANCE = 1 / 32;

const shownImages = (page, loadedOnly) => page.evaluate(({ storagePath, loadedOnly }) => [...document.images]
  .filter(image => (image.getAttribute("src") || "").includes(storagePath))
  .filter(image => image.checkVisibility({ opacityProperty: true }))
  .map(image => ({ image, box: image.getBoundingClientRect() }))
  .filter(({ box }) => box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth)
  .filter(({ image }) => !loadedOnly || image.currentSrc)
  .map(({ image, box }) => {
    const edge = getComputedStyle(image);
    return {
      address: image.currentSrc,
      source: image.src,
      loaded: image.complete && image.naturalWidth > 0,
      moved: edge.transform !== "none",
      boxWidth: box.width,
      cropped: edge.objectFit === "cover",
      pictureWidth: box.width - parseFloat(edge.borderLeftWidth) - parseFloat(edge.borderRightWidth),
      pictureHeight: box.height - parseFloat(edge.borderTopWidth) - parseFloat(edge.borderBottomWidth),
      declaredWidth: Number(image.getAttribute("width")),
      declaredHeight: Number(image.getAttribute("height")),
      alt: image.alt,
    };
  }),
{ storagePath: STORAGE_PATH, loadedOnly });
const waitForShownImages = page => expect.poll(async () => (await shownImages(page, false)).every(image => image.loaded && !image.moved)).toBe(true);
const scrollThrough = async (page, screen, visit) => {
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let top = 0; top < pageHeight; top += screen.height) {
    await page.evaluate(top => scrollTo({ top, behavior: "instant" }), top);
    await waitForShownImages(page);
    await visit();
  }
};

const fits = ({ path, screen }) => {
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
    const pixels = new Map();
    const pixelsOf = async address => {
      if (!pixels.has(address)) {
        const body = responses.has(address) ? await responses.get(address).body() : await (await request.get(address)).body();
        const { width, height } = await sharp(body).metadata();
        pixels.set(address, { width, height });
      }
      return pixels.get(address);
    };
    const storedFiles = asset => Promise.all(asset.sizes.map(size =>
      pixelsOf(new URL(`/storage/v1/object/public/site-content-public/${asset.storagePath.replace(/\.[a-z0-9]+$/, "")}-w${size}.webp`, contentOrigin).href)));

    await page.goto(path);
    await waitForShownImages(page);
    const firstScreen = [...new Set((await shownImages(page, true)).map(image => image.address))];
    let firstScreenBytes = 0;
    for (const address of firstScreen) firstScreenBytes += (await responses.get(address).body()).length;

    if (path === "/") {
      await scrollThrough(page, screen, async () => {});
      const allGames = page.getByRole("button", { name: "View All Games", exact: true });
      await allGames.scrollIntoViewIfNeeded();
      await allGames.click();
      await expect(page.locator('[aria-controls="supported-games-more"]')).toHaveAttribute("aria-expanded", "true");
      await page.locator("#supported-games-more").evaluate(list => Promise.all(list.getAnimations().map(animation => animation.finished)));
      await page.mouse.move(0, 0);
      await waitForShownImages(page);
    }
    const seen = new Map();
    await scrollThrough(page, screen, async () => {
      for (const image of await shownImages(page, true)) seen.set(`${image.address} in ${image.boxWidth}`, image);
    });
    const images = [...seen.values()];
    expect(images.length).toBeGreaterThan(0);

    const resizeRequests = [...responses.keys()].filter(address => address.includes(RESIZE_PATH) && assetOf(address) !== unfilled);
    const originalRequests = [...responses.keys()].filter(address => !address.includes(RESIZE_PATH) && assetOf(address)?.sizes?.length && address.endsWith(assetOf(address).storagePath));
    const oversized = [];
    const blurry = [];
    const judgeCrop = async ({ label, asset, address, boxWidth, boxHeight, ratio }) => {
      const capacity = file => Math.min(file.width, (file.height * boxWidth) / boxHeight);
      const files = await storedFiles(asset);
      const served = await pixelsOf(address);
      const need = boxWidth * ratio;
      const line = `${label}: ${served.width} by ${served.height} file for a ${boxWidth} by ${boxHeight} box at ${ratio}x`;
      if (capacity(served) < need && served.width !== files.at(-1).width) blurry.push(line);
      if (files.some(file => file.width < served.width && capacity(file) >= Math.ceil(need))) oversized.push(line);
    };
    for (const image of images) {
      const asset = assetOf(image.address);
      if (!asset?.sizes?.length) continue;
      if (image.cropped) {
        await judgeCrop({ label: asset.name, asset, address: image.address, boxWidth: image.pictureWidth, boxHeight: image.pictureHeight, ratio: screen.deviceScaleFactor });
        if (image.declaredWidth && image.declaredHeight) await judgeCrop({ label: `${asset.name} src`, asset, address: image.source, boxWidth: image.declaredWidth, boxHeight: image.declaredHeight, ratio: 1 });
        continue;
      }
      const { width } = await pixelsOf(image.address);
      const need = Math.ceil(image.boxWidth * screen.deviceScaleFactor);
      const line = `${asset.name}: ${width} wide file for ${need} needed`;
      if (width > (asset.sizes.find(size => size >= need) ?? asset.sizes.at(-1))) oversized.push(line);
      if (width < need && width !== asset.sizes.at(-1)) blurry.push(line);
    }
    const notSeen = CROPPED_IMAGES[path].filter(name => !images.some(image => image.cropped && assetOf(image.address)?.name === name));

    console.log(`${path} at ${screen.width} (${screen.deviceScaleFactor}x): ${resizeRequests.length} resize requests, ${oversized.length} oversized images, ${blurry.length} blurry images, ${originalRequests.length} original files, first screen ${firstScreenBytes} image bytes in ${firstScreen.length} files`);
    for (const line of [...new Set(oversized)]) console.log(`  oversized ${line}`);
    for (const line of [...new Set(blurry)]) console.log(`  blurry ${line}`);
    for (const name of notSeen) console.log(`  not seen: ${name}`);

    const reshaped = images.filter(image => image.declaredWidth && Math.abs(image.pictureHeight - (image.pictureWidth * image.declaredHeight) / image.declaredWidth) > SHAPE_TOLERANCE)
      .map(image => `${image.alt}: ${image.pictureWidth} by ${image.pictureHeight} picture for a ${image.declaredWidth} by ${image.declaredHeight} image`);
    for (const line of reshaped) console.log(`  reshaped ${line}`);
    expect(reshaped).toEqual([]);
    if (path === "/reviews") {
      const shown = address => images.find(image => assetOf(image.address) === assetOf(address) && image.address.includes(address));
      expect(images.find(image => assetOf(image.address) === unfilled && image.address.includes(RESIZE_PATH))).toMatchObject({ loaded: true });
      expect(shown(`/object/public/site-content-public/${vector.storagePath}`)).toMatchObject({ loaded: true });
    }
    expect(notSeen).toEqual([]);
    expect(resizeRequests).toEqual([]);
    expect(originalRequests).toEqual([]);
    expect(oversized).toEqual([]);
    expect(blurry).toEqual([]);
  });
};

for (const [screens, pages] of [[SCREENS, PAGES], [HOME_ONLY_SCREENS, ["/"]]]) {
  for (const screen of screens) {
    test.describe(`${screen.width} wide at ${screen.deviceScaleFactor}x`, () => {
      test.use({ viewport: { width: screen.width, height: screen.height }, deviceScaleFactor: screen.deviceScaleFactor, javaScriptEnabled: true });
      for (const path of pages) fits({ path, screen });
    });
  }
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
