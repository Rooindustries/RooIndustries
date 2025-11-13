import { createClient } from "@sanity/client";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async function handler(req, res) {
  try {
    const creatorId = req.query.id;

    if (!creatorId) {
      return res.status(400).json({ ok: false, error: "Missing creator ID" });
    }

    const referral = await client.fetch(
      `*[_type == "referral" && _id == $id][0]{
        _id,
        name,
        slug,
        maxCommissionPercent,
        currentCommissionPercent,
        currentDiscountPercent,
        paypalEmail
      }`,
      { id: creatorId }
    );

    if (!referral) {
      return res.status(404).json({ ok: false, error: "Creator not found" });
    }

    return res.json({ ok: true, referral });
  } catch (err) {
    console.error("GETDATA ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
