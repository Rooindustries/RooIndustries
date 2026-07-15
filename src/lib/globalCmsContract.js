export const GLOBAL_SANITY_PROJECT_ID = "9g42k3ur";
export const GLOBAL_SANITY_DATASET = "production";

const CMS_PAUSE_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const CMS_PAUSE_FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export const resolveCmsWritePauseFlag = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (CMS_PAUSE_TRUE_VALUES.has(normalized)) {
    return { configured: true, paused: true };
  }
  if (CMS_PAUSE_FALSE_VALUES.has(normalized)) {
    return { configured: true, paused: false };
  }
  return { configured: false, paused: true };
};

export const GLOBAL_PUBLIC_CONTENT_TYPES = Object.freeze([
  "about",
  "benchmark",
  "contact",
  "discordBanner",
  "faqSection",
  "faqSettings",
  "footer",
  "hero",
  "howItWorks",
  "meetTheTeam",
  "package",
  "packagesSettings",
  "privacyPolicy",
  "proReviewsCarousel",
  "referralBox",
  "review",
  "services",
  "siteSettings",
  "supportedGames",
  "terms",
  "tool",
  "upgradeLink",
]);

export const GLOBAL_COMMERCE_CONTENT_TYPES = Object.freeze([
  "bookingSettings",
  "coupon",
  "package",
  "upgradeLink",
]);

export const GLOBAL_REFERRAL_DOCUMENT_TYPES = Object.freeze(["referral"]);

export const GLOBAL_OPERATIONAL_DOCUMENT_TYPES = Object.freeze([
  "booking",
  "bookingRecoveryCase",
  "bookingSlot",
  "couponRedemption",
  "paymentProofClaim",
  "paymentRecord",
  "paymentRecoveryCase",
  "paymentStartClaim",
  "paymentUpgradeLock",
  "paymentWebhookReceipt",
  "rateLimitBucket",
  "referralIdentityClaim",
  "slotHold",
]);

const PUBLIC_TYPE_SET = new Set(GLOBAL_PUBLIC_CONTENT_TYPES);
const COMMERCE_TYPE_SET = new Set(GLOBAL_COMMERCE_CONTENT_TYPES);
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const ASSET_ID_PATTERN = /^(?:image|file)-[A-Za-z0-9_.-]{1,240}$/;
const SYSTEM_FIELDS = new Set([
  "_createdBy",
  "_originalId",
  "_rev",
  "_system",
  "_updatedAt",
]);

const sortValue = (value) => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = sortValue(value[key]);
      return result;
    }, {});
};

export const stableCmsJson = (value) => JSON.stringify(sortValue(value));

export const isGlobalPublicContentType = (value) =>
  PUBLIC_TYPE_SET.has(String(value || "").trim());

export const isGlobalCmsEditableType = (value) => {
  const type = String(value || "").trim();
  return PUBLIC_TYPE_SET.has(type) || COMMERCE_TYPE_SET.has(type);
};

export const globalCmsAuthorityDomain = (value) => {
  const type = String(value || "").trim();
  if (COMMERCE_TYPE_SET.has(type)) return "commerce";
  if (PUBLIC_TYPE_SET.has(type)) return "content";
  if (GLOBAL_REFERRAL_DOCUMENT_TYPES.includes(type)) return "referral";
  if (GLOBAL_OPERATIONAL_DOCUMENT_TYPES.includes(type)) return "operational";
  return null;
};

export const publishedDocumentId = (value) => {
  const id = String(value || "")
    .trim()
    .replace(/^drafts\./, "");
  if (
    !DOCUMENT_ID_PATTERN.test(id) ||
    id.includes("..") ||
    id.startsWith("versions.")
  ) {
    throw new Error("The CMS document ID is invalid.");
  }
  return id;
};

export const normalizeGlobalCmsDocument = ({ document, id, type } = {}) => {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("A CMS document is required.");
  }
  const sourceType = String(document._type || "").trim();
  const documentType = String(type || sourceType).trim();
  if (!isGlobalCmsEditableType(documentType)) {
    throw new Error("The CMS document type is not supported.");
  }
  if (!sourceType || sourceType !== documentType) {
    throw new Error("The CMS document type does not match its schema.");
  }
  const normalizedId = publishedDocumentId(id || document._id);
  if (publishedDocumentId(document._id) !== normalizedId) {
    throw new Error("The CMS document ID does not match its source.");
  }
  const business = {};
  for (const [key, value] of Object.entries(document)) {
    if (
      SYSTEM_FIELDS.has(key) ||
      key.startsWith("_supabase") ||
      key === "_id" ||
      key === "_type"
    ) {
      continue;
    }
    business[key] = value;
  }
  return { ...business, _id: normalizedId, _type: documentType };
};

export const collectGlobalCmsAssetLinks = (document) => {
  const links = [];
  const seen = new Set();
  const documentId = publishedDocumentId(document?._id);

  const visit = (value, path) => {
    if (!value || typeof value !== "object") return;
    const reference = String(value._ref || "").trim();
    if (ASSET_ID_PATTERN.test(reference)) {
      const key = `${reference}:${path}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({
          document_legacy_id: documentId,
          asset_legacy_id: reference,
          field_path: path,
        });
      }
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key.startsWith("_") && key !== "_ref") continue;
      visit(entry, path ? `${path}.${key}` : key);
    }
  };

  visit(document, "$");
  return links.sort((left, right) =>
    `${left.asset_legacy_id}:${left.field_path}`.localeCompare(
      `${right.asset_legacy_id}:${right.field_path}`,
    ),
  );
};

export const collectGlobalCmsAssetIds = (document) =>
  [
    ...new Set(
      collectGlobalCmsAssetLinks(document).map((link) => link.asset_legacy_id),
    ),
  ].sort();

export const normalizeGlobalCmsAssetManifest = (assets) =>
  (Array.isArray(assets) ? assets : [])
    .map((asset) => ({
      _id: String(asset?._id || "").trim(),
      _type: String(asset?._type || "").trim(),
      assetId: String(asset?.assetId || "").trim(),
      extension: String(asset?.extension || "")
        .trim()
        .toLowerCase(),
      url: String(asset?.url || "").trim(),
      mimeType: String(asset?.mimeType || "")
        .trim()
        .toLowerCase(),
      size: Number(asset?.size || 0),
      sha1hash: String(asset?.sha1hash || "")
        .trim()
        .toLowerCase(),
      metadata: {
        dimensions: {
          width: Number(asset?.metadata?.dimensions?.width || 0) || null,
          height: Number(asset?.metadata?.dimensions?.height || 0) || null,
        },
      },
    }))
    .sort((left, right) => left._id.localeCompare(right._id));
