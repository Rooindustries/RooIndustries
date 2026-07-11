import { createImageUrlBuilder } from "@sanity/image-url";

const publicDataset = process.env.NEXT_PUBLIC_SANITY_DATASET || "production";
const publicProjectId =
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || "9g42k3ur";
// Keep asset URLs pinned to the real public dataset. Content queries use the
// fixed same-origin API so browser CORS settings cannot blank the site.
const builder = createImageUrlBuilder({
  projectId: publicProjectId,
  dataset: publicDataset,
});

const SUPABASE_PUBLIC_IMAGE_PATH = "/storage/v1/object/public/";
const SUPABASE_RENDER_IMAGE_PATH = "/storage/v1/render/image/public/";
const TRANSFORMABLE_IMAGE_PATH = /\.(?:gif|jpe?g|png)$/i;
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

class DirectAssetUrlBuilder {
  constructor(url, transforms = {}, forceTransform = false) {
    this.directUrl = url;
    this.transforms = { ...transforms };
    this.forceTransform = forceTransform;
  }

  withTransform(key, value) {
    if (value === null || value === undefined || value === "") return this;
    return new DirectAssetUrlBuilder(
      this.directUrl,
      { ...this.transforms, [key]: value },
      true
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
      true
    );
  }

  quality(value) {
    return this.withTransform("quality", normalizedInteger(value, 20, 100));
  }

  url() {
    return transformedSupabaseUrl(
      this.directUrl,
      this.transforms,
      this.forceTransform
    );
  }
}

const directAssetUrl = (source) =>
  String(
    source?._supabaseUrl ||
      source?.asset?._supabaseUrl ||
      source?.asset?.url ||
      ""
  ).trim();

export const urlFor = (source) => {
  const directUrl = directAssetUrl(source);
  return directUrl
    ? new DirectAssetUrlBuilder(directUrl)
    : builder.image(source);
};
export const publicUrlFor = urlFor;
