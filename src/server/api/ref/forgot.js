import { createDataClient as createClient } from "../../data/documentClient.js";
import crypto from "crypto";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";
import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";
import {
  deliverReferralEmailDispatch,
  enqueueReferralEmailMutation,
  isReferralEmailSourceStateConflict,
  requeueReferralEmailDispatch,
  sendReferralEmailDirect,
} from "./referralEmailDispatches.js";
import {
  sealReferralEmailToken,
  unsealReferralEmailToken,
} from "./referralEmailTokenSeal.js";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
}, { allowLegacyFallback: false });

const recoverResetToken = (referral) => {
  try {
    const expiresAt = Date.parse(referral?.resetTokenExpiresAt || "");
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return "";
    const token = unsealReferralEmailToken(referral?.resetDeliveryToken);
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    return tokenHash === referral?.resetTokenHash ? token : "";
  } catch {
    return "";
  }
};

const isRevisionConflict = (error) =>
  Number(error?.statusCode || error?.status || 0) === 409;

const readReferralById = (id) =>
  client.fetch(`*[_type == "referral" && _id == $id][0]`, { id });

const ensureSanityResetToken = async (initialReferral) => {
  let referral = initialReferral;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const recovered = recoverResetToken(referral);
    if (recovered) {
      return {
        referral,
        resetToken: recovered,
        resetTokenExpiresAt: referral.resetTokenExpiresAt,
      };
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");
    const resetTokenExpiresAt = new Date(
      Date.now() + 60 * 60 * 1000
    ).toISOString();
    let patch = client.patch(referral._id);
    if (referral._rev && typeof patch.ifRevisionId === "function") {
      patch = patch.ifRevisionId(referral._rev);
    }
    try {
      const committed = await patch
        .set({
          resetTokenHash,
          resetTokenExpiresAt,
          resetDeliveryToken: sealReferralEmailToken(resetToken),
        })
        .unset(["resetToken"])
        .commit({ visibility: "sync" });
      return { referral: committed || referral, resetToken, resetTokenExpiresAt };
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      referral = await readReferralById(referral._id);
      if (!referral?._id) throw error;
    }
  }
  const error = new Error("Reset token changed concurrently.");
  error.code = "RESET_TOKEN_CONFLICT";
  throw error;
};

const isMutationConflict = (error) =>
  isRevisionConflict(error) ||
  ["23505", "40001"].includes(String(error?.code || ""));

const respondToResetConflict = (res) =>
  res.status(503).json({
    ok: false,
    retryable: true,
    error: "Password reset is temporarily unavailable. Please try again.",
  });

const enqueueSupabaseReset = async ({ initialReferral, recipientEmail }) => {
  let referral = initialReferral;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const recoveredResetToken = recoverResetToken(referral);
    const resetToken =
      recoveredResetToken || crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");
    const resetTokenExpiresAt = recoveredResetToken
      ? referral.resetTokenExpiresAt
      : new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const nextReferral = {
      ...referral,
      resetTokenHash,
      resetTokenExpiresAt,
      resetDeliveryToken: recoveredResetToken
        ? referral.resetDeliveryToken
        : sealReferralEmailToken(resetToken),
    };
    delete nextReferral.resetToken;
    try {
      const dispatch = await enqueueReferralEmailMutation({
        mutations: [
          {
            operation: "replace",
            document: nextReferral,
            expected_revision: referral._rev || "",
          },
        ],
        referralId: referral._id,
        dispatchKind: "password_reset",
        recipientEmail,
        token: resetToken,
        name: referral.name,
        expiresAt: resetTokenExpiresAt,
      });
      return { dispatch, resetToken };
    } catch (error) {
      if (!isMutationConflict(error)) throw error;
      referral = await readReferralById(referral._id);
      if (!referral?._id) throw error;
    }
  }
  const error = new Error("Reset token changed concurrently.");
  error.code = "RESET_TOKEN_CONFLICT";
  throw error;
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ ok: false, error: "Missing email" });
    }

    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (
      normalizedEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    ) {
      return res.status(200).json({ ok: true, message: "If email exists, link sent." });
    }
    const clientAddress = getClientAddress(req);

    if (
      !(await requireRateLimit(res, {
        key: `ref-forgot:${clientAddress}`,
        max: 5,
        windowMs: 30 * 60 * 1000,
      }))
    ) {
      return;
    }

    const policy = resolveSupabaseRuntimePolicy();
    if (policy.primaryBackend === "sanity" && policy.cutoverEnabled === true) {
      return res.status(503).json({
        ok: false,
        error:
          "Password reset emails are temporarily unavailable during manual authentication failover.",
      });
    }

    const referral = await client.fetch(
      `*[_type == "referral" && registrationStatus != "pending_email" && creatorEmail == $email][0]`,
      { email: normalizedEmail }
    );

    if (!referral) {
      return res
        .status(200)
        .json({ ok: true, message: "If email exists, link sent." });
    }

    if (policy.primaryBackend === "supabase") {
      const { dispatch } = await enqueueSupabaseReset({
        initialReferral: referral,
        recipientEmail: normalizedEmail,
      });
      let syncPending = false;
      try {
        const delivery = await deliverReferralEmailDispatch({
          idempotencyKey: dispatch?.idempotency_key,
        });
        if (isReferralEmailSourceStateConflict(delivery)) {
          return respondToResetConflict(res);
        }
        if (delivery.deadLetter > 0) {
          let recovery;
          try {
            recovery = await requeueReferralEmailDispatch({
              referralId: referral._id,
              dispatchKind: "password_reset",
            });
          } catch (error) {
            if (isReferralEmailSourceStateConflict(error)) {
              return respondToResetConflict(res);
            }
            logSafeError("Referral reset email recovery failed", error);
            return res.status(200).json({
              ok: true,
              message: "If email exists, link sent.",
            });
          }
          if (isReferralEmailSourceStateConflict(recovery)) {
            return respondToResetConflict(res);
          }
          if (recovery?.requeued !== true && recovery?.sent !== true) {
            logSafeError(
              "Referral reset email recovery blocked",
              Object.assign(new Error("Referral reset delivery cannot be recovered."), {
                code: recovery?.recovery_blocked_reason || "email_recovery_blocked",
              })
            );
            return res.status(200).json({
              ok: true,
              message: "If email exists, link sent.",
            });
          }
        }
        syncPending = delivery.sent !== 1;
      } catch (error) {
        if (isReferralEmailSourceStateConflict(error)) {
          return respondToResetConflict(res);
        }
        logSafeError("Referral reset email delivery remains pending", error);
        syncPending = true;
      }
      return res.status(200).json({
        ok: true,
        message: "Reset link sent",
        ...(syncPending ? { syncPending: true } : {}),
      });
    }

    const sanityToken = await ensureSanityResetToken(referral);
    const resetToken = sanityToken.resetToken;

    try {
      await sendReferralEmailDirect({
        dispatchKind: "password_reset",
        referralId: referral._id,
        recipientEmail: normalizedEmail,
        token: resetToken,
        name: referral.name,
      });
    } catch (error) {
      logSafeError("Referral reset email failed", error);
      return res.status(500).json({ ok: false, error: "Failed to send email" });
    }
    return res.status(200).json({ ok: true, message: "Reset link sent" });
  } catch (err) {
    if (
      err?.code === "RESET_TOKEN_CONFLICT" ||
      isReferralEmailSourceStateConflict(err)
    ) {
      logSafeError("Referral reset source conflict", err);
      return respondToResetConflict(res);
    }
    logSafeError("Referral forgot-password failed", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
