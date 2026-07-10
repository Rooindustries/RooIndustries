import crypto from "node:crypto";

export const REFERRAL_IDENTITY_CLAIM_TYPE = "referralIdentityClaim";

const normalize = (value) => String(value || "").trim().toLowerCase();

export const buildReferralIdentityClaimId = ({ kind, value }) => {
  const normalizedKind = normalize(kind);
  const normalizedValue = normalize(value);
  if (!normalizedKind || !normalizedValue) return "";
  const digest = crypto
    .createHash("sha256")
    .update(`${normalizedKind}:${normalizedValue}`)
    .digest("hex");
  return `referralIdentityClaim.${normalizedKind}.${digest}`;
};

export const buildReferralIdentityClaim = ({
  kind,
  value,
  referralId,
  createdAt = new Date().toISOString(),
}) => ({
  _id: buildReferralIdentityClaimId({ kind, value }),
  _type: REFERRAL_IDENTITY_CLAIM_TYPE,
  kind: normalize(kind),
  referral: { _type: "reference", _ref: String(referralId || "").trim() },
  createdAt,
});
