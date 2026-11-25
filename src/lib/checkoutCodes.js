export const CODE_VALIDATION_UNAVAILABLE_MESSAGE =
  "Code validation is temporarily unavailable. Try again or continue without this code.";
const loadCodeApi = () => import("./paymentCheckoutHold");

export { currencyDecimals, formatCheckoutAmount, normalizeCurrencyCode, toMoney, toSubunitsClient } from "./checkoutMoney";
import { formatCheckoutAmount, normalizeCurrencyCode, parseMoneyValue, toMoney } from "./checkoutMoney";

const clamp = (value, minimum, maximum) =>
  Math.min(maximum, Math.max(minimum, value));

const clampPercent = (value) => clamp(toMoney(value), 0, 100);

const normalizeCode = (value) => String(value || "").trim();

export const sanitizeReferralForCheckout = (referral) => {
  const code = normalizeCode(referral?.code);
  if (!code) return null;

  return {
    code,
    currentDiscountPercent: clampPercent(
      referral?.currentDiscountPercent
    ),
  };
};

export const sanitizeCouponForCheckout = (coupon) => {
  const code = normalizeCode(coupon?.code);
  if (!code) return null;

  const discountType = getCouponDiscountType(coupon);
  return {
    code,
    discountType,
    ...(discountType === "fixed"
      ? { discountAmount: Math.max(0, toMoney(coupon?.discountAmount)) }
      : { discountPercent: clampPercent(coupon?.discountPercent) }),
    canCombineWithReferral: coupon?.canCombineWithReferral === true,
  };
};

export const getCouponDiscountType = (coupon) =>
  String(coupon?.discountType || "").trim().toLowerCase() === "fixed"
    ? "fixed"
    : "percent";

export const getCouponDiscountValue = (coupon, currency = "USD") =>
  getCouponDiscountType(coupon) === "fixed"
    ? Math.max(0, toMoney(coupon?.discountAmount, currency))
    : clampPercent(coupon?.discountPercent);

export const getCouponDiscountAmount = (coupon, baseAmount, currency = "USD") => {
  const normalizedBaseAmount = Math.max(0, toMoney(baseAmount, currency));
  if (!coupon || normalizedBaseAmount <= 0) return 0;
  const discountType = getCouponDiscountType(coupon);
  const rawAmount =
    discountType === "fixed"
      ? getCouponDiscountValue(coupon, currency)
      : normalizedBaseAmount * (getCouponDiscountValue(coupon, currency) / 100);
  return clamp(toMoney(rawAmount, currency), 0, normalizedBaseAmount);
};

export const formatCouponValue = (coupon, currency = "USD") => {
  if (getCouponDiscountType(coupon) === "fixed") {
    const code = normalizeCurrencyCode(currency);
    return `${formatCheckoutAmount(getCouponDiscountValue(coupon, code), code, { includeCurrency: code !== "USD" })} off`;
  }
  return `${getCouponDiscountValue(coupon)}% off`;
};

const calculateClientDiscounts = ({ baseAmount, referral, coupon }) => {
  const referralPercent = clampPercent(referral?.currentDiscountPercent);
  const couponDiscountAmount = getCouponDiscountAmount(
    coupon,
    baseAmount
  );
  const canStackCouponWithReferral =
    coupon?.canCombineWithReferral === true || false;

  let referralDiscountAmount = 0;
  if (baseAmount > 0 && referralPercent > 0) {
    const referralBase =
      coupon && canStackCouponWithReferral
        ? Math.max(0, baseAmount - couponDiscountAmount)
        : baseAmount;
    referralDiscountAmount = clamp(
      toMoney(referralBase * (referralPercent / 100)),
      0,
      referralBase
    );
  }

  const canApplyCouponWithReferral =
    !(coupon && referral && !canStackCouponWithReferral);
  const uncappedTotalDiscount = canApplyCouponWithReferral
    ? toMoney((referralDiscountAmount || 0) + (couponDiscountAmount || 0))
    : Math.max(referralDiscountAmount || 0, couponDiscountAmount || 0);
  const totalDiscountAmount = clamp(uncappedTotalDiscount, 0, baseAmount);
  const rawFinalAmount = Math.max(
    0,
    toMoney(baseAmount - totalDiscountAmount)
  );
  const hasDiscountPath =
    (!!referral && referralPercent > 0) ||
    (!!coupon && couponDiscountAmount > 0);
  const clientIsFree =
    baseAmount > 0 && hasDiscountPath && rawFinalAmount === 0;

  return {
    referralPercent,
    couponDiscountAmount,
    canStackCouponWithReferral,
    referralDiscountAmount,
    canApplyCouponWithReferral,
    totalDiscountAmount,
    rawFinalAmount,
    clientIsFree,
  };
};

