import { createClient } from "@sanity/client";
import bcrypt from "bcryptjs";

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

    const now = new Date().toISOString();

    // 1. Find user with matching token and ensure it hasn't expired
    const referral = await client.fetch(
      `*[_type == "referral" && resetToken == $token && resetTokenExpiresAt > $now][0]{ _id }`,
      { token, now }
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
      .unset(["resetToken", "resetTokenExpiresAt"])
      .commit();

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("RESET API ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
