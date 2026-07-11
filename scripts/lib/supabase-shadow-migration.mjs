import crypto from "node:crypto";

export const CMS_DOCUMENT_TYPES = new Set([
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
  "packageBullet",
  "packagesSettings",
  "privacyPolicy",
  "proReviewsCarousel",
  "referralBox",
  "review",
  "reviewsCarousel",
  "services",
  "siteSettings",
  "supportedGames",
  "terms",
  "tool",
  "upgradeLink",
]);

const normalize = (value) => String(value || "").trim();
const normalizeEmail = (value) => normalize(value).toLowerCase();
const clampInteger = (value, minimum, maximum, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
};

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

export const stableJson = (value) => JSON.stringify(sortValue(value));

export const sha256 = (value) =>
  crypto
    .createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : stableJson(value))
    .digest("hex");

export const deterministicAuthUserId = (value) => {
  const bytes = crypto
    .createHash("sha256")
    .update(`roo-industries-auth:${normalizeEmail(value)}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};

const isBcrypt = (value) => /^\$2[aby]\$/.test(normalize(value));

const mergeUnique = (values) => [...new Set(values.filter(Boolean))].sort();

const internalTourneyEmail = (username) =>
  `tourney+${sha256(normalize(username).toLowerCase()).slice(0, 24)}@auth.rooindustries.invalid`;

const roleForTourney = (value) => {
  const role = normalize(value).toLowerCase();
  return ["player", "viewer", "caster", "owner"].includes(role)
    ? `tourney_${role}`
    : "";
};

const buildCredentialMigration = ({
  legacySanityId,
  source,
  passwordHash,
  sourceRevision,
}) => ({
  legacy_sanity_id: legacySanityId,
  legacy_source: source,
  credential_kind: isBcrypt(passwordHash) ? "bcrypt" : "legacy_plaintext",
  status: isBcrypt(passwordHash) ? "imported" : "pending",
  source_revision: sourceRevision || "",
});

const addAccount = (accounts, input) => {
  const key = normalizeEmail(input.primaryEmail);
  if (!key) throw new Error("An account is missing its login email.");
  const existing = accounts.get(key);
  if (!existing) {
    accounts.set(key, {
      userId: deterministicAuthUserId(key),
      primaryEmail: key,
      displayName: input.displayName,
      emailVerified: Boolean(input.emailVerified),
      legacySanityId: input.legacySanityId,
      sourceRevision: input.sourceRevision,
      sourceHash: input.sourceHash,
      sourceDocuments: [input.sourceDocument],
      roles: mergeUnique(input.roles),
      aliases: input.aliases,
      passwordHash: isBcrypt(input.passwordHash) ? input.passwordHash : "",
      credentialMigration: input.credentialMigration,
      creatorProfile: input.creatorProfile || null,
      tourneyAccount: input.tourneyAccount || null,
    });
    return;
  }

  if (
    existing.passwordHash &&
    isBcrypt(input.passwordHash) &&
    existing.passwordHash !== input.passwordHash
  ) {
    throw new Error("Two legacy identities with one email have different passwords.");
  }

  existing.displayName = existing.displayName || input.displayName;
  existing.emailVerified ||= Boolean(input.emailVerified);
  existing.roles = mergeUnique([...existing.roles, ...input.roles]);
  existing.aliases = [
    ...existing.aliases,
    ...input.aliases.filter(
      (alias) =>
        !existing.aliases.some(
          (current) =>
            current.type === alias.type &&
            normalize(current.value).toLowerCase() ===
              normalize(alias.value).toLowerCase()
        )
    ),
  ];
  existing.passwordHash ||= isBcrypt(input.passwordHash) ? input.passwordHash : "";
  existing.creatorProfile ||= input.creatorProfile || null;
  existing.tourneyAccount ||= input.tourneyAccount || null;
  existing.sourceDocuments.push(input.sourceDocument);
  existing.sourceHash = sha256(existing.sourceDocuments);
};

const parseTourneyAccounts = (document) => {
  try {
    const parsed = JSON.parse(String(document?.accountsJson || ""));
    const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts;
    return Array.isArray(accounts) ? accounts : [];
  } catch {
    throw new Error("The Tourney account store contains invalid JSON.");
  }
};

export const buildMigrationAccounts = (documents) => {
  const accounts = new Map();
  const referrals = documents.filter((document) => document?._type === "referral");

  for (const referral of referrals) {
    const primaryEmail = normalizeEmail(referral.creatorEmail);
    const referralCode = normalize(referral.slug?.current).toLowerCase();
    const passwordHash = normalize(referral.creatorPassword);
    if (!primaryEmail || !referralCode || !passwordHash) {
      throw new Error("A referral account is missing required login data.");
    }

    const sourceHash = sha256(referral);
    addAccount(accounts, {
      primaryEmail,
      displayName: normalize(referral.name) || referralCode,
      emailVerified: true,
      legacySanityId: referral._id,
      sourceRevision: referral._rev,
      sourceHash,
      sourceDocument: referral,
      roles: ["customer", "creator"],
      aliases: [
        { type: "email", value: primaryEmail, verified: true },
        { type: "referral_code", value: referralCode, verified: true },
      ],
      passwordHash,
      credentialMigration: buildCredentialMigration({
        legacySanityId: referral._id,
        source: "referral",
        passwordHash,
        sourceRevision: referral._rev,
      }),
      creatorProfile: {
        referral_code: referralCode,
        paypal_email: normalizeEmail(referral.paypalEmail),
        contact_discord: normalize(referral.contactDiscord),
        commission_basis_points: clampInteger(
          Number(referral.currentCommissionPercent || 10) * 100,
          0,
          10000,
          1000
        ),
        discount_basis_points: clampInteger(
          Number(referral.currentDiscountPercent || 0) * 100,
          0,
          10000,
          0
        ),
        successful_referrals: clampInteger(
          referral.successfulReferrals,
          0,
          Number.MAX_SAFE_INTEGER,
          0
        ),
        payout_details: {
          paypal_email: normalizeEmail(referral.paypalEmail),
        },
        accounting_totals: {
          earned_total: Number(referral.earnedTotal || 0),
          owed_total: Number(referral.owedTotal || 0),
          paid_total: Number(referral.paidTotal || 0),
          earned_vertex: Number(referral.earnedVertex || 0),
          earned_xoc: Number(referral.earnedXoc || 0),
          owed_vertex: Number(referral.owedVertex || 0),
          owed_xoc: Number(referral.owedXoc || 0),
          paid_vertex: Number(referral.paidVertex || 0),
          paid_xoc: Number(referral.paidXoc || 0),
        },
        active: referral.active !== false,
        legacy_sanity_id: referral._id,
        source_revision: referral._rev || "",
        source_hash: sourceHash,
      },
    });
  }

  const store = documents.find((document) => document?._type === "tourneyAuthStore");
  if (store) {
    for (const legacyAccount of parseTourneyAccounts(store)) {
      const username = normalize(legacyAccount.username).toLowerCase();
      const tourneyRole = roleForTourney(legacyAccount.role);
      const passwordHash = normalize(
        legacyAccount.passwordHash || legacyAccount.password_hash
      );
      if (!username || !tourneyRole || !passwordHash) {
        throw new Error("A Tourney account is missing required login data.");
      }

      const configuredEmail = normalizeEmail(legacyAccount.email);
      const primaryEmail = configuredEmail || internalTourneyEmail(username);
      const compositeLegacyId = `${store._id}#${username}`;
      const sourceHash = sha256({ store: store._id, account: legacyAccount });

      addAccount(accounts, {
        primaryEmail,
        displayName: username,
        emailVerified: Boolean(configuredEmail),
        legacySanityId: compositeLegacyId,
        sourceRevision: store._rev,
        sourceHash,
        sourceDocument: { store: store._id, account: legacyAccount },
        roles: [tourneyRole],
        aliases: [
          { type: "email", value: primaryEmail, verified: Boolean(configuredEmail) },
          { type: "tourney_username", value: username, verified: true },
        ],
        passwordHash,
        credentialMigration: buildCredentialMigration({
          legacySanityId: compositeLegacyId,
          source: "tourney",
          passwordHash,
          sourceRevision: store._rev,
        }),
        tourneyAccount: {
          username,
          role: tourneyRole,
          active: legacyAccount.active !== false,
          credential_version: normalize(legacyAccount.version) || "1",
          legacy_sanity_id: compositeLegacyId,
          source_revision: store._rev || "",
          source_hash: sourceHash,
          legacy_payload: {
            role: normalize(legacyAccount.role).toLowerCase(),
            active: legacyAccount.active !== false,
            version: normalize(legacyAccount.version) || "1",
          },
        },
      });
    }
  }

  return [...accounts.values()]
    .map((account) => ({
      ...account,
      sourceHash: sha256(account.sourceDocuments),
      roles: mergeUnique(account.roles),
      aliases: account.aliases.sort((left, right) =>
        `${left.type}:${left.value}`.localeCompare(
          `${right.type}:${right.value}`
        )
      ),
    }))
    .sort((left, right) => left.userId.localeCompare(right.userId));
};

