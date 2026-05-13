import { createClient } from "@sanity/client";
import marketConfig from "../../../lib/market.js";

const { resolveMarketCurrency } = marketConfig;

const pricingClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

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

export const normalizePackageTitle = (value) =>
  String(value || "")
    .replace(/\s*\(upgrade\)\s*$/i, "")
    .trim()
    .toLowerCase();

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
  currency = resolveMarketCurrency(),
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
      currency,
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
  const paidBookings =
    (await client.fetch(
      `*[_type == "booking"
        && status in ["captured", "completed"]
        && (_id == $rootId || originalOrderId == $rootId)
      ]{
        _id,
        packageTitle,
        netAmount,
        grossAmount,
        packagePrice,
        currency
      }`,
      { rootId: rootOrderId }
    )) || [];

  const requestedCurrency = String(currency || resolveMarketCurrency())
    .trim()
    .toUpperCase();
  const paidCurrencies = [
    ...new Set(
      paidBookings
        .map((entry) => String(entry?.currency || "").trim().toUpperCase())
        .filter(Boolean)
    ),
  ];
  if (requestedCurrency && paidCurrencies.length && !paidCurrencies.includes(requestedCurrency)) {
    throw createApiError(
      400,
      "This upgrade belongs to a different market.",
      "upgrade_market_mismatch"
    );
  }

  const targetPackage = await client.fetch(
    `*[_type == "package" && title == $title][0]{title, price}`,
    { title: normalizedUpgradeTitle }
  );

  if (!targetPackage?.title) {
    throw createApiError(
      500,
      "Target package not found in CMS.",
      "target_package_missing"
    );
  }

  const targetPrice = toMoney(targetPackage.price);
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
    targetPackage,
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
  currency = resolveMarketCurrency(),
}) {
  const isUpgrade = !!originalOrderId;
  const normalizedCouponCode = normalizeCouponCode(couponCode);
  const normalizedReferralCode = normalizeReferralCode(referralCode);

  let effectiveGrossAmount = 0;

  if (!isUpgrade) {
    const packageDoc = await client.fetch(
      `*[_type == "package" && title == $title][0]{price}`,
      { title: packageTitle }
    );

    effectiveGrossAmount = toMoney(packageDoc?.price);
  } else {
    const resolvedUpgradeContext =
      upgradeContext ||
      (await resolveUpgradeContext({
        originalOrderId,
        packageTitle,
        currency,
        client,
      }));

    effectiveGrossAmount = resolvedUpgradeContext.upgradePrice;
  }

  if (!effectiveGrossAmount || effectiveGrossAmount <= 0) {
    throw createApiError(
      400,
      "Unable to resolve package pricing on server.",
      "package_pricing_missing"
    );
  }

  let referralDoc = null;
  if (referralId) {
    referralDoc = await client.fetch(
      `*[_type == "referral" && _id == $id][0]{
        _id,
        slug,
        currentCommissionPercent,
        currentDiscountPercent
      }`,
      { id: referralId }
    );
  }

  if (!referralDoc && normalizedReferralCode) {
    referralDoc = await client.fetch(
      `*[_type == "referral" && slug.current == $code][0]{
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

  let couponDoc = null;
  if (normalizedCouponCode) {
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
        discountPercent
      }`,
      { code: normalizedCouponCode }
    );

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
  }

  const couponDiscountPercent = clampPercent(couponDoc?.discountPercent || 0);
  const canCombineWithReferral = couponDoc?.canCombineWithReferral === true;

  const referralDiscountAmount = toMoney(
    effectiveGrossAmount * (referralDiscountPercent / 100)
  );
  const couponDiscountAmount = toMoney(
    effectiveGrossAmount * (couponDiscountPercent / 100)
  );

  let effectiveDiscountAmount = 0;
  if (couponDoc && referralDoc) {
    effectiveDiscountAmount = canCombineWithReferral
      ? toMoney(referralDiscountAmount + couponDiscountAmount)
      : Math.max(referralDiscountAmount, couponDiscountAmount);
  } else if (couponDoc) {
    effectiveDiscountAmount = couponDiscountAmount;
  } else {
    effectiveDiscountAmount = referralDiscountAmount;
  }

  effectiveDiscountAmount = Math.min(
    effectiveGrossAmount,
    effectiveDiscountAmount
  );

  if (paymentProvider === "free") {
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
      : effectiveNetAmount || effectiveGrossAmount || 0;
  const commissionAmount = toMoney(
    commissionBase * (effectiveCommissionPercent / 100)
  );

  return {
    canCombineWithReferral,
    couponDiscountAmount,
    couponDiscountPercent,
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
    currency: String(currency || resolveMarketCurrency()).trim().toUpperCase(),
  };
}

export async function resolvePaymentQuote({
  packageTitle,
  originalOrderId = "",
  referralId = "",
  referralCode = "",
  couponCode = "",
  currency = resolveMarketCurrency(),
  client,
}) {
  const quote = await resolveBookingPricing({
    packageTitle,
    originalOrderId,
    referralId,
    referralCode,
    couponCode,
    paymentProvider: "",
    allowZeroPayable: true,
    currency,
    client,
  });

  return {
    ...quote,
    paymentProvider: quote.effectiveNetAmount <= 0 ? "free" : "paid",
  };
}
