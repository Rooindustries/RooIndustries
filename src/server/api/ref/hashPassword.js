import bcrypt from "bcryptjs";
import { createDataClient as createClient } from "../../data/documentClient.js";
import { requireReferralSession } from "./auth.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import { updateSupabaseAccountPassword } from "../../supabase/accounts.js";
import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";
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
    const session = requireReferralSession(req, res);
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

    let preparedPatch = client.patch(creatorId);
    if (referral._rev && typeof preparedPatch.ifRevisionId === "function") {
      preparedPatch = preparedPatch.ifRevisionId(referral._rev);
    }
    const prepared = await preparedPatch
      .set({ passwordResetRequired: true })
      .commit({ visibility: "sync" });

    const policy = resolveSupabaseRuntimePolicy();
    const shouldSyncSupabase =
      session.authBackend === "supabase" ||
      policy.shadowWritesEnabled ||
      policy.primaryBackend === "supabase";
    if (shouldSyncSupabase) {
      try {
        const updated = await updateSupabaseAccountPassword({
          identifier: referral.creatorEmail || referral.slug?.current || session.code,
          password: normalizedPassword,
        });
        if (
          !updated.updated &&
          (session.authBackend === "supabase" || policy.primaryBackend === "supabase")
        ) {
          throw new Error("Supabase creator account was not found.");
        }
      } catch (error) {
        logSafeError("Supabase referral password change failed", error);
        return res.status(503).json({
          ok: false,
          error: "Password update is temporarily unavailable. Please try again.",
        });
      }
    }

    let finalPatch = client.patch(creatorId);
    if (prepared?._rev && typeof finalPatch.ifRevisionId === "function") {
      finalPatch = finalPatch.ifRevisionId(prepared._rev);
    }
    await finalPatch
      .set({
        creatorPassword: hash,
        passwordResetRequired: false,
        credentialVersion: 2,
        passwordChangedAt,
        passwordLoginEnabled: true,
      })
      .commit();

    return res.json({ ok: true });
  } catch (err) {
    logSafeError("Referral password change failed", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
