import { createClient } from "@sanity/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";

// Initialize Sanity with WRITE permissions
const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN, // CRITICAL: Must be a write token
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

    const referral = await client.fetch(
      `*[_type == "referral" && resetTokenHash == $tokenHash && resetTokenExpiresAt > $now][0]{ _id, _rev }`,
      { tokenHash, now }
    );

    if (!referral) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid or expired reset link" });
    }

    // 2. Hash new password
    const hash = await bcrypt.hash(normalizedPassword, 12);

    // 3. Update password and remove reset tokens
    let patch = client.patch(referral._id);
    if (referral._rev && typeof patch.ifRevisionId === "function") {
      patch = patch.ifRevisionId(referral._rev);
    }
    await patch
      .set({
        creatorPassword: hash,
        passwordResetRequired: false,
        credentialVersion: 2,
        passwordChangedAt: now,
      })
      .unset(["resetToken", "resetTokenHash", "resetTokenExpiresAt"])
      .commit();

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
