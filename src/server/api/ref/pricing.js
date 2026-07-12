import { createDataClient as createClient } from "../../data/documentClient.js";
import packagePricing from "../../../lib/packagePricing.js";

const {
  applyPackagePricing,
  getPackagePricePresentation,
  getPackageTitleAliases,
  normalizePackageTitleForMatch,
} = packagePricing;

const pricingClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
}, { domain: "commerce" });

const createApiError = (status, message, code = "") => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

const toMoney = (value) => {
  const parsed = Number(
    typeof value === "string" ? value.replace(/[^0-9.]/g, "") : value
  );
  if (!Number.isFinite(parsed)) return 0;
  return +parsed.toFixed(2);
};

const clampPercent = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, parsed));
};

const normalizeDiscountType = (value) =>
  String(value || "").trim().toLowerCase() === "fixed" ? "fixed" : "percent";

export const normalizePackageTitle = (value) =>
  normalizePackageTitleForMatch(value);

export const getPaymentPackageTitleAliases = (value) =>
  getPackageTitleAliases(value);

const normalizePackageId = (value) => String(value || "").trim();

const getCouponEligiblePackages = (couponDoc = {}) =>
  Array.isArray(couponDoc?.eligiblePackages)
    ? couponDoc.eligiblePackages.filter(Boolean)
    : [];

const fetchPackageByTitle = (client, packageTitle) =>
  client.fetch(
    `*[_type == "package" && title in $titles][0]{_id, title, price}`,
    { titles: getPackageTitleAliases(packageTitle) }
  );

export const isCouponEligibleForPackage = ({
  couponDoc,
  packageId = "",
  packageTitle = "",
}) => {
  const eligiblePackages = getCouponEligiblePackages(couponDoc);
  if (eligiblePackages.length === 0) return true;

  const normalizedPackageId = normalizePackageId(packageId);
  const normalizedPackageTitle = normalizePackageTitle(packageTitle);

  return eligiblePackages.some((pkg) => {
    const eligibleId = normalizePackageId(pkg?._id || pkg?._ref);
    const eligibleTitle = normalizePackageTitle(pkg?.title || pkg?.packageTitle);

    return (
      (!!normalizedPackageId && eligibleId === normalizedPackageId) ||
      (!!normalizedPackageTitle && eligibleTitle === normalizedPackageTitle)
    );
  });
};

export const getPaidAmount = (booking) => {
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

  return toMoney(booking?.packagePrice);
};

const normalizeCouponCode = (value) => String(value || "").trim().toLowerCase();
const normalizeReferralCode = (value) =>
  String(value || "").trim().toLowerCase();

export async function resolveUpgradeContext({
  originalOrderId = "",
  packageTitle = "",
  client = pricingClient,
}) {
  const normalizedUpgradeTitle = String(packageTitle || "")
    .replace(/\s*\(upgrade\)\s*$/i, "")
    .trim();
  const normalizedTargetTitle = normalizePackageTitle(normalizedUpgradeTitle);

  const booking = await client.fetch(
    `*[_type == "booking" && _id == $id][0]{
      _id,
      status,
      originalOrderId,
      packageTitle,
      packagePrice,
      grossAmount,
      netAmount,
      email,
      payerEmail,
      discord,
      specs,
      mainGame,
      message,
      localTimeZone,
      startTimeUTC,
      displayDate,
      displayTime
    }`,
    { id: originalOrderId }
  );

  if (!booking?._id) {
    throw createApiError(
      400,
      "Original booking could not be verified for this upgrade.",
      "original_booking_missing"
    );
  }

  const bookingStatus = String(booking.status || "").toLowerCase();
  const bookingPaid =
    bookingStatus === "captured" || bookingStatus === "completed";
  if (!bookingPaid) {
    throw createApiError(
      400,
      "Only paid bookings can be upgraded.",
      "original_booking_unpaid"
    );
  }

  const rootOrderId = booking.originalOrderId || booking._id;
  const paidBookings = typeof client?.upgradeBookingChain === "function"
    ? await client.upgradeBookingChain({ rootId: rootOrderId })
    : (await client.fetch(
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
    )) || [];

  const targetPackage = await fetchPackageByTitle(client, normalizedUpgradeTitle);

  if (!targetPackage?.title) {
    throw createApiError(
      500,
      "Target package not found in CMS.",
      "target_package_missing"
    );
  }

  const pricedTargetPackage = applyPackagePricing(targetPackage);
  const targetPrice = toMoney(pricedTargetPackage.price);
  const totalPaid = paidBookings.reduce(
    (sum, entry) => sum + getPaidAmount(entry),
    0
  );
  const alreadyTarget = paidBookings.some(
    (entry) => normalizePackageTitle(entry?.packageTitle) === normalizedTargetTitle
  );

  if (alreadyTarget) {
    throw createApiError(
      400,
      "This order already matches the target package.",
      "already_target"
    );
  }

  return {
    booking,
    rootOrderId,
    paidBookings,
    targetPackage: pricedTargetPackage,
    targetPrice,
    totalPaid: toMoney(totalPaid),
    upgradePrice: Math.max(0, toMoney(targetPrice - totalPaid)),
  };
}

