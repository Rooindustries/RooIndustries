import { createDocumentReadClient } from "../data/documentClient.js";
import {
  resolveBookingFromSubmittedOrderId,
  isBookingDocument,
} from "../api/ref/orderResolver.js";
import {
  getDownloadBySlug,
  getPublicDownloadInfo,
} from "./downloadCatalog.js";
import { isDownloadAvailable } from "./downloadStorage.js";
import {
  createDownloadToken,
  DOWNLOAD_TOKEN_TTL_SECONDS,
  hashDownloadEmail,
} from "./downloadToken.js";

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const normalizeText = (value) =>
  String(value || "").trim().replace(/\s+/g, " ").toLowerCase();

export const createDownloadDataClient = (env = process.env) =>
  createDocumentReadClient({ env, domain: "commerce" });

export const isPaidBookingStatus = (status = "") => {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "captured" || normalized === "completed";
};

export const validateBookingForDownload = ({ booking, email, download }) => {
  if (!isBookingDocument(booking)) {
    return {
      ok: false,
      status: 404,
      error: "No paid booking found with that Order ID.",
    };
  }

  const normalizedEmail = normalizeEmail(email);
  const allowedEmails = [booking.email, booking.payerEmail]
    .map(normalizeEmail)
    .filter(Boolean);

  if (allowedEmails.length > 0 && !allowedEmails.includes(normalizedEmail)) {
    return {
      ok: false,
      status: 404,
      error: "No paid booking found with that Order ID.",
    };
  }

  if (!isPaidBookingStatus(booking.status)) {
    return {
      ok: false,
      status: 400,
      error:
        "This booking is not marked as paid yet. Only paid bookings can access this download.",
    };
  }

  const allowedPackages = (download?.allowedPackageTitles || [])
    .map(normalizeText)
    .filter(Boolean);

  if (allowedPackages.length > 0) {
    const bookingPackage = normalizeText(booking.packageTitle);
    const packageAllowed = allowedPackages.some(
      (item) => item === bookingPackage || bookingPackage.includes(item)
    );

    if (!packageAllowed) {
      return {
        ok: false,
        status: 403,
        error: "This booking is not eligible for this download.",
      };
    }
  }

  return { ok: true };
};

export const validateBookingForDownloadToken = ({
  booking,
  emailHash,
  download,
}) => {
  if (!isBookingDocument(booking)) {
    return {
      ok: false,
      status: 404,
      error: "Download access could not be verified.",
    };
  }

  const allowedEmailHashes = [booking.email, booking.payerEmail]
    .map(normalizeEmail)
    .filter(Boolean)
    .map(hashDownloadEmail)
    .filter(Boolean);

  if (allowedEmailHashes.length > 0 && !allowedEmailHashes.includes(emailHash)) {
    return {
      ok: false,
      status: 403,
      error: "Download access could not be verified.",
    };
  }

  return validateBookingForDownload({
    booking,
    email: booking.email || booking.payerEmail || "verified@example.invalid",
    download,
  });
};

export const validateDownloadAccess = async ({
  slug = "",
  orderId = "",
  email = "",
  client = createDownloadDataClient(),
  env = process.env,
  nowMs = Date.now(),
  availabilityCheck = isDownloadAvailable,
}) => {
  const download = getDownloadBySlug(slug, env);
  if (!download) {
    return {
      status: 404,
      body: { ok: false, error: "Download link not found." },
    };
  }

  const normalizedOrderId = String(orderId || "").trim();
  if (!normalizedOrderId) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "Please enter the Order ID from your confirmation email.",
      },
    };
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "Please enter the email used on the booking.",
      },
    };
  }

  if (!(await availabilityCheck(download, env))) {
    return {
      status: 404,
      body: {
        ok: false,
        error: "This download file is not available yet. Please contact support.",
      },
    };
  }

  const booking = await resolveBookingFromSubmittedOrderId({
    id: normalizedOrderId,
    client,
  });
  const bookingValidation = validateBookingForDownload({
    booking,
    email: normalizedEmail,
    download,
  });

  if (!bookingValidation.ok) {
    return {
      status: bookingValidation.status,
      body: { ok: false, error: bookingValidation.error },
    };
  }

  const token = createDownloadToken({
    slug: download.slug,
    fileName: download.fileName,
    bookingId: booking._id,
    email: normalizedEmail,
    issuedAtMs: nowMs,
    ttlSeconds: DOWNLOAD_TOKEN_TTL_SECONDS,
    env,
  });

  return {
    status: 200,
    downloadToken: token,
    body: {
      ok: true,
      download: getPublicDownloadInfo(download),
      booking: {
        id: booking._id,
        packageTitle: booking.packageTitle || "",
      },
      downloadUrl: "/api/downloads/file",
      expiresAt: new Date(nowMs + DOWNLOAD_TOKEN_TTL_SECONDS * 1000).toISOString(),
    },
  };
};
