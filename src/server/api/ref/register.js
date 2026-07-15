// ./api/ref/register.js
import { createDataClient as createClient } from "../../data/documentClient.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { setReferralSessionCookie } from "./auth.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";
import {
  buildReferralIdentityClaim,
  buildReferralIdentityClaimId,
} from "./referralIdentity.js";
import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";
import {
  createSupabaseCreatorAccount,
  resolveSupabaseAccountByUserId,
} from "../../supabase/accounts.js";
import { hashShadowDocument } from "../../supabase/shadowStore.js";
import { getLegacySupabaseUser } from "../../supabase/serverSession.js";
import {
  deliverReferralEmailDispatch,
  enqueueReferralEmailMutation,
  requeueReferralEmailDispatch,
  sendReferralEmailDirect,
} from "./referralEmailDispatches.js";
import {
  sealReferralEmailToken,
  unsealReferralEmailToken,
} from "./referralEmailTokenSeal.js";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const isExpiredPendingRegistration = (referral) =>
  referral?.registrationStatus === "pending_email" &&
  Date.parse(referral.registrationVerificationExpiresAt || "") <= Date.now();

const removeExpiredPendingRegistration = async (referral) => {
  if (!isExpiredPendingRegistration(referral)) return false;
  const emailClaimId = buildReferralIdentityClaimId({
    kind: "email",
    value: referral.creatorEmail,
  });
  const slugClaimId = buildReferralIdentityClaimId({
    kind: "slug",
    value: referral.slug?.current,
  });
  let transaction = client.transaction().delete(referral._id);
  if (emailClaimId) transaction = transaction.delete(emailClaimId);
  if (slugClaimId) transaction = transaction.delete(slugClaimId);
  await transaction.commit();
  return true;
};

const recoverPendingRegistrationToken = (referral) => {
  try {
    const token = unsealReferralEmailToken(
      referral?.registrationVerificationDeliveryToken
    );
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    return tokenHash === referral?.registrationVerificationTokenHash ? token : "";
  } catch {
    return "";
  }
};

