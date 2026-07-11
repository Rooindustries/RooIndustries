import {
  COMMERCE_EPHEMERAL_DOCUMENT_TYPES,
  COMMERCE_MIXED_IDENTITY_DOCUMENT_TYPES,
  COMMERCE_RECONCILABLE_DOCUMENT_TYPES,
  COMMERCE_SHADOW_DOCUMENT_TYPES,
  isCommerceShadowDocumentType,
} from "../server/commerce/documentTypes";

describe("Supabase commerce-only shadow scope", () => {
  test("contains the booking and payment records needed for cutover", () => {
    expect(COMMERCE_SHADOW_DOCUMENT_TYPES).toEqual(
      expect.arrayContaining([
        "booking",
        "slotHold",
        "bookingSlot",
        "paymentRecord",
        "paymentProofClaim",
        "paymentWebhookReceipt",
        "paymentRecoveryCase",
        "coupon",
        "couponRedemption",
        "owedReferral",
        "creatorPayout",
      ])
    );
  });

  test("does not include Auth, Tourney, CMS assets, or ephemeral rate buckets", () => {
    expect(COMMERCE_SHADOW_DOCUMENT_TYPES).not.toEqual(
      expect.arrayContaining([
        "referralIdentityClaim",
        "tourneyAuthStore",
        "sanity.imageAsset",
        "sanity.fileAsset",
        "refRateLimitBucket",
      ])
    );
    expect(COMMERCE_EPHEMERAL_DOCUMENT_TYPES).toEqual([
      "refRateLimitBucket",
    ]);
  });

  test("reads mixed referral records but cannot reconcile their identities", () => {
    expect(COMMERCE_MIXED_IDENTITY_DOCUMENT_TYPES).toEqual(["referral"]);
    expect(isCommerceShadowDocumentType("referral")).toBe(true);
    expect(COMMERCE_RECONCILABLE_DOCUMENT_TYPES).not.toContain("referral");
  });
});
