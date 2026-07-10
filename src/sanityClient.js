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

export const urlFor = (source) => builder.image(source);
export const publicUrlFor = urlFor;
