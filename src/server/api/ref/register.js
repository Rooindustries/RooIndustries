// ./api/ref/register.js
import { createClient } from "@sanity/client";
import bcrypt from "bcryptjs";
import { setReferralSessionCookie } from "./auth.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";

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
      !requireRateLimit(res, {
        key: `ref-register:${clientAddress}`,
        max: 10,
        windowMs: 30 * 60 * 1000,
      })
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

    const emailRegex = /\S+@\S+\.\S+/;

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

    // Check email uniqueness (login email)
    const existingByEmail = await client.fetch(
      `*[_type == "referral" && creatorEmail == $email][0]`,
      { email: trimmedEmail }
    );
    if (existingByEmail)
      return res
        .status(409)
        .json({ ok: false, error: "Email already registered" });

    // Check slug uniqueness
    const existingBySlug = await client.fetch(
      `*[_type == "referral" && slug.current == $slug][0]`,
      { slug: trimmedSlug }
    );
    if (existingBySlug)
      return res
        .status(409)
        .json({ ok: false, error: "Referral code already taken" });

    // Hash password
    const hash = await bcrypt.hash(password, 10);

    // Create referral document
    const referral = await client.create({
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
    });

    setReferralSessionCookie(
      res,
      { referralId: referral._id, code: trimmedSlug },
      true
    );

    return res.status(201).json({ ok: true, referralId: referral._id });
  } catch (err) {
    console.error("💥 REGISTER ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
