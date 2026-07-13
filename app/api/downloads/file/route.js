import { createDownloadSanityClient } from "@/src/server/downloads/downloadAccess";
import { getDownloadBySlug } from "@/src/server/downloads/downloadCatalog";
import {
  validateBookingForDownloadToken,
} from "@/src/server/downloads/downloadAccess";
import {
  createSignedBlobDownloadUrl,
  DOWNLOAD_STORAGE_BLOB,
  getDownloadStorageBackend,
  streamDownload,
} from "@/src/server/downloads/downloadStorage";
import { verifyDownloadToken } from "@/src/server/downloads/downloadToken";
import { logSafeError } from "@/src/server/safeErrorLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const textHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

const safeHeaderFileName = (value) =>
  String(value || "download.zip").replace(/[^\w.\- ]+/g, "_");

const contentDisposition = (fileName) => {
  const safeName = safeHeaderFileName(fileName);
  return `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(
    safeName
  )}`;
};

const textResponse = (message, status = 400) =>
  new Response(message, {
    status,
    headers: {
      ...textHeaders,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });

const clearAccessCookie = () =>
  [
    "download_access=",
    "Path=/api/downloads/file",
    "HttpOnly",
    "SameSite=Strict",
    process.env.NODE_ENV === "production" ? "Secure" : "",
    "Max-Age=0",
  ]
    .filter(Boolean)
    .join("; ");

const readCookie = (request, name) => {
  const prefix = `${name}=`;
  const match = String(request.headers.get("cookie") || "")
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  if (!match) return "";
  try {
    return decodeURIComponent(match.slice(prefix.length));
  } catch {
    return "";
  }
};

const readLegacyToken = (url) => {
  const deadline = new Date(
    String(process.env.PAYMENT_LEGACY_COMPLETION_UNTIL || "")
  ).getTime();
  if (!Number.isFinite(deadline) || deadline <= Date.now()) return "";
  return url.searchParams.get("token") || "";
};

export async function GET(request) {
  const url = new URL(request.url);
  const token = readCookie(request, "download_access") || readLegacyToken(url);
  if (url.searchParams.has("token") && !token) {
    return textResponse("This legacy download link expired.", 410);
  }
  const verified = verifyDownloadToken({ token });

  if (!verified.ok) {
    return textResponse("This download link is invalid or expired.", 403);
  }

  const download = getDownloadBySlug(verified.payload.slug);
  if (!download || download.fileName !== verified.payload.fileName) {
    return textResponse("Download not found.", 404);
  }

  const client = createDownloadSanityClient();
  const booking = await client.getDocument(verified.payload.bookingId);
  const access = validateBookingForDownloadToken({
    booking,
    emailHash: verified.payload.emailHash,
    download,
  });

  if (!access.ok) {
    return textResponse(access.error, access.status);
  }

  if (getDownloadStorageBackend(download) === DOWNLOAD_STORAGE_BLOB) {
    try {
      const signedUrl = await createSignedBlobDownloadUrl(download);
      return new Response(null, {
        status: 307,
        headers: {
          "Cache-Control": "private, no-store",
          Location: signedUrl,
          "Referrer-Policy": "no-referrer",
          "Set-Cookie": clearAccessCookie(),
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      logSafeError("Signed download URL failed", error);
      const suppliedStatus = Number(error?.status || 0);
      const status = suppliedStatus >= 400 && suppliedStatus < 500 ? suppliedStatus : 503;
      return textResponse("Download file is not available.", status);
    }
  }

  let downloadStream = null;
  try {
    downloadStream = await streamDownload(download);
  } catch (error) {
    logSafeError("Download stream failed", error);
    const suppliedStatus = Number(error?.status || 0);
    const status = suppliedStatus >= 400 && suppliedStatus < 500 ? suppliedStatus : 503;
    return textResponse("Download file is not available.", status);
  }

  const headers = {
    "Cache-Control": downloadStream.cacheControl || "private, no-store",
    "Content-Type": downloadStream.contentType || "application/zip",
    "Content-Disposition": contentDisposition(download.fileName),
    "X-Content-Type-Options": "nosniff",
    "Set-Cookie": clearAccessCookie(),
  };

  if (downloadStream.contentLength) {
    headers["Content-Length"] = String(downloadStream.contentLength);
  }
  if (downloadStream.etag) {
    headers.ETag = downloadStream.etag;
  }

  return new Response(downloadStream.stream, {
    status: 200,
    headers,
  });
}
