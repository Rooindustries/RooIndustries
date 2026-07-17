import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { createSupabaseAdminClient } from "./adminClient.js";
import { createSupabaseAuthClient } from "./authClient.js";

const normalizeIdentifier = (value) => String(value || "").trim().toLowerCase();
const normalizePassword = (value) => String(value || "");
const RESET_CREDENTIAL_FIELDS = [
  "resetToken",
  "resetTokenHash",
  "resetTokenExpiresAt",
  "resetDeliveryToken",
];

const requireRpcData = ({ data, error }, operation) => {
  if (error) {
    const failure = new Error(`Supabase ${operation} failed.`);
    failure.code = error.code || "SUPABASE_ACCOUNT_FAILED";
    failure.status = error.status || 500;
    throw failure;
  }
  return data || null;
};

export const resolveSupabaseAccountAlias = async ({
  identifier,
  accountScope = "default",
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  const normalized = normalizeIdentifier(identifier);
  if (!normalized || normalized.length > 254) return null;
  return requireRpcData(
    await adminClient.rpc(
      accountScope === "tourney"
        ? "roo_resolve_tourney_account_alias"
        : "roo_resolve_account_alias",
      {
      p_identifier: normalized,
      }
    ),
    "account lookup"
  );
};

export const resolveSupabaseAccountByUserId = async ({
  userId,
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  const normalizedUserId = String(userId || "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalizedUserId
    )
  ) {
    return null;
  }
  return requireRpcData(
    await adminClient.rpc("roo_account_by_user_id", {
      p_user_id: normalizedUserId,
    }),
    "account lookup"
  );
};

const resolveAuthenticationFailure = (error) => {
  const status = Number(error?.status || 0);
  if (status === 400 || status === 401) return "invalid_credentials";
  return "unavailable";
};

export const authenticateSupabaseAccount = async ({
  identifier,
  password,
  env = process.env,
  requiredRoles = [],
  accountScope = "default",
  verifyLegacyPassword,
  adminClient = createSupabaseAdminClient({ env }),
  authClient = createSupabaseAuthClient({ env }),
} = {}) => {
  const normalizedPassword = normalizePassword(password);
  if (!normalizedPassword || normalizedPassword.length > 128) {
    return { ok: false, reason: "invalid_credentials" };
  }

  const account = await resolveSupabaseAccountAlias({
    identifier,
    accountScope,
    adminClient,
  });
  const roles = Array.isArray(account?.roles) ? account.roles : [];
  const hasRequiredRole =
    requiredRoles.length < 1 || requiredRoles.some((role) => roles.includes(role));
  if (!account || !hasRequiredRole) {
    return { ok: false, reason: "invalid_credentials" };
  }
  if (requiredRoles.includes("creator") && account.creator_active === false) {
    return { ok: false, reason: "invalid_credentials" };
  }
  if (accountScope === "tourney" && account.tourney_active === false) {
    return {
      ok: false,
      reason: account.tourney_status === "removed"
        ? "suspended"
        : "invalid_credentials",
    };
  }
  if (account.status !== "active") {
    return { ok: false, reason: "invalid_credentials" };
  }

  const signIn = () =>
    authClient.auth.signInWithPassword({
      email: account.primary_email,
      password: normalizedPassword,
    });
  let result = await signIn();

  const canUpgradeLegacy =
    result.error &&
    account.credential_status === "pending" &&
    account.credential_kind === "legacy_plaintext" &&
    typeof verifyLegacyPassword === "function";
  if (canUpgradeLegacy) {
    const verified = await verifyLegacyPassword({ account, password: normalizedPassword });
    if (verified) {
      const updated = await adminClient.auth.admin.updateUserById(account.user_id, {
        password: normalizedPassword,
      });
      if (updated.error) {
        return { ok: false, reason: "unavailable" };
      }
      requireRpcData(
        await adminClient.rpc("roo_complete_credential_migration", {
          p_user_id: account.user_id,
        }),
        "credential migration"
      );
      result = await signIn();
    }
  }

  if (result.error || !result.data?.user || !result.data?.session) {
    return {
      ok: false,
      reason: resolveAuthenticationFailure(result.error),
    };
  }

  return {
    ok: true,
    account,
    user: result.data.user,
    session: result.data.session,
  };
};

export const updateSupabaseAccountPassword = async ({
  identifier,
  password,
  passwordHash = "",
  sourceBackend = "",
  sourceDocumentId = "",
  sourcePreconditions = null,
  sourceMutation = null,
  sourceRevision = "",
  operationKey = `credential:${crypto.randomUUID()}`,
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  const normalizedPassword = normalizePassword(password);
  const importedHash = String(passwordHash || "").trim();
  if (
    normalizedPassword.length < 10 ||
    normalizedPassword.length > 128 ||
    (importedHash && !/^\$2[aby]\$/.test(importedHash))
  ) {
    throw new Error("Password must be between 10 and 128 characters.");
  }
  const account = await resolveSupabaseAccountAlias({ identifier, adminClient });
  if (!account?.user_id) return { updated: false };
  const resolvedHash = importedHash || (await bcrypt.hash(normalizedPassword, 12));
  const normalizedSourceBackend = String(sourceBackend || "").trim().toLowerCase();
  const normalizedSourceDocumentId = String(sourceDocumentId || "").trim();
  const normalizedSourceRevision = String(sourceRevision || "").trim();
  if (
    !["sanity", "supabase"].includes(normalizedSourceBackend) ||
    !normalizedSourceDocumentId ||
    !normalizedSourceRevision ||
    !sourcePreconditions ||
    typeof sourcePreconditions !== "object" ||
    !sourceMutation ||
    typeof sourceMutation !== "object"
  ) {
    throw new Error("Credential source recovery metadata is required.");
  }
  const prepared = requireRpcData(
    await adminClient.rpc("roo_prepare_credential_operation_v2", {
      p_operation_key: operationKey,
      p_user_id: account.user_id,
      p_password_hash: resolvedHash,
      p_source_backend: normalizedSourceBackend,
      p_source_document_id: normalizedSourceDocumentId,
      p_source_expected_revision: normalizedSourceRevision,
      p_source_preconditions: sourcePreconditions,
      p_source_mutation: sourceMutation,
    }),
    "credential recovery preparation"
  );
  const effectiveHash = String(prepared?.password_hash || resolvedHash);
  if (prepared?.status === "prepared") {
    const result = await adminClient.auth.admin.updateUserById(account.user_id, {
      password: normalizedPassword,
    });
    if (result.error) throw new Error("Supabase password update failed.");
    requireRpcData(
      await adminClient.rpc("roo_mark_credential_operation", {
        p_operation_key: operationKey,
        p_status: "auth_applied",
        p_error_code: null,
      }),
      "credential recovery checkpoint"
    );
  }
  return {
    updated: true,
    userId: account.user_id,
    principalId: account.principal_id,
    operationKey,
    passwordHash: effectiveHash,
    sourceBackend: normalizedSourceBackend,
    sourceDocumentId: normalizedSourceDocumentId,
    sourcePreconditions: prepared?.source_preconditions || sourcePreconditions,
    sourceMutation: prepared?.source_mutation || sourceMutation,
  };
};

export const getSupabaseCredentialOperation = async ({
  operationKey,
  adminClient = createSupabaseAdminClient(),
} = {}) =>
  requireRpcData(
    await adminClient.rpc("roo_get_credential_operation", {
      p_operation_key: String(operationKey || "").trim(),
    }),
    "credential operation lookup"
  );

export const buildCredentialSourceMutation = ({
  passwordHash,
  passwordChangedAt,
  consumeResetToken = false,
} = {}) => ({
  set: {
    creatorPassword: String(passwordHash || ""),
    credentialVersion: 2,
    passwordLoginEnabled: true,
    passwordResetRequired: false,
    passwordChangedAt: String(passwordChangedAt || ""),
  },
  unset: consumeResetToken ? RESET_CREDENTIAL_FIELDS : [],
});

export const buildCredentialSourcePreconditions = ({
  document,
  resetTokenHash = "",
} = {}) => {
  const preconditions = {};
  for (const field of [
    "creatorPassword",
    "credentialVersion",
    "resetTokenExpiresAt",
  ]) {
    if (document?.[field] !== undefined && document?.[field] !== null) {
      preconditions[field] = document[field];
    }
  }
  const normalizedResetTokenHash = String(resetTokenHash || "").trim();
  if (normalizedResetTokenHash) {
    preconditions.resetTokenHash = normalizedResetTokenHash;
  } else if (
    document?.resetTokenHash !== undefined &&
    document?.resetTokenHash !== null
  ) {
    preconditions.resetTokenHash = document.resetTokenHash;
  }
  return preconditions;
};

export const resolveCredentialSourceRevision = ({
  document,
  sourceBackend,
} = {}) => {
  if (String(sourceBackend || "").trim().toLowerCase() === "supabase") {
    return String(document?._supabaseRevision || document?._rev || "").trim();
  }
  return String(document?._rev || "").trim();
};

export const markSupabaseCredentialSourceApplied = async ({
  operationKey,
  sourceRevision,
  adminClient = createSupabaseAdminClient(),
} = {}) =>
  requireRpcData(
    await adminClient.rpc("roo_mark_credential_source_applied", {
      p_operation_key: operationKey,
      p_source_revision: sourceRevision,
    }),
    "credential source checkpoint"
  );

export const completeSupabaseCredentialMirror = async ({
  operationKey,
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  const completed = requireRpcData(
    await adminClient.rpc("roo_complete_credential_operation", {
      p_operation_key: operationKey,
    }),
    "credential mirror completion"
  );
  return { sessionVersion: Number(completed?.session_version || 0) };
};

const deterministicUuid = (value) => {
  const bytes = crypto
    .createHash("sha256")
    .update(`roo-industries-auth:${normalizeIdentifier(value)}`)
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

const sha256 = (value) =>
  crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

export const buildTourneyPlayerAuthEmail = (username) =>
  `tourney-player+${sha256(normalizeIdentifier(username)).slice(0, 24)}@auth.rooindustries.invalid`;

const buildTourneyAdminAuthEmail = ({ username, email }) =>
  normalizeIdentifier(email) ||
  `tourney+${sha256(normalizeIdentifier(username)).slice(0, 24)}@auth.rooindustries.invalid`;

const upsertAuthUserWithHash = async ({
  userId,
  email,
  passwordHash,
  displayName,
  appMetadata,
  adminClient,
}) => {
  if (!/^\$2[aby]\$/.test(String(passwordHash || ""))) {
    throw new Error("Supabase Auth imports require bcrypt credentials.");
  }
  const attributes = {
    email,
    email_confirm: true,
    password_hash: passwordHash,
    user_metadata: { display_name: displayName },
    app_metadata: appMetadata,
  };
  const existing = await adminClient.auth.admin.getUserById(userId);
  if (existing.error && Number(existing.error.status || 0) !== 404) {
    throw new Error("Supabase Auth inventory failed.");
  }
  if (existing.data?.user) {
    const currentUser = existing.data.user;
    const existingRoles = Array.isArray(currentUser.app_metadata?.roles)
      ? currentUser.app_metadata.roles
      : [];
    const desiredRoles = Array.isArray(appMetadata?.roles) ? appMetadata.roles : [];
    const roles = [...new Set([
      ...existingRoles.filter((role) => !String(role).startsWith("tourney_")),
      ...desiredRoles,
    ])];
    const updated = await adminClient.auth.admin.updateUserById(userId, {
      ...attributes,
      user_metadata: {
        ...(currentUser.user_metadata || {}),
        ...attributes.user_metadata,
      },
      app_metadata: {
        ...(currentUser.app_metadata || {}),
        ...appMetadata,
        imported_from:
          currentUser.app_metadata?.imported_from || appMetadata?.imported_from,
        roles,
      },
    });
    if (updated.error) throw new Error("Supabase Auth synchronization failed.");
    return;
  }
  const created = await adminClient.auth.admin.createUser({ id: userId, ...attributes });
  if (created.error) throw new Error("Supabase Auth account creation failed.");
};

export const syncSupabaseTourneyPlayerAccount = async ({
  player,
  passwordHash,
  authUserId = "",
  env = process.env,
  installPassword = true,
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  const username = normalizeIdentifier(player?.username);
  const source = {
    id: player?.id,
    username,
    email: normalizeIdentifier(player?.email),
    display_name: String(player?.display_name || player?.displayName || player?.discord || username),
    status: String(player?.status || "pending"),
    version: String(player?.version || "1"),
    registration_pool: String(player?.registration_pool || player?.registrationPool || "main"),
  };
  const sourceHash = sha256(source);
  const existingAccount = await resolveSupabaseAccountAlias({
    identifier: username,
    accountScope: "tourney",
    adminClient,
  });
  const requestedUserId = String(authUserId || "").trim();
  if (
    requestedUserId &&
    existingAccount?.user_id &&
    existingAccount.user_id !== requestedUserId
  ) {
    throw new Error("Tourney account is already linked to another Auth user.");
  }
  const fallbackEmail = buildTourneyPlayerAuthEmail(username);
  const userId = requestedUserId || existingAccount?.user_id || deterministicUuid(fallbackEmail);
  const existingAuth = await adminClient.auth.admin.getUserById(userId);
  if (existingAuth.error && Number(existingAuth.error.status || 0) !== 404) {
    throw new Error("Supabase Auth inventory failed.");
  }
  const existingUser = existingAuth.data?.user || null;
  if (existingUser) {
    const existingLegacyId = String(
      existingUser.app_metadata?.legacy_player_id || ""
    ).trim();
    if (existingLegacyId && existingLegacyId !== String(source.id || "")) {
      throw new Error("Supabase Auth user belongs to another Tourney player.");
    }
    if (requestedUserId) {
      const linkedAccount = await resolveSupabaseAccountByUserId({
        userId: requestedUserId,
        adminClient,
      });
      const verifiedEmail = normalizeIdentifier(linkedAccount?.verified_real_email);
      if (!verifiedEmail || verifiedEmail !== source.email) {
        throw new Error("Tourney social signup email does not match Auth.");
      }
    }
    const roles = new Set([
      ...(Array.isArray(existingUser.app_metadata?.roles)
        ? existingUser.app_metadata.roles
        : []),
      "tourney_player",
    ]);
    const updated = await adminClient.auth.admin.updateUserById(userId, {
      ...(installPassword ? { password_hash: passwordHash } : {}),
      app_metadata: {
        ...existingUser.app_metadata,
        imported_from:
          existingUser.app_metadata?.imported_from || "legacy-tourney-database",
        legacy_player_id: source.id,
        roles: [...roles],
      },
    });
    if (updated.error) throw new Error("Supabase Auth synchronization failed.");
  } else {
    await upsertAuthUserWithHash({
      userId,
      email: fallbackEmail,
      passwordHash,
      displayName: source.display_name,
      appMetadata: {
        imported_from: "legacy-tourney-database",
        legacy_player_id: source.id,
        roles: ["tourney_player"],
      },
      adminClient,
    });
  }
  const authEmail = normalizeIdentifier(existingUser?.email) || fallbackEmail;
  const imported = requireRpcData(
    await adminClient.rpc("roo_import_tourney_player_account_v2", {
      p_account: {
        user_id: userId,
        auth_email: authEmail,
        login_email: source.email,
        username,
        player_id: source.id,
        display_name: source.display_name,
        status: source.status,
        credential_version: source.version,
        source_hash: sourceHash,
        legacy_payload: {
          status: source.status,
          registration_pool: source.registration_pool,
        },
      },
    }),
    "Tourney player account synchronization"
  );
  const resolvedAccount = await resolveSupabaseAccountByUserId({ userId, adminClient });
  return {
    userId,
    principalId: resolvedAccount?.principal_id || "",
    account: resolvedAccount,
    imported,
    discordRoleAssignment: null,
  };
};

export const syncSupabaseTourneyAdminAccount = async ({
  account,
  env = process.env,
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  const username = normalizeIdentifier(account?.username);
  const role = normalizeIdentifier(account?.role);
  if (!username || !["viewer", "caster", "owner"].includes(role)) {
    throw new Error("Invalid Tourney administrator account.");
  }
  const primaryEmail = buildTourneyAdminAuthEmail({
    username,
    email: account?.email,
  });
  const existing = await resolveSupabaseAccountAlias({
    identifier: username,
    accountScope: "tourney",
    adminClient,
  });
  const existingEmailAccount = account?.email
    ? await resolveSupabaseAccountAlias({
        identifier: account.email,
        adminClient,
      })
    : null;
  if (
    existingEmailAccount?.user_id &&
    ((existing?.user_id && existingEmailAccount.user_id !== existing.user_id) ||
      (!existing?.user_id &&
        !(existingEmailAccount.roles || []).some((value) =>
          String(value).startsWith("tourney_")
        )))
  ) {
    throw new Error(
      "Tourney administrator email is already linked to another account."
    );
  }
  const userId =
    existing?.user_id ||
    existingEmailAccount?.user_id ||
    deterministicUuid(primaryEmail);
  const legacyId = `tourneyAuthStore#${username}`;
  const sourceHash = sha256({
    username,
    role,
    active: account.active !== false,
    version: String(account.version || "1"),
  });
  await upsertAuthUserWithHash({
    userId,
    email: primaryEmail,
    passwordHash: account.passwordHash || account.password_hash,
    displayName: username,
    appMetadata: {
      imported_from: "sanity",
      legacy_sanity_id: legacyId,
      roles: [`tourney_${role}`],
    },
    adminClient,
  });
  requireRpcData(
    await adminClient.rpc("roo_import_account_v2", {
      p_account: {
        user_id: userId,
        primary_email: primaryEmail,
        display_name: username,
        status: account.active === false ? "disabled" : "active",
        legacy_sanity_id: legacyId,
        source_revision: null,
        source_hash: sourceHash,
        roles: [`tourney_${role}`],
        aliases: [
          { type: "email", value: primaryEmail, verified: Boolean(account.email) },
          { type: "tourney_username", value: username, verified: true },
        ],
        credential_migration: {
          legacy_sanity_id: legacyId,
          legacy_source: "tourney",
          credential_kind: "bcrypt",
          status: "imported",
          source_revision: null,
        },
        tourney_account: {
          username,
          role: `tourney_${role}`,
          active: account.active !== false,
          credential_version: String(account.version || "1"),
          legacy_sanity_id: legacyId,
          source_revision: null,
          source_hash: sourceHash,
          legacy_payload: {
            role,
            active: account.active !== false,
            version: String(account.version || "1"),
          },
        },
      },
    }),
    "Tourney administrator account synchronization"
  );
  requireRpcData(
    await adminClient.rpc("roo_finalize_imported_account_metadata", {
      p_user_id: userId,
      p_source_revision: null,
      p_source_hash: sourceHash,
      p_email_verified: Boolean(account.email),
    }),
    "Tourney administrator metadata synchronization"
  );
  return {
    userId,
    account: await resolveSupabaseAccountByUserId({ userId, adminClient }),
    discordRoleAssignment: null,
  };
};

export const createSupabaseCreatorAccount = async ({
  referral,
  password,
  passwordHash = "",
  authUserId = "",
  sourceRevision = "",
  sourceHash = "",
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  const email = normalizeIdentifier(referral?.creatorEmail);
  const code = normalizeIdentifier(referral?.slug?.current);
  const legacyId = String(referral?._id || "").trim();
  if (!email || !code || !legacyId) {
    throw new Error("Creator account metadata is incomplete.");
  }

  const existingAccount = await resolveSupabaseAccountAlias({
    identifier: email,
    adminClient,
  });
  const requestedUserId = String(authUserId || "").trim();
  if (
    existingAccount?.user_id &&
    requestedUserId &&
    existingAccount.user_id !== requestedUserId
  ) {
    throw new Error("Creator email is already linked to another account.");
  }
  if (
    existingAccount?.user_id &&
    !requestedUserId &&
    !(existingAccount.roles || []).includes("creator")
  ) {
    throw new Error("Creator email is already linked to another account.");
  }

  const userId = requestedUserId || existingAccount?.user_id || deterministicUuid(email);
  let createdUserId = "";
  if (requestedUserId) {
    const existing = await adminClient.auth.admin.getUserById(requestedUserId);
    const user = existing.data?.user;
    const linkedAccount = await resolveSupabaseAccountByUserId({
      userId: requestedUserId,
      adminClient,
    });
    const verifiedEmail = normalizeIdentifier(linkedAccount?.verified_real_email);
    if (existing.error || !user || verifiedEmail !== email) {
      throw new Error("Creator social signup email does not match Auth.");
    }
    const roles = new Set([
      ...(Array.isArray(user.app_metadata?.roles) ? user.app_metadata.roles : []),
      "creator",
    ]);
    const normalizedPassword = normalizePassword(password);
    const updated = await adminClient.auth.admin.updateUserById(requestedUserId, {
      ...(normalizedPassword ? { password: normalizedPassword } : {}),
      user_metadata: {
        ...user.user_metadata,
        display_name: String(referral.name || code).trim(),
        migration_source: "roo-industries-website",
      },
      app_metadata: { ...user.app_metadata, roles: [...roles] },
    });
    if (updated.error) throw new Error("Supabase creator Auth update failed.");
  } else {
    const importedHash = String(passwordHash || "").trim();
    if (importedHash && !/^\$2[aby]\$/.test(importedHash)) {
      throw new Error("Creator password import requires bcrypt.");
    }
    const authAttributes = {
      email,
      email_confirm: true,
      ...(importedHash
        ? { password_hash: importedHash }
        : { password: normalizePassword(password) }),
      user_metadata: {
        display_name: String(referral.name || code).trim(),
        migration_source: "roo-industries-website",
      },
    };
    const existingAuth = await adminClient.auth.admin.getUserById(userId);
    if (existingAuth.error && Number(existingAuth.error.status || 0) !== 404) {
      throw new Error("Supabase creator Auth inventory failed.");
    }
    if (existingAuth.data?.user) {
      const updated = await adminClient.auth.admin.updateUserById(
        userId,
        authAttributes
      );
      if (updated.error) throw new Error("Supabase creator Auth update failed.");
    } else {
      const created = await adminClient.auth.admin.createUser({
        id: userId,
        ...authAttributes,
      });
      if (created.error) {
        throw new Error("Supabase creator Auth creation failed.");
      }
      createdUserId = created.data?.user?.id || "";
    }
  }

  try {
    requireRpcData(
      await adminClient.rpc("roo_upsert_native_creator_account", {
        p_account: {
          user_id: userId,
          primary_email: email,
          display_name: String(referral.name || code).trim(),
          referral_code: code,
          paypal_email: normalizeIdentifier(referral.paypalEmail) || null,
          contact_discord: String(referral.contactDiscord || "").trim() || null,
          legacy_sanity_id: legacyId,
          source_revision: sourceRevision || referral._rev || null,
          source_hash: sourceHash || null,
        },
      }),
      "creator account upsert"
    );
    requireRpcData(
      await adminClient.rpc("roo_reconcile_auth_identity_links", {
        p_user_id: userId,
      }),
      "creator identity reconciliation"
    );
  } catch (error) {
    if (createdUserId) {
      await adminClient.auth.admin.deleteUser(createdUserId).catch(() => {});
    }
    throw error;
  }

  return {
    userId,
    account: await resolveSupabaseAccountByUserId({ userId, adminClient }),
  };
};

export const bootstrapSupabaseNativeAccount = async ({
  userId,
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  const normalizedUserId = String(userId || "").trim();
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalizedUserId
    );
  if (!isUuid) {
    throw new Error("A valid Supabase Auth user id is required.");
  }

  const account = requireRpcData(
    await adminClient.rpc("roo_bootstrap_native_account", {
      p_user_id: normalizedUserId,
    }),
    "native account bootstrap"
  );
  requireRpcData(
    await adminClient.rpc("roo_reconcile_auth_identity_links", {
      p_user_id: normalizedUserId,
    }),
    "identity reconciliation"
  );
  return account;
};

export const createVerifiedSupabaseBrowserSession = async ({
  userId,
  adminClient = createSupabaseAdminClient(),
  authClient = createSupabaseAuthClient(),
} = {}) => {
  const account = await resolveSupabaseAccountByUserId({ userId, adminClient });
  const email = normalizeIdentifier(account?.verified_real_email);
  if (!email) throw new Error("A verified real email is required for browser sign-in.");
  const generated = await adminClient.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = String(generated.data?.properties?.hashed_token || "").trim();
  if (generated.error || !tokenHash) {
    throw new Error("Supabase browser sign-in grant could not be created.");
  }
  const verified = await authClient.auth.verifyOtp({
    token_hash: tokenHash,
    type: "magiclink",
  });
  if (
    verified.error ||
    verified.data?.user?.id !== userId ||
    !verified.data?.session
  ) {
    throw new Error("Supabase browser sign-in grant could not be verified.");
  }
  return { account, session: verified.data.session };
};

export const requireSupabaseBearerUser = async ({
  authorization,
  adminClient = createSupabaseAdminClient(),
  requireVerifiedEmail = true,
} = {}) => {
  const match = String(authorization || "").match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return { ok: false, status: 401, reason: "missing_token" };
  const result = await adminClient.auth.getUser(match[1]);
  if (result.error || !result.data?.user) {
    return { ok: false, status: 401, reason: "invalid_token" };
  }
  const user = result.data.user;
  const account = await resolveSupabaseAccountByUserId({
    userId: user.id,
    adminClient,
  });
  const verifiedEmail = normalizeIdentifier(account?.verified_real_email);
  if (requireVerifiedEmail && !verifiedEmail) {
    return { ok: false, status: 403, reason: "email_not_verified" };
  }
  return { ok: true, user, account, verifiedEmail, accessToken: match[1] };
};
