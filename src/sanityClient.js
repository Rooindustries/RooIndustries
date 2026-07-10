import { createImageUrlBuilder } from "@sanity/image-url";

const publicDataset =
  process.env.NEXT_PUBLIC_SANITY_PUBLIC_DATASET ||
  process.env.NEXT_PUBLIC_SANITY_DATASET ||
  "production";
const publicProjectId =
  process.env.NEXT_PUBLIC_SANITY_PUBLIC_PROJECT_ID ||
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ||
  "9g42k3ur";
const builder = createImageUrlBuilder({
  projectId: publicProjectId,
  dataset: publicDataset,
});

export const urlFor = (source) => builder.image(source);
export const publicUrlFor = urlFor;
