import sharp from "sharp";
import { IMAGE_SIZE_WIDTHS, imageSizeFile, storedHeight } from "../../lib/imageSizeLadder.js";

export const IMAGE_SIZE_QUALITY = 75;
export const IMAGE_SIZE_MIME_TYPE = "image/webp";
export const IMAGE_SIZE_CACHE_SECONDS = 365 * 24 * 60 * 60;
const IMAGE_SIZE_TIMEOUT_SECONDS = 30;
const TALLEST_IMAGE_SIZE = 16383;
const IMAGE_PIXEL_LIMIT = 100000000;
const AVIF_PIXEL_LIMIT = 36000000;
const TIMEOUT_MESSAGE = /timeout: \d+% complete/;
const SIZED_EXTENSIONS = new Set(["png", "jpg", "gif", "webp", "avif"]);

export const isImageSizeTimeout = (error) => TIMEOUT_MESSAGE.test(String(error?.message));
export const imageSizePath = (sha1, width) => imageSizeFile(`images/${sha1}`, width);

export const imagePixelLimit = (extension) => (extension === "avif" ? AVIF_PIXEL_LIMIT : IMAGE_PIXEL_LIMIT);

export const imageSizeWidths = ({ width, height }) => {
  const widest = Math.min(width, IMAGE_SIZE_WIDTHS.at(-1), Math.floor((TALLEST_IMAGE_SIZE * width) / height));
  return [...IMAGE_SIZE_WIDTHS.filter((step) => step < widest), widest];
};

const decode = (bytes, extension) =>
  sharp(bytes, { failOn: "error", limitInputPixels: imagePixelLimit(extension) }).timeout({ seconds: IMAGE_SIZE_TIMEOUT_SECONDS });

export const makeImageSizes = async ({ bytes, extension, width, height }) => {
  if (!SIZED_EXTENSIONS.has(extension)) return [];
  const { pages = 1 } = await decode(bytes, extension).metadata();
  if (pages > 1) return [];
  const widths = imageSizeWidths({ width, height });
  const exact = (step) => ({ width: step, height: storedHeight(step, { width, height }), fit: "fill" });
  const { data, info } = await decode(bytes, extension).autoOrient().resize(exact(widths.at(-1))).raw().toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels };
  const sizes = [];
  for (const step of widths) {
    sizes.push({
      width: step,
      bytes: await sharp(data, { raw }).resize(exact(step)).webp({ quality: IMAGE_SIZE_QUALITY }).toBuffer(),
    });
  }
  return sizes;
};
