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

  const rawCode = (req.query.code || "").trim();
  if (!rawCode) {
    return res.status(400).json({ ok: false, error: "Missing coupon code." });
  }

  const code = rawCode.toLowerCase();

  try {
    const coupon = await client.fetch(
      `*[_type == "coupon" && lower(code) == $code][0]{
        _id,
        title,
        code,
        discountPercent,
        isActive,
        canCombineWithReferral,
        validFrom,
        validTo
      }`,
      { code }
    );

    if (!coupon) {
      return res
        .status(404)
        .json({ ok: false, error: "Coupon not found or invalid." });
    }

    if (!coupon.isActive) {
      return res
        .status(400)
        .json({ ok: false, error: "This coupon is not active." });
    }

    const now = new Date();

    if (coupon.validFrom && new Date(coupon.validFrom) > now) {
      return res.status(400).json({
        ok: false,
        error: "This coupon is not valid yet.",
      });
    }

    if (coupon.validTo && new Date(coupon.validTo) < now) {
      return res.status(400).json({
        ok: false,
        error: "This coupon has expired.",
      });
    }

    return res.status(200).json({
      ok: true,
      coupon: {
        id: coupon._id,
        title: coupon.title,
        code: coupon.code,
        discountPercent: coupon.discountPercent,
        canCombineWithReferral: coupon.canCombineWithReferral ?? false,
      },
    });
  } catch (err) {
    console.error("❌ validateCoupon error:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error while validating coupon.",
    });
  }
}