export const accountRpcPayload = (account) => ({
  user_id: account.userId,
  primary_email: account.primaryEmail,
  display_name: account.displayName,
  status: "active",
  legacy_sanity_id: account.legacySanityId,
  source_revision: account.sourceRevision || "",
  source_hash: account.sourceHash,
  roles: account.roles,
  aliases: account.aliases,
  credential_migration: account.credentialMigration,
  ...(account.creatorProfile ? { creator_profile: account.creatorProfile } : {}),
  ...(account.tourneyAccount ? { tourney_account: account.tourneyAccount } : {}),
});

const sanitizeAssetSegment = (value) =>
  normalize(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const assetStorageDescriptor = (asset) => {
  const isImage = asset?._type === "sanity.imageAsset";
  const isFile = asset?._type === "sanity.fileAsset";
  if (!isImage && !isFile) throw new Error("Unsupported Sanity asset type.");
  const extension = sanitizeAssetSegment(asset.extension).toLowerCase();
  const assetId = sanitizeAssetSegment(asset.assetId || asset._id);
  if (!extension || !assetId || !normalize(asset.url) || !normalize(asset.mimeType)) {
    throw new Error("A Sanity asset is missing required metadata.");
  }
  return {
    legacySanityAssetId: asset._id,
    sourceUrl: normalize(asset.url),
    storageBucket: isImage
      ? "site-content-public"
      : "optimization-builds-private",
    storagePath: `${isImage ? "images" : "builds"}/${assetId}.${extension}`,
    mimeType: normalize(asset.mimeType).toLowerCase(),
    expectedBytes: Number(asset.size || 0),
    expectedSha1: normalize(asset.sha1hash).toLowerCase(),
    width: Number(asset.metadata?.dimensions?.width || 0) || null,
    height: Number(asset.metadata?.dimensions?.height || 0) || null,
    metadata: {
      extension,
      source_type: asset._type,
      source_asset_id: asset.assetId || "",
    },
  };
};

export const collectAssetLinks = (documents) => {
  const links = [];
  const seen = new Set();

  const visit = (value, path, documentId) => {
    if (!value || typeof value !== "object") return;
    if (
      typeof value._ref === "string" &&
      /^(image|file)-/.test(value._ref)
    ) {
      const key = `${documentId}:${value._ref}:${path}`;
      if (!seen.has(key)) {
        links.push({
          document_legacy_id: documentId,
          asset_legacy_id: value._ref,
          field_path: path,
        });
        seen.add(key);
      }
    }

    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        visit(entry, `${path}[${index}]`, documentId)
      );
      return;
    }

    for (const [key, entry] of Object.entries(value)) {
      if (key.startsWith("_") && key !== "_ref") continue;
      visit(entry, path ? `${path}.${key}` : key, documentId);
    }
  };

  for (const document of documents) {
    if (!CMS_DOCUMENT_TYPES.has(document?._type)) continue;
    visit(document, "$", document._id);
  }

  return links.sort((left, right) =>
    `${left.document_legacy_id}:${left.field_path}`.localeCompare(
      `${right.document_legacy_id}:${right.field_path}`
    )
  );
};

