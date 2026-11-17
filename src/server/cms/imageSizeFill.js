import { CMS_UPLOAD_LIMITS, detectBytes, makeSizes, objectMissing, readBytes, storeImageSizes } from "./assets.js";
import { imageSizePath } from "./imageSizes.js";

const IMAGE_BUCKET = "site-content-public";
const IMAGE_PATH = /^images\/([a-f0-9]{40})\.[a-z0-9]+$/;
const IMAGE_PAGE_SIZE = 100;
const STORAGE_UNAVAILABLE = "ASSET_STORAGE_UNAVAILABLE";
const UNREADABLE = "ASSET_VERIFICATION_FAILED";
const REFUSED_BYTES = new Set([UNREADABLE, "ASSET_TOO_LARGE", "ASSET_TYPE_REFUSED"]);

const failed = (reason) => ({ outcome: "failed", reason });
const storageFailure = (error) => {
  if (error.code === STORAGE_UNAVAILABLE) return failed("storage");
  if (REFUSED_BYTES.has(error.code)) return failed(error.message);
  throw error;
};

export async function* imagesToFill(client) {
  let after = null;
  for (;;) {
    const { data, error } = await client.rpc("roo_cms_image_size_records", { p_after: after, p_limit: IMAGE_PAGE_SIZE });
    if (error) throw Object.assign(new Error(`Image listing failed: ${error.message}`), { code: error.code });
    if (!data.length) return;
    yield* data;
    after = data.at(-1).id;
  }
}

const makeOrEmpty = async (original, image) => {
  try {
    const detected = await detectBytes(original.bytes);
    if (detected.kind !== "image") return failed("bytes are not an image");
    if (detected.width !== image.width || detected.height !== image.height) return failed("shape differs");
    const made = await makeSizes(original.bytes, detected);
    return { made, ...(made.length ? {} : { reason: "vector or animated" }) };
  } catch (error) {
    if (error.code === UNREADABLE) return failed(error.message);
    if (error.code === STORAGE_UNAVAILABLE) return failed("making sizes timed out");
    throw error;
  }
};

export const fillImageSizes = async ({ client, image, apply }) => {
  if (image.sizes) return { outcome: "already filled", sizes: image.sizes };
  if (image.document !== "present") return { outcome: "no document", reason: `document ${image.document}` };
  const sha1 = image.storage_bucket === IMAGE_BUCKET ? IMAGE_PATH.exec(image.storage_path)?.[1] : null;
  if (!sha1) return failed("path is not images/<sha1>.<extension>");
  const stored = await client.storage.from(image.storage_bucket).info(image.storage_path);
  if (stored.error) return objectMissing(stored.error) ? { outcome: "missing" } : failed("storage");
  let original;
  try { original = await readBytes(client, image.storage_bucket, image.storage_path, CMS_UPLOAD_LIMITS.image); }
  catch (error) { return storageFailure(error); }
  if (original.sha1 !== sha1 || original.sha256 !== image.sha256 || original.byteSize !== Number(image.byte_size)) return failed("bytes disagree");
  const plan = await makeOrEmpty(original, image);
  if (!plan.made) return plan;
  const { made, reason } = plan;
  const sizes = made.map((size) => size.width);
  const result = { sizes, ...(reason ? { reason } : {}), files: made.map((size) => ({ path: imageSizePath(sha1, size.width), bytes: size.bytes })) };
  if (!apply) return { outcome: sizes.length ? "to fill" : "to record empty", ...result };
  try { await storeImageSizes({ client, bucket: image.storage_bucket, upload: original, sizes: made }); }
  catch (error) { return storageFailure(error); }
  const recorded = await client.rpc("roo_record_cms_image_sizes", { p_asset_id: image.id, p_sizes: sizes });
  if (recorded.error) return failed(`record ${[recorded.error.code, recorded.error.message].filter(Boolean).join(" ")}`);
  if (!recorded.data.recorded) return { outcome: "already filled", sizes: recorded.data.sizes };
  return { outcome: sizes.length ? "filled" : "recorded empty", ...result };
};
