import { createClient } from "@sanity/client";
import {
  getPaidAmount,
  resolveUpgradeContext,
} from "./pricing.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import packageContent from "../../../lib/packageContent.js";
import packagePricing from "../../../lib/packagePricing.js";
import { issueUpgradeIntentToken } from "./upgradeIntentToken.js";

const { normalizePackageText } = packageContent;
const {
  TOP_PACKAGE_PUBLIC_TITLE,
  applyPackagePricing,
  getPackageTitleAliases,
} = packagePricing;

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const parseMoney = (value) =>
  parseFloat(String(value || "").replace(/[^0-9.]/g, "")) || 0;

const normalizeSlug = (value) => {
  if (!value) return "";
  if (Array.isArray(value)) return String(value[0] || "").toLowerCase();
  return String(value || "").toLowerCase();
};

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const normalizeSubmittedOrderId = (value) => String(value || "").trim();
const isBookingDocument = (doc) => doc?._type === "booking" && !!doc?._id;
const isPaymentRecordDocument = (doc) =>
  doc?._type === "paymentRecord" && !!doc?._id;

const fetchBookingByField = async ({ client, field, id }) => {
  if (!id) return null;
  return client.fetch(`*[_type == "booking" && ${field} == $id][0]`, { id });
};

const fetchPaymentRecordByField = async ({ client, field, id }) => {
  if (!id) return null;
  return client.fetch(`*[_type == "paymentRecord" && ${field} == $id][0]`, {
    id,
  });
};

const resolveBookingFromPaymentRecord = async ({ record, client }) => {
  if (!isPaymentRecordDocument(record)) return null;

  const bookingId = normalizeSubmittedOrderId(record.bookingId);
  if (bookingId) {
    const booking = await fetchBookingByField({
      client,
      field: "_id",
      id: bookingId,
    });
    if (isBookingDocument(booking)) return booking;
  }

  const provider = String(record.provider || "").trim().toLowerCase();
  const providerOrderId = normalizeSubmittedOrderId(record.providerOrderId);
  const providerPaymentId = normalizeSubmittedOrderId(record.providerPaymentId);

  if (provider === "paypal" && providerOrderId) {
    const booking = await fetchBookingByField({
      client,
      field: "paypalOrderId",
      id: providerOrderId,
    });
    if (isBookingDocument(booking)) return booking;
  }

  if (provider === "razorpay" && providerPaymentId) {
    const booking = await fetchBookingByField({
      client,
      field: "razorpayPaymentId",
      id: providerPaymentId,
    });
    if (isBookingDocument(booking)) return booking;
  }

  if (provider === "razorpay" && providerOrderId) {
    const booking = await fetchBookingByField({
      client,
      field: "razorpayOrderId",
      id: providerOrderId,
    });
    if (isBookingDocument(booking)) return booking;
  }

  return null;
};

export const resolveBookingFromSubmittedOrderId = async ({ id, client }) => {
  const normalizedId = normalizeSubmittedOrderId(id);
  if (!normalizedId || !client) return null;

  const directDocument = await client.getDocument(normalizedId);
  if (isBookingDocument(directDocument)) return directDocument;

  for (const field of [
    "orderId",
    "paypalOrderId",
    "razorpayOrderId",
    "razorpayPaymentId",
  ]) {
    const booking = await fetchBookingByField({
      client,
      field,
      id: normalizedId,
    });
    if (isBookingDocument(booking)) return booking;
  }

  for (const field of [
    "_id",
    "providerOrderId",
    "providerPaymentId",
    "bookingId",
  ]) {
    const directPaymentRecord =
      field === "_id" && isPaymentRecordDocument(directDocument)
        ? directDocument
        : null;
    const record =
      directPaymentRecord ||
      (await fetchPaymentRecordByField({
        client,
        field,
        id: normalizedId,
      }));
    const booking = await resolveBookingFromPaymentRecord({ record, client });
    if (isBookingDocument(booking)) return booking;
  }

  return null;
};