export const summarizeDocuments = (documents) => {
  const byType = {};
  for (const document of documents) {
    byType[document._type] = (byType[document._type] || 0) + 1;
  }
  return {
    total: documents.length,
    byType: Object.fromEntries(Object.entries(byType).sort()),
  };
};

export const buildDocumentManifest = (documents) =>
  documents
    .map((document) => ({
      id: document._id,
      type: document._type,
      revision: document._rev || "",
      hash: sha256(document),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

export const compareDocumentManifests = (source, target) => {
  const sourceById = new Map(source.map((entry) => [entry.id, entry]));
  const targetById = new Map(target.map((entry) => [entry.id, entry]));
  const missingTarget = [];
  const missingSource = [];
  const mismatched = [];

  for (const [id, sourceEntry] of sourceById) {
    const targetEntry = targetById.get(id);
    if (!targetEntry) {
      missingTarget.push(id);
    } else if (
      sourceEntry.type !== targetEntry.type ||
      sourceEntry.hash !== targetEntry.hash
    ) {
      mismatched.push(id);
    }
  }
  for (const id of targetById.keys()) {
    if (!sourceById.has(id)) missingSource.push(id);
  }

  return {
    ok:
      missingTarget.length === 0 &&
      missingSource.length === 0 &&
      mismatched.length === 0,
    missingTarget,
    missingSource,
    mismatched,
  };
};

export const mapConcurrent = async (values, concurrency, worker) => {
  const result = new Array(values.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      result[currentIndex] = await worker(values[currentIndex], currentIndex);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), values.length || 1) },
      run
    )
  );
  return result;
};
