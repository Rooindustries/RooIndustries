import { cleanOutsideValue } from "./outsideValue.cjs";
import { hasUsableShape, imageSizeFile, storedHeight } from "./imageSizeLadder.js";
const SUPABASE_PUBLIC_IMAGE_PATH = "/storage/v1/object/public/";
const SUPABASE_RENDER_IMAGE_PATH = "/storage/v1/render/image/public/";
const TRANSFORMABLE_IMAGE_PATH = /\.(?:gif|jpe?g|png)$/i;
const IMAGE_EXTENSION = /\.[a-z0-9]+$/i;
const RESIZE_MODE_BY_FIT = Object.freeze({
  crop: "cover",
  fill: "fill",
  max: "contain",
  min: "cover",
});

const normalizedInteger = (value, minimum, maximum) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
};

const transformedSupabaseUrl = (directUrl, transforms, forceTransform) => {
  if (!directUrl) return null;
  try {
    const url = new URL(directUrl);
    if (
      !forceTransform ||
      !url.pathname.includes(SUPABASE_PUBLIC_IMAGE_PATH) ||
      !TRANSFORMABLE_IMAGE_PATH.test(url.pathname)
    ) {
      return directUrl;
    }

    url.pathname = url.pathname.replace(
      SUPABASE_PUBLIC_IMAGE_PATH,
      SUPABASE_RENDER_IMAGE_PATH
    );
    Object.entries(transforms).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  } catch {
    return directUrl;
  }
};

const storedSizeUrl = (directUrl, sizes, shape, { width, height, resize }) => {
  const cropped = height && resize === "cover" && hasUsableShape(shape);
  return imageSizeFile(
    directUrl.replace(IMAGE_EXTENSION, ""),
    sizes.find((size) => size >= width && (!cropped || storedHeight(size, shape) >= height)) ?? sizes.at(-1)
  );
};

class DirectAssetUrlBuilder {
  constructor(url, transforms = {}, forceTransform = false, sizes = null, shape = null) {
    this.directUrl = url;
    this.transforms = { ...transforms };
    this.forceTransform = forceTransform;
    this.sizes = sizes;
    this.shape = shape;
  }

  withTransform(key, value) {
    if (value === null || value === undefined || value === "") return this;
    return new DirectAssetUrlBuilder(
      this.directUrl,
      { ...this.transforms, [key]: value },
      true,
      this.sizes,
      this.shape
    );
  }

  width(value) {
    return this.withTransform("width", normalizedInteger(value, 1, 5000));
  }

  height(value) {
    return this.withTransform("height", normalizedInteger(value, 1, 5000));
  }

  fit(value) {
    return this.withTransform(
      "resize",
      RESIZE_MODE_BY_FIT[String(value || "").trim().toLowerCase()] || null
    );
  }

  format(value) {
    const format = String(value || "").trim().toLowerCase();
    if (format === "origin") return this.withTransform("format", "origin");
    if (format !== "webp") return this;
    return new DirectAssetUrlBuilder(
      this.directUrl,
      this.transforms,
      true,
      this.sizes,
      this.shape
    );
  }

  quality(value) {
    return this.withTransform("quality", normalizedInteger(value, 20, 100));
  }

  url() {
    if (!this.directUrl || !this.sizes) {
      return transformedSupabaseUrl(
        this.directUrl,
        this.transforms,
        this.forceTransform
      );
    }
    return this.sizes.length && this.transforms.width
      ? storedSizeUrl(this.directUrl, this.sizes, this.shape, this.transforms)
      : this.directUrl;
  }
}

const loggedMissing = new Set();
const publicSupabaseOrigin = cleanOutsideValue(process.env.NEXT_PUBLIC_SUPABASE_URL);
const safeImageUrl = (value) => {
  if (typeof value !== "string" || !value) return null;
  if (/^\/(?!\/)/.test(value) && !value.includes("..")) return value;
  try {
    const url = new URL(value);
    const configuredOrigin = publicSupabaseOrigin ? new URL(publicSupabaseOrigin).origin : null;
    if (url.username || url.password || !["https:", "http:"].includes(url.protocol) || !(url.origin === configuredOrigin || url.hostname.endsWith(".supabase.co")) || !/^\/storage\/v1\/(?:object|render\/image)\/public\/site-content-public\//.test(url.pathname)) return null;
    return value;
  } catch { return null; }
};
export const urlFor = (source) => {
  const value = typeof source === "string" ? source : source?._supabaseUrl || source?.asset?._supabaseUrl;
  const directUrl = safeImageUrl(value);
  if (!directUrl) {
    const key = typeof source === "object" ? source?.asset?._ref || source?._ref || "unmapped-image" : "unmapped-image";
    if (!loggedMissing.has(key) && loggedMissing.size < 1000) {
      loggedMissing.add(key);
      console.warn("CMS image has no verified Supabase copy.");
    }
  }
  return new DirectAssetUrlBuilder(
    directUrl,
    {},
    false,
    Array.isArray(source?.sizes) ? source.sizes : null,
    source?.dimensions
  );
};