const clearRegistrationDeliveryToken = async (referralId) => {
  try {
    await client
      .patch(referralId)
      .unset(["registrationVerificationDeliveryToken"])
      .commit({ visibility: "sync" });
  } catch (error) {
    logSafeError("Referral verification token cleanup failed", error);
  }
};

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const {
      name,
      discordUsername,
      contactDiscord,
      email,
      paypalEmail,
      slug,
      password,
    } = req.body;

    const clientAddress = getClientAddress(req);
    if (
      !(await requireRateLimit(res, {
        key: `ref-register:${clientAddress}`,
        max: 10,
        windowMs: 30 * 60 * 1000,
      }))
    ) {
      return;
    }

    // Basic presence validation
    const trimmedDiscordUsername = String(
      discordUsername || contactDiscord || name || ""
    ).trim();

    if (
      !trimmedDiscordUsername ||
      !email ||
      !paypalEmail ||
      !slug
    ) {
      return res.status(400).json({ ok: false, error: "All fields required" });
    }

    const trimmedEmail = String(email).trim().toLowerCase();
    const trimmedPaypalEmail = String(paypalEmail).trim().toLowerCase();
    const trimmedSlug = String(slug).trim().toLowerCase();
    const normalizedPassword = String(password || "");

    const socialUser = await getLegacySupabaseUser({ req, res }).catch(
      () => null
    );
    const socialAccount = socialUser?.id
      ? await resolveSupabaseAccountByUserId({ userId: socialUser.id }).catch(() => null)
      : null;
    const policy = resolveSupabaseRuntimePolicy();
    if (
      socialUser &&
      String(socialAccount?.verified_real_email || "").trim().toLowerCase() !== trimmedEmail
    ) {
      return res.status(409).json({
        ok: false,
        error: "Your verified sign-in email does not match this registration.",
      });
    }

    const emailRegex = /\S+@\S+\.\S+/;

    if (
      trimmedDiscordUsername.length < 2 ||
      trimmedDiscordUsername.length > 80 ||
      trimmedEmail.length > 254 ||
      trimmedPaypalEmail.length > 254 ||
      !/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/.test(trimmedSlug)
    ) {
      return res.status(400).json({ ok: false, error: "Invalid registration details" });
    }

    if (!emailRegex.test(trimmedEmail)) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid login email address" });
    }

    if (!emailRegex.test(trimmedPaypalEmail)) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid PayPal email address" });
    }
    if (
      (!socialUser && normalizedPassword.length < 10) ||
      normalizedPassword.length > 128 ||
      (socialUser && normalizedPassword.length > 0 && normalizedPassword.length < 10)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Use a password between 10 and 128 characters.",
      });
    }

    // Check email uniqueness (login email)
    const existingByEmail = await client.fetch(
      `*[_type == "referral" && lower(creatorEmail) == $email][0]{
        _id,_rev,name,creatorEmail,slug,registrationStatus,
        registrationVerificationTokenHash,registrationVerificationExpiresAt,
        registrationVerificationDeliveryToken
      }`,
      { email: trimmedEmail }
    );
    let expiredSupabaseRegistration = null;
    if (existingByEmail && isExpiredPendingRegistration(existingByEmail)) {
      if (policy.primaryBackend === "supabase") {
        if (existingByEmail.slug?.current !== trimmedSlug) {
          return res
            .status(409)
            .json({ ok: false, error: "Email already registered" });
        }
        expiredSupabaseRegistration = existingByEmail;
      } else {
        await removeExpiredPendingRegistration(existingByEmail);
      }
    } else if (existingByEmail) {
      if (
        policy.primaryBackend === "supabase" &&
        existingByEmail.registrationStatus === "pending_email"
      ) {
        try {
          const recovery = await requeueReferralEmailDispatch({
            referralId: existingByEmail._id,
            dispatchKind: "registration_verification",
          });
          const recoverable =
            recovery?.sent === true ||
            recovery?.requeued === true ||
            ["pending", "retry", "sending"].includes(recovery?.status);
          if (!recoverable) throw Object.assign(
            new Error("Verification email recovery is blocked."),
            { code: recovery?.recovery_blocked_reason || "email_recovery_blocked" }
          );
          return res.status(202).json({
            ok: true,
            pendingVerification: true,
            message: "Check your email to finish creating your account.",
            ...(recovery?.sent === true ? {} : { syncPending: true }),
          });
        } catch (error) {
          logSafeError("Referral verification email recovery failed", error);
          return res.status(503).json({
            ok: false,
            error: "Verification email could not be recovered. Please try again.",
          });
        }
      }
      const retryToken =
        policy.primaryBackend === "sanity" &&
        existingByEmail.registrationStatus === "pending_email"
          ? recoverPendingRegistrationToken(existingByEmail)
          : "";
      if (retryToken) {
        try {
          await sendReferralEmailDirect({
            dispatchKind: "registration_verification",
            referralId: existingByEmail._id,
            recipientEmail: trimmedEmail,
            token: retryToken,
            name: existingByEmail.name,
          });
          await clearRegistrationDeliveryToken(existingByEmail._id);
          return res.status(202).json({
            ok: true,
            pendingVerification: true,
            message: "Check your email to finish creating your account.",
          });
        } catch (error) {
          logSafeError("Referral verification email retry failed", error);
          return res.status(503).json({
            ok: false,
            error: "Verification email could not be sent. Please try again.",
          });
        }
      }
      return res
        .status(409)
        .json({ ok: false, error: "Email already registered" });
    }

    // Check slug uniqueness
    const existingBySlug = await client.fetch(
      `*[_type == "referral" && lower(slug.current) == $slug][0]{
        _id,_rev,creatorEmail,slug,registrationStatus,registrationVerificationExpiresAt
      }`,
      { slug: trimmedSlug }
    );
    if (
      existingBySlug &&
      existingBySlug._id !== expiredSupabaseRegistration?._id
    ) {
      const removed =
        policy.primaryBackend === "sanity" &&
        (await removeExpiredPendingRegistration(existingBySlug));
      if (!removed) {
        return res
          .status(409)
          .json({ ok: false, error: "Referral code already taken" });
      }
    }

    // Hash password
    const passwordMaterial =
      normalizedPassword || crypto.randomBytes(32).toString("base64url");
    const hash = await bcrypt.hash(passwordMaterial, 12);

    // Create the referral and both unique identity claims atomically.
    const referralId =
      expiredSupabaseRegistration?._id || `referral.${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const verificationToken = socialUser
      ? ""
      : crypto.randomBytes(32).toString("base64url");
    const verificationTokenHash = verificationToken
      ? crypto.createHash("sha256").update(verificationToken).digest("hex")
      : "";
    const verificationExpiresAt = verificationToken
      ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
      : "";
    const referral = {
      _id: referralId,
      _type: "referral",
      name: trimmedDiscordUsername,
      slug: { _type: "slug", current: trimmedSlug },
      creatorEmail: trimmedEmail,
      creatorPassword: hash,
      paypalEmail: trimmedPaypalEmail,
      contactDiscord: trimmedDiscordUsername,
      currentCommissionPercent: 10,
      successfulReferrals: 0,
      isFirstTime: true,
      passwordResetRequired: !socialUser,
      credentialVersion: 2,
      passwordChangedAt: createdAt,
      passwordLoginEnabled: Boolean(normalizedPassword),
      registrationStatus: socialUser ? "active" : "pending_email",
      ...(verificationTokenHash
        ? {
            registrationVerificationTokenHash: verificationTokenHash,
            registrationVerificationExpiresAt: verificationExpiresAt,
            ...(policy.primaryBackend === "sanity"
              ? {
                  registrationVerificationDeliveryToken:
                    sealReferralEmailToken(verificationToken),
                }
              : {}),
          }
        : {}),
    };
    const emailClaim = buildReferralIdentityClaim({
      kind: "email",
      value: trimmedEmail,
      referralId,
      createdAt,
    });
    const slugClaim = buildReferralIdentityClaim({
      kind: "slug",
      value: trimmedSlug,
      referralId,
      createdAt,
    });
    let emailDispatch = null;
    if (!socialUser && policy.primaryBackend === "supabase") {
      const mutations = expiredSupabaseRegistration
        ? [
            {
              operation: "replace",
              document: referral,
              expected_revision: expiredSupabaseRegistration._rev || "",
            },
          ]
        : [emailClaim, slugClaim, referral].map((document) => ({
            operation: "create",
            document,
          }));
      emailDispatch = await enqueueReferralEmailMutation({
        mutations,
        referralId,
        dispatchKind: "registration_verification",
        recipientEmail: trimmedEmail,
        token: verificationToken,
        name: trimmedDiscordUsername,
        expiresAt: verificationExpiresAt,
      });
    } else {
      await client
        .transaction()
        .create(emailClaim)
        .create(slugClaim)
        .create(referral)
        .commit();
    }

    if (!socialUser) {
      let syncPending = false;
      try {
        if (policy.primaryBackend === "supabase") {
          const delivery = await deliverReferralEmailDispatch({
            idempotencyKey: emailDispatch?.idempotency_key,
          });
          if (delivery.deadLetter > 0) {
            let recovery;
            try {
              recovery = await requeueReferralEmailDispatch({
                referralId,
                dispatchKind: "registration_verification",
              });
            } catch (error) {
              const terminalError =
                error instanceof Error
                  ? error
                  : new Error("Verification email recovery failed.");
              terminalError.terminalDelivery = true;
              throw terminalError;
            }
            if (recovery?.requeued !== true && recovery?.sent !== true) {
              const error = new Error("Verification email recovery is blocked.");
              error.code =
                recovery?.recovery_blocked_reason || "email_recovery_blocked";
              error.terminalDelivery = true;
              throw error;
            }
          }
          syncPending = delivery.sent !== 1;
        } else {
          await sendReferralEmailDirect({
            dispatchKind: "registration_verification",
            referralId,
            recipientEmail: trimmedEmail,
            token: verificationToken,
            name: trimmedDiscordUsername,
          });
          await clearRegistrationDeliveryToken(referralId);
        }
      } catch (error) {
        logSafeError("Referral verification email failed", error);
        if (policy.primaryBackend === "supabase") {
          if (error?.terminalDelivery === true) {
            return res.status(503).json({
              ok: false,
              error: "Verification email could not be recovered. Please try again.",
            });
          }
          syncPending = true;
        } else {
          return res.status(503).json({
            ok: false,
            error: "Verification email could not be sent. Please try again.",
          });
        }
      }
      if (policy.primaryBackend === "supabase") {
        return res.status(202).json({
          ok: true,
          pendingVerification: true,
          message: "Check your email to finish creating your account.",
          ...(syncPending ? { syncPending: true } : {}),
        });
      }
      return res.status(202).json({
        ok: true,
        pendingVerification: true,
        message: "Check your email to finish creating your account.",
      });
    }

    let supabaseAccount = null;
    if (
      socialUser ||
      policy.shadowWritesEnabled ||
      policy.primaryBackend === "supabase"
    ) {
      try {
        const persistedReferral =
          (await client.fetch(`*[_id == $id][0]`, { id: referralId })) || referral;
        const createdAccount = await createSupabaseCreatorAccount({
          referral: persistedReferral,
          password: normalizedPassword,
          authUserId: socialUser?.id || "",
          sourceRevision: persistedReferral._rev || "",
          sourceHash: hashShadowDocument(persistedReferral),
        });
        supabaseAccount = createdAccount.account;
      } catch (error) {
        logSafeError("Supabase creator account projection failed", error);
        if (socialUser || policy.primaryBackend === "supabase") {
          await client
            .transaction()
            .delete(referralId)
            .delete(emailClaim._id)
            .delete(slugClaim._id)
            .commit()
            .catch(() => {});
          return res.status(503).json({
            ok: false,
            error: "Registration is temporarily unavailable. Please try again.",
          });
        }
      }
    }

    setReferralSessionCookie(
      res,
      {
        referralId: referral._id,
        code: trimmedSlug,
        authBackend:
          socialUser || policy.primaryBackend === "supabase"
            ? "supabase"
            : "sanity",
        principalId: supabaseAccount?.principal_id || "",
        sessionVersion: supabaseAccount?.session_version || 1,
      },
      true
    );

    return res.status(201).json({ ok: true, referralId: referral._id });
  } catch (err) {
    if (Number(err?.statusCode || err?.status || 0) === 409) {
      return res.status(409).json({
        ok: false,
        error: "That email or referral code is already registered.",
      });
    }
    logSafeError("Referral registration failed", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
