import bcrypt from "bcryptjs";
import { createDataClient as createClient } from "../../data/documentClient.js";
import {
  clearReferralSessionCookie,
  requireReferralSession,
} from "./auth.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import {
  buildCredentialSourcePreconditions,
  buildCredentialSourceMutation,
  completeSupabaseCredentialMirror,
  markSupabaseCredentialSourceApplied,
  resolveCredentialSourceRevision,
  resolveSupabaseAccountAlias,
  updateSupabaseAccountPassword,
} from "../../supabase/accounts.js";
import { createSupabaseAdminClient } from "../../supabase/adminClient.js";
import { reconcileSupabaseCredentialSource } from "../../supabase/credentialRecovery.js";
import { clearLegacySupabaseSession } from "../../supabase/serverSession.js";
import { hashReauthToken, readReauthToken } from "../../supabase/reauth.js";
import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";
import { logSafeError } from "../../safeErrorLog.js";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
}, { allowLegacyFallback: false });

const PASSWORD_PENDING_MESSAGE =
  "Your password change is saving. It will finish in a moment.";
const PASSWORD_UPDATED_MESSAGE =
  "Password updated. Log in with your new password.";
const PASSWORD_OPERATION_BUSY_MESSAGE =
  "A previous password change is still in progress. Please try again shortly.";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    const session = await requireReferralSession(req, res);
    if (!session) return;
    const policy = resolveSupabaseRuntimePolicy();
    if (policy.primaryBackend === "sanity" && policy.cutoverEnabled) {
      return res.status(503).json({
        ok: false,
        error:
          "Password changes are temporarily unavailable during manual authentication failover.",
      });
    }
    const creatorId = session.referralId;
    const { password } = req.body || {};
    const normalizedPassword = String(password || "");

    if (normalizedPassword.length < 10 || normalizedPassword.length > 128) {
      return res
        .status(400)
        .json({ ok: false, error: "Use a password between 10 and 128 characters." });
    }
    if (
      !(await requireRateLimit(res, {
        key: `ref-change-password:${getClientAddress(req)}`,
        max: 5,
        windowMs: 30 * 60 * 1000,
      }))
    ) {
      return;
    }

    const passwordChangedAt = new Date().toISOString();
    const hash = await bcrypt.hash(normalizedPassword, 12);

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
        resetDeliveryToken,
        slug
      }`,
      { id: creatorId }
    );
    if (!referral?._id) {
      return res.status(401).json({ ok: false, error: "Unauthorized. Please log in again." });
    }

    const account = await resolveSupabaseAccountAlias({ identifier: session.code });
    const reauthToken = readReauthToken(req);
    if (!account?.user_id || !reauthToken) {
      return res.status(409).json({
        ok: false,
        error: "Confirm your current password before changing it.",
      });
    }
    const consumed = await createSupabaseAdminClient().rpc(
      "roo_consume_reauth_grant",
      {
        p_token_hash: hashReauthToken(reauthToken),
        p_user_id: account.user_id,
        p_purpose: "change_password",
        p_provider: null,
      }
    );
    if (consumed.error) {
      return res.status(409).json({
        ok: false,
        error: "Your password confirmation expired. Confirm it again.",
      });
    }

    const sourceBackend = policy.primaryBackend;
    const sourceRevision = resolveCredentialSourceRevision({
      document: referral,
      sourceBackend,
    });
    const sourceMutation = buildCredentialSourceMutation({
      passwordHash: hash,
      passwordChangedAt,
      consumeResetToken: true,
    });
    const sourcePreconditions = buildCredentialSourcePreconditions({
      document: referral,
    });
    let credentialOperation;
    try {
      credentialOperation = await updateSupabaseAccountPassword({
        identifier: referral.creatorEmail || referral.slug?.current || session.code,
        password: normalizedPassword,
        passwordHash: hash,
        sourceBackend,
        sourceDocumentId: referral._id,
        sourcePreconditions,
        sourceMutation,
        sourceRevision,
        operationKey: `credential:change:${hashReauthToken(reauthToken)}`,
      });
      if (!credentialOperation.updated) {
        throw new Error("Supabase creator account was not found.");
      }
    } catch (error) {
      logSafeError("Supabase referral password change failed", error);
      return res.status(503).json({
        ok: false,
        error:
          String(error?.code || "") === "55006"
            ? PASSWORD_OPERATION_BUSY_MESSAGE
            : "Password update is temporarily unavailable. Please try again.",
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
        let finalPatch = client.patch(creatorId);
        if (referral._rev && typeof finalPatch.ifRevisionId === "function") {
          finalPatch = finalPatch.ifRevisionId(referral._rev);
        }
        finalPatch = finalPatch.set(committedMutation.set);
        if (Array.isArray(committedMutation.unset) && committedMutation.unset.length) {
          finalPatch = finalPatch.unset(committedMutation.unset);
        }
        const committed = await finalPatch.commit({ visibility: "sync" });
        await markSupabaseCredentialSourceApplied({
          operationKey: credentialOperation.operationKey,
          sourceRevision: committed?._rev || referral._rev,
        });
        await completeSupabaseCredentialMirror({
          operationKey: credentialOperation.operationKey,
        });
      }
    } catch (error) {
      logSafeError("Supabase referral password source update pending", error);
      res.setHeader?.("Retry-After", "2");
      return res.status(202).json({
        ok: true,
        status: "pending",
        message: PASSWORD_PENDING_MESSAGE,
      });
    }
    clearReferralSessionCookie(res);
    await clearLegacySupabaseSession({ req, res }).catch(() => {});

    return res.json({
      ok: true,
      signedOut: true,
      status: "updated",
      message: PASSWORD_UPDATED_MESSAGE,
    });
  } catch (err) {
    logSafeError("Referral password change failed", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