export async function resolveBookingPricing({
  packageTitle,
  originalOrderId = "",
  referralId = "",
  referralCode = "",
  couponCode = "",
  paymentProvider = "",
  allowZeroPayable = false,
  client = pricingClient,
  upgradeContext = null,
  pricingInputs = null,
}) {
  const isUpgrade = !!originalOrderId;
  const normalizedCouponCode = normalizeCouponCode(couponCode);
  const normalizedReferralCode = normalizeReferralCode(referralCode);

  let effectiveGrossAmount = 0;
  let effectivePackageId = "";
  let effectivePackageTitle = String(packageTitle || "").trim();

  if (!isUpgrade) {
    const packageDoc =
      pricingInputs &&
      Object.prototype.hasOwnProperty.call(pricingInputs, "packageDoc")
        ? pricingInputs.packageDoc
        : await fetchPackageByTitle(client, packageTitle);

    const pricing = getPackagePricePresentation(packageTitle, packageDoc?.price);
    effectiveGrossAmount = toMoney(pricing.price);
    effectivePackageId = packageDoc?._id || "";
    effectivePackageTitle = packageDoc?.title || effectivePackageTitle;
  } else {
    const resolvedUpgradeContext =
      upgradeContext ||
      (await resolveUpgradeContext({
        originalOrderId,
        packageTitle,
        client,
      }));

    effectiveGrossAmount = resolvedUpgradeContext.upgradePrice;
    effectivePackageId = resolvedUpgradeContext.targetPackage?._id || "";
    effectivePackageTitle =
      resolvedUpgradeContext.targetPackage?.title || effectivePackageTitle;
  }

  if (!effectiveGrossAmount || effectiveGrossAmount <= 0) {
    throw createApiError(
      400,
      "Unable to resolve package pricing on server.",
      "package_pricing_missing"
    );
  }

  const hasReferralInput =
    pricingInputs &&
    Object.prototype.hasOwnProperty.call(pricingInputs, "referralDoc");
  let referralDoc = hasReferralInput ? pricingInputs.referralDoc : null;
  if (!hasReferralInput && referralId) {
    referralDoc = await client.fetch(
      `*[_type == "referral" && registrationStatus != "pending_email" && _id == $id][0]{
        _id,
        slug,
        currentCommissionPercent,
        currentDiscountPercent
      }`,
      { id: referralId }
    );
  }

  if (!hasReferralInput && !referralDoc && normalizedReferralCode) {
    referralDoc = await client.fetch(
      `*[_type == "referral" && registrationStatus != "pending_email" && slug.current == $code][0]{
        _id,
        slug,
        currentCommissionPercent,
        currentDiscountPercent
      }`,
      { code: normalizedReferralCode }
    );
  }

  const effectiveReferralId = referralDoc?._id || null;
  const effectiveReferralCode =
    referralDoc?.slug?.current || normalizedReferralCode || "";
  const referralDiscountPercent = clampPercent(
    referralDoc?.currentDiscountPercent || 0
  );
  const effectiveCommissionPercent = clampPercent(
    referralDoc?.currentCommissionPercent || 0
  );

  const hasCouponInput =
    pricingInputs &&
    Object.prototype.hasOwnProperty.call(pricingInputs, "couponDoc");
  let couponDoc = hasCouponInput ? pricingInputs.couponDoc : null;
  if (!hasCouponInput && normalizedCouponCode) {
    couponDoc = await client.fetch(
      `*[_type == "coupon" && lower(code) == $code][0]{
        _id,
        code,
        isActive,
        timesUsed,
        maxUses,
        validFrom,
        validTo,
        canCombineWithReferral,
        discountType,
        discountPercent,
        discountAmount,
        eligiblePackages[]{
          _ref,
          "_id": @->_id,
          "title": @->title
        }
      }`,
      { code: normalizedCouponCode }
    );
  }

  if (normalizedCouponCode) {
    if (!couponDoc) {
      throw createApiError(400, "Coupon is invalid.", "coupon_invalid");
    }

    const now = new Date();
    const used = couponDoc.timesUsed ?? 0;
    const max = couponDoc.maxUses;

    if (
      couponDoc.isActive === false ||
      (couponDoc.validFrom && new Date(couponDoc.validFrom) > now) ||
      (couponDoc.validTo && new Date(couponDoc.validTo) < now) ||
      (typeof max === "number" && max > 0 && used >= max)
    ) {
      throw createApiError(
        400,
        "This coupon is inactive or expired.",
        "coupon_inactive"
      );
    }

    if (
      !isCouponEligibleForPackage({
        couponDoc,
        packageId: effectivePackageId,
        packageTitle: effectivePackageTitle,
      })
    ) {
      throw createApiError(
        400,
        "This coupon is not valid for the selected package.",
        "coupon_package_mismatch"
      );
    }
  }

  const couponDiscountType = couponDoc
    ? normalizeDiscountType(couponDoc.discountType)
    : "";
  const configuredCouponPercent =
    couponDiscountType === "percent"
      ? clampPercent(couponDoc?.discountPercent || 0)
      : 0;
  const configuredCouponAmount =
    couponDiscountType === "fixed" ? toMoney(couponDoc?.discountAmount || 0) : 0;
  const couponDiscountValue =
    couponDiscountType === "fixed"
      ? configuredCouponAmount
      : configuredCouponPercent;
  const rawCouponDiscountAmount =
    couponDiscountType === "fixed"
      ? configuredCouponAmount
      : toMoney(effectiveGrossAmount * (configuredCouponPercent / 100));
  const couponDiscountAmount = couponDoc
    ? Math.min(effectiveGrossAmount, rawCouponDiscountAmount)
    : 0;
  const couponDiscountPercent =
    couponDiscountType === "fixed"
      ? effectiveGrossAmount > 0
        ? toMoney((couponDiscountAmount / effectiveGrossAmount) * 100)
        : 0
      : configuredCouponPercent;
  const canCombineWithReferral = couponDoc?.canCombineWithReferral === true;
  const hasCouponAndReferral = !!couponDoc && !!referralDoc;

  if (hasCouponAndReferral && !canCombineWithReferral) {
    throw createApiError(
      400,
      "This coupon can't be combined with a referral discount.",
      "coupon_referral_not_combinable"
    );
  }

  const referralBaseAmount = toMoney(
    Math.max(0, effectiveGrossAmount - couponDiscountAmount)
  );
  const referralDiscountAmount = toMoney(
    referralBaseAmount * (referralDiscountPercent / 100)
  );
  let effectiveDiscountAmount = toMoney(
    couponDiscountAmount + referralDiscountAmount
  );

  effectiveDiscountAmount = Math.min(
    effectiveGrossAmount,
    effectiveDiscountAmount
  );

  if (paymentProvider === "free") {
    if (!couponDoc || couponDiscountAmount < effectiveGrossAmount) {
      throw createApiError(
        400,
        "This coupon does not provide a full discount.",
        "free_coupon_not_full"
      );
    }
    effectiveDiscountAmount = effectiveGrossAmount;
  }

  const effectiveNetAmount =
    paymentProvider === "free"
      ? 0
      : toMoney(effectiveGrossAmount - effectiveDiscountAmount);

  if (paymentProvider === "free" && effectiveNetAmount > 0) {
    throw createApiError(
      400,
      "This booking still requires payment.",
      "free_requires_zero"
    );
  }

  if (paymentProvider !== "free" && !allowZeroPayable && effectiveNetAmount <= 0) {
    throw createApiError(
      400,
      "Payable amount resolved to zero. Use the free booking flow.",
      "payable_zero"
    );
  }

  const effectiveDiscountPercent =
    effectiveGrossAmount > 0
      ? toMoney((effectiveDiscountAmount / effectiveGrossAmount) * 100)
      : 0;

  const commissionBase =
    paymentProvider === "free"
      ? 0
      : referralBaseAmount || effectiveGrossAmount || 0;
  const commissionAmount = toMoney(
    commissionBase * (effectiveCommissionPercent / 100)
  );

  return {
    canCombineWithReferral,
    couponDiscountAmount,
    couponDiscountPercent,
    couponDiscountType,
    couponDiscountValue,
    couponDoc,
    effectiveCommissionPercent,
    effectiveDiscountAmount,
    effectiveDiscountPercent,
    effectiveGrossAmount,
    effectiveNetAmount,
    effectiveReferralCode,
    effectiveReferralId,
    referralDiscountAmount,
    referralDiscountPercent,
    referralDoc,
    commissionAmount,
  };
}

export async function resolvePaymentQuote({
  packageTitle,
  originalOrderId = "",
  referralId = "",
  referralCode = "",
  couponCode = "",
  client,
  pricingInputs = null,
}) {
  const quote = await resolveBookingPricing({
    packageTitle,
    originalOrderId,
    referralId,
    referralCode,
    couponCode,
    paymentProvider: "",
    allowZeroPayable: true,
    client,
    pricingInputs,
  });

  return {
    ...quote,
    paymentProvider: quote.effectiveNetAmount <= 0 ? "free" : "paid",
  };
}
