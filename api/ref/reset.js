import { createClient } from "@sanity/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";

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

    if (!token || !password) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing token or password" });
    }

    const clientAddress = getClientAddress(req);
    if (
      !requireRateLimit(res, {
        key: `ref-reset:${clientAddress}`,
        max: 10,
        windowMs: 30 * 60 * 1000,
      })
    ) {
      return;
    }

    const now = new Date().toISOString();
    const tokenHash = crypto
      .createHash("sha256")
      .update(String(token))
      .digest("hex");

    const referral = await client.fetch(
      `*[_type == "referral" && resetTokenHash == $tokenHash && resetTokenExpiresAt > $now][0]{ _id }`,
      { tokenHash, now }
    );

    if (!referral) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid or expired reset link" });
    }

    // 2. Hash new password
    const hash = await bcrypt.hash(password, 10);

    // 3. Update password and remove reset tokens
    await client
      .patch(referral._id)
      .set({ creatorPassword: hash })
      .unset(["resetToken", "resetTokenHash", "resetTokenExpiresAt"])
      .commit();

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("RESET API ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
