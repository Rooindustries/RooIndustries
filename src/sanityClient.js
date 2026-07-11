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

class DirectAssetUrlBuilder {
  constructor(url) {
    this.directUrl = url;
  }

  width() {
    return this;
  }

  height() {
    return this;
  }

  fit() {
    return this;
  }

  format() {
    return this;
  }

  quality() {
    return this;
  }

  url() {
    return this.directUrl;
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
