import { createClient } from "@sanity/client";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const { id } = req.query;
  if (!id) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing Order ID (bookingId)." });
  }

  try {
    // 1) Fetch the original booking
    const booking = await client.getDocument(id);

    if (!booking) {
      return res
        .status(404)
        .json({ ok: false, error: "No booking found with that Order ID." });
    }

    // Only allow upgrades from captured / paid bookings
    if (booking.status !== "captured") {
      return res.status(400).json({
        ok: false,
        error:
          "This booking is not marked as paid yet. Only paid PVO bookings can be upgraded.",
      });
    }

    // Only allow upgrades from PVO
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

    // 2) Fetch XOC package from Sanity
    const xoc = await client.fetch(
      `*[_type == "package" && title == "XOC / Extreme Overclocking"][0]{
        title,
        price
      }`
    );

    if (!xoc) {
      return res.status(500).json({
        ok: false,
        error:
          "XOC / Extreme Overclocking package not found in CMS. Please contact support.",
      });
    }

    const xocPriceNum =
      parseFloat(String(xoc.price || "").replace(/[^0-9.]/g, "")) || 0;

    // 3) Use final price with all discounts from the original booking
    // Prefer netAmount if present, otherwise fall back to packagePrice
    const originalPaid =
      typeof booking.netAmount === "number" && !Number.isNaN(booking.netAmount)
        ? booking.netAmount
        : parseFloat(
            String(booking.packagePrice || "").replace(/[^0-9.]/g, "")
          ) || 0;

    // 4) Upgrade price = XOC - already paid (never negative)
    const upgradePrice = Math.max(0, +(xocPriceNum - originalPaid).toFixed(2));

    return res.status(200).json({
      ok: true,
      booking,
      xoc: {
        title: xoc.title,
        priceString: xoc.price,
        price: xocPriceNum,
      },
      originalPaid,
      upgradePrice,
    });
  } catch (err) {
    console.error("❌ getUpgradeInfo error:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error while computing upgrade price.",
    });
  }
}
