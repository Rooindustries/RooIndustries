const { spawn } = require("node:child_process");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { test, expect } = require("./fixtures/isolated-content-test.cjs");
const { adminControl, login, choose, prepareAdminContext } = require("./fixtures/admin-content.cjs");
const { createContentGate } = require("./fixtures/content-store-gate.cjs");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/fill-image-sizes.mjs");
const LADDER = [128, 320, 640, 960, 1280];
const TALLEST_FILE = 16383;
const ONE_YEAR = "max-age=31536000";
const PUBLIC_PATH = "/storage/v1/object/public/site-content-public/";
const RESIZE_PATH = "/storage/v1/render/image/";
const STORAGE_PATH = "/storage/v1/";
const SIZE_FILE = /-w\d+\.webp$/;
const INVALID_MESSAGE = "Image format or dimensions are invalid.";
const UNREADABLE_MESSAGE = "Image bytes do not parse as the declared format.";
const MIME_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", avif: "image/avif", gif: "image/gif", svg: "image/svg+xml" };

const noise = (width, height) => sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } });
const flat = (width, height) => sharp({ create: { width, height, channels: 3, background: { r: randomBytes(1)[0], g: randomBytes(1)[0], b: randomBytes(1)[0] } }, limitInputPixels: false });
const picture = async (pixels, extension, shown) => {
  const { data, info } = await pixels.toBuffer({ resolveWithObject: true });
  return { name: `picture.${extension}`, mimeType: MIME_TYPES[extension], extension, width: info.width, height: info.height, ...shown, buffer: data };
};
const png = (width, height) => picture(noise(width, height).png(), "png");
const jpeg = (width, height) => picture(noise(width, height).jpeg(), "jpg");
const webp = (width, height) => picture(noise(width, height).webp(), "webp");
const turnedJpeg = (width, height) => picture(noise(height, width).jpeg().withMetadata({ orientation: 6 }), "jpg", { width, height });
const tallPng = (width, height) => picture(flat(width, height).png(), "png");
const largeAvif = (width, height) => picture(flat(width, height).avif({ effort: 0 }), "avif");
const animatedGif = (width, height) => picture(sharp(randomBytes(width * height * 6), { raw: { width, height: height * 2, channels: 3, pageHeight: height } }).gif(), "gif", { width, height });
const vector = (width, height) => ({ name: "picture.svg", mimeType: MIME_TYPES.svg, extension: "svg", width, height, buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="0" y="40">${randomUUID()}</text></svg>`) });
const cutShort = async (width, height) => {
  const whole = await png(width, height);
  return { ...whole, buffer: whole.buffer.subarray(0, Math.floor(whole.buffer.length / 2)) };
};

const storedWidths = ({ width, height, extension }) => {
  if (["svg", "gif"].includes(extension)) return [];
  const top = Math.min(width, LADDER.at(-1), Math.floor((TALLEST_FILE * width) / height));
  return [...LADDER.filter(step => step < top), top];
};
const sizeFile = (image, width) => `images/${image.sha1}-w${width}.webp`;
const filesFor = (image, widths) => [image.path, ...widths.map(width => sizeFile(image, width))].sort();
const control = (request, route, data) => (data === undefined ? request.get(`${adminControl()}${route}`) : request.post(`${adminControl()}${route}`, { data }));
const seed = async (request, file, options) => {
  const response = await control(request, "/seed-legacy-image", { bytes: file.buffer.toString("base64"), extension: file.extension, mimeType: file.mimeType, width: file.width, height: file.height, ...options });
  expect(response.ok(), await response.text()).toBe(true);
  return { ...file, ...(await response.json()) };
};
const store = async request => (await control(request, "/image-store")).json();
const filesOf = (stored, image) => stored.objects.map(object => object.name).filter(name => name.includes(image.sha1));
const recordOf = (stored, image) => stored.documents.find(document => document.id === image.id);
const assetOf = async (request, image) => (await control(request, `/asset-document?id=${image.id}`)).json();
const storeRpc = async (request, name, data) => {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = Object.fromEntries((await (await control(request, "/operator-environment")).text()).trim().split("\n").map(line => line.split(/=(.*)/s)));
  return request.post(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { headers: { apikey: SUPABASE_SECRET_KEY, authorization: `Bearer ${SUPABASE_SECRET_KEY}` }, data });
};
const imagesWithoutSizes = async request => {
  const images = [];
  for (;;) {
    const page = await (await storeRpc(request, "roo_cms_image_size_records", { p_after: images.at(-1)?.id ?? null, p_limit: 100 })).json();
    if (!page.length) return images.filter(image => !image.sizes);
    images.push(...page);
  }
};
const failStorage = async (request, rules) => expect((await control(request, "/storage-failures", { rules })).ok()).toBe(true);
const refusedSizeUpload = (image, width, hold = false) => ({ method: "POST", path: `/storage/v1/object/site-content-public/${sizeFile(image, width)}`, hold });

const startFill = async (request, testInfo, args, env = {}) => {
  const environment = testInfo.outputPath("operator.env");
  fs.writeFileSync(environment, await (await control(request, "/operator-environment")).text(), { mode: 0o600 });
  const child = spawn(process.execPath, [SCRIPT, "--env", environment, ...args], { cwd: ROOT, env: { PATH: process.env.PATH, CMS_WRITES_PAUSED: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const finished = new Promise(resolve => child.once("close", (code, signal) => {
    console.log(`fill ${args.join(" ") || "(dry run)"} exited ${signal || code}\n${stdout}${stderr}`);
    resolve({ code, signal, stdout, stderr, lines: stdout.trim().split("\n") });
  }));
  return { child, finished };
};
const fill = async (...run) => (await startFill(...run)).finished;
const outcomeOf = (result, image) => result.lines.find(line => line.startsWith(`${image.id} `))?.slice(image.id.length + 1);
const listed = widths => (widths.length ? ` ${widths.join(",")}` : "");

const expectStoredSizes = async (request, image, widths) => {
  const origin = (await (await control(request, "/fixture")).json()).origins[1];
  for (const width of widths) {
    const response = await request.get(`${origin}${PUBLIC_PATH}${sizeFile(image, width)}`);
    expect(response.headers()).toMatchObject({ "content-type": "image/webp", "cache-control": ONE_YEAR });
    const { info } = await sharp(await response.body(), { failOn: "error" }).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(width);
    expect(Math.abs(info.height - (image.height * width) / image.width)).toBeLessThan(1);
  }
};
const publishReview = (gate, image) => gate.cms("/api/admin/content/publish", {
  operation: "create", type: "review", createIntentId: randomUUID(),
  document: { title: `Review ${image.sha1}`, alt: `Review ${image.sha1}`, image: { _type: "image", asset: { _type: "reference", _ref: image.id } } },
});
const openPage = async (gate, page, path, image) => {
  const requested = [];
  const record = request => { if (new URL(request.url()).pathname.startsWith(STORAGE_PATH)) requested.push(request.url()); };
  await gate.rebuild([path]);
  page.on("request", record);
  await page.goto(path);
  const shown = page.locator(`img[src*="${image.sha1}"]`).first();
  await shown.scrollIntoViewIfNeeded();
  await expect.poll(() => requested.filter(address => address.includes(image.sha1)).length).toBeGreaterThan(0);
  page.off("request", record);
  return { shown, requested, addresses: await page.locator(`img[src*="${STORAGE_PATH}"]`).evaluateAll(elements => elements.map(element => `${element.getAttribute("src")} ${element.getAttribute("srcset") || ""}`)) };
};
const openEditor = async (page, type, create = false) => {
  await choose(page, type);
  if (create) await page.getByRole("region", { name: `${type} list` }).getByRole("button", { name: "New", exact: true }).click();
  const editor = page.getByRole("region", { name: "Editor", exact: true });
  await expect(editor).toHaveAttribute("aria-busy", "false");
  const closed = editor.locator('button[aria-expanded="false"]');
  while (await closed.count()) await closed.first().click();
  return editor;
};
const imageFields = editor => editor.locator('input[type="file"]').locator("xpath=../..");
const uploadInto = async (page, asset, image) => {
  const steps = [];
  const record = response => {
    const step = /\/api\/admin\/content\/assets\/(upload|finalize)$/.exec(new URL(response.url()).pathname);
    if (step) steps.push(step[1]);
  };
  const labels = await asset.evaluateHandle(field => {
    const seen = [];
    new MutationObserver(() => {
      const label = field.querySelector('[role="status"] span')?.textContent;
      if (label && seen.at(-1) !== label) seen.push(label);
    }).observe(field, { subtree: true, childList: true, characterData: true });
    return seen;
  });
  page.on("response", record);
  const chooser = page.waitForEvent("filechooser");
  const answered = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/assets/upload"));
  await asset.getByRole("button", { name: /^(Upload|Replace)$/ }).click();
  await (await chooser).setFiles({ name: image.name, mimeType: image.mimeType, buffer: image.buffer });
  const issued = await answered;
  await expect(asset.getByRole("button", { name: "Replace", exact: true })).toBeEnabled();
  await expect(asset.locator("img")).toHaveAttribute("src", new RegExp(`/${image.path.replace(".", "\\.")}$`));
  page.off("response", record);
  return { steps, shown: await labels.jsonValue(), issued: { ok: issued.ok(), ...(await issued.json()).data } };
};
const openReviewUpload = async (page, image) => {
  await login(page);
  const editor = await openEditor(page, "Reviews", true);
  return () => uploadInto(page, imageFields(editor).filter({ has: page.locator('[aria-label="Review Image"]') }), image);
};

test.beforeAll(async ({ playwright }) => {
  const earlier = await playwright.request.newContext();
  expect((await earlier.post(`${adminControl()}/reset-isolation`)).ok()).toBe(true);
  await earlier.dispose();
});
test.beforeEach(prepareAdminContext);

test("images uploaded before sizes existed get theirs stored and recorded, and the reviews page stops asking the resizer", async ({ page, request, baseURL }, testInfo) => {
  const gate = createContentGate(request, baseURL);
  const screenshot = await seed(request, await png(1600, 900));
  const photo = await seed(request, await jpeg(800, 600));
  const images = [screenshot, photo, await seed(request, await turnedJpeg(600, 1000)), await seed(request, await webp(500, 300)), await seed(request, await tallPng(1280, 20000)), await seed(request, vector(1400, 700)), await seed(request, await animatedGif(320, 200))];
  expect(images.map(storedWidths)).toEqual([[128, 320, 640, 960, 1280], [128, 320, 640, 800], [128, 320, 600], [128, 320, 500], [128, 320, 640, 960, 1048], [], []]);
  const raster = images.filter(image => storedWidths(image).length);
  const unreported = "failed 0, missing 0, no document 0";

  await publishReview(gate, screenshot);
  const resized = await openPage(gate, page, "/reviews", screenshot);
  await expect(resized.shown).toHaveAttribute("src", new RegExp(`${RESIZE_PATH}public/site-content-public/${screenshot.path.replace(".", "\\.")}`));
  expect(resized.requested.filter(address => address.includes(RESIZE_PATH)).length).toBeGreaterThan(0);

  const untouched = await store(request);
  expect(untouched.objects.map(object => object.name)).toEqual(images.map(image => image.path).sort());
  expect(untouched.documents.map(document => document.sizes)).toEqual(images.map(() => null));
  const reportFile = testInfo.outputPath("plan.json");
  const sizesFolder = testInfo.outputPath("sizes");
  const plan = await fill(request, testInfo, ["--report", reportFile, "--save-sizes", sizesFolder]);
  expect(plan.code).toBe(0);
  for (const image of images) expect(outcomeOf(plan, image)).toBe(storedWidths(image).length ? `to fill${listed(storedWidths(image))}` : "to record empty: vector or animated");
  expect(plan.lines.at(-1)).toBe(`to fill ${raster.length}, already filled 0, to record empty ${images.length - raster.length}, ${unreported}`);
  expect(await store(request)).toEqual(untouched);
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  expect(report).toEqual({
    target: new URL((await (await control(request, "/fixture")).json()).origins[1]).host,
    apply: false,
    summary: { "to fill": raster.length, "already filled": 0, "to record empty": images.length - raster.length, failed: 0, missing: 0, "no document": 0 },
    images: expect.any(Array),
  });
  expect(report.images.sort((left, right) => left.id.localeCompare(right.id))).toEqual([...images].sort((left, right) => left.id.localeCompare(right.id)).map(image => (storedWidths(image).length
    ? { id: image.id, path: image.path, outcome: "to fill", sizes: storedWidths(image) }
    : { id: image.id, path: image.path, outcome: "to record empty", sizes: [], reason: "vector or animated" })));
  expect(fs.readdirSync(sizesFolder).sort()).toEqual(raster.flatMap(image => storedWidths(image).map(width => path.basename(sizeFile(image, width)))).sort());

  const applied = await fill(request, testInfo, ["--apply"]);
  expect(applied.code).toBe(0);
  for (const image of images) expect(outcomeOf(applied, image)).toBe(storedWidths(image).length ? `filled${listed(storedWidths(image))}` : "recorded empty: vector or animated");
  expect(applied.lines.at(-1)).toBe(`filled ${raster.length}, already filled 0, recorded empty ${images.length - raster.length}, ${unreported}`);
  const filled = await store(request);
  expect(filled.objects.filter(object => !SIZE_FILE.test(object.name))).toEqual(untouched.objects);
  for (const image of images) {
    expect(filesOf(filled, image)).toEqual(filesFor(image, storedWidths(image)));
    expect(recordOf(filled, image)).toEqual({ ...recordOf(untouched, image), sizes: storedWidths(image), revision: expect.not.stringMatching(recordOf(untouched, image).revision) });
    await expectStoredSizes(request, image, storedWidths(image));
  }

  await publishReview(gate, photo);
  const stored = await openPage(gate, page, "/reviews", screenshot);
  await expect(stored.shown).toHaveAttribute("src", new RegExp(`${PUBLIC_PATH}images/${screenshot.sha1}-w\\d+\\.webp$`));
  await expect.poll(() => stored.shown.evaluate(shown => shown.naturalWidth > 0 && shown.currentSrc)).toMatch(SIZE_FILE);
  expect(stored.addresses.filter(address => address.includes(photo.sha1) || address.includes(screenshot.sha1))).toHaveLength(2);
  expect(stored.addresses.filter(address => address.includes(RESIZE_PATH))).toEqual([]);
  expect(stored.requested.filter(address => address.includes(RESIZE_PATH))).toEqual([]);

  const again = await fill(request, testInfo, ["--apply"]);
  expect(again.code).toBe(0);
  for (const image of images) expect(outcomeOf(again, image)).toBe(`already filled${listed(storedWidths(image))}`);
  expect(again.lines.at(-1)).toBe(`filled 0, already filled ${images.length}, recorded empty 0, ${unreported}`);
  expect(await store(request)).toEqual(filled);
});

test("a size that cannot be stored fails its image and records nothing, and the next run finishes it", async ({ request }, testInfo) => {
  const blocked = await seed(request, await png(800, 500));
  const other = await seed(request, await jpeg(400, 300));
  const untouched = await store(request);
  let refused;
  try {
    await failStorage(request, [refusedSizeUpload(blocked, 640)]);
    refused = await fill(request, testInfo, ["--apply"]);
  } finally { await failStorage(request, []); }
  expect(refused.code).toBe(1);
  expect(outcomeOf(refused, blocked)).toBe("failed: storage");
  expect(outcomeOf(refused, other)).toBe("filled 128,320,400");
  expect(refused.lines.at(-1)).toBe("filled 1, already filled 0, recorded empty 0, failed 1, missing 0, no document 0");
  const partial = await store(request);
  expect(filesOf(partial, blocked)).toEqual(filesFor(blocked, [128, 320, 800]));
  expect(recordOf(partial, blocked)).toEqual(recordOf(untouched, blocked));

  const finished = await fill(request, testInfo, ["--apply"]);
  expect(finished.code).toBe(0);
  expect(outcomeOf(finished, blocked)).toBe("filled 128,320,640,800");
  expect(outcomeOf(finished, other)).toBe("already filled 128,320,400");
  const complete = await store(request);
  expect(filesOf(complete, blocked)).toEqual(filesFor(blocked, [128, 320, 640, 800]));
  expect(recordOf(complete, blocked).sizes).toEqual([128, 320, 640, 800]);
  expect(complete.objects.filter(object => object.name !== sizeFile(blocked, 640))).toEqual(partial.objects);
  await expectStoredSizes(request, blocked, [128, 320, 640, 800]);
});

test("an image whose original or whose record is gone is reported, and the run fails", async ({ request }, testInfo) => {
  const lost = await seed(request, await png(800, 500));
  const unrecorded = await seed(request, await jpeg(400, 300));
  const whole = await seed(request, await webp(500, 300));
  expect((await control(request, "/remove-object", { path: lost.path })).ok()).toBe(true);
  expect((await control(request, "/remove-content-document", { id: unrecorded.id })).ok()).toBe(true);
  const untouched = await store(request);

  const result = await fill(request, testInfo, ["--apply"]);
  expect(result.code).toBe(1);
  expect(outcomeOf(result, lost)).toBe("missing");
  expect(outcomeOf(result, unrecorded)).toBe("no document: document missing");
  expect(outcomeOf(result, whole)).toBe("filled 128,320,500");
  expect(result.lines.at(-1)).toBe("filled 1, already filled 0, recorded empty 0, failed 0, missing 1, no document 1");
  const stored = await store(request);
  expect(stored.objects.filter(object => !object.name.includes(whole.sha1))).toEqual(untouched.objects.filter(object => !object.name.includes(whole.sha1)));
  expect(stored.documents.filter(document => document.id !== whole.id)).toEqual(untouched.documents.filter(document => document.id !== whole.id));
  expect(recordOf(stored, whole).sizes).toEqual([128, 320, 500]);
});

test("an image over its format's pixel limit and one whose pixels cannot be read fail with the reason and record nothing, until the operator records no sizes", async ({ request }, testInfo) => {
  const oversized = await seed(request, await largeAvif(6000, 6001));
  const broken = await seed(request, await cutShort(800, 500));
  const untouched = await store(request);
  expect(untouched.documents.map(document => document.sizes)).toEqual([null, null]);

  for (const [args, counts] of [[[], "to fill 0, already filled 0, to record empty 0"], [["--apply"], "filled 0, already filled 0, recorded empty 0"]]) {
    const result = await fill(request, testInfo, args);
    expect(outcomeOf(result, oversized)).toBe(`failed: ${INVALID_MESSAGE}`);
    expect(outcomeOf(result, broken)).toBe(`failed: ${UNREADABLE_MESSAGE}`);
    expect(result.lines.at(-1)).toBe(`${counts}, failed 2, missing 0, no document 0`);
    expect(result.code).toBe(1);
    expect(await store(request)).toEqual(untouched);
  }

  const byHand = await control(request, "/record-no-image-sizes", { id: broken.id });
  expect(await byHand.json()).toEqual({ recorded: true, sizes: [] });
  const again = await fill(request, testInfo, ["--apply"]);
  expect(outcomeOf(again, broken)).toBe("already filled");
  expect(outcomeOf(again, oversized)).toBe(`failed: ${INVALID_MESSAGE}`);
  expect(again.lines.at(-1)).toBe("filled 0, already filled 1, recorded empty 0, failed 1, missing 0, no document 0");
  expect(again.code).toBe(1);
  const stored = await store(request);
  expect(stored.objects).toEqual(untouched.objects);
  expect(recordOf(stored, broken)).toMatchObject({ sizes: [], dimensions: recordOf(untouched, broken).dimensions });
  expect(recordOf(stored, oversized)).toEqual(recordOf(untouched, oversized));
});

test("a run killed while it stores a size records nothing, and the next run completes the image", async ({ request }, testInfo) => {
  const image = await seed(request, await png(800, 500));
  const untouched = await store(request);
  await failStorage(request, [refusedSizeUpload(image, 640, true)]);
  const { child, finished } = await startFill(request, testInfo, ["--apply"]);
  try {
    await expect.poll(async () => (await (await control(request, "/storage-holds")).json()).held).toBe(1);
    child.kill("SIGKILL");
    expect(await finished).toMatchObject({ code: null, signal: "SIGKILL" });
    expect(await (await control(request, "/storage-release", {})).json()).toEqual({ released: 1 });
  } finally {
    child.kill("SIGKILL");
    await control(request, "/storage-release", {});
    await failStorage(request, []);
  }
  expect((await store(request)).documents).toEqual(untouched.documents);

  const rerun = await fill(request, testInfo, ["--apply"]);
  expect(rerun.code).toBe(0);
  expect(outcomeOf(rerun, image)).toBe("filled 128,320,640,800");
  const stored = await store(request);
  expect(filesOf(stored, image)).toEqual(filesFor(image, recordOf(stored, image).sizes));
  expect(recordOf(stored, image).sizes).toEqual([128, 320, 640, 800]);
  await expectStoredSizes(request, image, [128, 320, 640, 800]);
});

test("an apply while content writes are paused is refused before anything is read or written", async ({ request }, testInfo) => {
  await seed(request, await png(800, 500));
  const untouched = await store(request);
  const refused = await fill(request, testInfo, ["--apply"], { CMS_WRITES_PAUSED: "1" });
  expect(refused).toMatchObject({ code: 1, stdout: "" });
  expect(refused.stderr).toContain("CMS_WRITES_PAUSED: Content publishing is paused.");
  expect(await store(request)).toEqual(untouched);
});

test("an image whose shape differs from its record fails and keeps its record, in a run and when it is uploaded again", async ({ page, request }, testInfo) => {
  const image = await seed(request, { ...(await turnedJpeg(600, 1000)), width: 1000, height: 600 });
  const untouched = await store(request);

  const result = await fill(request, testInfo, ["--apply"]);
  expect(result.code).toBe(1);
  expect(outcomeOf(result, image)).toBe("failed: shape differs");
  expect(result.lines.at(-1)).toBe("filled 0, already filled 0, recorded empty 0, failed 1, missing 0, no document 0");
  expect(await store(request)).toEqual(untouched);

  const uploadAgain = await openReviewUpload(page, image);
  expect((await uploadAgain()).steps).toEqual(["upload"]);
  expect(await store(request)).toEqual(untouched);
});

test("an image uploaded before sizes existed gets them when it is uploaded again", async ({ page, request }) => {
  const image = await seed(request, await png(800, 500));
  const untouched = await store(request);
  const uploadAgain = await openReviewUpload(page, image);

  expect((await uploadAgain()).steps).toEqual(["upload", "finalize"]);
  const stored = await store(request);
  expect(filesOf(stored, image)).toEqual(filesFor(image, [128, 320, 640, 800]));
  expect(stored.objects.filter(object => !SIZE_FILE.test(object.name))).toEqual(untouched.objects);
  expect(recordOf(stored, image)).toMatchObject({ sizes: [128, 320, 640, 800], dimensions: recordOf(untouched, image).dimensions });
  await expectStoredSizes(request, image, [128, 320, 640, 800]);

  expect((await uploadAgain()).steps).toEqual(["upload"]);
  expect(await store(request)).toEqual(stored);
});

test("a live image with no record gets its record and its sizes when the same file is uploaded into the field that holds it", async ({ context, page, request, baseURL }, testInfo) => {
  const gate = createContentGate(request, baseURL);
  const member = await seed(request, await png(512, 512), { document: false });
  const reviewer = await seed(request, await png(504, 504), { document: false });
  const images = [member, reviewer];
  expect(images.map(storedWidths)).toEqual([[128, 320, 512], [128, 320, 504]]);
  const held = image => ({ _type: "image", asset: { _type: "reference", _ref: image.id } });
  const documents = ["tooling-meetTheTeam", "tooling-proReviewsCarousel"];
  const revisions = () => Promise.all(documents.map(async id => (await gate.document(id)).revision));
  await gate.publish(await gate.document(documents[0]), { sections: [{ _key: "crew", title: "Fixture crew", variant: "standard", cards: [{ _key: "member", name: "Fixture member", title: "Fixture role", bio: "Fixture bio", avatar: held(member) }] }] });
  await gate.publish(await gate.document(documents[1]), { reviews: [{ _key: "reviewer", name: "Fixture reviewer", text: "Fixture review", rating: 5, pfp: held(reviewer) }] });
  const published = await revisions();
  const places = [{ path: "/meet-the-team", type: "Meet The Team Page", image: member }, { path: "/", type: "Pro Reviews Carousel", image: reviewer }];
  const site = await context.newPage();

  const untouched = await store(request);
  const plan = await fill(request, testInfo, []);
  for (const image of images) expect(outcomeOf(plan, image)).toBe("no document: document missing");
  expect(plan.lines.at(-1)).toBe("to fill 0, already filled 0, to record empty 0, failed 0, missing 0, no document 2");
  expect(plan.code).toBe(1);
  expect(await store(request)).toEqual(untouched);
  expect(untouched.objects.map(object => object.name)).toEqual(images.map(image => image.path).sort());
  expect(untouched.documents).toEqual([]);
  for (const image of images) expect(await assetOf(request, image)).toEqual({ document: null, assets: 1 });
  for (const { path, image } of places) {
    const resized = await openPage(gate, site, path, image);
    await expect(resized.shown).toHaveAttribute("src", new RegExp(`${RESIZE_PATH}public/site-content-public/${image.path.replace(".", "\\.")}`));
    expect(resized.requested.filter(address => address.includes(RESIZE_PATH) && address.includes(image.sha1)).length).toBeGreaterThan(0);
  }

  await login(page);
  await (await context.newCDPSession(page)).send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 256 * 1024 });
  const uploadAgain = async ({ type, image }) => {
    const editor = await openEditor(page, type);
    const outcome = await uploadInto(page, imageFields(editor).filter({ has: page.locator(`img[src$="/${image.path}"]`) }), image);
    await expect(editor.getByText("Unpublished changes")).toHaveCount(0);
    return outcome;
  };
  for (const place of places) expect(await uploadAgain(place)).toEqual({ steps: ["upload", "finalize"], shown: ["Checking file…", "Preparing upload…", "Uploading…", "Verifying on the server…"], issued: expect.objectContaining({ ok: true, uploadId: expect.any(String) }) });
  const origin = (await (await control(request, "/fixture")).json()).origins[1];
  const recorded = await store(request);
  for (const image of images) {
    expect(await assetOf(request, image)).toEqual({ assets: 1, document: expect.objectContaining({
      _id: image.id, _type: "sanity.imageAsset", url: `${origin}${PUBLIC_PATH}${image.path}`, sha1hash: image.sha1, size: image.buffer.length, mimeType: "image/png", extension: "png",
      metadata: { dimensions: { width: image.width, height: image.height, aspectRatio: 1 }, sizes: storedWidths(image) },
    }) });
    expect(filesOf(recorded, image)).toEqual(filesFor(image, storedWidths(image)));
    await expectStoredSizes(request, image, storedWidths(image));
  }
  expect(recorded.documents.map(document => document.id).sort()).toEqual(images.map(image => image.id).sort());
  expect(recorded.objects.filter(object => !SIZE_FILE.test(object.name))).toEqual(untouched.objects);
  expect(await revisions()).toEqual(published);

  await gate.publish(await gate.document("tooling-hero"), { subtext: "Fixture subtext after the images were uploaded again" });
  for (const { path, image } of places) {
    const stored = await openPage(gate, site, path, image);
    await expect(stored.shown).toHaveAttribute("src", new RegExp(`${PUBLIC_PATH}images/${image.sha1}-w\\d+\\.webp(\\?frame=1)?$`));
    await expect.poll(() => stored.shown.evaluate(shown => shown.naturalWidth > 0 && shown.currentSrc)).toMatch(SIZE_FILE);
    expect(stored.addresses.filter(address => address.includes(RESIZE_PATH))).toEqual([]);
    expect(stored.requested.filter(address => address.includes(RESIZE_PATH))).toEqual([]);
  }

  for (const place of places) expect(await uploadAgain(place)).toEqual({ steps: ["upload"], shown: ["Checking file…", "Preparing upload…"], issued: expect.objectContaining({ ok: true, alreadyExists: true, uploadId: null, assetId: place.image.id }) });
  expect(await store(request)).toEqual(recorded);
  expect(await revisions()).toEqual(published);

  const filled = await fill(request, testInfo, ["--apply"]);
  expect(filled.code).toBe(0);
  for (const image of images) expect(outcomeOf(filled, image)).toBe(`already filled${listed(storedWidths(image))}`);
  expect(filled.lines.at(-1)).toBe("filled 0, already filled 2, recorded empty 0, failed 0, missing 0, no document 0");
  expect(await imagesWithoutSizes(request)).toEqual([]);
  expect(await store(request)).toEqual(recorded);
});

test("the service key cannot write an asset row without its record, on its own or inside a publish", async ({ request }) => {
  const image = await png(64, 64);
  const sha1 = createHash("sha1").update(image.buffer).digest("hex");
  const id = `image-${sha1}-64x64-png`;
  const row = {
    legacy_sanity_asset_id: id, storage_bucket: "site-content-public", storage_path: `images/${sha1}.png`, source_url: `https://cdn.sanity.io/images/fixture/production/${sha1}-64x64.png`,
    mime_type: "image/png", byte_size: image.buffer.length, sha256: createHash("sha256").update(image.buffer).digest("hex"), width: 64, height: 64, metadata: { source_sha1: sha1 },
  };
  const review = `fixture-review-${sha1}`;
  const command = createHash("sha256").update(review).digest("hex");
  const answer = async response => ({ status: response.status(), ...(await response.json()) });
  const direct = await answer(await storeRpc(request, "roo_upsert_asset", { p_asset: row }));
  const published = await answer(await storeRpc(request, "roo_apply_cms_publish_command", {
    p_command_id: `cms:${command}`, p_request_hash: command, p_actor: "sanity:fixture", p_assets: [row], p_asset_links: [],
    p_mutations: [{ operation: "create", id: review, document: { _id: review, _type: "review", title: "Fixture review", image: { _type: "image", asset: { _type: "reference", _ref: id } } } }],
  }));
  expect({ direct, published }).toMatchObject({ direct: { status: 403, code: "42501" }, published: { status: 409, code: "23503", message: "CMS_ASSET_RECORD_MISSING" } });
  expect(await assetOf(request, { id })).toEqual({ document: null, assets: 0 });
  expect(await assetOf(request, { id: review })).toEqual({ document: null, assets: 0 });
});
