import sharp from "sharp";
import { IMAGE_SIZE_WIDTHS, imageSizeFile } from "../../lib/imageSizeLadder.js";

export const IMAGE_SIZE_QUALITY = 75;
export const IMAGE_SIZE_MIME_TYPE = "image/webp";
export const IMAGE_SIZE_CACHE_SECONDS = 365 * 24 * 60 * 60;
const IMAGE_SIZE_TIMEOUT_SECONDS = 30;
const TIMEOUT_MESSAGE = /timeout: \d+% complete/;
const SIZED_EXTENSIONS = new Set(["png", "jpg", "gif", "webp", "avif"]);

export const isImageSizeTimeout = (error) => TIMEOUT_MESSAGE.test(String(error?.message));
export const imageSizePath = (sha1, width) => imageSizeFile(`images/${sha1}`, width);

const decode = (bytes) =>
  sharp(bytes, { failOn: "error", limitInputPixels: 100000000 }).timeout({ seconds: IMAGE_SIZE_TIMEOUT_SECONDS });

export const makeImageSizes = async ({ bytes, extension, width }) => {
  if (!SIZED_EXTENSIONS.has(extension)) return [];
  const { pages = 1 } = await decode(bytes).metadata();
  if (pages > 1) return [];
  const widest = Math.min(width, IMAGE_SIZE_WIDTHS.at(-1));
  const { data, info } = await decode(bytes).autoOrient().resize({ width: widest }).raw().toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels };
  const sizes = [];
  for (const step of [...IMAGE_SIZE_WIDTHS.filter((candidate) => candidate < widest), widest]) {
    sizes.push({
      width: step,
      bytes: await sharp(data, { raw }).resize({ width: step }).webp({ quality: IMAGE_SIZE_QUALITY }).toBuffer(),
    });
  }
  return sizes;
};
