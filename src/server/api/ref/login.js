import { createClient } from "@sanity/client";
import bcrypt from "bcryptjs";
import { setReferralSessionCookie } from "./auth.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";

const DUMMY_PASSWORD_HASH =
  // nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash
  "$2b$12$6584hc9FBR7p989gOkedS.vPcNBNo89i4Inr1NKZPvdlqMwuNzKfi";

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
    const { code, password, rememberMe = false } = req.body || {};
    const normalizedIdentifier = String(code || "").trim().toLowerCase();
    const normalizedPassword = String(password || "");
    if (!normalizedIdentifier || normalizedIdentifier.length > 254 || normalizedPassword.length > 128) {
      return res.status(400).json({ ok: false, error: "Invalid login request." });
    }
    const clientAddress = getClientAddress(req);

    if (
      !(await requireRateLimit(res, {
        key: `ref-login:${clientAddress}`,
        max: 10,
        windowMs: 15 * 60 * 1000,
      }))
    ) {
      return;
    }

    const referral = await client.fetch(
      `*[
        _type == "referral"
        && (
          (defined(slug.current) && lower(slug.current) == $identifier)
          || (defined(creatorEmail) && lower(creatorEmail) == $identifier)
        )
      ][0]{_id,name,slug,creatorPassword,passwordResetRequired}`,
      { identifier: normalizedIdentifier }
    );

    const stored = String(referral?.creatorPassword || "");
    const looksHashed = /^\$2[aby]\$/.test(stored);
    const valid = await bcrypt.compare(
      normalizedPassword,
      looksHashed ? stored : DUMMY_PASSWORD_HASH
    );
    if (!referral || !looksHashed || !valid || referral.passwordResetRequired === true) {
      return res.status(401).json({
        ok: false,
        error: "Invalid login details. Use Forgot Password if you need to reset access.",
      });
    }

    setReferralSessionCookie(
      res,
      { referralId: referral._id, code: referral.slug?.current || code },
      Boolean(rememberMe)
    );

    return res.json({
      ok: true,
      creatorId: referral._id,
      name: referral.name,
      code: referral.slug.current,
    });
  } catch (err) {
    logSafeError("Referral login failed", err);
    return res.status(500).json({ ok: false });
  }
}
