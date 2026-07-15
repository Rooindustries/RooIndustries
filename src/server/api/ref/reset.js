import { createDataClient as createClient } from "../../data/documentClient.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";
import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";
import {
  buildCredentialSourcePreconditions,
  buildCredentialSourceMutation,
  completeSupabaseCredentialMirror,
  markSupabaseCredentialSourceApplied,
  resolveCredentialSourceRevision,
  updateSupabaseAccountPassword,
} from "../../supabase/accounts.js";
import {
  reconcileSupabaseCredentialSource,
  resumeSupabaseCredentialOperation,
} from "../../supabase/credentialRecovery.js";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { token, password } = req.body || {};

    const normalizedPassword = String(password || "");
    if (
      !/^[a-f0-9]{64}$/i.test(String(token || "")) ||
      normalizedPassword.length < 10 ||
      normalizedPassword.length > 128
    ) {
      return res
        .status(400)
        .json({ ok: false, error: "Use a password between 10 and 128 characters." });
    }

    const clientAddress = getClientAddress(req);
    if (
      !(await requireRateLimit(res, {
        key: `ref-reset:${clientAddress}`,
        max: 10,
        windowMs: 30 * 60 * 1000,
      }))
    ) {
      return;
    }

    const now = new Date().toISOString();
    const tokenHash = crypto
      .createHash("sha256")
      .update(String(token))
      .digest("hex");
    const policy = resolveSupabaseRuntimePolicy();
    const operationKey = `credential:reset:${tokenHash}`;
    const manualFallback =
      policy.primaryBackend === "sanity" && policy.cutoverEnabled === true;
    if (manualFallback) {
      return res.status(503).json({
        ok: false,
        error:
          "Password resets are temporarily unavailable during manual authentication failover. Existing reset links are unchanged.",
      });
    }
    const useSupabaseCredentialSaga =
      policy.primaryBackend === "supabase" || policy.shadowWritesEnabled;

    if (useSupabaseCredentialSaga) {
      try {
        const resumed = await resumeSupabaseCredentialOperation({ operationKey });
        if (resumed.resumed) {
          return res.status(200).json({ ok: true, replayed: true });
        }
      } catch (error) {
        logSafeError("Referral password reset recovery remains pending", error);
        return res.status(503).json({
          ok: false,
          error: "Password update is finishing. Please try signing in shortly.",
        });
      }
    }

    const referral = await client.fetch(
      `*[_type == "referral" && registrationStatus != "pending_email" && resetTokenHash == $tokenHash && resetTokenExpiresAt > $now][0]{ _id, _rev, _supabaseRevision, creatorEmail, creatorPassword, credentialVersion, resetTokenHash, resetTokenExpiresAt, slug }`,
      { tokenHash, now }
    );

    if (!referral) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid or expired reset link" });
    }

    const hash = await bcrypt.hash(normalizedPassword, 12);
    const sourceBackend = policy.primaryBackend;
    const sourceRevision = resolveCredentialSourceRevision({
      document: referral,
      sourceBackend,
    });
    const sourceMutation = buildCredentialSourceMutation({
      passwordHash: hash,
      passwordChangedAt: now,
      consumeResetToken: true,
    });
    const sourcePreconditions = buildCredentialSourcePreconditions({
      document: referral,
      resetTokenHash: tokenHash,
    });
    let credentialOperation = null;

    if (useSupabaseCredentialSaga) {
      try {
        credentialOperation = await updateSupabaseAccountPassword({
          identifier: referral.creatorEmail || referral.slug?.current,
          passwordHash: hash,
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
        logSafeError("Supabase referral password update failed", error);
        if (["23505", "40001"].includes(String(error?.code || ""))) {
          return res
            .status(400)
            .json({ ok: false, error: "Invalid or expired reset link" });
        }
        return res.status(503).json({
          ok: false,
          error: "Password update is temporarily unavailable. Please retry the link.",
        });
      }
    }

    try {
      if (credentialOperation?.updated && sourceBackend === "supabase") {
        await reconcileSupabaseCredentialSource({
          operationKey: credentialOperation.operationKey,
          sourceDocumentId: referral._id,
        });
      } else {
        const committedMutation =
          credentialOperation?.sourceMutation || sourceMutation;
        let patch = client.patch(referral._id);
        if (referral._rev && typeof patch.ifRevisionId === "function") {
          patch = patch.ifRevisionId(referral._rev);
        }
        const committed = await patch
          .set(committedMutation.set)
          .unset(committedMutation.unset)
          .commit({ visibility: "sync" });

        if (credentialOperation?.updated) {
          await markSupabaseCredentialSourceApplied({
            operationKey: credentialOperation.operationKey,
            sourceRevision: committed?._rev || referral._rev,
          });
          await completeSupabaseCredentialMirror({
            operationKey: credentialOperation.operationKey,
          });
        }
      }
    } catch (error) {
      logSafeError("Referral password source update pending", error);
      if (Number(error?.statusCode || error?.status || 0) === 409) {
        return res
          .status(400)
          .json({ ok: false, error: "Invalid or expired reset link" });
      }
      return res.status(503).json({
        ok: false,
        error: "Password update is finishing. Please try signing in shortly.",
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    if (Number(err?.statusCode || err?.status || 0) === 409) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid or expired reset link" });
    }
    logSafeError("Referral password reset failed", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
