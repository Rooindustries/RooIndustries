import { urlFor } from "./cmsImageUrl";
import { hasUsableShape, storedHeight } from "./imageSizeLadder";

export const croppedImageSrcSet = (image, boxWidth, boxHeight) => {
  if (!image?.sizes?.length) return undefined;
  const sources = [];
  for (const size of image.sizes) {
    const label = hasUsableShape(image.dimensions)
      ? Math.max(1, Math.min(size, Math.floor((storedHeight(size, image.dimensions) * boxWidth) / boxHeight)))
      : size;
    if (!sources.length || label > sources.at(-1).label) {
      sources.push({ label, url: urlFor(image).width(size).url() });
    }
  }
  if (sources.length < 2) return undefined;
  return sources.map(({ label, url }) => `${url} ${label}w`).join(", ");
};
