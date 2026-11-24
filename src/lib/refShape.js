export const KNOWN_AD_REF_TAGS = ["gads-max", "chatgpt-ads"];
const REF_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const normalizeRef = (value) => {
  if (typeof value !== "string") return "";
  const code = value.trim().toLowerCase();
  return code && REF_PATTERN.test(code) && (code.match(/\d/g) || []).length < 7 ? code : "";
};
export const isKnownAdRefTag = (value) =>
  typeof value === "string" && KNOWN_AD_REF_TAGS.includes(value.trim().toLowerCase());
export const normalizeLinkReferral = (value) => {
  const code = normalizeRef(value);
  return code && !isKnownAdRefTag(code) ? code : "";
};
