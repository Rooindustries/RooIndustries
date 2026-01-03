import { createClient } from "@sanity/client";
import bcrypt from "bcryptjs";

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
    const { code, password } = req.body;

    const referral = await client.fetch(
      `*[_type == "referral" && slug.current == $code][0]`,
      { code }
    );

    if (!referral) {
      return res.status(404).json({ ok: false });
    }

    const stored = referral.creatorPassword || "";
    let valid = false;

    // If stored looks like a bcrypt hash → compare using bcrypt
    const looksHashed = stored.startsWith("$2a$") || stored.startsWith("$2b$");

    if (looksHashed) {
      valid = await bcrypt.compare(password, stored);
    } else {
      // Treat stored as plain text password (first-time setup)
      valid = password === stored;

      if (valid && stored) {
        // Auto-hash on first successful login
        const hash = await bcrypt.hash(password, 10);
        try {
          await client
            .patch(referral._id)
            .set({ creatorPassword: hash })
            .commit();
        } catch (e) {
          console.error("Failed to auto-hash password:", e);
        }
      }
    }

    if (!valid) {
      return res.status(401).json({ ok: false });
    }

    return res.json({
      ok: true,
      creatorId: referral._id,
      name: referral.name,
      code: referral.slug.current,
    });
  } catch (err) {
    console.error("💥 LOGIN INTERNAL ERROR:", err);
    return res.status(500).json({ ok: false });
  }
}
