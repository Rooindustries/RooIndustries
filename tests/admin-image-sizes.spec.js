const { test, expect } = require("@playwright/test");
const sharp = require("sharp");
const { createHash, randomBytes } = require("node:crypto");
const { adminControl, login, choose, prepareAdminContext } = require("./fixtures/admin-content.cjs");
const { createContentGate } = require("./fixtures/content-store-gate.cjs");

const LADDER = [128, 320, 640, 960, 1280];
const ONE_YEAR = "max-age=31536000";
const INVALID_MESSAGE = "Image format or dimensions are invalid.";
const TALLEST_FILE = 16383;
const UNREADABLE_MESSAGE = "Image bytes do not parse as the declared format.";
const RETRY_MESSAGE = "Image size storage is temporarily unavailable. Retry before the upload expires.";
const UPLOAD_BUTTON = /^(Upload|Replace)$/;

const sha1Of = bytes => createHash("sha1").update(bytes).digest("hex");
const sizePath = (sha1, width) => `/storage/v1/object/site-content-public/images/${sha1}-w${width}.webp`;
const noisyPixels = (width, height) => {
  const pixels = Buffer.alloc(width * height * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    const pixel = offset / 3;
    pixels[offset] = ((pixel % width) * 255) / width;
    pixels[offset + 1] = (Math.floor(pixel / width) * 255) / height;
    pixels[offset + 2] = 96;
  }
  randomBytes(150000).copy(pixels);
  return pixels;
};
const png = async (width, height) => ({
  name: `review-${width}x${height}.png`,
  mimeType: "image/png",
  buffer: await sharp(noisyPixels(width, height), { raw: { width, height, channels: 3 } }).png().toBuffer(),
});
const rotatedPhoto = async (width, height) => ({
  name: "photo.jpg",
  mimeType: "image/jpeg",
  buffer: await sharp(noisyPixels(height, width), { raw: { width: height, height: width, channels: 3 } }).jpeg().withMetadata({ orientation: 6 }).toBuffer(),
});
const cutShort = async (width, height) => {
  const whole = await png(width, height);
  return { ...whole, buffer: whole.buffer.subarray(0, Math.floor(whole.buffer.length / 2)) };
};
const animatedGif = async (width, height) => ({
  name: "clip.gif",
  mimeType: "image/gif",
  buffer: await sharp(noisyPixels(width, height * 2), { raw: { width, height: height * 2, channels: 3, pageHeight: height } }).gif().toBuffer(),
});
const svg = () => ({
  name: "mark.svg",
  mimeType: "image/svg+xml",
  buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="700"><text x="0" y="40">${randomBytes(8).toString("hex")}</text></svg>`),
});

const openReviewImage = async page => {
  await login(page);
  await choose(page, "Reviews");
  await page.getByRole("region", { name: "Reviews list" }).getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("region", { name: "Editor", exact: true })).toHaveAttribute("aria-busy", "false");
  return page.locator('input[type="file"][aria-label="Review Image"]').locator("xpath=../..");
};
const beginUpload = async (page, asset, file) => {
  const answers = [];
  const record = response => {
    if (/\/api\/admin\/content\/assets\/(upload|finalize)$/.test(new URL(response.url()).pathname)) answers.push({ response, at: Date.now() });
  };
  page.on("response", record);
  const chooser = page.waitForEvent("filechooser");
  await asset.getByRole("button", { name: UPLOAD_BUTTON }).click();
  const picked = await chooser;
  const started = Date.now();
  await picked.setFiles(file);
  return async () => {
    let outcome;
    await expect.poll(async () => {
      const last = answers.at(-1);
      if (!last) return false;
      const body = await last.response.json();
      if (body.ok && last.response.url().endsWith("/upload") && !body.data.alreadyExists) return false;
      outcome = { ...body, milliseconds: last.at - started };
      return true;
    }, { timeout: 60000 }).toBe(true);
    await expect(asset.getByRole("button", { name: UPLOAD_BUTTON })).toBeEnabled();
    page.off("response", record);
    return outcome;
  };
};
const upload = async (page, asset, file) => (await beginUpload(page, asset, file))();
const storedWidths = ({ width, height }) => {
  const top = Math.min(width, 1280, Math.floor((TALLEST_FILE * width) / height));
  return [...LADDER.filter(step => step < top), top];
};
const flat = async (width, height, format) => {
  const canvas = sharp({ create: { width, height, channels: 3, background: { r: randomBytes(1)[0], g: randomBytes(1)[0], b: randomBytes(1)[0] } }, limitInputPixels: false });
  return format === "avif"
    ? { name: "flat.avif", mimeType: "image/avif", buffer: await canvas.avif({ effort: 0 }).toBuffer() }
    : { name: "flat.png", mimeType: "image/png", buffer: await canvas.png().toBuffer() };
};
const failures = (request, rules) => request.post(`${adminControl()}/storage-failures`, { data: { rules } });
const storageOrigin = async request => (await (await request.get(`${adminControl()}/fixture`)).json()).origins[1];
const sizesInBucket = async (request, sha1, ...otherWidths) => {
  const origin = await storageOrigin(request);
  const found = {};
  for (const width of [...new Set([...LADDER, ...otherWidths])].sort((left, right) => left - right)) {
    const response = await request.get(`${origin}${sizePath(sha1, width).replace("/object/", "/object/public/")}`);
    if (!response.ok()) continue;
    const image = await sharp(await response.body()).metadata();
    found[width] = {
      contentType: response.headers()["content-type"],
      cacheControl: response.headers()["cache-control"],
      format: image.format,
      width: image.width,
      height: image.height,
      lastModified: response.headers()["last-modified"],
    };
  }
  console.log(`sizes in the bucket for ${sha1}: ${Object.keys(found).join(", ") || "none"}`);
  return found;
};
const registered = async (request, assetId) => {
  const response = await request.get(`${adminControl()}/asset-document?id=${encodeURIComponent(assetId)}`);
  expect(response.ok()).toBe(true);
  return response.json();
};
const expectSizes = async (request, file, original) => {
  const sha1 = sha1Of(file.buffer);
  const widths = storedWidths(original);
  const found = await sizesInBucket(request, sha1, original.width, widths.at(-1));
  expect(Object.keys(found).map(Number)).toEqual(widths);
  for (const width of widths) {
    expect(found[width]).toMatchObject({ contentType: "image/webp", cacheControl: ONE_YEAR, format: "webp", width });
    expect(Math.abs(found[width].height - (original.height * width) / original.width)).toBeLessThan(1);
  }
  const record = await registered(request, `image-${sha1}-${original.width}x${original.height}-${file.name.split(".").pop()}`);
  expect(record.assets).toBe(1);
  expect(record.document.metadata.sizes).toEqual(widths);
  expect(record.document.metadata.dimensions).toMatchObject(original);
  return found;
};

test.beforeEach(prepareAdminContext);

for (const [original, widths] of [
  [{ width: 1600, height: 1000 }, [128, 320, 640, 960, 1280]],
  [{ width: 90, height: 60 }, [90]],
]) {
  test(`a ${original.width} pixel wide image has its sizes stored and recorded`, async ({ page, request }) => {
    expect(storedWidths(original)).toEqual(widths);
    const file = await png(original.width, original.height);
    const asset = await openReviewImage(page);
    const outcome = await upload(page, asset, file);
    expect(outcome.ok).toBe(true);
    await expect(asset.locator("img")).toHaveAttribute("src", new RegExp(`/images/${sha1Of(file.buffer)}\\.png$`));
    await expect(asset).toContainText(`${original.width}×${original.height}`);
    await expectSizes(request, file, original);
  });
}

test("a narrow image stores the steps below its width and its own width, and the same bytes again add nothing", async ({ page, request }) => {
  const original = { width: 800, height: 500 };
  expect(storedWidths(original)).toEqual([128, 320, 640, 800]);
  const file = await png(original.width, original.height);
  const asset = await openReviewImage(page);
  const first = await upload(page, asset, file);
  expect(first.ok).toBe(true);
  console.log(`upload of an 800 by 500 screenshot (${file.buffer.length} bytes) took ${first.milliseconds} ms`);
  await expect(asset).toContainText("800×500");
  const stored = await expectSizes(request, file, original);
  const again = await upload(page, asset, file);
  expect(again.data).toMatchObject({ alreadyExists: true, assetId: first.data.assetId });
  expect(await expectSizes(request, file, original)).toEqual(stored);
});

test("an upload whose size cannot be stored is refused and not registered, and the next try finishes it", async ({ page, request }) => {
  const original = { width: 800, height: 500 };
  const file = await png(original.width, original.height);
  const sha1 = sha1Of(file.buffer);
  const asset = await openReviewImage(page);
  try {
    expect((await failures(request, [{ method: "POST", path: sizePath(sha1, 640) }])).ok()).toBe(true);
    const refused = await upload(page, asset, file);
    expect(refused).toMatchObject({ ok: false, code: "ASSET_STORAGE_UNAVAILABLE", error: RETRY_MESSAGE });
    await expect(asset.getByRole("alert")).toHaveText(RETRY_MESSAGE);
    await expect(asset.locator(`img[src*="${sha1}"]`)).toHaveCount(0);
    expect(await registered(request, `image-${sha1}-800x500-png`)).toEqual({ document: null, assets: 0 });
    expect(Object.keys(await sizesInBucket(request, sha1, original.width)).map(Number)).toEqual([128, 320, 800]);
  } finally { expect((await failures(request, [])).ok()).toBe(true); }
  const retried = await upload(page, asset, file);
  expect(retried.ok).toBe(true);
  await expect(asset.getByRole("alert")).toHaveCount(0);
  await expect(asset.locator("img")).toHaveAttribute("src", new RegExp(`/images/${sha1}\\.png$`));
  await expectSizes(request, file, original);
});

test("an upload that fails late leaves the sizes another upload of the same bytes recorded", async ({ page, request, browser, baseURL }) => {
  const original = { width: 800, height: 500 };
  const file = await png(original.width, original.height);
  const sha1 = sha1Of(file.buffer);
  const asset = await openReviewImage(page);
  const other = await browser.newContext();
  try {
    expect((await failures(request, [{ method: "POST", path: sizePath(sha1, 640), hold: true }])).ok()).toBe(true);
    const held = await beginUpload(page, asset, file);
    await expect.poll(async () => (await (await request.get(`${adminControl()}/storage-holds`)).json()).held).toBe(1);
    const otherPage = await other.newPage();
    await prepareAdminContext({ context: other, page: otherPage, request, baseURL });
    const completed = await upload(otherPage, await openReviewImage(otherPage), file);
    expect(completed.ok).toBe(true);
    expect(await (await request.post(`${adminControl()}/storage-release`)).json()).toEqual({ released: 1 });
    expect(await held()).toMatchObject({ ok: false, code: "ASSET_STORAGE_UNAVAILABLE", error: RETRY_MESSAGE });
    const recorded = (await registered(request, completed.data.assetId)).document.metadata.sizes;
    expect(Object.keys(await sizesInBucket(request, sha1, original.width)).map(Number)).toEqual(recorded);
    await expectSizes(request, file, original);
  } finally {
    await other.close();
    await request.post(`${adminControl()}/storage-release`);
    expect((await failures(request, [])).ok()).toBe(true);
  }
});

test("a photo turned on its side by its camera gets sizes as wide as browsers show it", async ({ page, request }) => {
  const shown = { width: 600, height: 1000 };
  const file = await rotatedPhoto(shown.width, shown.height);
  expect(await sharp(file.buffer).metadata()).toMatchObject({ width: 1000, height: 600, orientation: 6 });
  const asset = await openReviewImage(page);
  expect((await upload(page, asset, file)).ok).toBe(true);
  await expect(asset).toContainText("600×1000");
  const preview = asset.locator("img");
  await expect(preview).toHaveJSProperty("complete", true);
  expect(await preview.evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }))).toEqual(shown);
  const found = await expectSizes(request, file, shown);
  expect(Object.keys(found).map(Number)).toEqual([128, 320, 600]);
  expect(found[600]).toMatchObject({ width: 600, height: 1000 });
});

test("an image whose pixels cannot be read is refused like any other bad file", async ({ page, request }) => {
  const file = await cutShort(800, 500);
  const sha1 = sha1Of(file.buffer);
  const asset = await openReviewImage(page);
  const refused = await upload(page, asset, file);
  expect(refused).toMatchObject({ ok: false, code: "ASSET_VERIFICATION_FAILED", error: UNREADABLE_MESSAGE });
  await expect(asset.getByRole("alert")).toHaveText(UNREADABLE_MESSAGE);
  expect(await registered(request, `image-${sha1}-800x500-png`)).toEqual({ document: null, assets: 0 });
  expect(await sizesInBucket(request, sha1, 800)).toEqual({});
  const original = await request.get(`${await storageOrigin(request)}/storage/v1/object/public/site-content-public/images/${sha1}.png`);
  expect(original.ok()).toBe(false);
});

test("a very tall image is stored with a top size its format can hold", async ({ page, request }) => {
  const original = { width: 1280, height: 20000 };
  expect(storedWidths(original)).toEqual([128, 320, 640, 960, 1048]);
  const file = await flat(original.width, original.height, "png");
  const asset = await openReviewImage(page);
  expect((await upload(page, asset, file)).ok).toBe(true);
  const found = await expectSizes(request, file, original);
  expect(found[1048].height).toBeLessThanOrEqual(TALLEST_FILE);
});

test("a strip too tall for any width is refused", async ({ page, request }) => {
  const file = await flat(1, 16384, "png");
  const asset = await openReviewImage(page);
  expect(await upload(page, asset, file)).toMatchObject({ ok: false, code: "ASSET_VERIFICATION_FAILED", error: INVALID_MESSAGE });
  expect(await registered(request, `image-${sha1Of(file.buffer)}-1x16384-png`)).toEqual({ document: null, assets: 0 });
});

test("the largest picture each format may hold: 100 megapixels gets its sizes, an AVIF just over 36 is refused", async ({ page, request }) => {
  test.setTimeout(300000);
  const asset = await openReviewImage(page);
  const largest = { width: 10000, height: 10000 };
  const png = await flat(largest.width, largest.height, "png");
  expect((await upload(page, asset, png)).ok).toBe(true);
  await expectSizes(request, png, largest);
  const avif = await flat(6000, 6001, "avif");
  const sha1 = sha1Of(avif.buffer);
  expect(await upload(page, asset, avif)).toMatchObject({ ok: false, code: "ASSET_VERIFICATION_FAILED", error: INVALID_MESSAGE });
  await expect(asset.getByRole("alert")).toHaveText(INVALID_MESSAGE);
  expect(await registered(request, `image-${sha1}-6000x6001-avif`)).toEqual({ document: null, assets: 0 });
  expect(await sizesInBucket(request, sha1, 6000)).toEqual({});
  expect((await request.get(`${await storageOrigin(request)}/storage/v1/object/public/site-content-public/images/${sha1}.avif`)).ok()).toBe(false);
});

test("a published review image reaches visitors from its stored sizes", async ({ page, request, baseURL }) => {
  const file = await png(800, 500);
  const sha1 = sha1Of(file.buffer);
  const asset = await openReviewImage(page);
  try {
    const outcome = await upload(page, asset, file);
    expect(outcome.ok).toBe(true);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
    const gallery = (await (await request.get("/api/content/reviews-gallery")).json()).data;
    const published = gallery.find(review => review.image?.asset?._ref === outcome.data.assetId);
    expect(published.image.sizes).toEqual([128, 320, 640, 800]);
    await createContentGate(request, baseURL).rebuild(["/reviews"]);
    await page.goto("/reviews");
    const shown = page.locator(`img[src*="${sha1}"]`);
    await expect(shown).toHaveAttribute("src", new RegExp(`/object/public/site-content-public/images/${sha1}-w800\\.webp$`));
    expect((await shown.getAttribute("srcset")).split(", ").map(source => source.split(" ")[1])).toEqual(["128w", "320w", "640w", "800w"]);
    await shown.scrollIntoViewIfNeeded();
    await expect.poll(() => shown.evaluate(image => image.naturalWidth > 0 && image.currentSrc.split("/").pop())).toMatch(new RegExp(`^${sha1}-w(128|320|640|800)\\.webp$`));
  } finally { expect((await request.post(`${adminControl()}/reset-content`)).ok()).toBe(true); }
});

test("a vector image and an animated image are stored as before and record no sizes", async ({ page, request }) => {
  const asset = await openReviewImage(page);
  for (const file of [svg(), await animatedGif(1400, 700)]) {
    const outcome = await upload(page, asset, file);
    expect(outcome.ok).toBe(true);
    await expect(asset.locator("img")).toHaveAttribute("src", new RegExp(`/images/${sha1Of(file.buffer)}\\.`));
    const record = await registered(request, outcome.data.assetId);
    expect(record.assets).toBe(1);
    expect(record.document.metadata.dimensions).toMatchObject({ width: 1400, height: 700 });
    expect(record.document.metadata.sizes).toEqual([]);
    expect(await sizesInBucket(request, sha1Of(file.buffer), 1400)).toEqual({});
  }
});
