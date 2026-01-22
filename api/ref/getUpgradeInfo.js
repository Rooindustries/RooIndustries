import { createClient } from "@sanity/client";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const parseMoney = (value) =>
  parseFloat(String(value || "").replace(/[^0-9.]/g, "")) || 0;

const normalizeTitle = (value) =>
  String(value || "")
    .replace(/\s*\(upgrade\)\s*$/i, "")
    .trim()
    .toLowerCase();

const normalizeSlug = (value) => {
  if (!value) return "";
  if (Array.isArray(value)) return String(value[0] || "").toLowerCase();
  return String(value || "").toLowerCase();
};

const getPaidAmount = (booking) => {
  if (
    typeof booking?.netAmount === "number" &&
    !Number.isNaN(booking.netAmount)
  ) {
    return booking.netAmount;
  }

  if (
    typeof booking?.grossAmount === "number" &&
    !Number.isNaN(booking.grossAmount)
  ) {
    return booking.grossAmount;
  }

  return parseMoney(booking?.packagePrice);
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const { id, slug } = req.query;
  if (!id) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing Order ID (bookingId)." });
  }

  try {
    const booking = await client.getDocument(id);

    if (!booking || booking._type !== "booking") {
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

    const targetPriceNum = parseMoney(targetPackage.price);
    const rootOrderId = booking.originalOrderId || booking._id;
    const paidBookings = await client.fetch(
      `*[_type == "booking"
        && status in ["captured", "completed"]
        && (_id == $rootId || originalOrderId == $rootId)
      ]{
        _id,
        packageTitle,
        netAmount,
        grossAmount,
        packagePrice
      }`,
      { rootId: rootOrderId }
    );

    const normalizedTarget = normalizeTitle(targetPackage.title);
    const alreadyTarget = Array.isArray(paidBookings)
      ? paidBookings.some(
          (entry) => normalizeTitle(entry?.packageTitle) === normalizedTarget
        )
      : normalizeTitle(booking.packageTitle) === normalizedTarget;

    if (alreadyTarget) {
      return res.status(400).json({
        ok: false,
        error: "This order already matches the target package.",
      });
    }

    const originalPaid = Array.isArray(paidBookings)
      ? paidBookings.reduce(
          (sum, entry) => sum + getPaidAmount(entry),
          0
        )
      : getPaidAmount(booking);
    const upgradePrice = Math.max(
      0,
      +(targetPriceNum - originalPaid).toFixed(2)
    );

    const packagePayload = {
      title: targetPackage.title,
      priceString: targetPackage.price,
      price: targetPriceNum,
    };

    const bookingPayload = {
      _id: booking._id,
      packageTitle: booking.packageTitle,
      packagePrice: booking.packagePrice,
      discord: booking.discord,
      email: booking.email,
      specs: booking.specs,
      mainGame: booking.mainGame,
      message: booking.message,
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
    console.error("getUpgradeInfo error:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error while computing upgrade price.",
    });
  }
}