export default async function handler(req, res) {
  const method = String(req?.method || "GET").toUpperCase();
  const legacyGetDeadline = new Date(
    process.env.LEGACY_UPGRADE_GET_UNTIL ||
      process.env.PAYMENT_LEGACY_COMPLETION_UNTIL ||
      ""
  ).getTime();
  const allowLegacyGet =
    process.env.NODE_ENV === "test" ||
    (Number.isFinite(legacyGetDeadline) && legacyGetDeadline > Date.now());
  if (method !== "POST" && !(method === "GET" && allowLegacyGet)) {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const input = method === "POST" ? req.body || {} : req.query || {};

  const clientAddress = getClientAddress(req);
  const rateLimitKey = `get-upgrade-info:${clientAddress}:${String(
    input.id || ""
  ).trim().toLowerCase()}:${String(input.email || "")
    .trim()
    .toLowerCase()}`;
  if (
    !requireRateLimit(res, {
      key: rateLimitKey,
      max: 20,
      message: "Too many upgrade lookup requests. Please try again later.",
    })
  ) {
    return;
  }

  const { id, slug, email } = input;
  if (!id) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing Order ID (bookingId)." });
  }
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing booking email." });
  }

  try {
    const booking = await resolveBookingFromSubmittedOrderId({ id, client });

    if (!booking || booking._type !== "booking") {
      return res
        .status(404)
        .json({ ok: false, error: "No booking found with that Order ID." });
    }

    const allowedEmails = [booking.email, booking.payerEmail]
      .map(normalizeEmail)
      .filter(Boolean);

    if (
      allowedEmails.length === 0 ||
      !allowedEmails.includes(normalizedEmail)
    ) {
      return res
        .status(404)
        .json({ ok: false, error: "No booking found with that Order ID." });
    }

    const status = String(booking.status || "").toLowerCase();
    const isPaid = status === "captured" || status === "completed";

    if (!isPaid) {
      return res.status(400).json({
        ok: false,
        error:
          "This booking is not marked as paid yet. Only paid bookings can be upgraded.",
      });
    }

    let upgradeLink = null;
    let targetPackage = null;

    const normalizedSlug = normalizeSlug(slug);

    if (normalizedSlug) {
      upgradeLink = await client.fetch(
        `*[_type == "upgradeLink" && lower(slug.current) == $slug][0]{
          _id,
          title,
          intro,
          targetPackage->{title, price}
        }`,
        { slug: normalizedSlug }
      );

      if (!upgradeLink || !upgradeLink.targetPackage) {
        return res.status(404).json({
          ok: false,
          error: "Upgrade link not found. Please contact support.",
        });
      }

      targetPackage = applyPackagePricing(upgradeLink.targetPackage);
    } else {
      const title = String(booking.packageTitle || "").toLowerCase();
      const isPvo =
        title.includes("performance vertex overhaul") || title.includes("pvo");

      if (!isPvo) {
        return res.status(400).json({
          ok: false,
          error:
            "This Order ID is not a Performance Vertex Overhaul booking, so it can't be upgraded with this link.",
        });
      }

      targetPackage = await client.fetch(
        `*[_type == "package" && title in $titles][0]{
          title,
          price
        }`,
        { titles: getPackageTitleAliases(TOP_PACKAGE_PUBLIC_TITLE) }
      );

      if (!targetPackage) {
        return res.status(500).json({
          ok: false,
          error:
            "Performance Vertex Max package not found in CMS. Please contact support.",
        });
      }

      targetPackage = applyPackagePricing(targetPackage);

      upgradeLink = {
        title: "Upgrade to Performance Vertex Max",
        intro:
          "This page is only for existing Performance Vertex Overhaul customers who want to upgrade to Performance Vertex Max.",
      };
    }

    const upgradeContext = await resolveUpgradeContext({
      originalOrderId: booking._id,
      packageTitle: targetPackage.title,
      client,
    });
    const targetPriceNum = parseMoney(upgradeContext.targetPackage.price);
    const originalPaid = upgradeContext.paidBookings.reduce(
      (sum, entry) => sum + getPaidAmount(entry),
      0
    );
    const upgradePrice = Math.max(0, +upgradeContext.upgradePrice.toFixed(2));

    const packagePayload = {
      title: upgradeContext.targetPackage.title,
      priceString: upgradeContext.targetPackage.price,
      price: targetPriceNum,
    };

    const bookingPayload = {
      _id: booking._id,
      packageTitle: booking.packageTitle,
      packagePrice: booking.packagePrice,
      displayDate: booking.displayDate,
      displayTime: booking.displayTime,
      localTimeZone: booking.localTimeZone,
      startTimeUTC: booking.startTimeUTC,
    };
    const upgradeIntentToken = issueUpgradeIntentToken({
      bookingId: booking._id,
      email: normalizedEmail,
      targetPackageTitle: upgradeContext.targetPackage.title,
    });

    return res.status(200).json({
      ok: true,
      booking: bookingPayload,
      upgradeLink: upgradeLink
        ? {
            title: normalizePackageText(upgradeLink.title),
            intro: normalizePackageText(upgradeLink.intro || ""),
          }
        : null,
      targetPackage: packagePayload,
      xoc: packagePayload,
      originalPaid,
      upgradePrice,
      upgradeIntentToken,
    });
  } catch (err) {
    const status = Number(err?.status) || 500;
    const message =
      status >= 400 && status < 500
        ? err?.message || "Unable to resolve upgrade pricing."
        : "Server error while computing upgrade price.";
    console.error("getUpgradeInfo error:", err);
    return res.status(status).json({
      ok: false,
      error: message,
    });
  }
}
