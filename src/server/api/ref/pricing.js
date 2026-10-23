import { createDataClient as createClient } from "../../data/documentClient.js";
import packagePricing from "../../../lib/packagePricing.js";
import { resolvePaymentCurrency } from "./bookingRefunds.js";
import { parseMoneySubunits } from "../payment/providerClients.js";
import { logSafeError } from "../../safeErrorLog.js";
import { buildPaymentUpgradeLockId } from "../payment/paymentRecord.js";

const {
  applyPackagePricing,
  getPackagePricePresentation,
  getPackageTitleAliases,
  normalizePackageTitleForMatch,
} = packagePricing;

const pricingClient = createClient({}, { domain: "commerce" });

const createApiError = (status, message, code = "") => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

const toMoney = (value) => {
  const normalized =
    typeof value === "string"
      ? value.trim().replace(/,/g, "").replace(/[$€£₹]/g, "").trim()
      : value;
  if (
    typeof normalized === "string" &&
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)
  ) {
    return 0;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 0;
  return +parsed.toFixed(2);
};

const clampPercent = (value) => {
  return Math.min(100, Math.max(0, toMoney(value)));
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

const creditError = () => {
  const error = createApiError(
    409,
    "Please contact us to upgrade this booking. The original payment and refund amounts could not be verified.",
    "upgrade_credit_unverified"
  );
  logSafeError("Upgrade credit requires review", error);
  return error;
};

const creditSubunits = (value) => {
  if (typeof value !== "number" && typeof value !== "string") throw creditError();
  const normalized = typeof value === "string" ? value.trim().replace(/^\$/, "").replace(/,/g, "") : value;
  if (/^0(?:\.0+)?$/.test(String(normalized))) return 0;
  const amount = parseMoneySubunits(normalized, "USD");
  if (amount === null) throw creditError();
  return amount;
};

const refundSubunits = (refund) => {
  const amount = refund.amount == null ? null : creditSubunits(refund.amount);
  const subunits = refund.amountInSubunits;
  if (subunits == null) {
    if (amount === null) throw creditError();
    return amount;
  }
  if (!Number.isSafeInteger(subunits) || subunits < 0 || (amount !== null && amount !== subunits)) {
    throw creditError();
  }
  return subunits;
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

export const getRetainedUpgradeCredit = async ({ booking, client, creditSources = null }) => {
  const records = booking.paymentRecordId
    ? [await client.fetch(`*[_type == "paymentRecord" && _id == $id][0]{...}`, { id: booking.paymentRecordId })]
    : await client.fetch(`*[_type == "paymentRecord" && bookingId == $bookingId]{...}`, { bookingId: booking._id });
  if (Array.isArray(creditSources) && Array.isArray(records)) {
    creditSources.push(...records.filter(record => record?._id));
  }
  if (!Array.isArray(records) || records.length !== 1 || !records[0]?._id) throw creditError();
  const record = records[0];
  if (record._type !== "paymentRecord" || record.bookingId !== booking._id ||
      record.provider !== booking.paymentProvider || !record.backendOwner ||
      record.backendOwner !== booking.backendOwner ||
      Number(record.cutoverGeneration || 0) !== Number(booking.cutoverGeneration || 0)) throw creditError();
  const provider = record.provider;
  if (!["paypal", "razorpay", "dodo", "free"].includes(provider)) throw creditError();
  if (record.dodoDisputeActive === true || booking.dodoDisputeActive === true ||
      (record.dodoDisputes != null && (!Array.isArray(record.dodoDisputes) ||
        record.dodoDisputes.some(dispute => !["dispute_won", "dispute_cancelled"].includes(dispute?.status))))) throw creditError();
  if (record.pricingSnapshot?.netAmount == null ||
      (provider !== "free" && record.verificationState !== "server_verified")) throw creditError();
  if (!["booked", "email_partial", "refunded"].includes(record.status)) throw creditError();
  const paid = creditSubunits(record.pricingSnapshot.netAmount);
  let currency;
  try {
    currency = resolvePaymentCurrency(record, { fallback: "" });
    resolvePaymentCurrency(record, { booking, fallback: "" });
  } catch {
    throw creditError();
  }
  if (currency !== "USD") throw creditError();
  if (booking.netAmount != null && creditSubunits(booking.netAmount) !== paid) {
    throw creditError();
  }
  const providerOrderId = provider === "dodo" ? booking.dodoCheckoutSessionId
    : provider === "paypal" ? booking.paypalOrderId : booking.razorpayOrderId;
  const providerPaymentId = provider === "dodo" ? booking.dodoPaymentId
    : provider === "razorpay" ? booking.razorpayPaymentId : "";
  if (provider !== "free" && (!providerOrderId || record.providerOrderId !== providerOrderId ||
      !record.providerPaymentId || (["dodo", "razorpay"].includes(provider) &&
        (!providerPaymentId || record.providerPaymentId !== providerPaymentId)))) throw creditError();
  if (provider === "free" && paid !== 0) throw creditError();
  if (["full", "reversal"].includes(booking.refundStatus) ||
      ["full", "reversal"].includes(record.refundState) || record.status === "refunded") return null;

  const bookingRefunded = booking.refundedAmount == null ? 0 : creditSubunits(booking.refundedAmount);
  const settled = new Map();
  if (record.refunds != null && !Array.isArray(record.refunds)) throw creditError();
  const identified = new Map();
  for (const refund of record.refunds || []) {
    if (!refund || typeof refund !== "object") throw creditError();
    if (!["processed", "pending", "review", "failed"].includes(refund.status) ||
        typeof refund.providerRefundId !== "string" || !refund.providerRefundId.trim()) throw creditError();
    if (refund.providerPaymentId && refund.providerPaymentId !== record.providerPaymentId) throw creditError();
    const amount = refund.amount == null && refund.amountInSubunits == null ? null : refundSubunits(refund);
    const previous = identified.get(refund.providerRefundId);
    if (previous != null && amount !== null && previous !== amount) throw creditError();
    if (amount !== null) identified.set(refund.providerRefundId, amount);
    if (refund.status !== "processed") continue;
    if (!refund.currency || !refund.providerPaymentId || refund.reversed === true || amount === null) throw creditError();
    settled.set(refund.providerRefundId, amount);
  }
  const refunded = [...settled.values()].reduce((sum, amount) => sum + amount, 0);
  if (!Number.isSafeInteger(refunded) || bookingRefunded > refunded) throw creditError();
  if (record.refundProcessedAmountInSubunits != null &&
      record.refundProcessedAmountInSubunits !== refunded) throw creditError();
  if (record.providerRefundDetailsMissing === true) throw creditError();
  if ((booking.refundStatus === "partial" || record.refundState === "partial") && refunded === 0) throw creditError();
  if (refunded > 0 && !["paypal", "razorpay", "dodo"].includes(provider)) throw creditError();

  const publicData = record.providerPublicData || {};
  const tax = publicData.taxAmount ?? (provider === "dodo" ? null : 0);
  const total = publicData.totalAmount ?? (provider === "dodo" || tax !== 0 ? null : paid);
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(tax) || tax < 0 || tax > total) {
    throw creditError();
  }
  const taxInclusive = provider === "dodo" ? publicData.taxInclusive !== false : publicData.taxInclusive === true;
  const price = total - tax;
  if ((taxInclusive ? total : price) !== paid || refunded > total) throw creditError();
  if (total > 0 && refunded === total) return null;
  let refundedPrice = 0;
  for (const amount of settled.values()) {
    if (total <= 0) throw creditError();
    refundedPrice += Number((BigInt(amount) * BigInt(price) + BigInt(total) - 1n) / BigInt(total));
  }
  return Math.max(0, price - refundedPrice) / 100;
};

const normalizeCouponCode = (value) => String(value || "").trim().toLowerCase();
const normalizeReferralCode = (value) =>
  String(value || "").trim().toLowerCase();

export async function resolveUpgradeContext({
  originalOrderId = "",
  packageTitle = "",
  client = pricingClient,
  forFinalization = false,
}) {
  const normalizedUpgradeTitle = String(packageTitle || "")
    .replace(/\s*\(upgrade\)\s*$/i, "")
    .trim();
  const normalizedTargetTitle = normalizePackageTitle(normalizedUpgradeTitle);

  let booking = await client.fetch(
    `*[_type == "booking" && _id == $id][0]{...}`,
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
      ]{...}`,
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
  if (!Array.isArray(paidBookings) || !paidBookings.some(entry => entry?._id === booking._id)) throw creditError();
  let totalPaid = 0;
  const retainedBookings = [];
  const creditSources = [];
  for (const entry of paidBookings) {
    const paidEntry = await client.fetch(`*[_type == "booking" && _id == $id][0]{...}`, { id: entry._id });
    if (!["captured", "completed"].includes(String(paidEntry?.status || "").toLowerCase())) {
      if (entry._id === booking._id) {
        throw createApiError(400, "Only paid bookings can be upgraded.", "original_booking_unpaid");
      }
      continue;
    }
    if (paidEntry._id !== rootOrderId && paidEntry.originalOrderId !== rootOrderId) throw creditError();
    creditSources.push(paidEntry);
    if (paidEntry._id === booking._id) booking = paidEntry;
    const credit = await getRetainedUpgradeCredit({ booking: paidEntry, client, creditSources });
    if (credit === null) {
      if (entry._id === booking._id) {
        throw createApiError(400, "Only paid bookings can be upgraded.", "original_booking_unpaid");
      }
      continue;
    }
    retainedBookings.push(paidEntry);
    totalPaid += credit;
  }
  const alreadyTarget = retainedBookings.some(
    (entry) => normalizePackageTitle(entry?.packageTitle) === normalizedTargetTitle
  );

  if (alreadyTarget && !forFinalization) {
    throw createApiError(
      400,
      "This order already matches the target package.",
      "already_target"
    );
  }

  const upgradePrice = Math.max(0, toMoney(targetPrice - totalPaid));
  if (upgradePrice <= 0 && !forFinalization) {
    throw createApiError(400, "Unable to resolve package pricing on server.", "package_pricing_missing");
  }

  return {
    booking,
    rootOrderId,
    paidBookings: retainedBookings,
    targetPackage: pricedTargetPackage,
    targetPrice,
    totalPaid: toMoney(totalPaid),
    upgradePrice,
    creditSources,
  };
}

export const resolveCapturedUpgradeFunding = async ({ record, client }) => {
  let context;
  try {
    context = await resolveUpgradeContext({
      originalOrderId: record.bookingPayload.originalOrderId,
      packageTitle: record.bookingPayload.packageTitle,
      client,
      forFinalization: true,
    });
  } catch (error) {
    if (error.status === 400) {
      throw createApiError(409, "The original booking changed after checkout.", "upgrade_credit_changed_after_quote");
    }
    throw error;
  }
  const lock = await client.fetch(`*[_type == "paymentUpgradeLock" && _id == $id][0]{...}`, {
    id: buildPaymentUpgradeLockId(`upgrade:${context.rootOrderId}`),
  });
  if (!lock?._rev || lock.paymentRecordId !== record._id) {
    throw createApiError(409, "This upgrade no longer owns the original booking credit.", "upgrade_credit_changed_after_quote");
  }
  context.creditSources.push(lock);
  if (context.paidBookings.some(booking => normalizePackageTitle(booking.packageTitle) ===
      normalizePackageTitle(record.bookingPayload.packageTitle))) {
    throw createApiError(409, "This booking already received the upgrade.", "upgrade_credit_changed_after_quote");
  }
  const captured = creditSubunits(record.pricingSnapshot.netAmount);
  const approvedDiscount = creditSubunits(record.pricingSnapshot.grossAmount) - captured;
  const required = Math.max(0, creditSubunits(context.upgradePrice) - approvedDiscount);
  if (required > captured) {
    const error = createApiError(409, "The retained upgrade credit changed after checkout.", "upgrade_credit_changed_after_quote");
    error.capturedAmount = captured / 100;
    error.requiredAmount = required / 100;
    throw error;
  }
  return context;
};

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
  let resolvedUpgradeContext = null;
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
    resolvedUpgradeContext =
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
    couponDiscountType === "fixed"
      ? Math.max(0, toMoney(couponDoc?.discountAmount || 0))
      : 0;
  const couponDiscountValue =
    couponDiscountType === "fixed"
      ? configuredCouponAmount
      : configuredCouponPercent;
  const rawCouponDiscountAmount =
    couponDiscountType === "fixed"
      ? configuredCouponAmount
      : toMoney(effectiveGrossAmount * (configuredCouponPercent / 100));
  const couponDiscountAmount = couponDoc
    ? Math.min(effectiveGrossAmount, Math.max(0, rawCouponDiscountAmount))
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

  const effectiveNetAmount = Math.max(
    0,
    toMoney(effectiveGrossAmount - effectiveDiscountAmount)
  );

  if (paymentProvider === "free" && effectiveNetAmount > 0) {
    throw createApiError(
      400,
      "The server quote still requires payment.",
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
    ...(resolvedUpgradeContext ? { upgradeContext: resolvedUpgradeContext } : {}),
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
    ...(quote.effectiveNetAmount <= 0 ? { effectiveCommissionPercent: 0, commissionAmount: 0 } : {}),
    paymentProvider: quote.effectiveNetAmount <= 0 ? "free" : "paid",
  };
}
