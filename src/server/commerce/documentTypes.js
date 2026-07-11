export const COMMERCE_SHADOW_DOCUMENT_TYPES = Object.freeze([
  "bookingSettings",
  "booking",
  "slotHold",
  "bookingSlot",
  "paymentRecord",
  "paymentStartClaim",
  "paymentProofClaim",
  "paymentUpgradeLock",
  "paymentWebhookReceipt",
  "paymentRecoveryCase",
  "bookingRecoveryCase",
  "coupon",
  "couponRedemption",
  "referral",
  "owedReferral",
  "creatorPayout",
  "package",
  "upgradeLink",
]);

// Referral documents also contain creator authentication state. They are read
// into the private compatibility store for pricing and accounting, but a
// commerce-only sync must never delete or recreate those identities.
export const COMMERCE_MIXED_IDENTITY_DOCUMENT_TYPES = Object.freeze([
  "referral",
]);

export const COMMERCE_RECONCILABLE_DOCUMENT_TYPES = Object.freeze(
  COMMERCE_SHADOW_DOCUMENT_TYPES.filter(
    (type) => !COMMERCE_MIXED_IDENTITY_DOCUMENT_TYPES.includes(type)
  )
);

export const COMMERCE_EPHEMERAL_DOCUMENT_TYPES = Object.freeze([
  "rateLimitBucket",
  "refRateLimitBucket",
]);

export const isCommerceShadowDocumentType = (type) =>
  COMMERCE_SHADOW_DOCUMENT_TYPES.includes(String(type || ""));
