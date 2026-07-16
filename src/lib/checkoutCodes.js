const parseMoneyValue = (value) => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/,/g, "")
    .replace(/[$€£₹]/g, "")
    .trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

export const toMoney = (value) => {
  const parsed = parseMoneyValue(value);
  return parsed === null ? 0 : +parsed.toFixed(2);
};

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

export const getCouponDiscountValue = (coupon) =>
  getCouponDiscountType(coupon) === "fixed"
    ? Math.max(0, toMoney(coupon?.discountAmount))
    : clampPercent(coupon?.discountPercent);

export const getCouponDiscountAmount = (coupon, baseAmount) => {
  const normalizedBaseAmount = Math.max(0, toMoney(baseAmount));
  if (!coupon || normalizedBaseAmount <= 0) return 0;
  const discountType = getCouponDiscountType(coupon);
  const rawAmount =
    discountType === "fixed"
      ? getCouponDiscountValue(coupon)
      : normalizedBaseAmount * (getCouponDiscountValue(coupon) / 100);
  return clamp(toMoney(rawAmount), 0, normalizedBaseAmount);
};

export const formatCouponValue = (coupon) => {
  if (getCouponDiscountType(coupon) === "fixed") {
    return `$${getCouponDiscountValue(coupon).toFixed(2)} off`;
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
  const parsedQuotedNetAmount = parseMoneyValue(serverQuote?.netAmount);
  const hasQuotedNetAmount = parsedQuotedNetAmount !== null;
  const quotedIsFree = serverQuote?.isFree === true;
  const finalAmount = quotedIsFree
    ? 0
    : hasQuotedNetAmount
      ? Math.max(0, toMoney(parsedQuotedNetAmount))
      : client.rawFinalAmount;
  const isFree =
    quotedIsFree ||
    (hasQuotedNetAmount
      ? finalAmount === 0 && (baseAmount > 0 || quotedIsFree)
      : client.clientIsFree);
  const preventedFreeReduction =
    client.clientIsFree && hasQuotedNetAmount && finalAmount > 0;
  const effectiveDiscountAmount = hasQuotedNetAmount || quotedIsFree
    ? clamp(toMoney(baseAmount - finalAmount), 0, baseAmount)
    : client.totalDiscountAmount;
  const discountPercentCombined =
    baseAmount > 0
      ? clamp(toMoney((effectiveDiscountAmount / baseAmount) * 100), 0, 100)
      : 0;

  return {
    isFree,
    preventedFreeReduction,
    finalAmount,
    effectiveDiscountAmount,
    discountPercentCombined,
  };
};

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

export const validateReferralCode = async (code, fetchImpl = fetch) => {
  const response = await fetchImpl(
    `/api/ref/validateReferral?code=${encodeURIComponent(code)}`
  );
  const data = await response.json();
  if (!data?.ok) {
    return {
      ok: false,
      error: data?.error || "Invalid or inactive referral code.",
    };
  }

  const referral = sanitizeReferralForCheckout(data.referral);
  if (!referral || data.active === false || data.eligible === false) {
    return { ok: false, error: "Invalid or inactive referral code." };
  }

  return {
    ok: true,
    active: data.active !== false,
    eligible: data.eligible !== false,
    referral,
  };
};

export const validateCouponCode = async (
  code,
  packageTitle,
  fetchImpl = fetch
) => {
  const response = await fetchImpl(
    `/api/ref/validateCoupon?code=${encodeURIComponent(
      code
    )}&packageTitle=${encodeURIComponent(packageTitle)}`
  );
  const data = await response.json();
  if (!data?.ok) {
    return {
      ok: false,
      error: data?.error || "Invalid referral or coupon code.",
    };
  }

  const coupon = sanitizeCouponForCheckout(data.coupon);
  if (!coupon) {
    return { ok: false, error: "Invalid referral or coupon code." };
  }

  return { ok: true, coupon };
};

export const resolveCheckoutCode = async (
  code,
  packageTitle,
  fetchImpl = fetch
) => {
  const [referralAttempt, couponAttempt] = await Promise.allSettled([
    validateReferralCode(code, fetchImpl),
    validateCouponCode(code, packageTitle, fetchImpl),
  ]);
  const referralResult =
    referralAttempt.status === "fulfilled" ? referralAttempt.value : null;
  const couponResult =
    couponAttempt.status === "fulfilled" ? couponAttempt.value : null;
  const hasReferral = !!(referralResult?.ok && referralResult.referral);
  const hasCoupon = !!(couponResult?.ok && couponResult.coupon);

  if (hasReferral && hasCoupon) {
    console.warn("checkout_code_namespace_collision", {
      event: "checkout_code_namespace_collision",
      code: normalizeCode(code).toLowerCase(),
      precedence: "referral_first",
      resolvedType: "referral",
    });
  }

  if (hasReferral) {
    return { ok: true, type: "referral", value: referralResult.referral };
  }
  if (hasCoupon) {
    return { ok: true, type: "coupon", value: couponResult.coupon };
  }

  return {
    ok: false,
    error:
      couponResult?.error ||
      referralResult?.error ||
      "We couldn't validate that referral or coupon code. Please try again.",
  };
};
