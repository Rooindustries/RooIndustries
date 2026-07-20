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

export const REFERRAL_COMMERCE_FIELDS = Object.freeze([
  "backendOwner",
  "cutoverGeneration",
  "successfulReferrals",
  "currentCommissionPercent",
  "currentDiscountPercent",
  "maxCommissionPercent",
  "bypassUnlock",
  "isFirstTime",
  "xocPayments",
  "vertexPayments",
  "earnedXoc",
  "earnedVertex",
  "earnedTotal",
  "paidXoc",
  "paidVertex",
  "paidTotal",
  "owedXoc",
  "owedVertex",
  "owedTotal",
  "notes",
]);

export const COMMERCE_PARITY_EXCLUDED_DOCUMENT_KEYS = Object.freeze([
  "_rev",
  "_createdAt",
  "_updatedAt",
  "_system",
  "_supabaseRevision",
  "_supabaseCanonicalHash",
  "_supabaseSequence",
  "_supabaseSequences",
  "_commerceCutoverGeneration",
  "_supabaseMirroredAt",
]);

export const REFERRAL_PARITY_CREDENTIAL_KEYS = Object.freeze([
  "creatorPassword",
  "resetToken",
  "resetTokenHash",
  "resetTokenExpiresAt",
  "resetDeliveryToken",
  "registrationVerificationTokenHash",
  "registrationVerificationExpiresAt",
  "registrationVerificationDeliveryToken",
  "passwordResetRequired",
  "credentialVersion",
]);

const parityExcludedKeys = new Set(COMMERCE_PARITY_EXCLUDED_DOCUMENT_KEYS);
const referralParityExcludedKeys = new Set([
  ...COMMERCE_PARITY_EXCLUDED_DOCUMENT_KEYS,
  ...REFERRAL_PARITY_CREDENTIAL_KEYS,
]);
const referralCommerceFieldSet = new Set(REFERRAL_COMMERCE_FIELDS);

export const isReferralCommerceField = (key) =>
  referralCommerceFieldSet.has(String(key || ""));

export const pickReferralCommerceFields = (value) =>
  Object.fromEntries(
    Object.entries(value || {}).filter(([key]) => isReferralCommerceField(key))
  );

export const pickReferralGeneralFields = (value) =>
  Object.fromEntries(
    Object.entries(value || {}).filter(
      ([key]) =>
        !isReferralCommerceField(key) && key !== "_commerceCutoverGeneration"
    )
  );

export const canonicalizeCommerceParityValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalizeCommerceParityValue);
  if (!value || typeof value !== "object") return value;
  const ignoredKeys =
    value._type === "referral"
      ? referralParityExcludedKeys
      : parityExcludedKeys;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !ignoredKeys.has(key))
      .map(([key, child]) => [key, canonicalizeCommerceParityValue(child)])
  );
};

export const isCommerceShadowDocumentType = (type) =>
  COMMERCE_SHADOW_DOCUMENT_TYPES.includes(String(type || ""));
