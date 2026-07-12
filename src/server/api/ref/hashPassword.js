import bcrypt from "bcryptjs";
import { createDataClient as createClient } from "../../data/documentClient.js";
import {
  clearReferralSessionCookie,
  requireReferralSession,
} from "./auth.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import {
  completeSupabaseCredentialMirror,
  resolveSupabaseAccountAlias,
  updateSupabaseAccountPassword,
} from "../../supabase/accounts.js";
import { createSupabaseAdminClient } from "../../supabase/adminClient.js";
import { clearLegacySupabaseSession } from "../../supabase/serverSession.js";
import { hashReauthToken, readReauthToken } from "../../supabase/reauth.js";
import { logSafeError } from "../../safeErrorLog.js";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    const session = await requireReferralSession(req, res);
    if (!session) return;
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
      `*[_id == $id][0]{_id,_rev,creatorEmail,slug}`,
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

    let credentialOperation;
    try {
      credentialOperation = await updateSupabaseAccountPassword({
        identifier: referral.creatorEmail || referral.slug?.current || session.code,
        passwordHash: hash,
        sourceRevision: referral._rev || "",
      });
      if (!credentialOperation.updated) {
        throw new Error("Supabase creator account was not found.");
      }
    } catch (error) {
      logSafeError("Supabase referral password change failed", error);
      return res.status(503).json({
        ok: false,
        error: "Password update is temporarily unavailable. Please try again.",
      });
    }

    let finalPatch = client.patch(creatorId);
    if (referral._rev && typeof finalPatch.ifRevisionId === "function") {
      finalPatch = finalPatch.ifRevisionId(referral._rev);
    }
    await finalPatch
      .set({
        creatorPassword: hash,
        passwordResetRequired: false,
        credentialVersion: 2,
        passwordChangedAt,
        passwordLoginEnabled: true,
      })
      .commit({ visibility: "sync" });

    await completeSupabaseCredentialMirror({
      operationKey: credentialOperation.operationKey,
    });
    clearReferralSessionCookie(res);
    await clearLegacySupabaseSession({ req, res }).catch(() => {});

    return res.json({ ok: true, signedOut: true });
  } catch (err) {
    logSafeError("Referral password change failed", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
