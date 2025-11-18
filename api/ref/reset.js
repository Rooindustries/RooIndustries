import { createClient } from "@sanity/client";
import bcrypt from "bcryptjs";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const { token, password } = req.body || {};

    if (!token || !password) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing token or password" });
    }

    const now = new Date().toISOString();

    const referral = await client.fetch(
      `*[_type == "referral" && resetToken == $token && resetTokenExpiresAt > $now][0]{
        _id
      }`,
      { token, now }
    );

    if (!referral) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid or expired reset link" });
    }

    const hash = await bcrypt.hash(password, 10);

    await client
      .patch(referral._id)
      .set({ creatorPassword: hash })
      .unset(["resetToken", "resetTokenExpiresAt"])
      .commit();

    return res.json({ ok: true });
  } catch (err) {
    console.error("RESET ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