const calculateFinalDiscounts = ({ baseAmount, client, serverQuote }) => {
  const quoteCurrency = normalizeCurrencyCode(serverQuote?.currency || "USD");
  const parsedQuotedNetAmount = parseMoneyValue(serverQuote?.netAmount);
  const hasQuotedNetAmount = parsedQuotedNetAmount !== null;
  const quotedIsFree = serverQuote?.isFree === true;
  const hasQuote = hasQuotedNetAmount || quotedIsFree;
  const quotedGrossAmount = hasQuote ? parseMoneyValue(serverQuote?.grossAmount) : null;
  const displayBaseAmount =
    quotedGrossAmount === null ? baseAmount : Math.max(0, toMoney(quotedGrossAmount, quoteCurrency));
  const finalAmount = quotedIsFree
    ? 0
    : hasQuotedNetAmount
      ? Math.max(0, toMoney(parsedQuotedNetAmount, quoteCurrency))
      : client.rawFinalAmount;
  const isFree =
    quotedIsFree ||
    (hasQuotedNetAmount
      ? finalAmount === 0 && (baseAmount > 0 || quotedIsFree)
      : client.clientIsFree);
  const preventedFreeReduction =
    client.clientIsFree && hasQuotedNetAmount && finalAmount > 0;
  const effectiveDiscountAmount = hasQuote
    ? clamp(toMoney(displayBaseAmount - finalAmount, quoteCurrency), 0, displayBaseAmount)
    : client.totalDiscountAmount;
  const discountPercentCombined =
    displayBaseAmount > 0
      ? clamp(toMoney((effectiveDiscountAmount / displayBaseAmount) * 100), 0, 100)
      : 0;

  const quotedLine = (name) =>
    clamp(toMoney(parseMoneyValue(serverQuote?.[name]) ?? 0, quoteCurrency), 0, displayBaseAmount);

  return {
    isFree,
    preventedFreeReduction,
    finalAmount,
    effectiveDiscountAmount,
    discountPercentCombined,
    displayBaseAmount,
    ...(hasQuote
      ? {
          couponDiscountAmount: quotedLine("couponDiscountAmount"),
          referralDiscountAmount: quotedLine("referralDiscountAmount"),
          referralPercent: clampPercent(parseMoneyValue(serverQuote?.referralDiscountPercent) ?? 0),
        }
      : {}),
  };
};

export const fetchCheckoutQuote = async (body, opts) =>
  (await loadCodeApi()).fetchCheckoutQuote(body, opts);

export const calculateCheckoutDiscounts = ({
  baseAmount,
  referral = null,
  coupon = null,
  serverQuote = null,
} = {}) => {
  const normalizedBaseAmount = Math.max(0, toMoney(baseAmount));
  const client = calculateClientDiscounts({
    baseAmount: normalizedBaseAmount,
    referral,
    coupon,
  });
  return {
    ...client,
    ...calculateFinalDiscounts({
      baseAmount: normalizedBaseAmount,
      client,
      serverQuote,
    }),
  };
};

const unavailableCode = () => ({ ok: false, unavailable: true, error: CODE_VALIDATION_UNAVAILABLE_MESSAGE });
export const validateReferralCode = async (code, fetchImpl = fetch) =>
  loadCodeApi().then((m) => m.validateReferralCode(code, fetchImpl), unavailableCode);

export const validateCouponCode = async (code, packageTitle, fetchImpl = fetch) =>
  loadCodeApi().then((m) => m.validateCouponCode(code, packageTitle, fetchImpl), unavailableCode);

export const resolveCheckoutCode = async (code, packageTitle, fetchImpl = fetch) =>
  loadCodeApi().then((m) => m.resolveCheckoutCode(code, packageTitle, fetchImpl), unavailableCode);
