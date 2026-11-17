export const recordedShape = (dimensions) =>
  dimensions?.width && dimensions?.height
    ? { aspectRatio: `${dimensions.width} / ${dimensions.height}` }
    : undefined;
