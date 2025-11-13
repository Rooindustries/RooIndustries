import { createClient } from "@sanity/client";
import bcrypt from "bcryptjs";

console.log("💡 Login API loaded");

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async function handler(req, res) {
  console.log("📥 Incoming request:", req.method, req.body);

  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const { code, password } = req.body;

    const referral = await client.fetch(
      `*[_type == "referral" && slug.current == $code][0]`,
      { code }
    );

    if (!referral) {
      console.log("❌ Referral not found");
      return res.status(404).json({ ok: false });
    }

    const valid = await bcrypt.compare(
      password,
      referral.creatorPassword || ""
    );

    console.log("🔐 Password match:", valid);

    if (!valid) {
      console.log("❌ Wrong password");
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
