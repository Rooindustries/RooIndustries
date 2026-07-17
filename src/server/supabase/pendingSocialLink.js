import crypto from "node:crypto";

import { resolveSupabaseAccountByUserId } from "./accounts.js";
import { createSupabaseAdminClient } from "./adminClient.js";

const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex");

const providersForUser = (user) =>
  new Set(
    (user?.identities || [])
      .map((identity) => String(identity?.provider || "").trim().toLowerCase())
      .filter(Boolean)
  );

const hasDomainAccount = (account) =>
  (account?.roles || []).some(
    (role) => role === "creator" || String(role).startsWith("tourney_")
  ) || Boolean(account?.creator_legacy_sanity_id || account?.tourney_legacy_player_id);

export const linkPendingDiscordIdentity = async ({
  adminClient = createSupabaseAdminClient(),
  pendingUser,
  primaryAccount,
  primaryUserId,
  resolveAccount = resolveSupabaseAccountByUserId,
} = {}) => {
  const pendingUserId = String(pendingUser?.id || "").trim();
  const targetUserId = String(primaryUserId || "").trim();
  if (!pendingUserId || !targetUserId || !providersForUser(pendingUser).has("discord")) {
    return { linked: false, reason: "discord_session_missing" };
  }
  if (pendingUserId === targetUserId) {
    return { linked: true, account: primaryAccount, alreadyLinked: true };
  }

  const [pendingAccount, resolvedPrimaryAccount] = await Promise.all([
    resolveAccount({ userId: pendingUserId, adminClient }),
    primaryAccount
      ? Promise.resolve(primaryAccount)
      : resolveAccount({ userId: targetUserId, adminClient }),
  ]);
  if (
    !resolvedPrimaryAccount?.principal_id ||
    !(resolvedPrimaryAccount.roles || []).includes("creator") ||
    resolvedPrimaryAccount.creator_active === false
  ) {
    return { linked: false, reason: "creator_account_missing" };
  }
  if (pendingAccount?.principal_id === resolvedPrimaryAccount.principal_id) {
    return {
      linked: true,
      account: resolvedPrimaryAccount,
      alreadyLinked: true,
    };
  }
  if (
    !pendingAccount?.principal_id ||
    hasDomainAccount(pendingAccount)
  ) {
    return { linked: false, reason: "discord_account_not_linkable" };
  }

  const primaryGrant = crypto.randomBytes(32).toString("base64url");
  const secondaryGrant = crypto.randomBytes(32).toString("base64url");
  const [primaryProof, secondaryProof] = await Promise.all([
    adminClient.rpc("roo_create_reauth_grant", {
      p_user_id: targetUserId,
      p_token_hash: sha256(primaryGrant),
      p_purpose: "merge_account",
      p_provider: null,
    }),
    adminClient.rpc("roo_create_reauth_grant", {
      p_user_id: pendingUserId,
      p_token_hash: sha256(secondaryGrant),
      p_purpose: "merge_account",
      p_provider: null,
    }),
  ]);
  if (primaryProof.error || secondaryProof.error) {
    throw Object.assign(new Error("Discord account proofs could not be created."), {
      code: primaryProof.error?.code || secondaryProof.error?.code || "DISCORD_LINK_FAILED",
    });
  }

  const merged = await adminClient.rpc("roo_merge_account_principals", {
    p_primary_grant_hash: sha256(primaryGrant),
    p_secondary_grant_hash: sha256(secondaryGrant),
  });
  if (merged.error || !merged.data) {
    throw Object.assign(new Error("Discord account could not be linked."), {
      code: merged.error?.code || "DISCORD_LINK_FAILED",
    });
  }
  return { linked: true, account: merged.data };
};
