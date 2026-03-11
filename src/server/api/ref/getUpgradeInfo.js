import { createClient } from "@sanity/client";
import {
  getPaidAmount,
  resolveUpgradeContext,
} from "./pricing.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";

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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const clientAddress = getClientAddress(req);
  const rateLimitKey = `get-upgrade-info:${clientAddress}:${String(
    req.query?.id || ""
  ).trim().toLowerCase()}:${String(req.query?.email || "")
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

  const { id, slug, email } = req.query;
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
    const booking = await client.getDocument(id);

    if (!booking || booking._type !== "booking") {
      return res
        .status(404)
        .json({ ok: false, error: "No booking found with that Order ID." });
    }

    const allowedEmails = [booking.email, booking.payerEmail]
      .map(normalizeEmail)
      .filter(Boolean);

    if (allowedEmails.length > 0 && !allowedEmails.includes(normalizedEmail)) {
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

      targetPackage = upgradeLink.targetPackage;
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
        `*[_type == "package" && title == "XOC / Extreme Overclocking"][0]{
          title,
          price
        }`
      );

      if (!targetPackage) {
        return res.status(500).json({
          ok: false,
          error:
            "XOC / Extreme Overclocking package not found in CMS. Please contact support.",
        });
      }

      upgradeLink = {
        title: "Upgrade to XOC / Extreme Overclocking",
        intro:
          "This page is only for existing Performance Vertex Overhaul customers who want to upgrade to XOC.",
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

    return res.status(200).json({
      ok: true,
      booking: bookingPayload,
      upgradeLink: upgradeLink
        ? {
            title: upgradeLink.title,
            intro: upgradeLink.intro || "",
          }
        : null,
      targetPackage: packagePayload,
      xoc: packagePayload,
      originalPaid,
      upgradePrice,
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
