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
import { createSupabaseCreatorAccount } from "../../supabase/accounts.js";
import { hashShadowDocument } from "../../supabase/shadowStore.js";
import { getLegacySupabaseUser } from "../../supabase/serverSession.js";
import { Resend } from "resend";
import { buildReferralVerificationEmail } from "../../email/referralVerificationEmail.js";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const createResendClient = () => {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  return apiKey ? new Resend(apiKey) : null;
};

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
    if (
      socialUser &&
      (!socialUser.email_confirmed_at ||
        String(socialUser.email || "").trim().toLowerCase() !== trimmedEmail)
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
        _id,_rev,creatorEmail,slug,registrationStatus,registrationVerificationExpiresAt
      }`,
      { email: trimmedEmail }
    );
    if (existingByEmail && !(await removeExpiredPendingRegistration(existingByEmail)))
      return res
        .status(409)
        .json({ ok: false, error: "Email already registered" });

    // Check slug uniqueness
    const existingBySlug = await client.fetch(
      `*[_type == "referral" && lower(slug.current) == $slug][0]{
        _id,_rev,creatorEmail,slug,registrationStatus,registrationVerificationExpiresAt
      }`,
      { slug: trimmedSlug }
    );
    if (existingBySlug && !(await removeExpiredPendingRegistration(existingBySlug)))
      return res
        .status(409)
        .json({ ok: false, error: "Referral code already taken" });

    // Hash password
    const passwordMaterial =
      normalizedPassword || crypto.randomBytes(32).toString("base64url");
    const hash = await bcrypt.hash(passwordMaterial, 12);

    // Create the referral and both unique identity claims atomically.
    const referralId = `referral.${crypto.randomUUID()}`;
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
    await client
      .transaction()
      .create(emailClaim)
      .create(slugClaim)
      .create(referral)
      .commit();

    if (!socialUser) {
      const resend = createResendClient();
      const baseUrl =
        process.env.NEXT_PUBLIC_BASE_URL ||
        process.env.SITE_URL ||
        "https://www.rooindustries.com";
      const verifyLink = `${baseUrl}/referrals/verify#token=${verificationToken}`;
      const fromAddress = process.env.FROM_EMAIL || "onboarding@resend.dev";
      try {
        if (!resend) throw new Error("Resend is not configured.");
        const sent = await resend.emails.send(
          {
            from: fromAddress,
            to: [trimmedEmail],
            subject: "Confirm your Roo Industries creator account",
            react: buildReferralVerificationEmail({
              name: trimmedDiscordUsername,
              verifyLink,
            }),
          },
          { idempotencyKey: `ref-signup-${verificationTokenHash.slice(0, 32)}` }
        );
        if (sent.error) throw sent.error;
      } catch (error) {
        logSafeError("Referral verification email failed", error);
        await client
          .transaction()
          .delete(referralId)
          .delete(emailClaim._id)
          .delete(slugClaim._id)
          .commit()
          .catch(() => {});
        return res.status(503).json({
          ok: false,
          error: "Verification email could not be sent. Please try again.",
        });
      }
      return res.status(202).json({
        ok: true,
        pendingVerification: true,
        message: "Check your email to finish creating your account.",
      });
    }

    const policy = resolveSupabaseRuntimePolicy();
    if (
      socialUser ||
      policy.shadowWritesEnabled ||
      policy.primaryBackend === "supabase"
    ) {
      try {
        const persistedReferral =
          (await client.fetch(`*[_id == $id][0]`, { id: referralId })) || referral;
        await createSupabaseCreatorAccount({
          referral: persistedReferral,
          password: normalizedPassword,
          authUserId: socialUser?.id || "",
          sourceRevision: persistedReferral._rev || "",
          sourceHash: hashShadowDocument(persistedReferral),
        });
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
