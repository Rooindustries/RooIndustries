import { createRefReadClient } from "./sanity.js";

export const COUNTED_BOOKING_STATUSES = ["captured", "completed"];

export const normalizeCouponCode = (value) =>
  String(value || "").trim().toLowerCase();

export const isCountedBookingStatus = (value) =>
  COUNTED_BOOKING_STATUSES.includes(String(value || "").trim().toLowerCase());

export const getSuccessfulReferralCount = async ({
  client,
  referralId = "",
}) => {
  if (!referralId) return 0;
  const resolvedClient = client || createRefReadClient();
  const count = await resolvedClient.fetch(
    `count(*[
      _type == "booking"
      && status in $statuses
      && defined(referral._ref)
      && referral._ref == $referralId
    ])`,
    {
      statuses: COUNTED_BOOKING_STATUSES,
      referralId,
    }
  );

  return Number.isFinite(Number(count)) ? Number(count) : 0;
};

export const getCouponUsageCount = async ({
  client,
  couponCode = "",
}) => {
  const normalizedCode = normalizeCouponCode(couponCode);
  if (!normalizedCode) return 0;
  const resolvedClient = client || createRefReadClient();
  const count = await resolvedClient.fetch(
    `count(*[
      _type == "booking"
      && status in $statuses
      && defined(couponCode)
      && lower(couponCode) == $couponCode
    ])`,
    {
      statuses: COUNTED_BOOKING_STATUSES,
      couponCode: normalizedCode,
    }
  );

  return Number.isFinite(Number(count)) ? Number(count) : 0;
};

export const syncReferralSuccessCount = async ({
  client,
  referralId = "",
}) => {
  if (!referralId) return 0;
  const count = await getSuccessfulReferralCount({ client, referralId });
  const referral = await client.fetch(
    `*[_type == "referral" && _id == $id][0]{ _id, successfulReferrals }`,
    { id: referralId }
  );

  if (
    referral?._id &&
    Number(referral.successfulReferrals ?? 0) !== count
  ) {
    await client.patch(referralId).set({ successfulReferrals: count }).commit();
  }

  return count;
};

export const syncCouponUsage = async ({
  client,
  couponCode = "",
}) => {
  const normalizedCode = normalizeCouponCode(couponCode);
  if (!normalizedCode) return 0;

  const coupon = await client.fetch(
    `*[_type == "coupon" && lower(code) == $code][0]{
      _id,
      redemptionCount,
      timesUsed,
      maxUses,
      isActive
    }`,
    { code: normalizedCode }
  );

  if (!coupon?._id) return 0;

  const timesUsed = await getCouponUsageCount({
    client,
    couponCode: normalizedCode,
  });

  const nextPatch = {};
  if (Number(coupon.redemptionCount ?? 0) !== timesUsed) {
    nextPatch.redemptionCount = timesUsed;
  }
  if (Number(coupon.timesUsed ?? 0) !== timesUsed) {
    nextPatch.timesUsed = timesUsed;
  }

  if (
    typeof coupon.maxUses === "number" &&
    coupon.maxUses > 0 &&
    timesUsed >= coupon.maxUses &&
    coupon.isActive !== false
  ) {
    nextPatch.isActive = false;
  }

  if (Object.keys(nextPatch).length > 0) {
    await client.patch(coupon._id).set(nextPatch).commit();
  }

  return timesUsed;
};
