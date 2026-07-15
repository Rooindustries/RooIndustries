import crypto from "node:crypto";
import { createDataClient as createClient } from "../../data/documentClient.js";
import {
  createSupabaseCreatorAccount,
  createVerifiedSupabaseBrowserSession,
} from "../../supabase/accounts.js";
import { installLegacySupabaseSession } from "../../supabase/serverSession.js";
import { hashShadowDocument } from "../../supabase/shadowStore.js";
import { logSafeError } from "../../safeErrorLog.js";
import { setReferralSessionCookie } from "./auth.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const token = String(req.body?.token || "").trim();
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
    return res.status(400).json({ ok: false, error: "Invalid or expired confirmation link." });
  }
  if (
    !(await requireRateLimit(res, {
      key: `ref-verify-registration:${getClientAddress(req)}`,
      max: 10,
      windowMs: 30 * 60 * 1000,
    }))
  ) {
    return;
  }

  try {
    const now = new Date().toISOString();
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const referral = await client.fetch(
      `*[
        _type == "referral"
        && registrationStatus == "pending_email"
        && registrationVerificationTokenHash == $tokenHash
        && registrationVerificationExpiresAt > $now
      ][0]`,
      { now, tokenHash }
    );
    if (!referral?._id || !/^\$2[aby]\$/.test(String(referral.creatorPassword || ""))) {
      return res.status(400).json({
        ok: false,
        error: "Invalid or expired confirmation link.",
      });
    }

    const created = await createSupabaseCreatorAccount({
      referral,
      passwordHash: referral.creatorPassword,
      sourceRevision: referral._rev || "",
      sourceHash: hashShadowDocument(referral),
    });

    let patch = client.patch(referral._id);
    if (referral._rev && typeof patch.ifRevisionId === "function") {
      patch = patch.ifRevisionId(referral._rev);
    }
    await patch
      .set({
        registrationStatus: "active",
        passwordResetRequired: false,
        emailVerifiedAt: now,
      })
      .unset([
        "registrationVerificationTokenHash",
        "registrationVerificationExpiresAt",
        "registrationVerificationDeliveryToken",
      ])
      .commit({ visibility: "sync" });

    const activeReferral = await client.fetch(`*[_id == $id][0]`, {
      id: referral._id,
    });
    if (activeReferral) {
      await createSupabaseCreatorAccount({
        referral: activeReferral,
        passwordHash: activeReferral.creatorPassword,
        sourceRevision: activeReferral._rev || "",
        sourceHash: hashShadowDocument(activeReferral),
      }).catch((error) => {
        logSafeError("Verified referral metadata resync failed", error);
      });
    }

    const browserSession = await createVerifiedSupabaseBrowserSession({
      userId: created.userId,
    });
    await installLegacySupabaseSession({
      req,
      res,
      session: browserSession.session,
    });

    setReferralSessionCookie(
      res,
      {
        authBackend: "supabase",
        code: referral.slug?.current || "",
        referralId: referral._id,
        principalId: browserSession.account?.principal_id || "",
        sessionVersion: browserSession.account?.session_version || 1,
      },
      true
    );
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({ ok: true });
  } catch (error) {
    if (Number(error?.statusCode || error?.status || 0) === 409) {
      return res.status(400).json({
        ok: false,
        error: "Invalid or expired confirmation link.",
      });
    }
    logSafeError("Referral registration verification failed", error);
    return res.status(503).json({
      ok: false,
      error: "Account confirmation is temporarily unavailable. Please try again.",
    });
  }
}
