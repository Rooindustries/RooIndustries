import { createClient } from "@sanity/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
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
      ][0]{_id,_rev,name,slug,creatorPassword,passwordResetRequired}`,
      { identifier: normalizedIdentifier }
    );

    const stored = String(referral?.creatorPassword || "");
    const looksHashed = /^\$2[aby]\$/.test(stored);
    const suppliedBuffer = Buffer.from(normalizedPassword);
    const storedBuffer = Buffer.from(stored);
    const legacyValid =
      !looksHashed &&
      storedBuffer.length > 0 &&
      suppliedBuffer.length === storedBuffer.length &&
      crypto.timingSafeEqual(suppliedBuffer, storedBuffer);
    const hashedValid = await bcrypt.compare(
      normalizedPassword,
      looksHashed ? stored : DUMMY_PASSWORD_HASH
    );
    const valid = looksHashed ? hashedValid : legacyValid;
    if (!referral || !valid || referral.passwordResetRequired === true) {
      return res.status(401).json({
        ok: false,
        error: "Invalid login details. Use Forgot Password if you need to reset access.",
      });
    }

    if (!looksHashed) {
      try {
        const hash = await bcrypt.hash(normalizedPassword, 12);
        let patch = client.patch(referral._id);
        if (referral._rev) patch = patch.ifRevisionId(referral._rev);
        await patch
          .set({
            creatorPassword: hash,
            credentialVersion: 2,
            passwordResetRequired: false,
            passwordStorageUpgradedAt: new Date().toISOString(),
          })
          .commit({ visibility: "sync" });
      } catch (error) {
        logSafeError("Referral password storage upgrade failed", error);
      }
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
