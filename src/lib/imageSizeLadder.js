export const IMAGE_SIZE_WIDTHS = Object.freeze([128, 320, 640, 960, 1280]);

export const imageSizeFile = (original, width) => `${original}-w${width}.webp`;

export const imageSrcSet = (image, buildUrl) => {
  if (!image) return undefined;
  const sources = (image.sizes?.length ? image.sizes : IMAGE_SIZE_WIDTHS).map(
    (width) => ({ url: buildUrl(image, width), width })
  );
  if (new Set(sources.map(({ url }) => url)).size < 2) return undefined;
  return sources.map(({ url, width }) => `${url} ${width}w`).join(", ");
};
