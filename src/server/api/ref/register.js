// ./api/ref/register.js
import { createDataClient as createClient } from "../../data/documentClient.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { setReferralSessionCookie } from "./auth.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";
import { buildReferralIdentityClaim } from "./referralIdentity.js";
import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";
import { createSupabaseCreatorAccount } from "../../supabase/accounts.js";
import { hashShadowDocument } from "../../supabase/shadowStore.js";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

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
      !slug ||
      !password
    ) {
      return res.status(400).json({ ok: false, error: "All fields required" });
    }

    const trimmedEmail = String(email).trim().toLowerCase();
    const trimmedPaypalEmail = String(paypalEmail).trim().toLowerCase();
    const trimmedSlug = String(slug).trim().toLowerCase();
    const normalizedPassword = String(password || "");

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
    if (normalizedPassword.length < 10 || normalizedPassword.length > 128) {
      return res.status(400).json({
        ok: false,
        error: "Use a password between 10 and 128 characters.",
      });
    }

    // Check email uniqueness (login email)
    const existingByEmail = await client.fetch(
      `*[_type == "referral" && lower(creatorEmail) == $email][0]`,
      { email: trimmedEmail }
    );
    if (existingByEmail)
      return res
        .status(409)
        .json({ ok: false, error: "Email already registered" });

    // Check slug uniqueness
    const existingBySlug = await client.fetch(
      `*[_type == "referral" && lower(slug.current) == $slug][0]`,
      { slug: trimmedSlug }
    );
    if (existingBySlug)
      return res
        .status(409)
        .json({ ok: false, error: "Referral code already taken" });

    // Hash password
    const hash = await bcrypt.hash(normalizedPassword, 12);

    // Create the referral and both unique identity claims atomically.
    const referralId = `referral.${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
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
      passwordResetRequired: false,
      credentialVersion: 2,
      passwordChangedAt: createdAt,
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

    const policy = resolveSupabaseRuntimePolicy();
    if (policy.shadowWritesEnabled || policy.primaryBackend === "supabase") {
      try {
        const persistedReferral =
          (await client.fetch(`*[_id == $id][0]`, { id: referralId })) || referral;
        await createSupabaseCreatorAccount({
          referral: persistedReferral,
          password: normalizedPassword,
          sourceRevision: persistedReferral._rev || "",
          sourceHash: hashShadowDocument(persistedReferral),
        });
      } catch (error) {
        logSafeError("Supabase creator account projection failed", error);
        if (policy.primaryBackend === "supabase") {
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
        authBackend: policy.primaryBackend === "supabase" ? "supabase" : "sanity",
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
