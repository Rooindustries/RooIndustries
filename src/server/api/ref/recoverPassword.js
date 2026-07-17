import bcrypt from "bcryptjs";
import crypto from "node:crypto";

import { createDataClient as createClient } from "../../data/documentClient.js";
import { clearReferralSessionCookie } from "./auth.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import {
  buildCredentialSourceMutation,
  buildCredentialSourcePreconditions,
  completeSupabaseCredentialMirror,
  markSupabaseCredentialSourceApplied,
  resolveCredentialSourceRevision,
  resolveSupabaseAccountByUserId,
  updateSupabaseAccountPassword,
} from "../../supabase/accounts.js";
import {
  reconcileSupabaseCredentialSource,
  resumeSupabaseCredentialOperation,
} from "../../supabase/credentialRecovery.js";
import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";
import {
  clearLegacySupabaseSession,
  createLegacySupabaseSessionClient,
} from "../../supabase/serverSession.js";
import { logSafeError } from "../../safeErrorLog.js";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const RECOVERY_SESSION_MAX_AGE_SECONDS = 2 * 60 * 60;

const recoveryMethodPresent = (claims) =>
  (Array.isArray(claims?.amr) ? claims.amr : []).some((entry) => {
    const method = typeof entry === "string" ? entry : entry?.method;
    return String(method || "").toLowerCase() === "otp";
  });

const readRecoveryIdentity = async ({ req, res }) => {
  const sessionClient = createLegacySupabaseSessionClient({ req, res });
  const userResult = await sessionClient.auth.getUser();
  if (userResult.error || !userResult.data?.user?.id) return null;

  const sessionResult = await sessionClient.auth.getSession();
  const accessToken = String(
    sessionResult.data?.session?.access_token || ""
  ).trim();
  if (sessionResult.error || !accessToken) return null;

  const claimsResult = await sessionClient.auth.getClaims(accessToken);
  const claims = claimsResult.data?.claims;
  const issuedAt = Number(claims?.iat || 0);
  const now = Math.floor(Date.now() / 1000);
  if (
    claimsResult.error ||
    String(claims?.sub || "") !== userResult.data.user.id ||
    !recoveryMethodPresent(claims) ||
    issuedAt < now - RECOVERY_SESSION_MAX_AGE_SECONDS ||
    issuedAt > now + 60
  ) {
    return null;
  }

  return {
    accessToken,
    user: userResult.data.user,
  };
};

const finishRecoverySession = async ({ req, res }) => {
  clearReferralSessionCookie(res);
  await clearLegacySupabaseSession({ req, res }).catch(() => {});
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const normalizedPassword = String(req.body?.password || "");
    if (normalizedPassword.length < 10 || normalizedPassword.length > 128) {
      return res.status(400).json({
        ok: false,
        error: "Use a password between 10 and 128 characters.",
      });
    }
    if (
      !(await requireRateLimit(res, {
        key: `ref-recover-password:${getClientAddress(req)}`,
        max: 5,
        windowMs: 30 * 60 * 1000,
      }))
    ) {
      return;
    }

    const recovery = await readRecoveryIdentity({ req, res });
    if (!recovery) {
      return res.status(401).json({
        ok: false,
        error: "This recovery session is invalid or expired. Request a new link.",
      });
    }

    const account = await resolveSupabaseAccountByUserId({
      userId: recovery.user.id,
    });
    const roles = Array.isArray(account?.roles) ? account.roles : [];
    const creatorId = String(
      account?.creator_legacy_sanity_id || account?.legacy_sanity_id || ""
    ).trim();
    if (
      !creatorId ||
      !roles.includes("creator") ||
      account?.creator_active === false ||
      account?.status !== "active"
    ) {
      return res.status(403).json({
        ok: false,
        error: "This recovery link is not connected to an active creator account.",
      });
    }

    const policy = resolveSupabaseRuntimePolicy();
    if (policy.primaryBackend === "sanity" && policy.cutoverEnabled) {
      return res.status(503).json({
        ok: false,
        error:
          "Password resets are temporarily unavailable during manual authentication failover.",
      });
    }

    const referral = await client.fetch(
      `*[_id == $id][0]{
        _id,
        _rev,
        _supabaseRevision,
        creatorEmail,
        creatorPassword,
        credentialVersion,
        resetTokenHash,
        resetTokenExpiresAt,
        slug
      }`,
      { id: creatorId }
    );
    if (!referral?._id) {
      return res.status(403).json({
        ok: false,
        error: "This recovery link is not connected to an active creator account.",
      });
    }

    const operationKey = `credential:recovery:${crypto
      .createHash("sha256")
      .update(recovery.accessToken)
      .digest("hex")}`;
    try {
      const resumed = await resumeSupabaseCredentialOperation({ operationKey });
      if (resumed.resumed) {
        await finishRecoverySession({ req, res });
        return res.status(200).json({ ok: true, replayed: true, signedOut: true });
      }
    } catch (error) {
      logSafeError("Referral recovery password operation remains pending", error);
      return res.status(503).json({
        ok: false,
        error: "Password update is finishing. Please try signing in shortly.",
      });
    }

    const passwordChangedAt = new Date().toISOString();
    const passwordHash = await bcrypt.hash(normalizedPassword, 12);
    const sourceBackend = policy.primaryBackend;
    const sourceRevision = resolveCredentialSourceRevision({
      document: referral,
      sourceBackend,
    });
    const sourceMutation = buildCredentialSourceMutation({
      passwordHash,
      passwordChangedAt,
      consumeResetToken: true,
    });
    const sourcePreconditions = buildCredentialSourcePreconditions({
      document: referral,
    });

    let credentialOperation;
    try {
      credentialOperation = await updateSupabaseAccountPassword({
        identifier:
          account.primary_email ||
          referral.creatorEmail ||
          referral.slug?.current,
        passwordHash,
        sourceBackend,
        sourceDocumentId: referral._id,
        sourcePreconditions,
        sourceMutation,
        sourceRevision,
        operationKey,
      });
      if (!credentialOperation.updated) {
        throw new Error("Supabase creator account was not found.");
      }
    } catch (error) {
      logSafeError("Supabase referral recovery password update failed", error);
      return res.status(503).json({
        ok: false,
        error: "Password update is temporarily unavailable. Please try again.",
      });
    }

    try {
      if (sourceBackend === "supabase") {
        await reconcileSupabaseCredentialSource({
          operationKey: credentialOperation.operationKey,
          sourceDocumentId: referral._id,
        });
      } else {
        const committedMutation = credentialOperation.sourceMutation || sourceMutation;
        let patch = client.patch(referral._id);
        if (referral._rev && typeof patch.ifRevisionId === "function") {
          patch = patch.ifRevisionId(referral._rev);
        }
        patch = patch.set(committedMutation.set);
        if (committedMutation.unset?.length) {
          patch = patch.unset(committedMutation.unset);
        }
        const committed = await patch.commit({ visibility: "sync" });
        await markSupabaseCredentialSourceApplied({
          operationKey: credentialOperation.operationKey,
          sourceRevision: committed?._rev || referral._rev,
        });
        await completeSupabaseCredentialMirror({
          operationKey: credentialOperation.operationKey,
        });
      }
    } catch (error) {
      logSafeError("Supabase referral recovery source update pending", error);
      return res.status(503).json({
        ok: false,
        error: "Password update is finishing. Please try signing in shortly.",
      });
    }

    await finishRecoverySession({ req, res });
    return res.status(200).json({ ok: true, signedOut: true });
  } catch (error) {
    logSafeError("Referral recovery password reset failed", error);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
