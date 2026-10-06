export const IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;
export const FILE_LIMIT_BYTES = 64 * 1024 * 1024;

const IMAGE_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["gif", "image/gif"],
  ["svg", "image/svg+xml"],
]);

const FILE_TYPES = new Map([
  ["zip", "application/zip"],
  ["exe", "application/x-msdownload"],
]);

export const acceptFor = (kind) =>
  kind === "image"
    ? [...new Set(IMAGE_TYPES.values())].join(",")
    : ".zip,.exe,application/zip,application/x-zip-compressed,application/x-msdownload,application/vnd.microsoft.portable-executable";

const extensionOf = (name) => String(name || "").toLowerCase().split(".").pop() || "";

export const describeFile = (kind, file) => {
  const extension = extensionOf(file.name);
  const types = kind === "image" ? IMAGE_TYPES : FILE_TYPES;
  const mimeType = types.get(extension) || "";
  const limit = kind === "image" ? IMAGE_LIMIT_BYTES : FILE_LIMIT_BYTES;
  if (!mimeType) {
    return {
      error:
        kind === "image"
          ? "Use a PNG, JPEG, WebP, AVIF, GIF or SVG image."
          : "Use a .zip or .exe file.",
    };
  }
  if (file.size <= 0) return { error: "The file is empty." };
  if (file.size > limit) {
    return { error: `The file is larger than ${Math.round(limit / 1024 / 1024)} MB.` };
  }
  return { mimeType, limit };
};

const hex = (buffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

export const hashFile = async (file) => {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Uploads need a secure (HTTPS) connection to this admin page.");
  }
  const bytes = await file.arrayBuffer();
  const [sha1, sha256] = await Promise.all([
    crypto.subtle.digest("SHA-1", bytes),
    crypto.subtle.digest("SHA-256", bytes),
  ]);
  return { sha1: hex(sha1), sha256: hex(sha256) };
};

export const imageDimensions = (file) =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const result = { width: image.naturalWidth || undefined, height: image.naturalHeight || undefined };
      URL.revokeObjectURL(url);
      resolve(result);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({});
    };
    image.src = url;
  });

export const putToSignedUrl = ({ signedUrl, file, mimeType, onProgress, signal }) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Upload cancelled."), { name: "AbortError" }));
      return;
    }
    const request = new XMLHttpRequest();
    request.open("PUT", signedUrl);
    request.setRequestHeader("Content-Type", mimeType);
    request.setRequestHeader("x-upsert", "false");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      let message = `Upload failed (${request.status}).`;
      try {
        const body = JSON.parse(request.responseText || "{}");
        if (body?.message || body?.error) message = `Upload refused: ${body.message || body.error}`;
      } catch {
        message = `Upload failed (${request.status}).`;
      }
      reject(new Error(message));
    };
    request.onerror = () => reject(new Error("The upload connection failed. Try again."));
    request.onabort = () => reject(Object.assign(new Error("Upload cancelled."), { name: "AbortError" }));
    signal?.addEventListener("abort", () => request.abort(), { once: true });
    request.send(file);
  });
