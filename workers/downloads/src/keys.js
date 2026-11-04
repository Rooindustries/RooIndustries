const CONTENT_TYPES = new Map([
  ["exe", "application/vnd.microsoft.portable-executable"],
  ["msi", "application/x-msi"],
  ["zip", "application/zip"],
  ["7z", "application/x-7z-compressed"],
]);

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SEGMENTS = 8;

const extensionOf = (key) => key.slice(key.lastIndexOf(".") + 1).toLowerCase();

export const contentTypeFor = (key) => CONTENT_TYPES.get(extensionOf(key));

export const fileNameOf = (key) => key.slice(key.lastIndexOf("/") + 1);

export const isDownloadKey = (key) => {
  const segments = key.split("/");
  return (
    segments.length <= MAX_SEGMENTS &&
    segments.every((segment) => SEGMENT.test(segment)) &&
    CONTENT_TYPES.has(extensionOf(key))
  );
};
