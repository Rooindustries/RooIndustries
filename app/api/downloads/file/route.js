import { createDownloadSanityClient } from "@/src/server/downloads/downloadAccess";
import { getDownloadBySlug } from "@/src/server/downloads/downloadCatalog";
import {
  validateBookingForDownloadToken,
} from "@/src/server/downloads/downloadAccess";
import { streamDownload } from "@/src/server/downloads/downloadStorage";
import { verifyDownloadToken } from "@/src/server/downloads/downloadToken";

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

export async function GET(request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
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

  let downloadStream = null;
  try {
    downloadStream = await streamDownload(download);
  } catch (error) {
    return textResponse(
      error?.message || "Download file is not available.",
      Number(error?.status) || 404
    );
  }

  const headers = {
    "Cache-Control": downloadStream.cacheControl || "private, no-store",
    "Content-Type": downloadStream.contentType || "application/zip",
    "Content-Disposition": contentDisposition(download.fileName),
    "X-Content-Type-Options": "nosniff",
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
