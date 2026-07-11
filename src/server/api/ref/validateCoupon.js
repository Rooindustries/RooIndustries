import { createDataClient as createClient } from "../../data/documentClient.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import packagePricing from "../../../lib/packagePricing.js";
import { logSafeError } from "../../safeErrorLog.js";

const { normalizePackageTitleForMatch } = packagePricing;

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const normalizePackageTitle = (value) =>
  normalizePackageTitleForMatch(value);

const normalizeDiscountType = (value) =>
  String(value || "").trim().toLowerCase() === "fixed" ? "fixed" : "percent";

const isCouponEligibleForPackage = ({ coupon, packageTitle = "" }) => {
  const eligiblePackages = Array.isArray(coupon?.eligiblePackages)
    ? coupon.eligiblePackages.filter(Boolean)
    : [];
  if (eligiblePackages.length === 0) return true;

  const normalizedPackageTitle = normalizePackageTitle(packageTitle);
  if (!normalizedPackageTitle) return false;

  return eligiblePackages.some(
    (pkg) => normalizePackageTitle(pkg?.title || pkg?.packageTitle) === normalizedPackageTitle
  );
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const rawCode = (req.query.code || "").trim();
  const packageTitle = String(req.query.packageTitle || "").trim();
  const clientAddress = getClientAddress(req);
  if (
    !(await requireRateLimit(res, {
      key: `validate-coupon:${clientAddress}`,
      max: 25,
      message: "Too many coupon validation requests. Please try again later.",
    }))
  ) {
    return;
  }
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
        discountType,
        discountPercent,
        discountAmount,
        isActive,
        canCombineWithReferral,
        validFrom,
        validTo,
        maxUses,
        timesUsed,
        eligiblePackages[]{
          _ref,
          "_id": @->_id,
          "title": @->title
        }
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

    const used = coupon.timesUsed ?? 0;
    const max = coupon.maxUses;

    if (typeof max === "number" && max > 0 && used >= max) {
      return res.status(400).json({
        ok: false,
        error: "This coupon has reached its maximum number of uses.",
      });
    }

    if (!isCouponEligibleForPackage({ coupon, packageTitle })) {
      return res.status(400).json({
        ok: false,
        error: packageTitle
          ? "This coupon is not valid for the selected package."
          : "Package details are required for this coupon.",
      });
    }

    const discountType = normalizeDiscountType(coupon.discountType);
    const discountAmount =
      discountType === "fixed" ? Number(coupon.discountAmount || 0) : null;
    const discountPercent =
      discountType === "percent" ? Number(coupon.discountPercent || 0) : 0;

    return res.status(200).json({
      ok: true,
      coupon: {
        id: coupon._id,
        title: coupon.title,
        code: coupon.code,
        discountType,
        discountPercent,
        discountAmount,
        canCombineWithReferral: coupon.canCombineWithReferral ?? false,
        maxUses: max ?? null,
        timesUsed: used,
      },
    });
  } catch (err) {
    logSafeError("Coupon validation failed", err);
    return res.status(500).json({
      ok: false,
      error: "Server error while validating coupon.",
    });
  }
}
